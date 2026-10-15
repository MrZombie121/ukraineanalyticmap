/* ============================================================
 * Fronty Map Backend (Render Web Service)
 * - Віддає KMZ/KML з правильними CORS
 * - POST /upload — приймає новий файл, зберігає в data/history/YYYY-MM-DD/HH-MM/
 * - GET /api/history — список збережених зрізів
 * - GET /api/kmz?date=YYYY-MM-DD — конкретний зріз (за замовч. — поточний)
 * - GET /admin — проста HTML-форма завантаження + перегляд історії
 * - WebSocket — миттєві сповіщення клієнтів
 * ============================================================ */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// === Cloudflare R2 (S3-сумісний) ===
const R2_ACCOUNT_ID     = process.env.R2_ACCOUNT_ID     || 'b3a2ea917079b32d69fbfdbebeb9891a';
const R2_ACCESS_KEY_ID  = process.env.R2_ACCESS_KEY_ID  || '29f2e39bf402d3a73ea508ca7ea13f4e';
const R2_SECRET_KEY     = process.env.R2_SECRET_KEY     || '938547b82efa7f76839c00de6968adaf1f7a6f938e85c73f2c1eb4179d332d67';
const R2_BUCKET         = process.env.R2_BUCKET         || 'kmzfile';
const R2_PUBLIC_URL     = process.env.R2_PUBLIC_URL     || 'https://pub-4bcabed7f9914ca3a07e013c10300e18.r2.dev';
const R2_PREFIX         = process.env.R2_PREFIX         || 'uam'; // 'uam' для UAM, 'akv' для AKV

let r2 = null;
function getR2() {
  if (r2) return r2;
  r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_KEY,
    },
    forcePathStyle: true,
  });
  return r2;
}

function r2Enabled() {
  return !!(R2_ACCESS_KEY_ID && R2_SECRET_KEY && R2_BUCKET);
}

function buildR2Name(prefix, now = new Date()) {
  // формат: uam-MM-DD-YY-Hour-Minute  (приклад: uam-10-15-26-15-30.kmz)
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const HH = String(now.getHours()).padStart(2, '0');
  const MM = String(now.getMinutes()).padStart(2, '0');
  return `${prefix}-${mm}-${dd}-${yy}-${HH}-${MM}.kmz`;
}

// Дістати дату й час з імені R2 файлу (для сортування і групування)
function parseR2Name(name) {
  const m = name.match(/^(uam|akv)-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.kmz$/);
  if (!m) return null;
  const [, prefix, mm, dd, yy, HH, MM] = m;
  const year = 2000 + parseInt(yy, 10);
  const date = `${year}-${mm}-${dd}`;
  const time = `${HH}:${MM}`;
  const iso = new Date(`${year}-${mm}-${dd}T${HH}:${MM}:00Z`).toISOString();
  return { prefix, date, time, iso };
}

// === Автосинхронізація з Google My Maps ===
const GOOGLE_MAPS_MID = process.env.GOOGLE_MAPS_MID || '1E7cefbjfT33zErTQADATnyZ_SVChrJc';
const GOOGLE_FETCH_MIN = parseInt(process.env.GOOGLE_FETCH_MIN || '10', 10);
const GOOGLE_USER_AGENT = process.env.GOOGLE_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const FRONT_DIR = path.resolve(__dirname, '..');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const CURRENT_POINTER = path.join(DATA_DIR, 'current.json');
const KMZ_PATH = path.join(DATA_DIR, 'fronty.kmz'); // legacy / fallback
const FALLBACK_PATHS = [
  path.join(FRONT_DIR, 'Ukraine Analystic Map UAM.kmz'),
  path.join(FRONT_DIR, 'front.kmz'),
  path.join(FRONT_DIR, 'front.kml'),
];

// Гарантуємо, що DATA_DIR і HISTORY_DIR існують
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(HISTORY_DIR, { recursive: true });

const app = express();

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === '*'
    ? '*'
    : (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) return cb(null, true);
        cb(new Error('CORS: origin ' + origin + ' not allowed'));
      },
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Admin-Token'],
  credentials: false,
}));

app.use((req, _res, next) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${req.method} ${req.url}`);
  next();
});

function checkAdmin(req, res, next) {
  if (!PASSWORD) return next();
  const token = req.headers['x-admin-token'] || req.query.token || '';
  if (token === PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized. Потрібен ?token=... або X-Admin-Token' });
}

// ============ Helpers: history (R2 + локальний кеш) ============

// async-список — беремо з R2, групуємо за датою
async function readHistoryR2() {
  if (!r2Enabled()) return [];
  const out = [];
  try {
    const client = getR2();
    const command = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: R2_PREFIX + '-',
    });
    const resp = await client.send(command);
    const items = (resp.Contents || [])
      .map(o => ({ name: o.Key, size: o.Size, mtime: o.LastModified ? new Date(o.LastModified).getTime() : 0 }))
      .filter(x => x.name && x.name.endsWith('.kmz'))
      .sort((a, b) => b.name.localeCompare(a.name)); // newest by name desc

    const groups = new Map();
    for (const it of items) {
      const p = parseR2Name(path.basename(it.name));
      if (!p) continue;
      const day = groups.get(p.date) || { date: p.date, files: [] };
      day.files.push({
        name: path.basename(it.name),
        time: p.time,
        size: it.size,
        mtime: it.mtime,
        iso: p.iso,
        relPath: it.name,
      });
      groups.set(p.date, day);
    }
    for (const day of groups.values()) {
      day.files.sort((a, b) => b.iso.localeCompare(a.iso));
      day.count = day.files.length;
      day.latest = day.files[0];
      out.push(day);
    }
    out.sort((a, b) => b.date.localeCompare(a.date));
  } catch (e) {
    console.warn('[r2 list]', e.message);
  }
  return out;
}

// Знайти об'єкт за датою (найновіший у цій даті), або за relPath
async function findInR2(date) {
  if (!r2Enabled()) return null;
  try {
    const client = getR2();
    const prefix = date ? `${R2_PREFIX}-${date.split('-').slice(1).join('-')}-` : R2_PREFIX + '-';
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
    }));
    const items = (resp.Contents || []).filter(x => x.Key && x.Key.endsWith('.kmz'));
    if (!items.length) return null;
    items.sort((a, b) => (b.LastModified ? new Date(b.LastModified).getTime() : 0) - (a.LastModified ? new Date(a.LastModified).getTime() : 0));
    return items[0].Key; // повертаємо key, а не Buffer
  } catch (e) {
    console.warn('[r2 find]', e.message);
    return null;
  }
}

async function getObjectFromR2(key) {
  const client = getR2();
  const resp = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  // stream → buffer
  const chunks = [];
  for await (const c of resp.Body) chunks.push(c);
  return { buffer: Buffer.concat(chunks), size: resp.ContentLength, lastModified: resp.LastModified };
}

async function readHistory() {
  // Тільки R2 — локально нічого не зберігаємо
  return await readHistoryR2();
}

async function readCurrent() {
  // current.json — зберігаємо в R2, не локально (Render ephemeral)
  if (!r2Enabled()) return null;
  try {
    const { buffer } = await getObjectFromR2(`${R2_PREFIX}-current.json`);
    return JSON.parse(buffer.toString('utf8'));
  } catch { return null; }
}

async function writeCurrent(meta) {
  if (!r2Enabled()) return;
  try {
    const client = getR2();
    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `${R2_PREFIX}-current.json`,
      Body: JSON.stringify(meta, null, 2),
      ContentType: 'application/json',
    }));
  } catch (e) {
    console.warn('[r2 current]', e.message);
  }
}

async function getKmzR2(date) {
  const key = await findInR2(date);
  if (!key) return null;
  const { buffer, size } = await getObjectFromR2(key);
  return { buffer, size, key, relPath: key };
}

// ============ Health ============
app.get('/health', (_req, res) => {
  const cur = readCurrent();
  res.json({
    ok: true,
    uptime: process.uptime(),
    historyDir: HISTORY_DIR,
    current: cur,
    clients: wss ? wss.clients.size : 0,
    adminPassword: !!PASSWORD,
    dataDir: DATA_DIR,
  });
});

// ============ History API ============
app.get('/api/history', async (_req, res) => {
  try {
    const [history, current] = await Promise.all([readHistory(), readCurrent()]);
    res.json({ history, current });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ KMZ serve ============
function sendKmzBuffer(req, res, buf, name) {
  if (!buf || !buf.length) {
    return res.status(404).json({ error: 'Зріз не знайдено' });
  }
  try {
    const ext = (name || '').toLowerCase();
    const kind = ext.endsWith('.kml')
      ? 'application/vnd.google-earth.kml+xml'
      : 'application/vnd.google-earth.kmz';
    res.set({
      'Content-Type': kind,
      'Content-Length': buf.length,
      'Content-Encoding': 'identity',
      'Cache-Control': 'no-store, max-age=0',
      'Access-Control-Allow-Origin': '*',
    });
    res.send(buf);
    console.log(`[kmz] served ${name || 'r2'} (${buf.length} байт)`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function resolveAndSend(req, res, date) {
  if (!r2Enabled()) {
    // legacy fallback на локальну ФС, якщо R2 вимкнено
    let f = null;
    if (date) {
      const dayDir = path.join(HISTORY_DIR, date);
      if (fs.existsSync(dayDir)) {
        const slots = fs.readdirSync(dayDir).sort();
        for (let i = slots.length - 1; i >= 0; i--) {
          const slotDir = path.join(dayDir, slots[i]);
          if (!fs.statSync(slotDir).isDirectory()) continue;
          const x = fs.readdirSync(slotDir).find(y => /\.(kmz|kml)$/i.test(y));
          if (x) { f = { path: path.join(slotDir, x), name: x }; break; }
        }
      }
    } else {
      const cur = readCurrent();
      if (cur && cur.relPath) {
        const p = path.join(HISTORY_DIR, cur.relPath);
        if (fs.existsSync(p)) f = { path: p, name: path.basename(p) };
      }
      if (!f && fs.existsSync(KMZ_PATH)) f = { path: KMZ_PATH, name: 'fronty.kmz' };
    }
    if (!f) return res.status(404).json({ error: 'Жоден KMZ не знайдено' });
    const buf = fs.readFileSync(f.path);
    return sendKmzBuffer(req, res, buf, f.name);
  }
  try {
    const r = await getKmzR2(date);
    if (!r) return res.status(404).json({ error: date ? `Зріз за ${date} не знайдено` : 'Жоден KMZ не знайдено' });
    sendKmzBuffer(req, res, r.buffer, path.basename(r.key));
  } catch (e) {
    console.error('[kmz]', e.message);
    res.status(500).json({ error: e.message });
  }
}

app.get('/kmz', (req, res) => resolveAndSend(req, res, null));
app.head('/kmz', (_req, res) => res.set({ 'Content-Type': 'application/vnd.google-earth.kmz' }).status(200).end());
app.get('/api/kmz', (req, res) => resolveAndSend(req, res, req.query.date || null));

// ============ Upload ============
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/upload', checkAdmin, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не знайдено в полі "file"' });
  }
  try {
    const buf = req.file.buffer;
    const ext = (req.file.originalname.split('.').pop() || 'kmz').toLowerCase();
    if (!['kmz', 'kml'].includes(ext)) {
      return res.status(400).json({ error: 'Тільки .kmz або .kml' });
    }

    // Опційна дата з форми (для завантаження історичного зрізу)
    const dateHint = (req.body && req.body.date) || null;
    const now = new Date();
    const date = (dateHint && /^\d{4}-\d{2}-\d{2}$/.test(dateHint)) ? dateHint : now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 16); // HH-MM
    const safeName = (req.file.originalname || `front.${ext}`).replace(/[^A-Za-z0-9._-]/g, '_');

    const slotDir = path.join(HISTORY_DIR, date, time);
    fs.mkdirSync(slotDir, { recursive: true });
    const filePath = path.join(slotDir, safeName);

    // Атомарний запис
    const tmpPath = path.join(DATA_DIR, `.${crypto.randomBytes(8).toString('hex')}.${ext}`);
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, filePath);

    // Оновлюємо current.json — це найновіший зріз
    const relPath = path.posix.join(date, time, safeName);
    writeCurrent({
      relPath,
      mtime: Date.now(),
      originalName: req.file.originalname,
      size: buf.length,
      uploadedAt: now.toISOString(),
    });

    // Legacy: копія в data/fronty.kmz для зворотної сумісності
    try { fs.writeFileSync(KMZ_PATH, buf); } catch {}

    console.log(`[upload] ${req.file.originalname} → history/${relPath} (${buf.length} байт)`);
    broadcastUpdate({ relPath, date, size: buf.length });
    res.json({
      ok: true,
      path: relPath,
      size: buf.length,
      date,
      time,
      mtime: Date.now(),
      message: 'Зріз збережено в історію. Клієнти отримають WS-сповіщення.',
    });
  } catch (e) {
    console.error('[upload err]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Видалити зріз
app.delete('/api/history/:date', checkAdmin, (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Невірна дата' });
  }
  const dayDir = path.join(HISTORY_DIR, date);
  if (!fs.existsSync(dayDir)) {
    return res.status(404).json({ error: 'Зріз не знайдено' });
  }
  fs.rmSync(dayDir, { recursive: true, force: true });
  // Якщо видалили поточний — скинути current.json
  const cur = readCurrent();
  if (cur && cur.relPath && cur.relPath.startsWith(date + '/')) {
    try { fs.unlinkSync(CURRENT_POINTER); } catch {}
  }
  broadcastUpdate({ removed: date });
  res.json({ ok: true, date });
});

// ============ Admin UI ============
app.get('/admin', (req, res) => {
  const token = req.query.token || '';
  const cur = readCurrent();
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(ADMIN_HTML.replace(/\{\{TOKEN\}\}/g, token).replace(/\{\{CURRENT\}\}/g, JSON.stringify(cur || null)));
});

// ============ Опціональний проксі ============
app.get('/proxy/kml', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Параметр url обовʼязковий' });
  if (!/^https?:\/\/(www\.)?google\.com\//.test(url)) {
    return res.status(400).json({ error: 'Тільки google.com дозволено' });
  }
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Fronty-Map/1.0',
        'Accept': 'application/vnd.google-earth.kml+xml, application/xml, */*',
      },
      redirect: 'follow',
    });
    const body = await r.text();
    res.set({
      'Content-Type': r.headers.get('content-type') || 'application/xml',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ============ Сервер + WebSocket ============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastUpdate(payload = {}) {
  if (!wss) return;
  const msg = JSON.stringify({ type: 'kmz-updated', ...payload });
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(msg);
  });
}

// ============ Автосинхронізація з Google My Maps ============
// Раз на GOOGLE_FETCH_MIN хвилин тягнемо KML напряму з Google (CORS не блокує — це сервер-сайд),
// зберігаємо в history і розсилаємо WS. Curl-style UA бо Google блокує дефолтний Node fetch.
let googleFetchInFlight = false;
let googleFetchLog = []; // останні 20 статусів

async function fetchGoogleKmlAsBuffer(mid) {
  // forcekml=1 повертає повний KML напряму, без редіректів на UI
  const url = `https://www.google.com/maps/d/kml?mid=${encodeURIComponent(mid)}&forcekml=1`;
  // Node 18+ має глобальний fetch. Якщо нема — fallback на https.
  if (typeof fetch === 'function') {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': GOOGLE_USER_AGENT, 'Accept': '*/*' },
    });
    if (!r.ok) throw new Error(`Google HTTP ${r.status}`);
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  }
  // Fallback на https
  const https = require('https');
  return await new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': GOOGLE_USER_AGENT } }, (resp) => {
      if (resp.statusCode !== 200) {
        resp.resume(); reject(new Error(`Google HTTP ${resp.statusCode}`)); return;
      }
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function pushFetchLog(entry) {
  googleFetchLog.unshift({ ts: new Date().toISOString(), ...entry });
  if (googleFetchLog.length > 20) googleFetchLog.pop();
}

async function uploadToR2(buffer, key, contentType = 'application/vnd.google-earth.kmz') {
  if (!r2Enabled()) throw new Error('R2 not configured');
  const client = getR2();
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
}

async function syncFromGoogle(reason = 'manual') {
  if (googleFetchInFlight) return { skipped: true, reason: 'already-running' };
  if (!GOOGLE_MAPS_MID) return { skipped: true, reason: 'no-mid' };
  googleFetchInFlight = true;
  const startedAt = Date.now();
  try {
    const buf = await fetchGoogleKmlAsBuffer(GOOGLE_MAPS_MID);
    const text = buf.toString('utf8');
    if (!text.includes('<kml') || !text.includes('<Placemark')) {
      const e = { ok: false, reason: 'not-kml', size: buf.length, snippet: text.slice(0, 200) };
      pushFetchLog(e);
      console.warn(`[google-sync] ${reason}: відповідь не KML (${buf.length} байт)`);
      return e;
    }

    const now = new Date();
    const fileName = buildR2Name(R2_PREFIX, now);
    const key = fileName;

    // Заливаємо в R2
    if (r2Enabled()) {
      try {
        await uploadToR2(buf, key);
      } catch (e) {
        const r = { ok: false, error: 'r2 upload: ' + e.message, reason };
        pushFetchLog(r);
        console.warn(`[google-sync] ✗ ${reason}: R2 upload failed: ${e.message}`);
        return r;
      }
    }

    // (Опціонально) дзеркало в локальну ФС — корисно для `/admin` bulk-download
    if (fs.existsSync(path.join(FRONT_DIR, '.keep-local'))) {
      const date = now.toISOString().slice(0, 10);
      const time = now.toISOString().slice(11, 16);
      const slotDir = path.join(HISTORY_DIR, date, time);
      fs.mkdirSync(slotDir, { recursive: true });
      fs.writeFileSync(path.join(slotDir, fileName), buf);
    }

    const date = now.toISOString().slice(0, 10);
    await writeCurrent({
      relPath: key,
      mtime: Date.now(),
      originalName: 'google-my-maps',
      size: buf.length,
      source: 'google-my-maps',
      uploadedAt: now.toISOString(),
    });

    const took = Date.now() - startedAt;
    const r = { ok: true, key, size: buf.length, took, reason };
    pushFetchLog(r);
    console.log(`[google-sync] ✓ ${reason}: ${buf.length} байт → r2://${R2_BUCKET}/${key} (${took}ms)`);
    broadcastUpdate({ key, date, size: buf.length, source: 'r2' });
    return r;
  } catch (e) {
    const r = { ok: false, error: e.message, reason };
    pushFetchLog(r);
    console.warn(`[google-sync] ✗ ${reason}: ${e.message}`);
    return r;
  } finally {
    googleFetchInFlight = false;
  }
}

let googleTimer = null;
function startGoogleSyncLoop() {
  if (!GOOGLE_MAPS_MID || GOOGLE_FETCH_MIN <= 0) {
    console.log(`[google-sync] вимкнено (GOOGLE_MAPS_MID=${GOOGLE_MAPS_MID ? '?' : '-'}, GOOGLE_FETCH_MIN=${GOOGLE_FETCH_MIN})`);
    return;
  }
  const ms = GOOGLE_FETCH_MIN * 60 * 1000;
  console.log(`[google-sync] увімкнено: mid=${GOOGLE_MAPS_MID.slice(0, 8)}…, інтервал=${GOOGLE_FETCH_MIN} хв`);
  // перший запит — одразу, через 5 секунд після старту (щоб HTTP вже був готовий)
  setTimeout(() => syncFromGoogle('startup'), 5000);
  googleTimer = setInterval(() => syncFromGoogle('interval'), ms);
}

// API для ручного запуску
app.post('/api/sync', (_req, res) => {
  syncFromGoogle('admin').then(r => res.json(r));
});

// Статус останніх синхронізацій
app.get('/api/sync-status', (_req, res) => {
  res.json({
    enabled: !!GOOGLE_MAPS_MID && GOOGLE_FETCH_MIN > 0,
    mid: GOOGLE_MAPS_MID ? GOOGLE_MAPS_MID.slice(0, 8) + '…' : null,
    intervalMin: GOOGLE_FETCH_MIN,
    log: googleFetchLog,
  });
});

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[ws+] ${ip} (всього: ${wss.clients.size})`);
  ws.send(JSON.stringify({
    type: 'hello',
    current: readCurrent(),
  }));
  ws.on('close', () => console.log(`[ws-] ${ip} (залишилось: ${wss.clients.size})`));
});

// ============ Старт ============
server.listen(PORT, () => {
  const sep = '═'.repeat(60);
  console.log(sep);
  console.log(`🟢 Fronty Backend на http://localhost:${PORT}`);
  console.log(sep);
  console.log(`   GET  /health               → статус`);
  console.log(`   GET  /api/history          → список зрізів з датами`);
  console.log(`   GET  /api/kmz?date=YYYY-MM-DD → конкретний зріз (за замовч. — поточний)`);
  console.log(`   GET  /kmz                  → поточний KMZ (back-compat)`);
  console.log(`   GET  /admin                → форма завантаження + історія`);
  console.log(`   POST /upload               → завантажити новий файл`);
  console.log(`   DEL  /api/history/:date    → видалити зріз за датою`);
  console.log(`   WS   /ws                   → сповіщення про оновлення`);
  console.log(sep);
  console.log(`   DATA_DIR:   ${DATA_DIR}`);
  console.log(`   HISTORY:    ${HISTORY_DIR}`);
  console.log(`   Поточний:   ${readCurrent()?.relPath || '—'}`);
  if (GOOGLE_MAPS_MID) {
    console.log(`   GOOGLE MID: ${GOOGLE_MAPS_MID}`);
    console.log(`   GOOGLE SYNC: кожні ${GOOGLE_FETCH_MIN} хв (POST /api/sync — ручний запуск)`);
  }
  console.log(sep);
  startGoogleSyncLoop();
});

process.on('SIGINT', () => {
  console.log('\n[bye] Зупинка…');
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => process.emit('SIGINT'));

// ============ Admin HTML ============
const ADMIN_HTML = `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fronty Admin — Історія зрізів</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px 20px; font-family: 'Manrope', system-ui, sans-serif; background: #0b1020; color: #e8ecf8; min-height: 100vh; }
    .card { max-width: 720px; margin: 0 auto 22px; padding: 24px; background: rgba(15,21,48,0.92); border: 1px solid rgba(255,255,255,0.16); border-radius: 16px; }
    h1 { margin: 0 0 6px; font-size: 1.3rem; }
    h2 { margin: 0 0 12px; font-size: 1rem; color: #97a3c2; }
    .muted { color: #97a3c2; font-size: 0.86rem; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .drop { padding: 26px; border: 2px dashed rgba(124,58,237,0.45); border-radius: 12px; text-align: center; cursor: pointer; transition: background .2s, border-color .2s; }
    .drop.drag, .drop:hover { background: rgba(124,58,237,0.12); border-color: rgba(124,58,237,0.7); }
    .drop input { display: none; }
    .status { margin-top: 12px; padding: 10px 12px; background: rgba(255,255,255,0.05); border-radius: 8px; font: 500 0.84rem ui-monospace, monospace; color: #97a3c2; word-break: break-all; }
    .status.ok { color: #4ade80; }
    .status.err { color: #fda4af; }
    .btn { display: inline-block; padding: 8px 14px; background: linear-gradient(135deg, #7c3aed, #06b6d4); color: white; border: 0; border-radius: 8px; font: 700 0.84rem 'Manrope', sans-serif; cursor: pointer; text-decoration: none; }
    .btn.secondary { background: rgba(255,255,255,0.08); }
    .btn.danger { background: rgba(244,63,94,0.18); color: #fda4af; }
    input[type="date"] { background: rgba(255,255,255,0.05); color: #e8ecf8; border: 1px solid rgba(255,255,255,0.16); border-radius: 6px; padding: 6px 10px; font: 500 0.84rem 'Manrope', sans-serif; }
    table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
    th { color: #97a3c2; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
    tr.latest { background: rgba(124,58,237,0.10); }
    tr.latest td:first-child::before { content: '● '; color: #7c3aed; }
    code { background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; font-size: 0.84rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>📤 Завантажити новий зріз</h1>
    <p class="muted">Файл зберігається в <code>data/history/YYYY-MM-DD/HH-MM/</code>. Клієнти отримують WS-сповіщення.</p>

    <div class="row" style="margin-bottom:14px;">
      <label class="muted">Дата зрізу (опц.):</label>
      <input type="date" id="date" />
      <span class="muted" style="font-size:0.78rem;">якщо не вказано — сьогодні</span>
    </div>

    <label class="drop" id="drop">
      <input type="file" id="file" accept=".kmz,.kml" />
      <strong>Перетягни файл сюди</strong>
      <div class="muted">або клікни, щоб обрати (.kmz, .kml)</div>
    </label>

    <div class="status" id="status">Очікую файл…</div>
  </div>

  <div class="card">
    <h2>📚 Історія зрізів</h2>
    <table id="hist">
      <thead><tr><th>Дата</th><th>Час</th><th>Файл</th><th>Розмір</th><th></th></tr></thead>
      <tbody><tr><td colspan="5" class="muted">Завантаження…</td></tr></tbody>
    </table>
    <div class="row" style="margin-top:14px;">
      <button class="btn secondary" id="refresh">↻ Оновити</button>
    </div>
  </div>

  <p style="text-align:center;"><a class="btn secondary" href="/">← До мапи</a></p>

  <script>
    const TOKEN = '{{TOKEN}}';
    const CURRENT = {{CURRENT}};
    const drop = document.getElementById('drop');
    const fileInput = document.getElementById('file');
    const dateInput = document.getElementById('date');
    const statusEl = document.getElementById('status');
    const histBody = document.querySelector('#hist tbody');

    function fmtSize(n) {
      if (n < 1024) return n + ' Б';
      if (n < 1024*1024) return (n/1024).toFixed(1) + ' КБ';
      return (n/1024/1024).toFixed(2) + ' МБ';
    }
    function fmtTime(ms) {
      return new Date(ms).toISOString().slice(11, 16);
    }

    async function loadHistory() {
      try {
        const r = await fetch('/api/history');
        const j = await r.json();
        if (!j.history.length) {
          histBody.innerHTML = '<tr><td colspan="5" class="muted">Поки що немає жодного зрізу. Завантаж перший!</td></tr>';
          return;
        }
        const curRel = (j.current && j.current.relPath) || '';
        const rows = [];
        for (const day of j.history) {
          for (const f of day.files) {
            const isCurrent = f.relPath === curRel;
            rows.push('<tr class="' + (isCurrent ? 'latest' : '') + '">' +
              '<td>' + day.date + '</td>' +
              '<td>' + f.time + '</td>' +
              '<td><code>' + f.name + '</code></td>' +
              '<td>' + fmtSize(f.size) + '</td>' +
              '<td><button class="btn secondary" data-del="' + day.date + '">🗑</button></td>' +
              '</tr>');
          }
        }
        histBody.innerHTML = rows.join('');
        histBody.querySelectorAll('button[data-del]').forEach(b => {
          b.addEventListener('click', () => deleteSlice(b.dataset.del));
        });
      } catch (e) {
        histBody.innerHTML = '<tr><td colspan="5" class="status err">Помилка: ' + e.message + '</td></tr>';
      }
    }

    async function deleteSlice(date) {
      if (!confirm('Видалити всі зрізи за ' + date + '?')) return;
      const headers = TOKEN ? { 'X-Admin-Token': TOKEN } : {};
      const r = await fetch('/api/history/' + date, { method: 'DELETE', headers });
      if (r.ok) loadHistory();
      else alert('Помилка: ' + r.status);
    }

    async function upload(file) {
      statusEl.className = 'status';
      statusEl.textContent = 'Завантаження ' + file.name + '…';
      const fd = new FormData();
      fd.append('file', file);
      if (dateInput.value) fd.append('date', dateInput.value);
      const headers = TOKEN ? { 'X-Admin-Token': TOKEN } : {};
      try {
        const r = await fetch('/upload', { method: 'POST', body: fd, headers });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
        statusEl.className = 'status ok';
        statusEl.textContent = '✅ Збережено в history/' + j.path + ' (' + fmtSize(j.size) + ')';
        loadHistory();
      } catch (e) {
        statusEl.className = 'status err';
        statusEl.textContent = '❌ ' + e.message;
      }
    }

    fileInput.addEventListener('change', (e) => { if (e.target.files[0]) upload(e.target.files[0]); });
    ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
    document.getElementById('refresh').addEventListener('click', loadHistory);

    // Bug fix: подвоїння лапок у шаблоні через мою помилку — простіше зробити через innerHTML
    loadHistory();
  </script>
</body>
</html>`;

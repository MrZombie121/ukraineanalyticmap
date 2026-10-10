/* ============================================================
 * Fronty Map Backend (Render Web Service)
 * - Віддає поточний KMZ/KML з правильними CORS
 * - POST /upload — приймає новий файл (multipart/form-data)
 * - GET /admin — проста HTML-форма завантаження
 * - WebSocket — миттєві сповіщення клієнтів
 * - Зберігає файл у DATA_DIR (/tmp на Render, ./data локально)
 * ============================================================ */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const multer = require('multer');

const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PASSWORD = process.env.ADMIN_PASSWORD || ''; // якщо задано — /admin і /upload вимагають
const FRONT_DIR = path.resolve(__dirname, '..');

// Гарантуємо, що DATA_DIR існує
fs.mkdirSync(DATA_DIR, { recursive: true });

const KMZ_PATH = path.join(DATA_DIR, 'fronty.kmz');
const FALLBACK_PATHS = [
  path.join(FRONT_DIR, 'Ukraine Analystic Map UAM.kmz'),
  path.join(FRONT_DIR, 'front.kmz'),
  path.join(FRONT_DIR, 'front.kml'),
];

const app = express();

// CORS для API та KMZ
// На Render задай env: ALLOWED_ORIGINS="https://uaanalyticmap.pp.ua,http://localhost:3000"
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
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Admin-Token'],
  credentials: false,
}));

// Логування
app.use((req, _res, next) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${req.method} ${req.url}`);
  next();
});

// Простий захист адмінки: Basic Auth через X-Admin-Token або query
function checkAdmin(req, res, next) {
  if (!PASSWORD) return next(); // без пароля — пускаємо всіх (тільки локально!)
  const token = req.headers['x-admin-token'] || req.query.token || '';
  if (token === PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized. Потрібен ?token=... або X-Admin-Token' });
}

// ============ Health ============
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    kmz: {
      path: currentKmzPath,
      size: currentKmz ? currentKmz.length : 0,
      mtime: currentMtime,
      exists: !!currentKmz,
    },
    clients: wss ? wss.clients.size : 0,
    adminPassword: !!PASSWORD,
    dataDir: DATA_DIR,
  });
});

// ============ KMZ ============
let currentKmz = null;
let currentKmzPath = null;
let currentMtime = null;
let currentKind = 'application/vnd.google-earth.kmz';

function findFallback() {
  for (const p of FALLBACK_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function loadKmz() {
  // 1. Спочатку шукаємо в DATA_DIR (завантажений адміном)
  let p = fs.existsSync(KMZ_PATH) ? KMZ_PATH : null;
  // 2. Якщо немає — fallback на файли в корені проєкту
  if (!p) p = findFallback();
  if (!p) {
    console.warn('[warn] Жоден KMZ-файл не знайдено. Чекаємо на /upload');
    return false;
  }
  try {
    const stat = fs.statSync(p);
    if (currentKmzPath === p && currentMtime === stat.mtimeMs && currentKmz) return false;
    currentKmz = fs.readFileSync(p);
    currentKmzPath = p;
    currentMtime = stat.mtimeMs;
    currentKind = p.toLowerCase().endsWith('.kml')
      ? 'application/vnd.google-earth.kml+xml'
      : 'application/vnd.google-earth.kmz';
    console.log(`[ok] Завантажено ${path.basename(p)} (${currentKmz.length} байт, mtime=${new Date(stat.mtimeMs).toISOString()})`);
    broadcastUpdate();
    return true;
  } catch (e) {
    console.error('[err] loadKmz:', e.message);
    return false;
  }
}

function broadcastUpdate() {
  if (!wss) return;
  const msg = JSON.stringify({
    type: 'kmz-updated',
    size: currentKmz ? currentKmz.length : 0,
    mtime: currentMtime,
    path: currentKmzPath ? path.basename(currentKmzPath) : null,
  });
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(msg);
  });
  console.log(`[ws] Сповіщено ${wss.clients.size} клієнт(ів)`);
}

app.get('/kmz', (_req, res) => {
  if (!currentKmz) loadKmz();
  if (!currentKmz) {
    return res.status(404).json({
      error: 'KMZ не знайдено. Завантажте файл через /admin',
    });
  }
  res.set({
    'Content-Type': currentKind,
    'Content-Length': currentKmz.length,
    'Content-Encoding': 'identity',
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Origin': '*',
  });
  res.send(currentKmz);
});

app.head('/kmz', (_req, res) => {
  if (!currentKmz) loadKmz();
  if (!currentKmz) return res.status(404).end();
  res.set({
    'Content-Type': currentKind,
    'Content-Length': currentKmz.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.status(200).end();
});

// ============ Upload (multipart) ============
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 МБ
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
    // Атомарний запис: спочатку тимчасовий, потім rename
    const tmpPath = path.join(DATA_DIR, `.${crypto.randomBytes(8).toString('hex')}.${ext}`);
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, KMZ_PATH);
    console.log(`[upload] Збережено ${req.file.originalname} → ${KMZ_PATH} (${buf.length} байт)`);
    loadKmz();
    res.json({
      ok: true,
      path: path.basename(KMZ_PATH),
      size: buf.length,
      mtime: currentMtime,
      message: 'Файл збережено, фронт оновлено через WebSocket',
    });
  } catch (e) {
    console.error('[upload err]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ Admin UI ============
app.get('/admin', (req, res) => {
  const token = req.query.token || '';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(ADMIN_HTML.replace(/\{\{TOKEN\}\}/g, token).replace(/\{\{STATUS\}\}/g, JSON.stringify({
    kmz: currentKmz ? path.basename(currentKmzPath) : '—',
    size: currentKmz ? currentKmz.length : 0,
    mtime: currentMtime ? new Date(currentMtime).toISOString() : '—',
  })));
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

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[ws+] ${ip} (всього: ${wss.clients.size})`);
  ws.send(JSON.stringify({
    type: 'hello',
    kmzSize: currentKmz ? currentKmz.length : 0,
    kmzMtime: currentMtime,
  }));
  ws.on('close', () => console.log(`[ws-] ${ip} (залишилось: ${wss.clients.size})`));
});

// Polling-fallback для авто-релоаду файлу
setInterval(() => {
  if (!currentKmzPath) {
    const p = findFallback() || (fs.existsSync(KMZ_PATH) ? KMZ_PATH : null);
    if (p) loadKmz();
    return;
  }
  try {
    if (!fs.existsSync(currentKmzPath)) return;
    const stat = fs.statSync(currentKmzPath);
    if (stat.mtimeMs !== currentMtime) loadKmz();
  } catch {}
}, 15_000);

// ============ Старт ============
loadKmz();
server.listen(PORT, () => {
  const sep = '═'.repeat(60);
  console.log(sep);
  console.log(`🟢 Fronty Backend на http://localhost:${PORT}`);
  console.log(sep);
  console.log(`   GET  /health        → статус`);
  console.log(`   GET  /kmz           → поточний KMZ з CORS`);
  console.log(`   GET  /admin         → форма завантаження${PASSWORD ? ' (з паролем)' : ''}`);
  console.log(`   POST /upload        → завантажити новий файл (multipart/form-data, поле "file")`);
  console.log(`   WS   /ws            → сповіщення про оновлення`);
  console.log(sep);
  console.log(`   DATA_DIR: ${DATA_DIR}`);
  console.log(`   Поточний файл: ${currentKmzPath ? path.basename(currentKmzPath) : '—'}`);
  console.log(sep);
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
  <title>Fronty Admin — Завантаження KMZ</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 40px 20px;
      font-family: 'Manrope', system-ui, sans-serif;
      background: #0b1020; color: #e8ecf8;
      min-height: 100vh;
    }
    .card {
      max-width: 560px; margin: 0 auto;
      padding: 28px;
      background: rgba(15,21,48,0.92);
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 18px;
      box-shadow: 0 20px 60px -20px rgba(0,0,0,0.6);
    }
    h1 { margin: 0 0 8px; font-size: 1.4rem; }
    .muted { color: #97a3c2; font-size: 0.9rem; margin-bottom: 18px; }
    .drop {
      padding: 32px;
      border: 2px dashed rgba(124,58,237,0.45);
      border-radius: 14px;
      text-align: center;
      cursor: pointer;
      transition: background .2s, border-color .2s;
    }
    .drop.drag, .drop:hover { background: rgba(124,58,237,0.12); border-color: rgba(124,58,237,0.7); }
    .drop input { display: none; }
    .status {
      margin-top: 16px;
      padding: 12px 14px;
      background: rgba(255,255,255,0.05);
      border-radius: 10px;
      font: 500 0.85rem ui-monospace, monospace;
      color: #97a3c2;
      word-break: break-all;
    }
    .status.ok { color: #4ade80; }
    .status.err { color: #fda4af; }
    button.btn {
      display: inline-block;
      padding: 10px 18px;
      margin-top: 10px;
      background: linear-gradient(135deg, #7c3aed, #06b6d4);
      color: white;
      border: 0;
      border-radius: 10px;
      font: 700 0.9rem 'Manrope', sans-serif;
      cursor: pointer;
    }
    a.btn {
      background: rgba(255,255,255,0.08);
      color: #e8ecf8;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>📤 Завантажити KMZ/KML</h1>
    <div class="muted">Перетягни файл сюди або клікни. Бекенд віддасть його мапі через CORS.</div>

    <label class="drop" id="drop">
      <input type="file" id="file" accept=".kmz,.kml" />
      <strong>Перетягни файл сюди</strong>
      <div class="muted">або клікни, щоб обрати</div>
    </label>

    <div class="status" id="status">Очікую файл…</div>

    <div class="status" style="margin-top:18px;">
      <strong>Поточний файл:</strong><br>
      <span id="curName">{{STATUS}}</span>
    </div>

    <p style="margin-top:18px;">
      <a href="/" class="btn">← До мапи</a>
    </p>
  </div>

  <script>
    const TOKEN = '{{TOKEN}}';
    const drop = document.getElementById('drop');
    const fileInput = document.getElementById('file');
    const statusEl = document.getElementById('status');

    async function upload(file) {
      statusEl.className = 'status';
      statusEl.textContent = 'Завантаження ' + file.name + '…';
      const fd = new FormData();
      fd.append('file', file);
      try {
        const headers = {};
        if (TOKEN) headers['X-Admin-Token'] = TOKEN;
        const r = await fetch('/upload', { method: 'POST', body: fd, headers });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
        statusEl.className = 'status ok';
        statusEl.textContent = '✅ ' + file.name + ' (' + j.size + ' байт) — фронт оновлено через WS';
        setTimeout(() => location.reload(), 1500);
      } catch (e) {
        statusEl.className = 'status err';
        statusEl.textContent = '❌ ' + e.message;
      }
    }

    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) upload(e.target.files[0]);
    });
    ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.add('drag');
    }));
    ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.remove('drag');
    }));
    drop.addEventListener('drop', (e) => {
      if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
    });
  </script>
</body>
</html>`;
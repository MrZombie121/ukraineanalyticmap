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

const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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

// ============ Helpers: history ============

// Список усіх зрізів: [{ date: 'YYYY-MM-DD', files: [{time, name, size, mtime}] }]
function readHistory() {
  const out = [];
  if (!fs.existsSync(HISTORY_DIR)) return out;
  const dates = fs.readdirSync(HISTORY_DIR).sort().reverse();
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const dayDir = path.join(HISTORY_DIR, d);
    if (!fs.statSync(dayDir).isDirectory()) continue;
    const slots = fs.readdirSync(dayDir).sort();
    const files = [];
    for (const slot of slots) {
      const slotDir = path.join(dayDir, slot);
      if (!fs.statSync(slotDir).isDirectory()) continue;
      for (const f of fs.readdirSync(slotDir)) {
        if (!/\.(kmz|kml)$/i.test(f)) continue;
        const fp = path.join(slotDir, f);
        const st = fs.statSync(fp);
        files.push({
          time: slot,                    // HH-MM
          name: f,
          size: st.size,
          mtime: st.mtimeMs,
          relPath: path.posix.join(d, slot, f),
        });
      }
    }
    if (files.length) {
      // Показуємо найпізніший зріз дня як "свіжий" — sort за mtime
      files.sort((a, b) => b.mtime - a.mtime);
      out.push({ date: d, latest: files[0], count: files.length, files });
    }
  }
  return out;
}

function readCurrent() {
  // current.json: { relPath, mtime, originalName, uploadedAt }
  try {
    if (!fs.existsSync(CURRENT_POINTER)) return null;
    return JSON.parse(fs.readFileSync(CURRENT_POINTER, 'utf8'));
  } catch { return null; }
}

function writeCurrent(meta) {
  fs.writeFileSync(CURRENT_POINTER, JSON.stringify(meta, null, 2));
}

function getKmzFilePath(date) {
  // date = 'YYYY-MM-DD' або null (тоді — поточний)
  if (date) {
    const dayDir = path.join(HISTORY_DIR, date);
    if (!fs.existsSync(dayDir)) return null;
    // Беремо останній зріз у цій даті
    const slots = fs.readdirSync(dayDir).sort();
    for (let i = slots.length - 1; i >= 0; i--) {
      const slotDir = path.join(dayDir, slots[i]);
      if (!fs.statSync(slotDir).isDirectory()) continue;
      const f = fs.readdirSync(slotDir).find(x => /\.(kmz|kml)$/i.test(x));
      if (f) return { path: path.join(slotDir, f), relPath: path.posix.join(date, slots[i], f) };
    }
    return null;
  }
  // Поточний
  const cur = readCurrent();
  if (cur && cur.relPath) {
    const p = path.join(HISTORY_DIR, cur.relPath);
    if (fs.existsSync(p)) return { path: p, relPath: cur.relPath };
  }
  // Legacy fallback
  if (fs.existsSync(KMZ_PATH)) return { path: KMZ_PATH, relPath: null };
  for (const p of FALLBACK_PATHS) {
    if (fs.existsSync(p)) return { path: p, relPath: null };
  }
  return null;
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
app.get('/api/history', (_req, res) => {
  res.json({ history: readHistory(), current: readCurrent() });
});

// ============ KMZ serve ============
function sendKmz(req, res, filePath) {
  if (!filePath) {
    return res.status(404).json({ error: 'Зріз не знайдено. Завантажте файл через /admin' });
  }
  try {
    const stat = fs.statSync(filePath);
    const buf = fs.readFileSync(filePath);
    const ext = filePath.toLowerCase();
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
    console.log(`[kmz] served ${path.basename(filePath)} (${buf.length} байт)`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Звичайний /kmz — поточний (back-compat)
app.get('/kmz', (_req, res) => {
  const f = getKmzFilePath(null);
  if (!f) return res.status(404).json({ error: 'Жоден KMZ не знайдено' });
  sendKmz(_req, res, f.path);
});
app.head('/kmz', (_req, res) => {
  const f = getKmzFilePath(null);
  if (!f) return res.status(404).end();
  res.set({ 'Content-Type': 'application/vnd.google-earth.kmz' });
  res.status(200).end();
});

// API з параметром date
app.get('/api/kmz', (req, res) => {
  const date = req.query.date || null;
  const f = getKmzFilePath(date);
  if (!f) return res.status(404).json({ error: date ? `Зріз за ${date} не знайдено` : 'Жоден KMZ не знайдено' });
  sendKmz(req, res, f.path);
});

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

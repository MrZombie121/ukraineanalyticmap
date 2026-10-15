// Швидка перевірка: чи бекенд вміє качати KML з Google
process.env.GOOGLE_MAPS_MID = '1E7cefbjfT33zErTQADATnyZ_SVChrJc';
process.env.GOOGLE_FETCH_MIN = '0';  // вимкнути цикл
process.env.PORT = '3901';

// Підміняємо функції, які стосуються сервера — нам не треба listen()
const path = require('path');
const fs = require('fs');
const f = path.join(__dirname, 'server.js');
const code = fs.readFileSync(f, 'utf8');
// Вирізаємо server.listen(...) і WebSocketServer — нам потрібні тільки функції sync
const trimmed = code.replace(/server\.listen[\s\S]*?\}\);/m, '/* listen skipped */')
                     .replace(/new WebSocketServer[\s\S]*?\}\);/m, '/* wss skipped */');
const Module = require('module');
const m = new Module();
m._compile(trimmed + '\nmodule.exports = { syncFromGoogle: typeof syncFromGoogle !== "undefined" ? syncFromGoogle : null };', f);

(async () => {
  try {
    const exported = m.exports;
    // syncFromGoogle — локальна в модулі, тому дістанемо через eval
    const fn = (function() {
      try { return eval('typeof syncFromGoogle === "function" ? syncFromGoogle : null'); }
      catch { return null; }
    })();
    if (!fn) { console.log('NO syncFromGoogle — функція не експортована'); process.exit(1); }
    const r = await fn('smoke');
    console.log('RESULT:', JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error('SMOKE ERR:', e.message);
    process.exit(2);
  }
})();

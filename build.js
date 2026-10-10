/* ============================================================
 * Fronty Map — build script
 * Копіює index.html, app.js, style.css, favicon.svg, vercel.json
 * у ./build/ для Render Static Site.
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BUILD = path.join(ROOT, 'build');

// Файли, які потраплять у build/
const FILES = [
  'index.html',
  'app.js',
  'style.css',
  'favicon.svg',
  'vercel.json',
];

// Очищаємо build/
if (fs.existsSync(BUILD)) {
  fs.rmSync(BUILD, { recursive: true, force: true });
}
fs.mkdirSync(BUILD, { recursive: true });

let copied = 0;
for (const file of FILES) {
  const src = path.join(ROOT, file);
  const dst = path.join(BUILD, file);
  if (!fs.existsSync(src)) {
    console.warn(`⚠️  Пропущено (немає): ${file}`);
    continue;
  }
  fs.copyFileSync(src, dst);
  copied++;
  console.log(`✅ ${file}`);
}

console.log('');
console.log(`🎉 Зібрано ${copied} файлів у ./build/`);
console.log('   Запусти: npx serve build -l 3000  — щоб перевірити');
# Fronty Map 🗺️📏

Інтерактивна супутникова мапа з **фронтом**, **лінійкою**, **пошуком** і кліком
по об'єктах. Фронт імпортується з `front.kmz`, який ти кладеш у папку проєкту
або на віддалений URL.

## Швидкий старт (локально)

1. Поклади `Ukraine Analystic Map UAM.kmz` (або `front.kmz` / `front.kml`) у цю папку
2. Відкрий `index.html` у браузері — або запусти dev-сервер:
   ```powershell
   npx serve .
   ```
3. Працюй. Точки/лінії/полігони з'являться автоматично.

## Що є

- 🛰️ **4 базових шари**: супутник Esri, схема, топо, Google (через ключ)
- 📏 **Лінійка** з per-segment і загальною відстанню (клік → клік → подвійний клік)
- 🔍 **Пошук** Nominatim (адреси + координати)
- 🗺️ **Імпорт KML/KMZ** — точка, лінія, полігон, MultiGeometry, ExtendedData
- 🎨 **Стилі з KML** — колір ліній, іконки (навіть з gstatic, через canvas)
- 🔎 **Клік по об'єкту** — попап з name, description, колонками ExtendedData
- 🔄 **Автооновлення** кожні N хвилин (за замовчуванням 10)
- 🔵 **TG-кнопка** праворуч знизу

## Як задеплоїти на Render

1. Створи репо на GitHub і запуш туди вміст цієї папки
   ```powershell
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/ТВІЙ_ЮЗЕР/fronty-map.git
   git push -u origin main
   ```
2. На [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints) →
   **New Blueprint Instance** → обери репо
3. Render знайде `render.yaml` і створить Static Site автоматично
4. **Кожен `git push` = новий деплой** (за ~30 секунд)

Альтернатива (без Blueprint):
- **New → Static Site** → підключи репо → Publish Directory: `.` →
  Build Command: порожньо → Create

## Як задеплоїти на Vercel

### Варіант A: GitHub → Vercel (найпростіший)

1. Створи репо на GitHub і запуш туди вміст цієї папки
   ```powershell
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/ТВІЙ_ЮЗЕР/fronty-map.git
   git push -u origin main
   ```
2. На [vercel.com/new](https://vercel.com/new) — `Import Project` → обери репо
3. Vercel автоматично розпізнає статику і задеплоїть
4. **Кожен `git push` = новий деплой** (без CI, за 30 секунд)

### Варіант B: Vercel CLI (без GitHub)

```powershell
npm i -g vercel
vercel login
vercel        # dev deploy (тестовий URL)
vercel --prod # production
```

### Варіант C: через Vercel Dashboard
Перетягни папку `D:\Uas FRONTY` в [vercel.com/new](https://vercel.com/new) →
`Deploy`.

## Як оновлювати фронт

### Локальний KMZ (файл у папці)
- Заміни `Ukraine Analystic Map UAM.kmz` → натисни «Перезавантажити» на мапі
- Або чекай — кожні 10 хв мапа сама підтягне свіжу версію
- На Vercel: запуш новий файл у репо → Vercel автоматично передеплоїть

### Віддалений URL (R2 / Dropbox / GitHub raw)
Відкрий `app.js`, рядок з константою, і встав свій URL:

```js
// Наприклад:
const FRONT_REMOTE_URL = 'https://my-bucket.r2.dev/Ukraine%20Analystic%20Map%20UAM.kmz';
// або
const FRONT_REMOTE_URL = 'https://raw.githubusercontent.com/USER/REPO/main/Ukraine%20Analystic%20Map%20UAM.kmz';
// або Dropbox (URL має закінчуватись на ?raw=1):
const FRONT_REMOTE_URL = 'https://www.dropbox.com/s/xxx/Ukraine%20Analystic%20Map%20UAM.kmz?raw=1';
```

Потім зроби `git push` → Vercel передеплоїть.

**CORS:** R2, GitHub raw, S3 — віддають CORS-заголовки за замовчуванням.
Dropbox — теж (`?raw=1` додає правильні заголовки). Google Cloud Storage — ні,
треба налаштувати CORS у bucket.

## Google Maps (опціонально)

Якщо хочеш справжній Google Maps як базовий шар — встав свій API-ключ у `app.js`:

```js
const GOOGLE_MAPS_API_KEY = 'AIzaSy...';
```

Отримати ключ: https://console.cloud.google.com → Maps JavaScript API →
Enable → Credentials → Restrict by HTTP referrer (твій домен на Vercel).

## Де взяти KML/KMZ з Google Maps

1. Відкрий [Google My Maps](https://mymaps.google.com) → свою мапу
2. Меню (3 крапки біля назви) → **Експорт → KML/KMZ**
3. Обери **«Експортувати як .KML»** або **.KMZ** (KMZ — це KML у ZIP)
4. Збережи як `Ukraine Analystic Map UAM.kmz` у цій папці
5. Онов сторінку

## Як це працює

```
┌─────────────────────────────────────────────────┐
│  index.html  ──► Leaflet (карта)                 │
│  style.css   ──► темна/світла теми, скляні картки │
│  app.js      ──► парсер KML, лінійка, пошук      │
│  Ukraine Analystic Map UAM.kmz   ──► дані про фронт │
└─────────────────────────────────────────────────┘
```

Жодного бекенду. Жодного API-ключа (крім опціонального Google). Все відкрито.

## Ліцензія

MIT — бери, змінюй, поширюй. Slug Ukraine 🇺🇦
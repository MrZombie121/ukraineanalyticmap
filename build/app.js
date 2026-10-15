/* ============================================================
 * Fronty Map
 * - 4 базових шари (Esri Sat/Road/Topo + Google через ключ)
 * - Лінійка з per-segment
 * - Пошук Nominatim
 * - Імпорт KML: автоматично через проксі + ручне завантаження файлу/KMZ
 *   + клік по об'єкту з попапом (назва + опис + центр)
 * ============================================================ */

(function () {
  'use strict';

  // ============================================================
  //  Утиліти
  // ============================================================
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('script,style,iframe,object,embed').forEach(n => n.remove());
    tpl.content.querySelectorAll('*').forEach(n => {
      Array.from(n.attributes).forEach(a => {
        if (/^on/i.test(a.name)) n.removeAttribute(a.name);
        if ((a.name === 'href' || a.name === 'src') && /^javascript:/i.test(a.value)) n.removeAttribute(a.name);
      });
    });
    tpl.content.querySelectorAll('a').forEach(a => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
    return tpl.innerHTML;
  }

  // Простий розпакувальник ZIP (для KMZ). Підтримує STORE (без стиснення) і DEFLATE.
  // Бо довантажувати JSZip раді одного KMZ — занадто.
  async function unzipKmz(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    // Шукаємо PK\x03\x04 (Local file header) і збираємо всі файли
    const files = {};
    let off = 0;
    while (off < u8.length - 4) {
      if (u8[off] !== 0x50 || u8[off+1] !== 0x4B || u8[off+2] !== 0x03 || u8[off+3] !== 0x04) break;
      const method = dv.getUint16(off + 8, true);   // 0=STORE, 8=DEFLATE
      const compSize = dv.getUint32(off + 18, true);
      const uncompSize = dv.getUint32(off + 22, true);
      const nameLen = dv.getUint16(off + 26, true);
      const extraLen = dv.getUint16(off + 28, true);
      const name = new TextDecoder().decode(u8.subarray(off + 30, off + 30 + nameLen));
      const dataStart = off + 30 + nameLen + extraLen;
      const compData = u8.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) {
        data = compData;
      } else if (method === 8) {
        // inflate через CompressionStream (підтримується у всіх сучасних браузерах)
        const stream = new Response(new Blob([compData]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
        data = new Uint8Array(await stream);
      } else {
        throw new Error('Невідомий метод стиснення ZIP: ' + method);
      }
      files[name] = data;
      off = dataStart + compSize;
      // Перевірка на DataDescriptor (optional)
      if (u8[off] === 0x50 && u8[off+1] === 0x4B && u8[off+2] === 0x07 && u8[off+3] === 0x08) {
        off += 12 + compSize; // skip descriptor
      }
    }
    // Шукаємо .kml всередині
    const kmlName = Object.keys(files).find(n => n.toLowerCase().endsWith('.kml'));
    if (!kmlName) throw new Error('У KMZ не знайдено .kml');
    return new TextDecoder('utf-8').decode(files[kmlName]);
  }

  // ============================================================
  //  GOOGLE MAPS (опціонально)
  // ============================================================
  const GOOGLE_MAPS_API_KEY = '';
  function loadGoogleMaps(key) {
    if (!key) return Promise.resolve(null);
    if (window.google && window.google.maps) return Promise.resolve(window.google);
    return new Promise((resolve, reject) => {
      const cb = '__gmapsReady';
      window[cb] = () => resolve(window.google);
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&callback=${cb}`;
      s.async = true; s.defer = true;
      s.onerror = () => reject(new Error('Не вдалося завантажити Google Maps API'));
      document.head.appendChild(s);
    });
  }

  // ============================================================
  //  КАРТА
  // ============================================================
  // Центр України (Київ) — стартова точка за замовчуванням.
  // Можна перевизначити через URL hash (#z=6&lat=50.45&lng=30.52)
  function readHashView() {
    const m = location.hash.match(/(?:^#|[&#])z=(\d+(?:\.\d+)?)/);
    const la = location.hash.match(/lat=(-?\d+(?:\.\d+)?)/);
    const ln = location.hash.match(/lng=(-?\d+(?:\.\d+)?)/);
    return {
      zoom: m ? parseFloat(m[1]) : 6,
      lat: la ? parseFloat(la[1]) : 50.4501,
      lng: ln ? parseFloat(ln[1]) : 30.5234,
    };
  }
  function writeHashView() {
    const c = map.getCenter();
    const z = map.getZoom().toFixed(2);
    const lat = c.lat.toFixed(5);
    const lng = c.lng.toFixed(5);
    const h = `#z=${z}&lat=${lat}&lng=${lng}`;
    if (location.hash !== h) {
      history.replaceState(null, '', h);
    }
  }
  const initialView = readHashView();
  const map = L.map('map', {
    center: [initialView.lat, initialView.lng],
    zoom: initialView.zoom,
    minZoom: 2,
    maxZoom: 19,
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: true,
    inertia: true,
    wheelPxPerZoomLevel: 90,
    fadeAnimation: true,
    zoomAnimation: true,
  });

  const baseOpts = { crossOrigin: true, maxNativeZoom: 18, keepBuffer: 6 };
  // Esri World Imagery — супутникові знімки
  const layerSatellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { ...baseOpts, maxZoom: 19, attribution: 'Tiles © Esri' }
  );
  // Esri World Street — класична схема
  const layerRoadmap = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    { ...baseOpts, maxZoom: 19, attribution: 'Tiles © Esri' }
  );
  // Google Terrain (рельєф) — справжні тайли Google без API-ключа.
  // lyrs=p — terrain (рельєф, горизонталі), додаємо ,m — написи міст і дороги поверх.
  // {s} — Leaflet підставляє subdomain.
  const layerTerrain = L.tileLayer(
    'https://{s}.google.com/vt/lyrs=p,m&x={x}&y={y}&z={z}',
    {
      ...baseOpts,
      maxZoom: 20,
      attribution: '© Google',
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    }
  );
  // Google Maps Standard (схема) — lyrs=m
  const layerGoogle = L.tileLayer(
    'https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
    {
      ...baseOpts,
      maxZoom: 20,
      attribution: '© Google',
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    }
  );
  // Google Maps Dark — lyrs=h (тільки дорожня сітка на темному фоні, як у Google Maps Dark).
  // Це публічний tile endpoint, без API-ключа (SkywatchUA так само робить).
  const layerDark = L.tileLayer(
    'https://{s}.google.com/vt/lyrs=h&x={x}&y={y}&z={z}',
    {
      ...baseOpts,
      maxZoom: 20,
      attribution: '© Google',
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    }
  );
  const layers = { satellite: layerSatellite, roadmap: layerRoadmap, terrain: layerTerrain, google: layerGoogle, dark: layerDark };
  layers.satellite.addTo(map);
  let activeKey = 'satellite';

  // Відстежуємо, чи користувач вже взаємодіяв з мапою (рухав/зумив).
  // Поки ні — flyToBounds при першому applyKmlText дозволено.
  let userTouchedMap = false;
  map.on('movestart zoomstart', () => {
    if (hashWriteTimer) userTouchedMap = true;
  });

  function switchLayer(key) {
    if (key === activeKey && layers[key]) return;
    Object.entries(layers).forEach(([k, l]) => {
      if (l && map.hasLayer(l)) map.removeLayer(l);
    });
    if (layers[key]) {
      layers[key].addTo(map);
    }
    activeKey = key;
    document.querySelectorAll('.ls-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.style === key);
    });
    map.invalidateSize();
  }
  document.querySelectorAll('.ls-btn').forEach(btn => {
    btn.addEventListener('click', () => switchLayer(btn.dataset.style));
  });

  function fixSize() { map.invalidateSize(); }
  setTimeout(fixSize, 50);
  setTimeout(fixSize, 300);
  window.addEventListener('resize', fixSize);
  window.addEventListener('load', fixSize);

  // Зберігаємо поточний вид у URL hash, щоб при перезавантаженні лишитися
  // на тому ж місці (з невеликою затримкою, щоб не смикати адресний рядок).
  let hashWriteTimer = null;
  function scheduleHashUpdate() {
    if (hashWriteTimer) clearTimeout(hashWriteTimer);
    hashWriteTimer = setTimeout(writeHashView, 250);
  }
  map.on('moveend zoomend', scheduleHashUpdate);
  // Записати одразу, щоб адреса відповідала реальному виду
  setTimeout(writeHashView, 500);

  // ============================================================
  //  KML: парсер + рендер
  // ============================================================
  const KML_MID = '1E7cefbjfT33zErTQADATnyZ_SVChrJc';

  // Віддалений URL твого KMZ. Залиш порожнім '', якщо кладеш файл локально.
  // Приклади:
  //   'https://pub-xxxxxx.r2.dev/kmzfile/Ukraine%20Analystic%20Map%20UAM.kmz'
  //   'https://my-bucket.r2.dev/front.kmz'
  //   'https://raw.githubusercontent.com/USER/REPO/main/front.kmz'
  const FRONT_REMOTE_URL = ''; // <- визначається автоматично через BACKEND_URL

  // Інтервал автооновлення (хвилини). 0 = вимкнено.
  const FRONT_REFRESH_MIN = 5;

  // URL бекенда — автоматично визначає:
  // 1. window.__BACKEND_URL__ якщо задано вручну (override)
  //    ДОДАЙ В HTML перед app.js:
  //    <script>window.__BACKEND_URL__ = 'https://api.uaanalyticmap.pp.ua';</script>
  // 2. Якщо override не задано — для .pp.ua/.com тощо: api.<поточний-хост>
  // 3. На Render: <name>-backend.onrender.com
  // 4. http://localhost:3001 для локальної розробки
  const BACKEND_URL = (() => {
    const override = (typeof window !== 'undefined' && window.__BACKEND_URL__) || '';
    if (override) return override.replace(/\/+$/, '');
    if (typeof window !== 'undefined') {
      const host = window.location.hostname;
      if (!host) return 'http://localhost:3001';
      if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:3001';
      if (host.endsWith('.onrender.com')) {
        const base = host.replace('.onrender.com', '');
        return `https://${base}-backend.onrender.com`;
      }
      // Для кастомних доменів (pp.ua, com, тощо) — автоматично api.<домен>
      return `${window.location.protocol}//api.${host}`;
    }
    return 'http://localhost:3001';
  })();

  const BACKEND_WS = BACKEND_URL.replace(/^http/, 'ws') + '/ws';

  // ========== Стан шарів (Folders з KML) ==========
  const layerState = { kmlLayers: [] };
  function isLayerEnabled(name) {
    const l = layerState.kmlLayers.find(x => x.name === name);
    return l ? !!l.enabled : true;
  }
  function toggleLayer(name, on) {
    const l = layerState.kmlLayers.find(x => x.name === name);
    if (l) { l.enabled = !!on; applyLayerVisibility(); renderLayerPanel(); }
  }
  function applyLayerVisibility() {
    if (!frontState.layer) return;
    frontState.layer.eachLayer(l => {
      if (!l || !l._frontItem) return;
      const ln = l._frontItem._layer || '(Корінь)';
      const want = isLayerEnabled(ln);
      if (want) { if (!map.hasLayer(l)) l.addTo(map); }
      else { if (map.hasLayer(l)) map.removeLayer(l); }
    });
  }
  function renderLayerPanel() {
    const el = document.getElementById('layerPanelList');
    const lc = document.getElementById('layerCount');
    if (lc) lc.textContent = String(layerState.kmlLayers.length);
    if (!el) return;
    if (!layerState.kmlLayers.length) {
      el.innerHTML = '<div class="muted" style="padding:8px 0;font-size:0.82rem;">KML не містить шарів</div>';
      return;
    }
    el.innerHTML = layerState.kmlLayers.map(l => {
      const checked = l.enabled ? 'checked' : '';
      const eye = l.enabled ? '👁' : '🚫';
      return '<label class="layer-row">' +
        '<input type="checkbox" data-layer="' + escapeHtml(l.name) + '" ' + checked + '>' +
        '<span class="layer-eye">' + eye + '</span>' +
        '<span class="layer-name">' + escapeHtml(l.name) + '</span>' +
        '<span class="layer-count">' + l.count + '</span>' +
        '</label>';
    }).join('');
    el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => toggleLayer(cb.dataset.layer, cb.checked));
    });
  }
  function setupLayerPanel() {
    const tog = document.getElementById('layerToggle');
    const body = document.getElementById('layerPanelList');
    if (!tog) return;
    tog.addEventListener('click', () => {
      const exp = tog.getAttribute('aria-expanded') === 'true';
      tog.setAttribute('aria-expanded', String(!exp));
      if (body) body.style.display = exp ? 'none' : 'block';
    });
  }

  // ========== Вибір дати (зріз фронту) ==========
  let currentDate = null;
  async function loadDateList() {
    const body = document.getElementById('dateBody');
    if (!body) return;
    try {
      const r = await fetch(BACKEND_URL + '/api/history', { cache: 'no-store' });
      const j = await r.json();
      renderDateList(j.history || [], j.current || null);
    } catch (e) {
      body.innerHTML = '<div class="muted" style="padding:6px 2px;font-size:0.78rem;color:#fda4af;">Бекенд недоступний</div>';
    }
  }
  function renderDateList(history, current) {
    const body = document.getElementById('dateBody');
    const head = document.getElementById('dateCurrent');
    const panel = document.getElementById('datePanel');
    if (!body) return;
    if (!history.length) {
      if (panel) panel.style.display = 'none';
      return;
    }
    if (panel) panel.style.display = 'block';
    const currentRel = (current && current.relPath) || '';
    let shownDate;
    if (currentDate) shownDate = currentDate;
    else if (currentRel) shownDate = currentRel.split('/')[0];
    else shownDate = history[0].date;
    if (head) head.textContent = shownDate;
    const items = ['<div class="dp-item" data-date="">' +
      '<span>📅</span><span class="dp-date">Останній доступний</span>' +
      (currentDate === null ? ' <span style="color:#7dd3fc;">●</span>' : '') +
      '</div>'];
    for (const day of history) {
      for (const f of day.files) {
        const isCur = f.relPath === currentRel;
        items.push('<div class="dp-item ' + (currentDate === day.date ? 'is-current' : '') + '" data-date="' + day.date + '">' +
          '<span>📄</span>' +
          '<span class="dp-date">' + day.date + ' · ' + f.time + '</span>' +
          (isCur && currentDate === null ? ' <span style="color:#7dd3fc;">●</span>' : '') +
          '</div>');
      }
    }
    body.innerHTML = items.join('');
    body.querySelectorAll('.dp-item').forEach(el => {
      el.addEventListener('click', () => {
        currentDate = el.dataset.date || null;
        document.getElementById('dateToggle').setAttribute('aria-expanded', 'false');
        body.setAttribute('hidden', '');
        loadFrontAuto(true);
        renderDateList(history, current);
      });
    });
  }
  function setupDatePanel() {
    const tog = document.getElementById('dateToggle');
    const body = document.getElementById('dateBody');
    if (!tog || !body) return;
    tog.addEventListener('click', () => {
      const exp = tog.getAttribute('aria-expanded') === 'true';
      tog.setAttribute('aria-expanded', String(!exp));
      if (exp) body.setAttribute('hidden', ''); else body.removeAttribute('hidden');
    });
    loadDateList();
  }

  const frontState = {
    enabled: true,
    layer: null,
    features: [],
    bounds: null,
  };

  const fToggle = document.getElementById('frontToggle');
  const fReload = document.getElementById('frontReload');
  const fFit = document.getElementById('frontFit');
  const fCount = document.getElementById('frontCount');
  const fStatus = document.getElementById('frontStatus');

  function setStatus(text, kind = '') {
    if (!text) { fStatus.setAttribute('hidden', ''); return; }
    fStatus.removeAttribute('hidden');
    fStatus.className = 'front-status' + (kind ? ' ' + kind : '');
    fStatus.innerHTML = `<span class="spinner"></span><span>${escapeHtml(text)}</span>`;
  }
  function clearStatus() { setStatus(''); }

  function setFrontEnabled(on) {
    frontState.enabled = on;
    fToggle.classList.toggle('off', !on);
    fToggle.setAttribute('aria-pressed', String(on));
    if (frontState.layer) {
      if (on) frontState.layer.addTo(map);
      else map.removeLayer(frontState.layer);
    }
  }

  // Парсер KML — повертає { placemarks, layers }
  function parseKML(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const errNode = doc.querySelector('parsererror');
    if (errNode) throw new Error('Не вдалося розпарсити KML');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'kml') {
      throw new Error('Кореневий тег не <kml>');
    }
    const styles = {};
    doc.querySelectorAll('Style, StyleMap').forEach(s => {
      const id = s.getAttribute('id');
      if (id) styles[id] = s;
    });
    const allPlacemarks = [];
    const layers = [];
    collectPlacemarks(root, styles, '(Корінь)', allPlacemarks, layers);
    return { placemarks: allPlacemarks, layers };
  }

  function collectPlacemarks(node, styles, layerName, out, layers) {
    Array.from(node.children).forEach(child => {
      const tag = child.nodeName.toLowerCase();
      if (tag === 'placemark') {
        const item = readPlacemark(child, styles);
        item._layer = layerName;
        out.push(item);
      } else if (tag === 'folder') {
        const folderName = textOf(child, 'name') || 'Без назви';
        const before = out.length;
        const subLayers = [];
        collectPlacemarks(child, styles, folderName, out, subLayers);
        const count = out.length - before;
        if (count > 0) layers.push({ name: folderName, count, enabled: true });
        for (const sl of subLayers) layers.push(sl);
      } else if (tag === 'document') {
        collectPlacemarks(child, styles, layerName, out, layers);
      } else if (tag === 'networklink') {
        const href = child.querySelector('Link > href, link > href');
        if (href) console.log('[Fronty] NetworkLink →', href.textContent.trim());
      }
    });
  }

  function textOf(node, tag) {
    const el = Array.from(node.children).find(c => c.nodeName.toLowerCase() === tag.toLowerCase());
    return el ? el.textContent.trim() : '';
  }

  // Резолв styleUrl -> реальний Style (або StyleMap -> нормал)
  function resolveStyle(styleUrl, styles) {
    if (!styleUrl) return null;
    const ref = styleUrl.replace(/^#/, '');
    const s = styles[ref];
    if (!s) return null;
    // StyleMap -> Pair key="normal"
    if (s.nodeName.toLowerCase() === 'stylemap') {
      const pair = Array.from(s.querySelectorAll('Pair')).find(p => p.getAttribute('key') === 'normal') || s.querySelector('Pair');
      if (pair) {
        const u = pair.querySelector('styleUrl');
        if (u) return resolveStyle('#' + u.textContent.trim().replace(/^#/, ''), styles);
      }
    }
    return s;
  }

  function readPlacemark(node, styles) {
    const name = textOf(node, 'name') || 'Без назви';
    const descriptionHtml = textOf(node, 'description') || '';
    const snippet = textOf(node, 'Snippet') || '';
    // ExtendedData — для Google Maps "опис"/"назва" колонок
    let extraFields = [];
    const ext = node.querySelector('ExtendedData');
    if (ext) {
      Array.from(ext.children).forEach(d => {
        if (d.nodeName.toLowerCase() !== 'data') return;
        const n = d.getAttribute('name') || '';
        const v = d.querySelector('value');
        // Додаємо поле завжди (навіть з порожнім value), щоб у попапі
        // користувач бачив структуру шаблону з Google My Maps.
        const value = v ? v.textContent.trim() : '';
        extraFields.push({ name: n, value });
      });
    }

    const geometry = [];
    const geoms = ['Point', 'LineString', 'Polygon', 'MultiGeometry'];
    geoms.forEach(g => {
      node.querySelectorAll(g).forEach(gNode => {
        if (g === 'MultiGeometry') {
          ['Point', 'LineString', 'Polygon'].forEach(inner => {
            gNode.querySelectorAll(inner).forEach(n => geometry.push({ kind: inner.toLowerCase(), node: n }));
          });
        } else {
          geometry.push({ kind: g.toLowerCase(), node: gNode });
        }
      });
    });

    // Стиль
    let iconHref = null, lineColor = null, polyColor = null, lineWidth = null, polyFill = null;
    let iconColor = null; // aabbggrr
    const styleUrl = node.querySelector(':scope > styleUrl');
    const inlineStyle = node.querySelector(':scope > Style');
    const styleNode = styleUrl ? resolveStyle(styleUrl.textContent.trim(), styles) : inlineStyle;

    if (styleNode) {
      // IconStyle
      const iconStyle = styleNode.querySelector('IconStyle');
      if (iconStyle) {
        const href = iconStyle.querySelector('Icon href');
        if (href) iconHref = href.textContent.trim();
        const colorEl = iconStyle.querySelector('color');
        if (colorEl) iconColor = colorEl.textContent.trim();
      }
      // LineStyle
      const ls = styleNode.querySelector('LineStyle');
      if (ls) {
        const c = ls.querySelector('color');
        if (c) lineColor = parseKmlColor(c.textContent);
        const w = ls.querySelector('width');
        if (w) lineWidth = parseFloat(w.textContent) || 3;
      }
      // PolyStyle
      const ps = styleNode.querySelector('PolyStyle');
      if (ps) {
        const c = ps.querySelector('color');
        if (c) polyColor = parseKmlColor(c.textContent);
        const fill = ps.querySelector('fill');
        if (fill) polyFill = fill.textContent.trim() === '1';
      }
    }

    return { name, descriptionHtml, snippet, extraFields, geometry, iconHref, iconColor, lineColor, polyColor, polyFill, lineWidth };
  }

  // KML color: aabbggrr -> rgba
  function parseKmlColor(c) {
    if (!c) return null;
    let s = c.trim();
    if (s.length < 7) return s;
    if (s.length === 7) s = 'ff' + s.slice(1);
    const a = parseInt(s.slice(0, 2), 16) / 255;
    const b = parseInt(s.slice(2, 4), 16);
    const g = parseInt(s.slice(4, 6), 16);
    const r = parseInt(s.slice(6, 8), 16);
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
  }

  function readCoords(node) {
    const cs = Array.from(node.children).find(c => c.nodeName.toLowerCase() === 'coordinates');
    if (!cs) return [];
    return cs.textContent.trim().split(/\s+/).map(t => {
      const [lon, lat] = t.split(',').map(Number);
      return [lat, lon];
    }).filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));
  }

  // Парсимо рядок кольору KML (aabbggrr) у hex для Leaflet
  function colorToHex(rgba) {
    if (!rgba) return null;
    const m = rgba.match(/rgba?\(([^)]+)\)/);
    if (!m) return rgba;
    const [r, g, b] = m[1].split(',').map(s => parseInt(s.trim()));
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  // Витягує URL фото з опису (або з ExtraFields, якщо value — це картинка).
  // Повертає масив {src, alt}[].
  function extractPhotoUrls(item) {
    const urls = [];
    // 1. <img src="..."> в <description>
    if (item.descriptionHtml) {
      const re = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(item.descriptionHtml)) !== null) {
        urls.push({ src: m[1], alt: item.name });
      }
    }
    // 2. Поле типу "фото" / "photo" / "image" з URL-значенням
    if (item.extraFields) {
      item.extraFields.forEach(f => {
        if (!f.value) return;
        const v = f.value.trim();
        if (/^https?:\/\/\S+\.(?:jpe?g|png|gif|webp|avif|bmp|svg)(\?|$)/i.test(v)) {
          if (!urls.some(u => u.src === v)) urls.push({ src: v, alt: f.name || item.name });
        }
      });
    }
    // 3. Якщо в ExtraFields значення — це просто URL без розширення, але ім'я поля канонічне
    if (item.extraFields && !urls.length) {
      const photoField = item.extraFields.find(f => /^(фото|photo|img|image|малюнок)/i.test(f.name || ''));
      if (photoField && /^https?:\/\//i.test(photoField.value.trim())) {
        urls.push({ src: photoField.value.trim(), alt: item.name });
      }
    }
    return urls;
  }

  function buildPopupHtml(item) {
    // Фото — витягуємо окремо, без санітизації (щоб не зламати <img>)
    const photos = extractPhotoUrls(item);
    const photosHtml = photos.length
      ? `<div class="pop-photos">${photos.map(p => `<a href="${escapeHtml(p.src)}" target="_blank" rel="noopener"><img src="${escapeHtml(p.src)}" alt="${escapeHtml(p.alt)}" loading="lazy" onerror="this.parentNode.style.display='none'"></a>`).join('')}</div>`
      : '';

    // ExtendedData — формуємо красиву таблицю, але прибираємо поле з URL фото,
    // бо воно вже показане як зображення. Поля з порожнім value ігноруємо
    // повністю (інакше таблиця забивається прочерками).
    const photoSrcs = new Set(photos.map(p => p.src));
    const filteredExtras = (item.extraFields || []).filter(f =>
      f.value && f.value.trim() && !photoSrcs.has(f.value.trim())
    );
    let extraHtml = '';
    if (filteredExtras.length) {
      const rows = filteredExtras
        .map(f => {
          const v = f.value.trim();
          // Якщо значення — це URL (не фото), показуємо як лінк
          if (/^https?:\/\//i.test(v)) {
            const linkText = v.length > 50 ? v.slice(0, 47) + '…' : v;
            return `<tr><td>${escapeHtml(f.name)}</td><td><a href="${escapeHtml(v)}" target="_blank" rel="noopener">${escapeHtml(linkText)}</a></td></tr>`;
          }
          return `<tr><td>${escapeHtml(f.name)}</td><td>${escapeHtml(v)}</td></tr>`;
        }).join('');
      if (rows) extraHtml = `<table class="pop-ext">${rows}</table>`;
    }

    // Опис — санітизуємо, АЛЕ прибираємо <img> (вже вище показали як фото)
    let desc = item.descriptionHtml ? sanitizeHtml(item.descriptionHtml) : '';
    desc = desc.replace(/<img\b[^>]*>/gi, '');

    const meta = [];
    if (item.geometry.length > 1) meta.push(`<span>${item.geometry.length} частин</span>`);
    if (item.geometry[0]) meta.push(`<span>${kindLabel(item.geometry[0].kind)}</span>`);
    return `
      <h3 class="pop-title">${escapeHtml(item.name)}</h3>
      ${photosHtml}
      ${desc ? `<div class="pop-desc">${desc}</div>` : ''}
      ${extraHtml}
      ${meta.length ? `<div class="pop-meta">${meta.join('')}</div>` : ''}
      <button class="pop-btn" data-act="zoom">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        Центрувати
      </button>
    `;
  }

  function kindLabel(k) {
    return { point: 'Точка', linestring: 'Лінія', polygon: 'Полігон' }[k] || k;
  }

  // Маркери для точок: кругла крапка з подвійним кільцем і drop-shadow.
  // Колір беремо з <IconStyle><color> у KML (aabbggrr).
  // Ігноруємо iconHref з KML (там завжди gstatic-іконка).
  function makePointIcon(item) {
    let c = '#ef4444'; // дефолт — червоний
    if (item.iconColor) {
      const rgba = parseKmlColor(item.iconColor);
      const hex = rgba ? colorToHex(rgba) : null;
      if (hex) c = hex;
    }
    // Підбираємо читабельний бордер і кільце: для світлих кольорів — темні,
    // для темних — білі (щоб крапка не зливалася з тлом).
    const rgb = hexToRgb(c) || { r: 239, g: 68, b: 68 };
    const lum = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
    const border = lum > 160 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.95)';
    const ring = lum > 160 ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.35)';
    return L.divIcon({
      className: 'kml-marker',
      html: `<span class="kml-dot" style="width:20px;height:20px;display:block;border-radius:50%;background:${c};border:3px solid ${border};box-shadow:0 0 0 3px ${ring}, 0 6px 14px rgba(0,0,0,0.4);"></span>`,
      iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -12],
    });
  }
  // Парсер hex -> {r,g,b}
  function hexToRgb(hex) {
    if (!hex) return null;
    const m = hex.replace('#','').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) return null;
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }
  // Освітлює/затемнює колір. amount: -1..1 (-1 = чорний, 1 = білий)
  function shadeColor(hex, amount) {
    const c = hexToRgb(hex);
    if (!c) return hex;
    const blend = (v) => {
      if (amount >= 0) return Math.round(v + (255 - v) * amount);
      return Math.round(v * (1 + amount));
    };
    const r = blend(c.r).toString(16).padStart(2, '0');
    const g = blend(c.g).toString(16).padStart(2, '0');
    const b = blend(c.b).toString(16).padStart(2, '0');
    return '#' + r + g + b;
  }

  function renderPlacemark(item) {
    const layersArr = [];
    let bounds = null;
    const lineHex = colorToHex(item.lineColor) || '#f43f5e';
    const polyHex = colorToHex(item.polyColor) || '#7c3aed';
    let polyOpacity = 0.3;
    if (item.polyColor) {
      const m = item.polyColor.match(/[\d.]+\)$/);
      if (m) {
        const v = parseFloat(m[0].slice(0, -1));
        if (Number.isFinite(v)) polyOpacity = v;
      }
    }

    item.geometry.forEach(g => {
      let pts;
      if (g.kind === 'polygon') {
        // У KML <coordinates> може лежати:
        //   - напряму в <Polygon> (Google My Maps експорт)
        //   - всередині <outerBoundaryIs><LinearRing> (стандарт)
        // Тому пробуємо обидва варіанти.
        const ringLatLngs = [];
        // Варіант 1: <coordinates> прямо в <Polygon>
        const directCoords = readCoords(g.node);
        if (directCoords.length) {
          ringLatLngs.push(directCoords);
        } else {
          // Варіант 2: шукаємо <LinearRing>
          const rings = g.node.querySelectorAll('LinearRing');
          rings.forEach(ring => {
            const c = readCoords(ring);
            if (c.length) ringLatLngs.push(c);
          });
        }
        // Детальний лог для перших 3 полігонів
        if (!window.__polyDiagLogged && item.name) {
          console.log('[fronty:polygon-debug]', item.name, '→ directCoords=', directCoords?.length || 0, 'ringLatLngs=', ringLatLngs.length);
          window.__polyDiagLogged = true;
        }
        if (!ringLatLngs.length) { window.__skippedPoly = (window.__skippedPoly || 0) + 1; return; } // нічого рендерити
        const safeOpacity = Math.max(polyOpacity || 0, 0.3);
        const safeColor = polyHex || lineHex;
        // Вибираємо контрастний border: якщо fill світлий — темний border, і навпаки.
        const polyRgb = hexToRgb(safeColor) || { r: 124, g: 58, b: 237 };
        const polyLum = 0.2126 * polyRgb.r + 0.7152 * polyRgb.g + 0.0722 * polyRgb.b;
        const borderColor = polyLum > 150 ? shadeColor(safeColor, -0.45) : shadeColor(safeColor, 0.25);
        const layer = L.polygon(ringLatLngs, {
          color: borderColor,
          weight: Math.max(item.lineWidth || 1, 2.2),
          fillColor: safeColor,
          fillOpacity: safeOpacity,
          opacity: 1,
          fill: true,
          className: 'kml-poly',
          smoothFactor: 1.2,
        });
        layer.bindPopup(buildPopupHtml(item), { maxWidth: 320, className: 'kml-popup' });
        layer.on('popupopen', (e) => {
          const btn = e.popup.getElement().querySelector('[data-act="zoom"]');
          if (btn) btn.addEventListener('click', () => zoomToItem(item), { once: true });
        });
        layer.on('click', () => layer.openPopup());
        // Hover — підсвічування через зміну opacity
        layer.on('mouseover', () => layer.setStyle({ fillOpacity: Math.min(0.9, safeOpacity + 0.25), weight: 3.2 }));
        layer.on('mouseout',  () => layer.setStyle({ fillOpacity: safeOpacity, weight: Math.max(item.lineWidth || 1, 2.2) }));
        layersArr.push(layer);
        const b = layer.getBounds();
        bounds = bounds ? bounds.extend(b) : L.latLngBounds(b);
        return;
      }
      pts = readCoords(g.node);
      if (!pts.length) return;
      let layer;
      if (g.kind === 'point') {
        layer = L.marker(pts[0], { icon: makePointIcon(item), title: item.name });
      } else if (g.kind === 'linestring') {
        layer = L.polyline(pts, {
          color: lineHex,
          weight: item.lineWidth || 3,
          opacity: 0.9,
        });
      }
      if (layer) {
        layer.bindPopup(buildPopupHtml(item), { maxWidth: 320, className: 'kml-popup' });
        layer.on('popupopen', (e) => {
          const btn = e.popup.getElement().querySelector('[data-act="zoom"]');
          if (btn) btn.addEventListener('click', () => zoomToItem(item), { once: true });
        });
        layer.on('click', () => layer.openPopup());
        layersArr.push(layer);
        const b = layer.getBounds ? layer.getBounds() : L.latLngBounds(pts, pts);
        bounds = bounds ? bounds.extend(b) : L.latLngBounds(b);
      }
    });

    return { layers: layersArr, bounds };
  }

  function zoomToItem(item) {
    let bounds = null;
    item.geometry.forEach(g => {
      const pts = readCoords(g.node);
      if (pts.length) {
        const b = L.latLngBounds(pts);
        bounds = bounds ? bounds.extend(b) : b;
      }
    });
    if (bounds && bounds.isValid()) map.flyToBounds(bounds, { padding: [60, 60], duration: 0.6, maxZoom: 16 });
  }

  // Спроба завантажити KML — перевіряємо джерела по порядку
  // FRONT_REMOTE_URL може бути перепризначений через window.__BACKEND_URL__ (на Render)
  const REMOTE_BASE = (() => {
    const override = (typeof window !== 'undefined' && window.__BACKEND_URL__) || '';
    if (override) return override + '/kmz';
    return FRONT_REMOTE_URL || (BACKEND_URL + '/kmz');
  })();

  const KML_SOURCES = [
    // 1. Бекенд: API з параметром дати, або /kmz (поточний)
    () => BACKEND_URL + (currentDate ? `/api/kmz?date=${encodeURIComponent(currentDate)}&t=` : '/kmz?t=') + Date.now(),
    // 2. Локальний файл
    () => `./Ukraine%20Analystic%20Map%20UAM.kmz?t=${Date.now()}`,
    () => `./front.kmz?t=${Date.now()}`,
    () => `./front.kml?t=${Date.now()}`,
    // 3. Google напряму
    () => `https://www.google.com/maps/d/kml?mid=${KML_MID}&forcekml=1`,
  ].filter(fn => fn);

  // Віддалений URL твого KMZ. Залиш порожнім, якщо кладеш файл локально.
  // Приклади:
  //   'https://my-bucket.r2.dev/front.kmz'
  //   'https://dropbox.com/s/xxx/front.kmz?raw=1'
  //   'https://raw.githubusercontent.com/USER/REPO/main/front.kmz'
  // const FRONT_REMOTE_URL = ''; // <- визначено вище в KML-секції

  // Інтервал автооновлення (хвилини). 0 = вимкнено.
  // const FRONT_REFRESH_MIN = 10; // <- визначено вище в KML-секції

  async function fetchKmlWithFallback() {
    let lastErr;
    for (const build of KML_SOURCES) {
      const url = build();
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        if (!text.trim().startsWith('<?xml') && !text.trim().startsWith('<kml')) {
          throw new Error('Не KML (відповідь: ' + text.slice(0, 80) + ')');
        }
        return text;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Усі джерела недоступні');
  }

  async function applyKmlText(text, { fit = true } = {}) {
    const parsed = parseKML(text);
    const placemarks = Array.isArray(parsed) ? parsed : parsed.placemarks;
    const kmlLayers = (parsed && parsed.layers) || [];
    if (!placemarks.length) throw new Error('KML не містить обʼєктів');

    let totalGeom = 0, withPoints = 0, withPolygons = 0, withLines = 0;
    placemarks.forEach(p => {
      p.geometry.forEach(g => {
        totalGeom++;
        if (g.kind === 'point') withPoints++;
        if (g.kind === 'polygon') withPolygons++;
        if (g.kind === 'linestring') withLines++;
      });
    });
    console.log('[Fronty] KML статистика:', {
      placemarks: placemarks.length,
      totalGeometryParts: totalGeom,
      points: withPoints,
      polygons: withPolygons,
      lines: withLines,
      kmlLayers: kmlLayers.length,
    });

    if (frontState.layer) map.removeLayer(frontState.layer);
    frontState.layer = L.layerGroup().addTo(map);
    frontState.features = [];
    frontState.bounds = null;

    layerState.kmlLayers = kmlLayers.map(l => ({ ...l, enabled: true }));
    renderLayerPanel();

    placemarks.forEach((item, i) => {
      const { layers: ll, bounds } = renderPlacemark(item);
      const layerName = item._layer || '(Корінь)';
      const visible = isLayerEnabled(layerName);
      ll.forEach(l => {
        l._frontItem = item;
        if (visible) frontState.layer.addLayer(l);
      });
      if (bounds && bounds.isValid() && visible) {
        frontState.bounds = frontState.bounds
          ? frontState.bounds.extend(bounds)
          : L.latLngBounds(bounds);
      }
      if (visible) frontState.features.push(item);
    });

    // Діагностика: скільки шарів додано в FeatureGroup
    console.log('[fronty] додано шарів на карту:', frontState.layer.getLayers().length,
      '(очікувалось ~', placemarks.length, ')');
    const polyLayers = frontState.layer.getLayers().filter(l => l instanceof L.Polygon);
    console.log('[fronty] полігонів на карті:', polyLayers.length);
    console.log('[fronty] пропущено полігонів через !ringLatLngs.length:', window.__skippedPoly || 0);

    fCount.textContent = String(frontState.features.length);
    if (fit && frontState.bounds && frontState.bounds.isValid() && !userTouchedMap) {
      // Літаємо до фронту лише якщо користувач ще не встиг порухати мапу.
      map.flyToBounds(frontState.bounds, { padding: [50, 50], duration: 0.8, maxZoom: 14 });
    }
    clearStatus();
  }

  // Ланцюжок CORS-проксі для обходу блокування Google
  const CORS_PROXIES = [
    { name: 'allorigins.get',     build: u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}&_t=${Date.now()}`, extract: j => j.contents },
    { name: 'allorigins.raw',     build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}&_t=${Date.now()}` },
    { name: 'corsproxy.io',       build: u => `https://corsproxy.io/?${encodeURIComponent(u)}&_t=${Date.now()}` },
    { name: 'cors-anywhere',      build: u => `https://cors-anywhere.herokuapp.com/${u}?_t=${Date.now()}` },
  ];

  // Витягує NetworkLink з KML/KMZ (якщо є — це лінк на реальний KML з Google)
  function extractNetworkLink(kmlText) {
    try {
      const doc = new DOMParser().parseFromString(kmlText, 'application/xml');
      const href = doc.querySelector('NetworkLink > Link > href, NetworkLink > link > href');
      return href ? href.textContent.trim() : null;
    } catch { return null; }
  }

  // Знайдений URL з NetworkLink — для автооновлення
  let discoveredNetworkLink = null;

  async function loadFrontAuto(forceFit = true) {
    const attempts = [];

    // Спочатку шукаємо NetworkLink у всіх локальних джерелах
    let networkLinkUrl = discoveredNetworkLink;
    if (!networkLinkUrl) {
      for (const build of KML_SOURCES) {
        const url = build();
        if (!url) continue;
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) continue;
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          const blob = await res.blob();
          let text;
          if (url.toLowerCase().endsWith('.kmz') || ct.includes('kmz')) {
            try { text = await unzipKmz(await blob.arrayBuffer()); }
            catch { continue; }
          } else {
            text = await blob.text();
          }
          // Шукаємо NetworkLink
          const nl = extractNetworkLink(text);
          if (nl) {
            networkLinkUrl = nl;
            attempts.push(`✅ [NetworkLink] знайдено в ${shortUrl(url)}`);
            console.log('[Fronty] NetworkLink:', nl);
            break;
          }
          // Якщо це вже справжній KML з Placemark — застосуємо напряму
          if (text.includes('<Placemark') && !text.includes('<NetworkLink')) {
            try {
              await applyKmlText(text, { fit: forceFit });
              console.log('[Fronty] OK (прямий KML):', attempts.join('\n'));
              return;
            } catch (e) {
              attempts.push(`❌ [applyKmlText] ${e.message}`);
            }
          }
        } catch (e) {
          attempts.push(`❌ [${shortUrl(url)}] ${e.message}`);
        }
      }
    }

    if (networkLinkUrl) {
      discoveredNetworkLink = networkLinkUrl;
      // Підтягуємо реальний KML через ланцюжок CORS-проксі
      for (const proxy of CORS_PROXIES) {
        const proxyUrl = proxy.build(networkLinkUrl);
        try {
          const res = await fetch(proxyUrl, { cache: 'no-store' });
          if (!res.ok) {
            attempts.push(`❌ [${proxy.name}] HTTP ${res.status}`);
            continue;
          }
          let text;
          if (proxy.extract) {
            const j = await res.json();
            text = proxy.extract(j);
          } else {
            text = await res.text();
          }
          if (!text || !text.includes('<Placemark')) {
            attempts.push(`❌ [${proxy.name}] відповідь не містить Placemark (${text.length} байт)`);
            continue;
          }
          await applyKmlText(text, { fit: forceFit });
          attempts.push(`✅ [${proxy.name}] ${text.length} байт — фронт завантажено`);
          console.log('[Fronty] OK:', attempts.join('\n'));
          return;
        } catch (e) {
          attempts.push(`❌ [${proxy.name}] ${e.message}`);
        }
      }
    }

    // Якщо дійшли сюди — все впало
    const summary = attempts.join(' · ');
    console.warn('[Fronty] Всі джерела недоступні:\n' + summary);
    showDetailedError(summary);
  }

  function shortUrl(url) {
    return url.length > 50 ? url.slice(0, 30) + '…' + url.slice(-15) : url;
  }

  function showDetailedError(summary) {
    fStatus.removeAttribute('hidden');
    fStatus.className = 'front-status error';
    const hasR2 = FRONT_REMOTE_URL && summary.includes(FRONT_REMOTE_URL.slice(0, 20));
    const hasLocal = summary.includes('./Ukraine');
    fStatus.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px;min-width:280px;max-width:480px;">
        <strong>Не вдалося завантажити KML</strong>
        <details style="font-size:0.78rem;opacity:0.85;">
          <summary style="cursor:pointer;">Деталі (${summary.split('·').length} спроб)</summary>
          <pre style="margin:8px 0 0;padding:8px;background:rgba(0,0,0,0.3);border-radius:6px;overflow-x:auto;white-space:pre-wrap;font:500 0.72rem ui-monospace,monospace;">${escapeHtml(summary)}</pre>
        </details>
        <div style="display:flex;gap:6px;flex-wrap:wrap;font-size:0.82rem;">
          ${hasR2 ? '<span style="opacity:0.85;">→ Перевір R2: Public Access має бути увімкнено і CORS дозволено</span>' : ''}
          ${hasLocal ? '<span style="opacity:0.85;">→ Локальний KMZ: поклади файл поряд з index.html</span>' : ''}
          <button class="pop-btn" id="retry-front">Спробувати ще</button>
        </div>
      </div>
    `;
    const btn = fStatus.querySelector('#retry-front');
    if (btn) btn.addEventListener('click', () => loadFrontAuto(true));
  }

  function openKmlModal() {
    // Заглушка — модалку прибрано на прохання користувача
  }

  // Обробка вибраного файлу (на майбутнє — якщо поверну модалку)
  async function handleFile(file) {
    if (!file) return;
    try {
      setStatus('Читання файлу…');
      const buf = await file.arrayBuffer();
      let text;
      if (file.name.toLowerCase().endsWith('.kmz')) {
        setStatus('Розпакування KMZ…');
        text = await unzipKmz(buf);
      } else {
        text = new TextDecoder('utf-8').decode(buf);
      }
      await applyKmlText(text, { fit: true });
    } catch (e) {
      console.error(e);
      setStatus('Помилка: ' + e.message, 'error');
    }
  }

  // UI обробники
  fToggle.addEventListener('click', () => setFrontEnabled(!frontState.enabled));
  fReload.addEventListener('click', () => loadFrontAuto(false));
  fFit.addEventListener('click', () => {
    if (frontState.bounds && frontState.bounds.isValid()) {
      map.flyToBounds(frontState.bounds, { padding: [50, 50], duration: 0.6, maxZoom: 14 });
    }
  });

  // ============================================================
  //  ЛІНІЙКА + ПЛОЩА
  // ============================================================
  const measure = { active: false, points: [], polyline: null, segmentLines: [], markers: [], totalMeters: 0 };
  const area    = { active: false, points: [], poly: null, markers: [] };
  const rToggle = document.getElementById('rulerToggle');
  const aToggle = document.getElementById('areaToggle');
  const rClear  = document.getElementById('rulerClear');
  const rTotal  = document.getElementById('rTotal');
  const rHint   = document.getElementById('rHint');
  const rLabel  = document.getElementById('rLabel');

  function fmt(m) { return m < 1000 ? `${Math.round(m)} м` : `${(m/1000).toFixed(2)} км`; }
  function fmtArea(m2) {
    if (m2 < 10000) return Math.round(m2) + ' м²';
    if (m2 < 1e6)   return (m2/10000).toFixed(2) + ' га';
    return (m2/1e6).toFixed(3) + ' км²';
  }
  function haversine(a, b) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function ringAreaSqm(latlngs) {
    if (latlngs.length < 3) return 0;
    const R = 6378137;
    let total = 0;
    for (let i = 0; i < latlngs.length; i++) {
      const a = latlngs[i], b = latlngs[(i+1) % latlngs.length];
      total += (b.lng - a.lng) * Math.PI/180 *
        (2 + Math.sin(a.lat*Math.PI/180) + Math.sin(b.lat*Math.PI/180));
    }
    return Math.abs(total * R * R / 2);
  }

  // Блокування кліків на плейсмарках під час вимірювання
  function setFrontInteractionBlocked(blocked) {
    if (!frontState.layer) return;
    frontState.layer.eachLayer(l => {
      if (!l) return;
      if (blocked) {
        if (l._origClick) return;
        const ev = l._events;
        l._origClick = ev && ev.click ? ev.click.slice() : [];
        l.off('click');
        if (l.closePopup) l.closePopup();
      } else if (l._origClick) {
        l._origClick.forEach(h => l.on('click', h.handler || h));
        l._origClick = null;
      }
    });
  }

  function clearMeasure() {
    if (measure.polyline) map.removeLayer(measure.polyline);
    measure.segmentLines.forEach(l => map.removeLayer(l));
    measure.markers.forEach(m => map.removeLayer(m));
    measure.polyline = null; measure.segmentLines = []; measure.markers = [];
    measure.points = []; measure.totalMeters = 0;
    updateTotal();
  }
  function clearArea() {
    if (area.poly) map.removeLayer(area.poly);
    area.markers.forEach(m => map.removeLayer(m));
    area.poly = null; area.markers = []; area.points = [];
  }

  function updateTotal() {
    if (area.active) return;
    rTotal.textContent = fmt(measure.totalMeters);
    rLabel.textContent = 'Загалом';
    if (measure.active && measure.points.length > 0) {
      rHint.textContent = `Точок: ${measure.points.length}. Подвійний клік — завершити, Esc — вийти.`;
    } else if (measure.active) {
      rHint.textContent = 'Клікни по карті, щоб поставити першу точку';
    } else {
      rHint.textContent = 'Натисни «Лінійка» або «Площа»';
    }
  }
  function startMeasure() {
    if (area.active) stopArea();
    measure.active = true;
    map.getContainer().classList.add('ruler-on');
    rToggle.classList.add('active');
    rToggle.setAttribute('aria-pressed', 'true');
    setFrontInteractionBlocked(true);
    updateTotal();
  }
  function stopMeasure() {
    measure.active = false;
    map.getContainer().classList.remove('ruler-on');
    rToggle.classList.remove('active');
    rToggle.setAttribute('aria-pressed', 'false');
    setFrontInteractionBlocked(false);
    updateTotal();
  }
  function addPoint(latlng) {
    const n = measure.points.length + 1;
    measure.points.push({ latlng, label: n });
    const marker = L.circleMarker(latlng, {
      radius: 6, color: '#f43f5e', weight: 3, fillColor: '#fff', fillOpacity: 1,
    }).addTo(map).bindTooltip(String(n), {
      permanent: true, direction: 'top', offset: [0, -8], className: 'seg-tip',
    });
    measure.markers.push(marker);
    if (measure.points.length >= 2) {
      const prev = measure.points[measure.points.length - 2];
      const d = haversine(prev.latlng, latlng);
      measure.totalMeters += d;
      const seg = L.polyline([prev.latlng, latlng], { color: '#f43f5e', weight: 4, opacity: 0.95, lineCap: 'round' }).addTo(map);
      measure.segmentLines.push(seg);
      const mid = L.latLng((prev.latlng.lat + latlng.lat)/2, (prev.latlng.lng + latlng.lng)/2);
      L.tooltip({ permanent: true, direction: 'center', className: 'seg-tip', offset: [0, 0] })
        .setLatLng(mid).setContent(fmt(d)).addTo(map);
    }
    updateTotal();
  }

  function startArea() {
    if (measure.active) stopMeasure();
    area.active = true;
    map.getContainer().classList.add('ruler-on');
    aToggle.classList.add('active');
    aToggle.setAttribute('aria-pressed', 'true');
    setFrontInteractionBlocked(true);
    rLabel.textContent = 'Площа';
    rTotal.textContent = '0 м²';
    rHint.textContent = 'Клікни по карті, щоб додати вершину (потрібно ≥ 3). Подвійний клік — завершити.';
  }
  function stopArea() {
    area.active = false;
    map.getContainer().classList.remove('ruler-on');
    aToggle.classList.remove('active');
    aToggle.setAttribute('aria-pressed', 'false');
    setFrontInteractionBlocked(false);
    updateTotal();
  }
  function addAreaPoint(latlng) {
    const n = area.points.length + 1;
    area.points.push(latlng);
    const marker = L.circleMarker(latlng, {
      radius: 5, color: '#06b6d4', weight: 3, fillColor: '#fff', fillOpacity: 1,
    }).addTo(map).bindTooltip(String(n), { permanent: true, direction: 'top', offset: [0, -8], className: 'seg-tip' });
    area.markers.push(marker);
    if (area.poly) map.removeLayer(area.poly);
    if (area.points.length >= 2) {
      area.poly = L.polygon(area.points, {
        color: '#06b6d4', weight: 2, fillColor: '#06b6d4', fillOpacity: 0.18, dashArray: '4 4',
      }).addTo(map);
    }
    if (area.points.length >= 3) {
      const a = ringAreaSqm(area.points);
      rTotal.textContent = fmtArea(a);
      rHint.textContent = `Вершин: ${area.points.length}. Площа: ${fmtArea(a)}. Подвійний клік — завершити.`;
    } else {
      rHint.textContent = `Вершин: ${area.points.length}. Потрібно ≥ 3 для площі.`;
    }
  }

  map.on('click', (e) => {
    if (measure.active) { addPoint(e.latlng); return; }
    if (area.active)    { addAreaPoint(e.latlng); return; }
  });
  map.on('dblclick', (e) => {
    if (measure.active) { stopMeasure(); e.originalEvent && e.originalEvent.preventDefault(); return; }
    if (area.active)    { stopArea();    e.originalEvent && e.originalEvent.preventDefault(); return; }
  });
  rToggle.addEventListener('click', () => {
    if (area.active) stopArea();
    if (measure.active) { stopMeasure(); return; }
    startMeasure();
  });
  aToggle.addEventListener('click', () => {
    if (measure.active) stopMeasure();
    if (area.active) { stopArea(); return; }
    startArea();
  });
  rClear.addEventListener('click', () => {
    clearMeasure(); clearArea();
    if (measure.active) stopMeasure();
    if (area.active) stopArea();
  });
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
      if (area.active) stopArea();
      if (measure.active) stopMeasure(); else startMeasure();
    } else if (e.key === 'Escape') {
      if (measure.active) stopMeasure();
      if (area.active) stopArea();
    }
  });

  // ============================================================
  //  ПОШУК (Nominatim)
  // ============================================================
  const q = document.getElementById('q');
  let dropdown = null;
  let activeAbort = null;
  let debounceT = null;
  const cache = new Map();
  function isCoord(s) {
    const m = s.trim().match(/^(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)$/);
    return m ? { lat: +m[1], lng: +m[2] } : null;
  }
  function closeDropdown() { if (dropdown) dropdown.remove(); dropdown = null; }
  function ensureDropdown() {
    if (dropdown) return dropdown;
    dropdown = document.createElement('div');
    Object.assign(dropdown.style, {
      position: 'absolute', left: '0', right: '0', top: 'calc(100% + 8px)',
      background: 'rgba(15,21,48,0.95)',
      border: '1px solid rgba(255,255,255,0.16)',
      borderRadius: '12px',
      boxShadow: '0 14px 36px -16px rgba(0,0,0,0.6)',
      backdropFilter: 'blur(14px) saturate(160%)',
      WebkitBackdropFilter: 'blur(14px) saturate(160%)',
      maxHeight: '320px', overflowY: 'auto', zIndex: '1100', display: 'none',
    });
    q.parentElement.style.position = 'relative';
    q.parentElement.appendChild(dropdown);
    return dropdown;
  }
  async function geocode(text) {
    if (cache.has(text)) return cache.get(text);
    if (activeAbort) activeAbort.abort();
    activeAbort = new AbortController();
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&accept-language=uk&q=${encodeURIComponent(text)}`;
    try {
      const res = await fetch(url, { signal: activeAbort.signal, headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [];
      cache.set(text, arr); return arr;
    } catch (e) { if (e.name === 'AbortError') return []; return []; }
  }
  function renderResults(items) {
    const dd = ensureDropdown(); dd.innerHTML = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.style.cssText = 'padding:12px 14px;color:#97a3c2;font-size:0.88rem;';
      e.textContent = 'Нічого не знайдено';
      dd.appendChild(e); dd.style.display = 'block'; return;
    }
    items.forEach(item => {
      const row = document.createElement('button'); row.type = 'button';
      row.style.cssText = `display:block;width:100%;text-align:left;padding:10px 14px;background:transparent;border:0;color:#e8ecf8;font:500 0.9rem 'Manrope',sans-serif;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);`;
      const main = item.display_name.split(',')[0];
      row.innerHTML = `<div style="font-weight:700;">${main}</div><div style="font-size:0.78rem;color:#97a3c2;margin-top:2px;">${item.display_name}</div>`;
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.05)'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      row.addEventListener('click', () => {
        const lat = +item.lat, lng = +item.lon;
        map.flyTo([lat, lng], Math.max(map.getZoom(), 14), { duration: 0.8 });
        L.marker([lat, lng]).addTo(map).bindPopup(`<strong>${item.display_name}</strong>`).openPopup();
        q.value = main; closeDropdown();
      });
      dd.appendChild(row);
    });
    dd.style.display = 'block';
  }
  function triggerSearch() {
    const v = q.value.trim(); if (!v) return closeDropdown();
    const c = isCoord(v);
    if (c) {
      map.flyTo([c.lat, c.lng], 14, { duration: 0.8 });
      L.marker([c.lat, c.lng]).addTo(map).bindPopup(`Координати<br>${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`).openPopup();
      closeDropdown(); return;
    }
    clearTimeout(debounceT);
    debounceT = setTimeout(async () => {
      const items = await geocode(v); renderResults(items);
    }, 250);
  }
  q.addEventListener('input', triggerSearch);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); triggerSearch(); }
    if (e.key === 'Escape') { closeDropdown(); q.blur(); }
  });
  document.addEventListener('click', (e) => {
    if (!q.parentElement.contains(e.target)) closeDropdown();
  });

  // ============================================================
  //  Запуск
  // ============================================================
  updateTotal();
  // Спробуємо автоматично; якщо не вийде — UI підкаже
  loadFrontAuto(true);

  // === WebSocket: миттєве оновлення від бекенда ===
  let ws = null;
  let wsReconnectDelay = 1000;
  function connectWs() {
    try {
      ws = new WebSocket(BACKEND_WS);
      ws.addEventListener('open', () => {
        console.log('[WS] Підключено до', BACKEND_WS);
        wsReconnectDelay = 1000;
      });
      ws.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'kmz-updated') {
            console.log('[WS] Оновлення KMZ від бекенда:', msg);
            loadDateList();
            if (currentDate === null) loadFrontAuto(false);
          } else if (msg.type === 'hello') {
            console.log('[WS] Привіт від бекенда');
          }
        } catch (err) {
          console.warn('[WS] Невідомий формат:', e.data);
        }
      });
      ws.addEventListener('close', () => {
        console.log('[WS] Зʼєднання закрито, повтор через %.1f с', wsReconnectDelay / 1000);
        setTimeout(connectWs, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30_000); // до 30 сек
      });
      ws.addEventListener('error', (e) => {
        console.warn('[WS] Помилка:', e.message || e);
      });
    } catch (e) {
      console.warn('[WS] Не вдалося підключитися:', e.message);
    }
  }
  connectWs();
  setupLayerPanel();
  setupDatePanel();

  // === Polling fallback (на випадок якщо WS недоступний) ===
  if (FRONT_REFRESH_MIN > 0) {
    setInterval(() => {
      if (frontState.features.length > 0 && (!ws || ws.readyState !== 1)) {
        console.log('[Fronty] Polling-оновлення фронту…');
        loadFrontAuto(false);
      }
    }, FRONT_REFRESH_MIN * 60 * 1000);
  }

})();
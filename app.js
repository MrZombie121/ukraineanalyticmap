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
  const map = L.map('map', {
    center: [46.4825, 30.7233],
    zoom: 13,
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
  const layerSatellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { ...baseOpts, maxZoom: 19, attribution: 'Tiles © Esri' }
  );
  const layerRoadmap = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    { ...baseOpts, maxZoom: 19, attribution: 'Tiles © Esri' }
  );
  const layerTerrain = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    { ...baseOpts, maxZoom: 19, attribution: 'Tiles © Esri' }
  );
  // Схема як Google Maps — справжні тайли Google через спеціальний публічний endpoint
  // Цей шар не потребує API-ключа для відображення (умовно безкоштовний для personal use)
  const layerGoogle = L.tileLayer(
    'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
    {
      ...baseOpts,
      maxZoom: 20,
      attribution: '© Google',
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    }
  );
  const layers = { satellite: layerSatellite, roadmap: layerRoadmap, terrain: layerTerrain, google: layerGoogle };
  layers.satellite.addTo(map);
  let activeKey = 'satellite';

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

  // ============================================================
  //  KML: парсер + рендер
  // ============================================================
  const KML_MID = '1E7cefbjfT33zErTQADATnyZ_SVChrJc';

  // Віддалений URL твого KMZ. Залиш порожнім '', якщо кладеш файл локально.
  // Приклади:
  //   'https://pub-xxxxxx.r2.dev/kmzfile/Ukraine%20Analystic%20Map%20UAM.kmz'
  //   'https://my-bucket.r2.dev/front.kmz'
  //   'https://raw.githubusercontent.com/USER/REPO/main/front.kmz'
  const FRONT_REMOTE_URL = 'http://localhost:3001/kmz';

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

  // Парсер KML
  function parseKML(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const errNode = doc.querySelector('parsererror');
    if (errNode) throw new Error('Не вдалося розпарсити KML');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'kml') {
      throw new Error('Кореневий тег не <kml>');
    }
    // Збираємо всі <Style> і <StyleMap> за id для резолву styleUrl
    const styles = {};
    doc.querySelectorAll('Style, StyleMap').forEach(s => {
      const id = s.getAttribute('id');
      if (id) styles[id] = s;
    });
    const allPlacemarks = [];
    collectPlacemarks(root, styles, allPlacemarks);
    return allPlacemarks;
  }

  function collectPlacemarks(node, styles, out) {
    Array.from(node.children).forEach(child => {
      const tag = child.nodeName.toLowerCase();
      if (tag === 'placemark') out.push(readPlacemark(child, styles));
      else if (tag === 'folder' || tag === 'document') {
        collectPlacemarks(child, styles, out);
      } else if (tag === 'networklink') {
        // NetworkLink — це лінк на інший KML, всередині нього даних немає.
        // Збережемо URL для KML_SOURCES як додаткове джерело.
        const href = child.querySelector('Link > href, link > href');
        if (href) {
          const url = href.textContent.trim();
          if (url && !KML_SOURCES.some(fn => fn() === url)) {
            console.log('[Fronty] NetworkLink →', url);
            // Не додаємо динамічно (KML_SOURCES const), але можемо показати підказку
          }
        }
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
        if (v && v.textContent.trim()) {
          extraFields.push({ name: n, value: v.textContent.trim() });
        }
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

  function buildPopupHtml(item) {
    // Якщо є ExtendedData, формуємо красиву таблицю
    let extraHtml = '';
    if (item.extraFields && item.extraFields.length) {
      const rows = item.extraFields
        .filter(f => f.value && f.value.trim())
        .map(f => `<tr><td>${escapeHtml(f.name)}</td><td>${escapeHtml(f.value)}</td></tr>`).join('');
      if (rows) {
        extraHtml = `<table class="pop-ext">${rows}</table>`;
      }
    }
    const desc = item.descriptionHtml ? sanitizeHtml(item.descriptionHtml) : '';
    const meta = [];
    if (item.geometry.length > 1) meta.push(`<span>${item.geometry.length} частин</span>`);
    if (item.geometry[0]) meta.push(`<span>${kindLabel(item.geometry[0].kind)}</span>`);
    return `
      <h3 class="pop-title">${escapeHtml(item.name)}</h3>
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

  // Маркери для точок: гарна кольорова крапка з рамкою (divIcon — синхронно, без async)
  // Ігноруємо iconHref з KML (там завжди одна й та сама gstatic-іконка),
  // а реальний колір беремо з <IconStyle><color> у KML.
  function makePointIcon(item) {
    let c = '#ef4444'; // дефолт — червоний
    if (item.iconColor) {
      // item.iconColor — це KML aabbggrr; parseKmlColor поверне rgba(...)
      const rgba = parseKmlColor(item.iconColor);
      if (rgba) {
        const hex = colorToHex(rgba);
        if (hex) c = hex;
      }
    }
    return L.divIcon({
      className: 'kml-marker',
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${c};border:3px solid #fff;box-shadow:0 0 0 4px ${c}55, 0 6px 14px rgba(0,0,0,0.45);"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9],
    });
  }

  function renderPlacemark(item) {
    const layersArr = [];
    let bounds = null;
    const lineHex = colorToHex(item.lineColor) || '#f43f5e';
    const polyHex = colorToHex(item.polyColor) || '#7c3aed';
    const polyOpacity = item.polyColor ? (parseFloat(item.polyColor.match(/[\d.]+\)$/)?.[0].slice(0, -1)) || 0.3) : 0.3;

    item.geometry.forEach(g => {
      const pts = readCoords(g.node);
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
      } else if (g.kind === 'polygon') {
        const rings = g.node.querySelectorAll('LinearRing');
        const ringLatLngs = [];
        rings.forEach(ring => {
          const c = readCoords({ children: [ring] });
          if (c.length) ringLatLngs.push(c);
        });
        // Гарантуємо, що полігон буде хоч трохи видимий
        const safeOpacity = Math.max(polyOpacity || 0, 0.25);
        const safeColor = polyHex || lineHex;
        layer = L.polygon(ringLatLngs, {
          color: lineHex,
          weight: item.lineWidth || 2,
          fillColor: safeColor,
          fillOpacity: safeOpacity,
          opacity: 0.9,
          // Не даємо Leaflet прибрати прозорі fill
          fill: true,
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
    // 1. Бекенд (Render або локальний)
    () => REMOTE_BASE ? REMOTE_BASE + '?t=' + Date.now() : null,
    // 2. Локальний файл у папці сайту. Перевіряємо кілька варіантів імен.
    () => `./Ukraine%20Analystic%20Map%20UAM.kmz?t=${Date.now()}`,
    () => `./Ukraine Analystic Map UAM.kmz?t=${Date.now()}`,
    () => `./front.kmz?t=${Date.now()}`,
    () => `./front.kml?t=${Date.now()}`,
    // 3. Google напряму (CORS блокує з браузера, але про всяк випадок)
    () => `https://www.google.com/maps/d/kml?mid=${KML_MID}&forcekml=1`,
  ].filter(fn => fn); // null-и викидаємо

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
    setStatus('Обробка обʼєктів…');
    await new Promise(r => setTimeout(r, 30));
    const placemarks = parseKML(text);
    if (!placemarks.length) throw new Error('KML не містить обʼєктів');

    // Лічильники для дебагу
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
    });

    if (frontState.layer) map.removeLayer(frontState.layer);
    frontState.layer = L.layerGroup().addTo(map);
    frontState.features = [];
    frontState.bounds = null;

    placemarks.forEach((item, i) => {
      const { layers: ll, bounds } = renderPlacemark(item);
      ll.forEach(l => {
        l._frontItem = item;
        frontState.layer.addLayer(l);
      });
      if (bounds && bounds.isValid()) {
        frontState.bounds = frontState.bounds
          ? frontState.bounds.extend(bounds)
          : L.latLngBounds(bounds);
      }
      frontState.features.push(item);
    });

    fCount.textContent = String(frontState.features.length);
    if (fit && frontState.bounds && frontState.bounds.isValid()) {
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
    setStatus('Завантаження KML…');
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
          setStatus(`Завантаження через ${proxy.name}…`);
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
  //  ЛІНІЙКА
  // ============================================================
  const measure = { active: false, points: [], polyline: null, segmentLines: [], markers: [], totalMeters: 0 };
  const rToggle = document.getElementById('rulerToggle');
  const rClear = document.getElementById('rulerClear');
  const rTotal = document.getElementById('rTotal');
  const rHint = document.getElementById('rHint');

  function fmt(m) { return m < 1000 ? `${Math.round(m)} м` : `${(m/1000).toFixed(2)} км`; }
  function haversine(a, b) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function clearMeasure() {
    if (measure.polyline) map.removeLayer(measure.polyline);
    measure.segmentLines.forEach(l => map.removeLayer(l));
    measure.markers.forEach(m => map.removeLayer(m));
    measure.polyline = null; measure.segmentLines = []; measure.markers = [];
    measure.points = []; measure.totalMeters = 0;
    updateTotal();
  }
  function updateTotal() {
    rTotal.textContent = fmt(measure.totalMeters);
    if (measure.active && measure.points.length > 0) {
      rHint.textContent = `Точок: ${measure.points.length}. Подвійний клік — завершити, Esc — вийти.`;
    } else if (measure.active) {
      rHint.textContent = 'Клікни по карті, щоб поставити першу точку';
    } else {
      rHint.textContent = 'Натисни «Лінійка», потім клікай по карті';
    }
  }
  function startMeasure() {
    measure.active = true;
    map.getContainer().classList.add('ruler-on');
    rToggle.classList.add('active');
    rToggle.setAttribute('aria-pressed', 'true');
    updateTotal();
  }
  function stopMeasure() {
    measure.active = false;
    map.getContainer().classList.remove('ruler-on');
    rToggle.classList.remove('active');
    rToggle.setAttribute('aria-pressed', 'false');
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
  map.on('click', (e) => { if (measure.active) addPoint(e.latlng); });
  map.on('dblclick', () => { if (measure.active) stopMeasure(); });
  rToggle.addEventListener('click', () => { if (measure.active) stopMeasure(); else startMeasure(); });
  rClear.addEventListener('click', () => { clearMeasure(); stopMeasure(); });
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
      if (measure.active) stopMeasure(); else startMeasure();
    } else if (e.key === 'Escape') stopMeasure();
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
            loadFrontAuto(false);
          } else if (msg.type === 'hello') {
            console.log('[WS] Привіт від бекенда, розмір=%.1f КБ', (msg.kmzSize || 0) / 1024);
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
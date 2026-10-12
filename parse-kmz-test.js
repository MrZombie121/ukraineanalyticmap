// Перевірка: чи є <LinearRing> в полігонах?
const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom');

const zip = new AdmZip('D:\\Uas FRONTY\\downloaded.kmz');
const entries = zip.getEntries();
console.log('Файли у KMZ:', entries.map(e => e.entryName));

const kmlEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.kml'));
const xml = kmlEntry.getData().toString('utf8');
console.log('Розмір KML:', xml.length);

const doc = new DOMParser().parseFromString(xml, 'application/xml');
const placemarks = doc.getElementsByTagName('Placemark');
console.log('Placemark всього:', placemarks.length);

let polys = 0, polysWithLinearRing = 0, polysWithCoords = 0, polysWithoutCoords = 0;
const polySamples = [];

for (let i = 0; i < placemarks.length; i++) {
  const p = placemarks[i];
  const polygons = p.getElementsByTagName('Polygon');
  if (polygons.length === 0) continue;
  polys++;
  const first = polygons[0];
  const lrs = first.getElementsByTagName('LinearRing');
  if (lrs.length > 0) polysWithLinearRing++;
  const coords = first.getElementsByTagName('coordinates');
  if (coords.length > 0) polysWithCoords++;
  else {
    polysWithoutCoords++;
    if (polySamples.length < 3) {
      polySamples.push({ name: p.getElementsByTagName('name')[0]?.firstChild?.data || '?' });
    }
  }
}

console.log('Placemark з <Polygon>:', polys);
console.log('  - мають <LinearRing>:', polysWithLinearRing);
console.log('  - мають <coordinates> прямо в <Polygon>:', polysWithCoords);
console.log('  - НЕ мають <coordinates> прямо:', polysWithoutCoords);
console.log('Приклади полігонів без coords:', polySamples);

// Перевірка, чи <coordinates> може бути просто текстом у Polygon без LinearRing
console.log('\n--- Raw XML першого полігона без coords ---');
let count = 0;
for (let i = 0; i < placemarks.length && count < 1; i++) {
  const p = placemarks[i];
  const polygons = p.getElementsByTagName('Polygon');
  for (let j = 0; j < polygons.length && count < 1; j++) {
    const poly = polygons[j];
    const coords = poly.getElementsByTagName('coordinates');
    if (coords.length === 0) {
      // Серіалізуємо весь Polygon
      const ser = require('@xmldom/xmldom').XMLSerializer ? new (require('@xmldom/xmldom').XMLSerializer)() : null;
      if (ser) console.log(ser.serializeToString(poly));
      else {
        // Сирий текст
        const start = xml.indexOf('<Polygon');
        console.log('Не вдалося серіалізувати, але покажу сирий фрагмент:');
        console.log(xml.substring(xml.indexOf('<Polygon'), xml.indexOf('</Polygon>') + 10));
      }
      count++;
    }
  }
}
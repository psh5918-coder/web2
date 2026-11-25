const fs = require('node:fs');
const path = require('node:path');

const source = process.argv[2];
if (!source) throw new Error('Usage: node build-map.cjs <source.geojson>');
const directory = path.join(__dirname, 'boundaries');
fs.mkdirSync(directory, { recursive: true });

const longitudeScale = Math.cos(Math.PI / 5) * 10000;
const latitudeScale = -10000;
const provinces = new Map();

function makePath(ring, bounds) {
  const points = [];
  for (const [longitude, latitude] of ring) {
    const x = Math.round(longitude * longitudeScale);
    const y = Math.round(latitude * latitudeScale);
    const point = `${x} ${y}`;
    if (points.at(-1) !== point) points.push(point);
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
  }
  if (points[0] === points.at(-1)) points.pop();
  return points.length > 2 ? `M${points.join(' ')}Z` : '';
}

const { features } = JSON.parse(fs.readFileSync(source, 'utf8'));
for (const { properties, geometry } of features) {
  const { sido, sidonm, sgg, sggnm } = properties;
  if (!provinces.has(sido)) provinces.set(sido, { code: sido, name: sidonm, districts: new Map() });
  const { districts } = provinces.get(sido);
  if (!districts.has(sgg)) {
    districts.set(sgg, { code: sgg, name: sggnm, bounds: [Infinity, Infinity, -Infinity, -Infinity], paths: [] });
  }
  const district = districts.get(sgg);
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) {
    const shape = polygon.map(ring => makePath(ring, district.bounds)).join('');
    if (shape) district.paths.push(shape);
  }
}

const index = [];
for (const { code, name, districts } of provinces.values()) {
  index.push({ code, name, districts: [...districts.values()].map(({ code, name }) => ({ code, name })) });
  const boundary = Object.fromEntries([...districts].map(([code, { bounds, paths }]) => [code, { bounds, paths }]));
  fs.writeFileSync(path.join(directory, `${code}.js`), `FuelBoundaries[${JSON.stringify(code)}]=${JSON.stringify(boundary)};\n`);
}

fs.writeFileSync(path.join(directory, 'regions.js'), `globalThis.FuelRegions=${JSON.stringify(index)};\nglobalThis.FuelBoundaries=Object.create(null);\n`);

// bench/tc-geom-cpu.ts
import { readFileSync } from "node:fs";

// ../shared/src/temporal.ts
var HOUR_MS = 36e5;
var MINUTE_MS = 6e4;
var TEMPORAL_SPEC = {
  earthquake: { temporalMode: "instant", windowMs: HOUR_MS },
  news: { temporalMode: "instant", windowMs: 2 * HOUR_MS },
  weather: { temporalMode: "interval" },
  flight: { temporalMode: "sampled", toleranceMs: 20 * MINUTE_MS }
};

// ../shared/src/coords.ts
function validateLonLat(lon, lat) {
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon === 0 && lat === 0) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return [lon, lat];
}

// ../shared/src/url-state.ts
var LAYER_ORDER = [
  { layer: "earthquake", short: "eq" },
  { layer: "weather", short: "wx" },
  { layer: "flight", short: "fl" },
  { layer: "news", short: "nw" }
];
var LAYER_TO_SHORT = Object.fromEntries(
  LAYER_ORDER.map(({ layer, short }) => [layer, short])
);
var SHORT_TO_LAYER = Object.fromEntries(
  LAYER_ORDER.map(({ layer, short }) => [short, layer])
);
var DEFAULT_APP_STATE = {
  lat: 20,
  lng: 0,
  z: 1.8,
  t: "live",
  l: LAYER_ORDER.map(({ layer }) => layer),
  sel: null,
  play: false,
  rate: 1,
  pin: null
};

// src/sources/gdacs.ts
var RECENT_EXPIRED_WINDOW_MS = 48 * 36e5;
function gdacsGeometryUrl(eventType, eventId, episodeId) {
  return `https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=${encodeURIComponent(eventType)}&eventid=${eventId}&episodeid=${episodeId}`;
}
function strOrNull(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
var LON_MEAN_EPS = 1e-9;
var DEG = Math.PI / 180;
function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const pts = ring.slice(0, -1).filter(
    (c) => Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number"
  );
  const first = pts[0];
  if (first === void 0) return null;
  const lat = pts.reduce((s, c) => s + c[1], 0) / pts.length;
  let x = 0;
  let y = 0;
  for (const [lonDeg] of pts) {
    x += Math.cos(lonDeg * DEG);
    y += Math.sin(lonDeg * DEG);
  }
  const lon = Math.hypot(x, y) < LON_MEAN_EPS ? first[0] : Math.atan2(y, x) / DEG;
  return validateLonLat(lon, lat);
}
function validRing(ring) {
  if (!Array.isArray(ring)) return null;
  const out = [];
  for (const c of ring) {
    const pos = Array.isArray(c) ? validateLonLat(c[0], c[1]) : null;
    if (pos) out.push([pos[0], pos[1]]);
  }
  return out.length >= 3 ? out : null;
}
function buildTcGeometry(geomResp) {
  const features = geomResp?.features;
  if (!Array.isArray(features)) return { track: null, centroid: null, cone: null };
  const points2 = [];
  let centroid = null;
  let cone = null;
  for (const f of features) {
    const cls = strOrNull(f?.properties?.Class);
    const geom = f?.geometry;
    if (!cls || !geom) continue;
    if (cls === "Point_Centroid" && geom.type === "Point") {
      const c = geom.coordinates;
      centroid = Array.isArray(c) ? validateLonLat(c[0], c[1]) : null;
      continue;
    }
    if (cls === "Poly_Cones" && geom.type === "Polygon") {
      const rings = geom.coordinates;
      const outer = Array.isArray(rings) ? validRing(rings[0]) : null;
      if (outer) cone = { type: "Polygon", coordinates: [outer] };
      continue;
    }
    const m = /^Point_Polygon_Point_(\d+)$/.exec(cls);
    if (m && geom.type === "Polygon") {
      const rings = geom.coordinates;
      const pos = Array.isArray(rings) ? ringCentroid(rings[0]) : null;
      if (pos) points2.push({ index: Number(m[1]), pos });
    }
  }
  points2.sort((a, b) => a.index - b.index);
  const track = points2.length >= 2 ? { type: "LineString", coordinates: points2.map((p) => [p.pos[0], p.pos[1]]) } : null;
  return { track, centroid, cone };
}

// bench/tc-geom-cpu.ts
var path = process.env.TC_GEOM_JSON ?? ".bench/tc-geom.json";
var text;
try {
  text = readFileSync(path, "utf8");
} catch {
  process.stderr.write(
    `\uC785\uB825 \uC5C6\uC74C: ${path}
  curl -s "${gdacsGeometryUrl("TC", 1001305, 6)}" -o ${path}
`
  );
  process.exit(1);
}
var runs = 20;
var cpu0 = process.cpuUsage();
var points = 0;
for (let i = 0; i < runs; i += 1) {
  const parsed = JSON.parse(text);
  const geom = buildTcGeometry(parsed);
  points += geom.track?.coordinates.length ?? 0;
}
var cpu = process.cpuUsage(cpu0);
var ms = (cpu.user + cpu.system) / 1e3 / runs;
var one = buildTcGeometry(JSON.parse(text));
process.stdout.write(
  JSON.stringify(
    {
      bytes: Buffer.byteLength(text),
      runs,
      cpuMsPerRun: +ms.toFixed(2),
      trackPoints: one.track?.coordinates.length ?? 0,
      conePoints: one.cone?.coordinates[0]?.length ?? 0,
      centroid: one.centroid,
      sanity: points
    },
    null,
    2
  ) + "\n"
);

// bench/slot-cpu.ts
import { readFileSync, existsSync } from "node:fs";

// src/http.ts
async function fetchText(url, timeoutMs, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) return { ok: false, status: 429, reason: "rate_limited" };
    if (!res.ok) return { ok: false, status: res.status, reason: "http" };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network" };
  }
}
async function fetchTextWithRetry(url, timeoutMs, retryDelayMs, headers) {
  const first = await fetchText(url, timeoutMs, headers);
  if (first.ok || first.reason === "rate_limited" || first.reason === "timeout") return first;
  await sleep(retryDelayMs);
  return await fetchText(url, timeoutMs, headers);
}
async function fetchBytes(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) return { ok: false, status: 429, reason: "rate_limited" };
    if (!res.ok) return { ok: false, status: res.status, reason: "http" };
    return { ok: true, status: res.status, bytes: await res.arrayBuffer() };
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network" };
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/gzip.ts
import { gunzipSync, gzipSync } from "node:zlib";
var GZIP_LEVEL = 1;
async function gzipText(text) {
  const out = gzipSync(new TextEncoder().encode(text), { level: GZIP_LEVEL });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
async function gunzipToText(data) {
  return new TextDecoder().decode(gunzipSync(new Uint8Array(data)));
}

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

// ../shared/src/normalize-usgs.ts
var USGS_ALL_HOUR_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";
function quakeSeverity(mag) {
  if (mag === null || !Number.isFinite(mag)) return { rank: 0 };
  const rank = mag >= 7 ? 4 : mag >= 5.5 ? 3 : mag >= 4 ? 2 : 1;
  return { rank, raw: mag, label: `M${mag}` };
}
function normalizeUsgs(feed, ingestedAtMs) {
  const features = feed?.features;
  if (!Array.isArray(features)) return { ok: false, reason: "schema" };
  const ingestedAt = new Date(ingestedAtMs).toISOString();
  const records = [];
  let dropped = 0;
  for (const raw of features) {
    const sourceId = typeof raw?.id === "string" ? raw.id : null;
    const props = raw?.properties ?? {};
    const coords = raw?.geometry?.coordinates;
    const timeMs = typeof props.time === "number" && Number.isFinite(props.time) ? props.time : null;
    if (!sourceId || timeMs === null || !Array.isArray(coords)) {
      dropped += 1;
      continue;
    }
    const lonLat = validateLonLat(coords[0], coords[1]);
    if (!lonLat) {
      dropped += 1;
      continue;
    }
    const [lon, lat] = lonLat;
    const depthKm = typeof coords[2] === "number" && Number.isFinite(coords[2]) ? coords[2] : null;
    const mag = typeof props.mag === "number" && Number.isFinite(props.mag) ? props.mag : null;
    const occurredAt = new Date(timeMs).toISOString();
    const revision = typeof props.updated === "number" && Number.isFinite(props.updated) ? props.updated : timeMs;
    const payload = {
      type: "earthquake",
      magnitude: mag,
      magType: typeof props.magType === "string" ? props.magType : null,
      depthKm,
      place: typeof props.place === "string" ? props.place : null,
      tsunami: props.tsunami === 1,
      status: typeof props.status === "string" ? props.status : null,
      url: typeof props.url === "string" ? props.url : null
    };
    records.push({
      id: `usgs:${sourceId}`,
      source: "usgs",
      sourceId,
      layer: "earthquake",
      revision,
      observedAt: occurredAt,
      ingestedAt,
      geometry: { type: "Point", coordinates: depthKm === null ? [lon, lat] : [lon, lat, -depthKm * 1e3] },
      centroid: [lon, lat],
      h3r3: "",
      severity: quakeSeverity(mag),
      kind: "occurrence",
      occurredAt,
      payload
    });
  }
  return { ok: true, records, dropped };
}

// ../shared/src/r2-keys.ts
var OBSERVATION_BUCKET_SEC = 180;
var NORM_SLOT_SEC = 900;
function slotStartSec(epochMs, slotSec) {
  return Math.floor(epochMs / 1e3 / slotSec) * slotSec;
}
function dtOf(epochSec) {
  return new Date(epochSec * 1e3).toISOString().slice(0, 10);
}
function hourOf(epochMs) {
  return new Date(epochMs).toISOString().slice(11, 13);
}
function rawKey(source, epochMs, name) {
  const sec = Math.floor(epochMs / 1e3);
  return `raw/${source}/dt=${dtOf(sec)}/hour=${hourOf(epochMs)}/${epochMs}-${name}.json.gz`;
}
function normKey(layer, slot, generation) {
  return `norm/${layer}/dt=${dtOf(slot)}/slot=${slot}.g${generation}.json.gz`;
}
function manifestEntryKey(layer, slot, generation) {
  return `manifest/${layer}/dt=${dtOf(slot)}/slot=${slot}.g${generation}.json`;
}
function normSlotPrefix(layer, slot) {
  return `norm/${layer}/dt=${dtOf(slot)}/slot=${slot}.g`;
}
function manifestSlotPrefix(layer, slot) {
  return `manifest/${layer}/dt=${dtOf(slot)}/slot=${slot}.g`;
}
function normPointerKey(dt) {
  return `manifest/pointers/norm/dt=${dt}.json`;
}
function statusKey(layer, slot, scheduledMs, attempt) {
  return `manifest/status/${layer}/dt=${dtOf(slot)}/slot=${slot}.${scheduledMs}.a${attempt}.json`;
}
var WEATHER_CYCLE_SEC = 3600;
function weatherCycleStartMs(epochMs) {
  return slotStartSec(epochMs, WEATHER_CYCLE_SEC) * 1e3;
}
var WEATHER_STAGING_PREFIX = "staging/weather/";
function weatherCyclePrefix(cycleStartMs) {
  return `${WEATHER_STAGING_PREFIX}cycle=${cycleStartMs}/`;
}
function weatherChunkKey(cycleStartMs, level, page) {
  return `${weatherCyclePrefix(cycleStartMs)}${level.toLowerCase()}-p${page}.json`;
}
function weatherProgressKey(cycleStartMs) {
  return `${weatherCyclePrefix(cycleStartMs)}progress.json`;
}
var TC_INDEX_KEY = "weather/tc-index.json";
function tcTrackKey(eventId, episodeId) {
  return `weather/tracks/${eventId}-${episodeId}.json`;
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

// src/sources/adsblol.ts
var ADSB_RADIUS_NM = 150;
function pointUrl(region) {
  return `https://api.adsb.lol/v2/point/${region.lat}/${region.lon}/${ADSB_RADIUS_NM}`;
}
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function normalizeAdsb(resp, region, bucketTs, ingestedAtMs) {
  const body = resp;
  if (!Array.isArray(body?.ac)) return { ok: false, reason: "schema" };
  const aircraft = body.ac;
  const responseNowMs = numOrNull(body?.now) ?? ingestedAtMs;
  const ingestedAt = new Date(ingestedAtMs).toISOString();
  const records = [];
  let dropped = 0;
  const isoCache = /* @__PURE__ */ new Map();
  const isoOf = (ms) => {
    const hit = isoCache.get(ms);
    if (hit !== void 0) return hit;
    const iso = new Date(ms).toISOString();
    isoCache.set(ms, iso);
    return iso;
  };
  for (const ac of aircraft) {
    const hex = strOrNull(ac?.hex)?.toLowerCase() ?? null;
    if (!hex) {
      dropped += 1;
      continue;
    }
    const lonLat = validateLonLat(ac?.lon, ac?.lat);
    if (!lonLat) {
      dropped += 1;
      continue;
    }
    const [lon, lat] = lonLat;
    const seenPosSec = numOrNull(ac?.seen_pos);
    const sampledMs = responseNowMs - (seenPosSec ?? 0) * 1e3;
    const sampledAt = isoOf(sampledMs);
    const altBaro = ac?.alt_baro === "ground" ? "ground" : numOrNull(ac?.alt_baro);
    const payload = {
      type: "flight",
      regionId: region.id,
      callsign: strOrNull(ac?.flight),
      altBaroFt: altBaro,
      groundSpeedKt: numOrNull(ac?.gs),
      trackDeg: numOrNull(ac?.track),
      aircraftType: strOrNull(ac?.t),
      registration: strOrNull(ac?.r),
      category: strOrNull(ac?.category),
      seenPosSec
    };
    const sourceId = `${hex}:${bucketTs}`;
    records.push({
      id: `adsblol:${sourceId}`,
      source: "adsblol",
      sourceId,
      layer: "flight",
      revision: 0,
      observedAt: sampledAt,
      ingestedAt,
      geometry: { type: "Point", coordinates: [lon, lat] },
      centroid: [lon, lat],
      h3r3: "",
      severity: { rank: 0 },
      kind: "observation",
      entityId: hex,
      sampledAt,
      payload
    });
  }
  return { ok: true, records, dropped };
}

// src/sources/gdacs.ts
var GDACS_ALERT_LEVELS = ["Green", "Orange", "Red"];
var RECENT_EXPIRED_WINDOW_MS = 48 * 36e5;
var GDACS_PAGE_SIZE = 100;
var GDACS_PAGE_CAP = 8;
function gdacsListUrl(level, page = 1) {
  return `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=${level}&pagenumber=${page}&pagesize=${GDACS_PAGE_SIZE}`;
}
function gdacsGeometryUrl(eventType, eventId, episodeId) {
  return `https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=${encodeURIComponent(eventType)}&eventid=${eventId}&episodeid=${episodeId}`;
}
var RANK_BY_LEVEL = { Green: 1, Orange: 2, Red: 4 };
function gdacsUtcIso(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const s = value.trim();
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function numOrNull2(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull2(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function normalizeGdacsList(resp, ingestedAtMs) {
  const features = resp?.features;
  if (!Array.isArray(features)) return { ok: false, reason: "schema" };
  const ingestedAt = new Date(ingestedAtMs).toISOString();
  const records = [];
  let dropped = 0;
  for (const raw of features) {
    const p = raw?.properties ?? {};
    const eventId = numOrNull2(p.eventid);
    const episodeId = numOrNull2(p.episodeid);
    const eventType = strOrNull2(p.eventtype);
    const level = strOrNull2(p.alertlevel);
    const validFrom = gdacsUtcIso(p.fromdate);
    if (eventId === null || episodeId === null || !eventType || !level || !(level in RANK_BY_LEVEL) || !validFrom) {
      dropped += 1;
      continue;
    }
    const coords = raw?.geometry?.coordinates;
    const lonLat = Array.isArray(coords) ? validateLonLat(coords[0], coords[1]) : null;
    if (!lonLat) {
      dropped += 1;
      continue;
    }
    const [lon, lat] = lonLat;
    const observedUntil = gdacsUtcIso(p.todate);
    const isCurrent = p.iscurrent === "true" || p.iscurrent === true;
    const validTo = isCurrent ? null : observedUntil;
    if (!isCurrent && (!observedUntil || Date.parse(observedUntil) < ingestedAtMs - RECENT_EXPIRED_WINDOW_MS)) {
      continue;
    }
    const modified = gdacsUtcIso(p.datemodified) ?? validFrom;
    const payload = {
      type: "weatherAlert",
      event: strOrNull2(p.name),
      headline: strOrNull2(p.severitydata?.severitytext),
      areaDesc: strOrNull2(p.country),
      capSeverity: null,
      gdacsAlertLevel: level,
      gdacsEventType: eventType,
      url: strOrNull2(p.url?.report),
      observedUntil
    };
    const sourceId = `${eventId}:${episodeId}`;
    records.push({
      id: `gdacs:${sourceId}`,
      source: "gdacs",
      sourceId,
      layer: "weather",
      revision: Date.parse(modified),
      observedAt: modified,
      ingestedAt,
      geometry: { type: "Point", coordinates: [lon, lat] },
      centroid: [lon, lat],
      h3r3: "",
      severity: {
        rank: RANK_BY_LEVEL[level],
        raw: numOrNull2(p.severitydata?.severity) ?? void 0,
        label: `${eventType} ${level}`
      },
      kind: "interval",
      validFrom,
      validTo,
      status: isCurrent ? "active" : "expired",
      payload
    });
  }
  return { ok: true, records, dropped };
}
function dedupeGdacs(lists) {
  const byId = /* @__PURE__ */ new Map();
  for (const list of lists) {
    for (const r of list) {
      const prev = byId.get(r.id);
      if (!prev || r.revision >= prev.revision) byId.set(r.id, r);
    }
  }
  return [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const pts = ring.slice(0, -1).filter(
    (c) => Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number"
  );
  if (pts.length === 0) return null;
  const lon = pts.reduce((s, c) => s + c[0], 0) / pts.length;
  const lat = pts.reduce((s, c) => s + c[1], 0) / pts.length;
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
  const points = [];
  let centroid = null;
  let cone = null;
  for (const f of features) {
    const cls = strOrNull2(f?.properties?.Class);
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
      if (pos) points.push({ index: Number(m[1]), pos });
    }
  }
  points.sort((a, b) => a.index - b.index);
  const track = points.length >= 2 ? { type: "LineString", coordinates: points.map((p) => [p.pos[0], p.pos[1]]) } : null;
  return { track, centroid, cone };
}
function tcIdsOf(record) {
  const parts = record.sourceId.split(":");
  if (parts.length !== 2) return null;
  const eventId = Number(parts[0]);
  const episodeId = Number(parts[1]);
  return Number.isInteger(eventId) && Number.isInteger(episodeId) ? { eventId, episodeId } : null;
}
function applyTcGeometry(record, cache) {
  const centroid = cache.centroid ?? record.centroid;
  const withTrack = cache.track === null ? { ...record, centroid } : {
    ...record,
    geometry: cache.track,
    centroid,
    payload: { ...record.payload, gdacsGeometryKind: "track" }
  };
  if (cache.cone === null) return { record: withTrack, cone: null };
  const coneSourceId = `${record.sourceId}:cone`;
  const cone = {
    ...record,
    id: `gdacs:${coneSourceId}`,
    sourceId: coneSourceId,
    geometry: cache.cone,
    centroid,
    payload: { ...record.payload, gdacsGeometryKind: "cone" }
  };
  return { record: withTrack, cone };
}

// src/sources/gdelt.ts
import { unzipSync } from "fflate";
import { inflateRawSync } from "node:zlib";
var GDELT_LASTUPDATE_URL = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt";
var NEWS_GRID_DEG = 0.5;
var COL_NUM_MENTIONS = 31;
var COL_NUM_ARTICLES = 33;
var COL_ACTIONGEO_FULLNAME = 52;
var COL_ACTIONGEO_LAT = 56;
var COL_ACTIONGEO_LON = 57;
var COL_SOURCEURL = 60;
var LAST_NEEDED_COL = COL_SOURCEURL;
function parseLastUpdate(text) {
  const firstLine = text.split("\n")[0] ?? "";
  const url = firstLine.trim().split(/\s+/).pop();
  if (!url || !url.endsWith(".export.CSV.zip")) return null;
  const m = /(\d{14})\.export\.CSV\.zip$/.exec(url);
  if (!m || !m[1]) return null;
  const t = m[1];
  const fileMs = Date.UTC(
    Number(t.slice(0, 4)),
    Number(t.slice(4, 6)) - 1,
    Number(t.slice(6, 8)),
    Number(t.slice(8, 10)),
    Number(t.slice(10, 12)),
    Number(t.slice(12, 14))
  );
  return Number.isFinite(fileMs) ? { url, fileMs } : null;
}
function gdeltRawZipKey(fileMs) {
  return `raw/gdelt/dt=${dtOf(Math.floor(fileMs / 1e3))}/hour=${hourOf(fileMs)}/${fileMs}-export.CSV.zip`;
}
function firstZipEntry(zipBytes) {
  if (zipBytes.length < 22) return null;
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let eocd = -1;
  const scanFloor = Math.max(0, zipBytes.length - 22 - 65535);
  for (let i = zipBytes.length - 22; i >= scanFloor; i -= 1) {
    if (view.getUint32(i, true) === 101010256) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const cd = view.getUint32(eocd + 16, true);
  if (cd + 46 > zipBytes.length || view.getUint32(cd, true) !== 33639248) return null;
  const method = view.getUint16(cd + 10, true);
  const compSize = view.getUint32(cd + 20, true);
  const uncompSize = view.getUint32(cd + 24, true);
  const localOff = view.getUint32(cd + 42, true);
  if (localOff + 30 > zipBytes.length || view.getUint32(localOff, true) !== 67324752) return null;
  const nameLen = view.getUint16(localOff + 26, true);
  const extraLen = view.getUint16(localOff + 28, true);
  const compStart = localOff + 30 + nameLen + extraLen;
  if (compStart + compSize > zipBytes.length) return null;
  return { method, compStart, compSize, uncompSize };
}
function zipUncompressedSize(zipBytes) {
  return firstZipEntry(zipBytes)?.uncompSize ?? null;
}
function extractCsv(zipBytes) {
  const entry = firstZipEntry(zipBytes);
  if (entry) {
    try {
      const comp = zipBytes.subarray(entry.compStart, entry.compStart + entry.compSize);
      const bytes = entry.method === 0 ? comp : entry.method === 8 ? inflateRawSync(comp) : null;
      if (bytes) return new TextDecoder().decode(bytes);
    } catch {
    }
  }
  try {
    const files = unzipSync(zipBytes);
    const name = Object.keys(files)[0];
    const bytes = name ? files[name] : void 0;
    if (!bytes) return null;
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
function pickColumns(line, wanted, out = new Array(wanted.length).fill(""), slotOf) {
  const table = slotOf ?? columnSlotTable(wanted);
  let col = 0;
  let start = 0;
  let found = 0;
  const len = line.length;
  const maxCol = table.length - 1;
  while (start <= len) {
    let end = line.indexOf("	", start);
    if (end < 0) end = len;
    const w = col <= maxCol ? table[col] ?? -1 : -1;
    if (w >= 0) {
      out[w] = line.slice(start, end);
      found += 1;
      if (found === wanted.length) break;
    }
    if (end === len) break;
    col += 1;
    start = end + 1;
    if (col > LAST_NEEDED_COL) break;
  }
  return found === wanted.length ? out : null;
}
function columnSlotTable(wanted) {
  const table = new Int8Array(LAST_NEEDED_COL + 1).fill(-1);
  wanted.forEach((col, slot) => {
    if (col <= LAST_NEEDED_COL) table[col] = slot;
  });
  return table;
}
function trimIfNeeded(value) {
  if (value === "") return "";
  const first = value.charCodeAt(0);
  const last = value.charCodeAt(value.length - 1);
  return first <= 32 || last <= 32 ? value.trim() : value;
}
var WANTED_COLS = [
  COL_NUM_MENTIONS,
  COL_NUM_ARTICLES,
  COL_ACTIONGEO_FULLNAME,
  COL_ACTIONGEO_LAT,
  COL_ACTIONGEO_LON,
  COL_SOURCEURL
];
var WANTED_SLOT_TABLE = columnSlotTable(WANTED_COLS);
var CELL_KEY_STRIDE = 1024;
var cellKeyOf = (lonIdx, latIdx) => (lonIdx + 360) * CELL_KEY_STRIDE + (latIdx + 180);
function newsSeverityRank(count) {
  return count >= 50 ? 3 : count >= 10 ? 2 : 1;
}
function buildNewsRecords(csvText, fileMs, ingestedAtMs) {
  const occurredAt = new Date(fileMs).toISOString();
  const ingestedAt = new Date(ingestedAtMs).toISOString();
  const fileSec = Math.floor(fileMs / 1e3);
  const cells = /* @__PURE__ */ new Map();
  let rows = 0;
  let dropped = 0;
  const colBuf = new Array(WANTED_COLS.length).fill("");
  let lineStart = 0;
  while (lineStart < csvText.length) {
    let lineEnd = csvText.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = csvText.length;
    const line = csvText.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    if (line === "" || line === "\r") continue;
    rows += 1;
    const cols = pickColumns(line, WANTED_COLS, colBuf, WANTED_SLOT_TABLE);
    if (!cols) {
      dropped += 1;
      continue;
    }
    const [mentionsStr, articlesStr, fullName, latStr, lonStr, sourceUrl] = cols;
    if (latStr === "" || lonStr === "") {
      dropped += 1;
      continue;
    }
    const lonLat = validateLonLat(Number(lonStr), Number(latStr));
    if (!lonLat) {
      dropped += 1;
      continue;
    }
    const [lon, lat] = lonLat;
    const lonIdx = Math.floor((lon === 180 ? -180 : lon) / NEWS_GRID_DEG);
    const latIdx = Math.min(Math.floor(lat / NEWS_GRID_DEG), 90 / NEWS_GRID_DEG - 1);
    const key = cellKeyOf(lonIdx, latIdx);
    let cell = cells.get(key);
    if (!cell) {
      cell = { lonIdx, latIdx, articleSum: 0, placeName: null, sampleUrl: null, sampleMentions: -1 };
      cells.set(key, cell);
    }
    const articles = articlesStr === "" ? 0 : Number(articlesStr);
    cell.articleSum += Number.isFinite(articles) && articles > 0 ? articles : 0;
    const mentions = mentionsStr === "" ? 0 : Number(mentionsStr);
    if (mentions > cell.sampleMentions && Number.isFinite(mentions)) {
      cell.sampleMentions = mentions;
      const url = trimIfNeeded(sourceUrl ?? "");
      if (url !== "") cell.sampleUrl = url;
      const place = trimIfNeeded(fullName ?? "");
      if (place !== "") cell.placeName = place;
    }
  }
  const records = [];
  for (const cell of cells.values()) {
    const centerLon = (cell.lonIdx + 0.5) * NEWS_GRID_DEG;
    const centerLat = (cell.latIdx + 0.5) * NEWS_GRID_DEG;
    const payload = {
      type: "news",
      placeName: cell.placeName,
      articleCount: cell.articleSum,
      sampleUrl: cell.sampleUrl
    };
    const sourceId = `${fileSec}:${cell.lonIdx}:${cell.latIdx}`;
    records.push({
      id: `gdelt:${sourceId}`,
      source: "gdelt",
      sourceId,
      layer: "news",
      revision: 0,
      observedAt: occurredAt,
      ingestedAt,
      geometry: { type: "Point", coordinates: [centerLon, centerLat] },
      centroid: [centerLon, centerLat],
      h3r3: "",
      severity: {
        rank: newsSeverityRank(cell.articleSum),
        raw: cell.articleSum,
        unit: "count",
        label: `${cell.articleSum} articles`
      },
      kind: "occurrence",
      occurredAt,
      payload
    });
  }
  records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { ok: true, records, dropped, rows };
}

// src/hash.ts
async function contentHash(records) {
  const canonical = records.map((r) => ({ ...r, ingestedAt: "" })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// src/r2/norm.ts
var mergeById = (existing, incoming) => {
  const byId = /* @__PURE__ */ new Map();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};
var mergeByRevision = (existing, incoming) => {
  const byId = /* @__PURE__ */ new Map();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) {
    const prev = byId.get(r.id);
    if (!prev || r.revision >= prev.revision) byId.set(r.id, r);
  }
  return [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};
async function readPointerShard(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return { shard: { layers: {} }, etag: null };
  const parsed = await obj.json();
  return { shard: { layers: parsed.layers ?? {} }, etag: obj.etag };
}
async function readSlotRecords(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return [];
  const text = await gunzipToText(await obj.arrayBuffer());
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.records) ? parsed.records : [];
}
var MAX_COMMIT_ATTEMPTS = 5;
var MAX_GENERATION_PROBES = 8;
async function maxExistingGeneration(bucket, layer, slot) {
  let maxG = -1;
  for (const prefix of [normSlotPrefix(layer, slot), manifestSlotPrefix(layer, slot)]) {
    let cursor;
    do {
      const page = await bucket.list({ prefix, cursor });
      for (const obj of page.objects) {
        const m = /\.g(\d+)\./.exec(obj.key.slice(prefix.length - 2));
        const g = m ? Number(m[1]) : NaN;
        if (Number.isFinite(g) && g > maxG) maxG = g;
      }
      cursor = page.truncated ? page.cursor : void 0;
    } while (cursor);
  }
  return maxG;
}
var CAS_BACKOFF_MIN_MS = 100;
var CAS_BACKOFF_MAX_MS = 500;
function casBackoffMs() {
  return CAS_BACKOFF_MIN_MS + Math.floor(Math.random() * (CAS_BACKOFF_MAX_MS - CAS_BACKOFF_MIN_MS));
}
async function upsertNormSlot(bucket, layer, slot, slotDurationSec, incoming, merge, meta) {
  const pointerKey = normPointerKey(dtOf(slot));
  const slotKey = String(slot);
  let probeFloor = 0;
  let probesUsed = 0;
  let prepared = null;
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(casBackoffMs());
    const { shard, etag } = await readPointerShard(bucket, pointerKey);
    const current = shard.layers[layer]?.[slotKey];
    const existingRecords = current ? await readSlotRecords(bucket, normKey(layer, slot, current.g)) : [];
    const merged = merge(existingRecords, incoming);
    const hash = await contentHash(merged);
    if (current && current.hash === hash) {
      return { layer, slot, written: false, generation: current.g, records: merged.length };
    }
    let generation;
    if (prepared && prepared.hash === hash && prepared.g > (current?.g ?? -1)) {
      generation = prepared.g;
    } else {
      prepared = null;
      probeFloor = Math.max(probeFloor, current ? current.g + 1 : 0);
      const writtenAt = (/* @__PURE__ */ new Date()).toISOString();
      let issued = -1;
      let jumped = false;
      while (probesUsed < MAX_GENERATION_PROBES) {
        const g = probeFloor;
        probeFloor += 1;
        probesUsed += 1;
        const body = { layer, slot, slotDurationSec, generation: g, writtenAt, records: merged };
        if (!await putIfAbsent(bucket, normKey(layer, slot, g), await gzipText(JSON.stringify(body)))) {
          if (!jumped) {
            jumped = true;
            probeFloor = Math.max(probeFloor, await maxExistingGeneration(bucket, layer, slot) + 1);
          }
          continue;
        }
        const entry = {
          layer,
          slot,
          generation: g,
          writtenAt,
          hash,
          counts: { records: merged.length, incoming: incoming.length, dropped: meta.dropped }
        };
        if (!await putIfAbsent(bucket, manifestEntryKey(layer, slot, g), JSON.stringify(entry))) {
          continue;
        }
        issued = g;
        break;
      }
      if (issued < 0) {
        throw new Error(`norm generation probes exhausted (${MAX_GENERATION_PROBES}): ${pointerKey} ${layer}/${slotKey}`);
      }
      generation = issued;
      prepared = { g: generation, hash };
    }
    const nextShard = {
      layers: {
        ...shard.layers,
        [layer]: { ...shard.layers[layer] ?? {}, [slotKey]: { g: generation, hash } }
      }
    };
    const putOk = await casPut(bucket, pointerKey, JSON.stringify(nextShard), etag);
    if (putOk) return { layer, slot, written: true, generation, records: merged.length };
    const { shard: afterShard } = await readPointerShard(bucket, pointerKey);
    const committed = afterShard.layers[layer]?.[slotKey];
    if (committed && committed.hash === hash) {
      return { layer, slot, written: true, generation: committed.g, records: merged.length };
    }
  }
  throw new Error(`norm slot commit failed after ${MAX_COMMIT_ATTEMPTS} attempts: ${pointerKey} ${layer}/${slotKey}`);
}
async function putIfAbsent(bucket, key, body) {
  const result = await bucket.put(key, body, { onlyIf: { etagDoesNotMatch: "*" } });
  return result !== null;
}
async function casPut(bucket, key, body, etag) {
  if (etag === null) return await putIfAbsent(bucket, key, body);
  const result = await bucket.put(key, body, { onlyIf: { etagMatches: etag } });
  return result !== null;
}

// src/schedule.ts
var REGIONS = [
  { id: "seoul", lat: 37.5, lon: 127 },
  { id: "tokyo", lat: 35.68, lon: 139.77 },
  { id: "london", lat: 51.51, lon: -0.13 },
  { id: "frankfurt", lat: 50, lon: 8.6 },
  { id: "newyork", lat: 40.71, lon: -74.01 },
  { id: "losangeles", lat: 34.05, lon: -118.25 }
];
var FIXED_SLOTS = [
  [0, "quake"],
  [2, "news-fetch"],
  [4, "news-process"],
  [6, "weather-page"],
  [11, "weather-page"],
  [13, "idle"],
  // capacity scan 자리 (03:13 UTC)
  [14, "weather-page"],
  [17, "news-fetch"],
  [19, "news-process"],
  [20, "quake"],
  [22, "weather-page"],
  [26, "weather-page"],
  [30, "weather-page"],
  [32, "news-fetch"],
  [34, "news-process"],
  [36, "weather-page"],
  [40, "quake"],
  [43, "weather-page"],
  [46, "weather-page"],
  [47, "news-fetch"],
  [49, "news-process"],
  [51, "weather-page"],
  [55, "weather-commit"],
  [57, "weather-track"]
];
var MINUTE_TASKS = (() => {
  const fixed = new Map(FIXED_SLOTS.map(([m, k]) => [m, k]));
  const table = [];
  let flightIndex = 0;
  for (let m = 0; m < 60; m += 1) {
    const kind = fixed.get(m);
    if (kind === void 0) {
      const region = REGIONS[flightIndex % REGIONS.length];
      flightIndex += 1;
      if (!region) throw new Error("REGIONS empty");
      table.push({ kind: "flight", region });
      continue;
    }
    if (kind === "flight") throw new Error("FIXED_SLOTS must not declare flight");
    table.push({ kind });
  }
  return table;
})();

// src/r2/latest.ts
var LATEST_V2_PREFIX = "latest/v2/";
function latestLayerKey(layer) {
  return `${LATEST_V2_PREFIX}${layer}.json`;
}
function latestFlightRegionKey(regionId) {
  return `${LATEST_V2_PREFIX}flight/${regionId}.json`;
}
async function putSnapshotIfNewer(bucket, key, asOf, records) {
  const existing = await bucket.head(key);
  const existingAsOf = existing?.customMetadata?.asOf;
  if (existingAsOf !== void 0 && existingAsOf >= asOf) return false;
  const part = { asOf, records };
  await bucket.put(key, JSON.stringify(part), { customMetadata: { asOf } });
  return true;
}
var LATEST_PARTS = [
  { chunk: "earthquake", key: latestLayerKey("earthquake") },
  { chunk: "weather", key: latestLayerKey("weather") },
  { chunk: "news", key: latestLayerKey("news") },
  ...REGIONS.map((r) => ({ chunk: `flight:${r.id}`, key: latestFlightRegionKey(r.id) }))
];

// src/collect.ts
var USGS_TIMEOUT_MS = 15e3;
var ADSB_TIMEOUT_MS = 2e4;
var USGS_RETRY_DELAY_MS = 2e3;
var ADSB_429_RETRY_DELAY_MS = 1e4;
var ADSB_CALL_GAP_MS = 5e3;
async function collectQuakes(env, scheduledMs) {
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  const res = await fetchTextWithRetry(USGS_ALL_HOUR_URL, USGS_TIMEOUT_MS, USGS_RETRY_DELAY_MS);
  if (!res.ok) {
    const detail = { reason: res.reason, status: res.status };
    await writeStatus(env, "earthquake", normSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "earthquake", detail };
  }
  try {
    await env.DATA.put(rawKey("usgs", scheduledMs, "all_hour"), await gzipText(res.text));
    const normalized = normalizeUsgs(JSON.parse(res.text), scheduledMs);
    if (!normalized.ok) {
      const detail = { reason: "schema" };
      await writeStatus(env, "earthquake", normSlot, scheduledMs, "failed", detail);
      return { ok: false, layer: "earthquake", detail };
    }
    const { records, dropped } = normalized;
    const bySlot = /* @__PURE__ */ new Map();
    for (const r of records) {
      const slot = slotStartSec(Date.parse(r.occurredAt), NORM_SLOT_SEC);
      bySlot.set(slot, [...bySlot.get(slot) ?? [], r]);
    }
    const commitSlots = /* @__PURE__ */ new Set([normSlot, normSlot - NORM_SLOT_SEC]);
    let slotsWritten = 0;
    let slotsSkipped = 0;
    for (const [slot, slotRecords] of bySlot) {
      if (!commitSlots.has(slot)) {
        slotsSkipped += 1;
        continue;
      }
      const outcome = await upsertNormSlot(
        env.DATA,
        "earthquake",
        slot,
        NORM_SLOT_SEC,
        slotRecords,
        mergeByRevision,
        { dropped }
      );
      if (outcome.written) slotsWritten += 1;
    }
    const asOf = new Date(scheduledMs).toISOString();
    await putSnapshotIfNewer(env.DATA, latestLayerKey("earthquake"), asOf, records);
    if (records.length === 0) {
      await writeStatus(env, "earthquake", normSlot, scheduledMs, "empty", { dropped });
    }
    return {
      ok: true,
      layer: "earthquake",
      detail: { records: records.length, dropped, slots: bySlot.size, slotsWritten, slotsSkipped }
    };
  } catch (error) {
    const detail = { reason: "exception", error: String(error) };
    await writeStatus(env, "earthquake", normSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "earthquake", detail };
  }
}
var FLIGHT_NORM_DEGRADED = true;
async function collectFlightRegion(env, scheduledMs, region) {
  const bucketTs = slotStartSec(scheduledMs, OBSERVATION_BUCKET_SEC);
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  const asOf = new Date(scheduledMs).toISOString();
  let records = [];
  let dropped = 0;
  let detail;
  let ok = false;
  try {
    const res = await fetchText(pointUrl(region), ADSB_TIMEOUT_MS);
    const retried = !res.ok && res.reason !== "timeout" ? await (async () => {
      await sleep(res.reason === "rate_limited" ? ADSB_429_RETRY_DELAY_MS : ADSB_CALL_GAP_MS);
      return fetchText(pointUrl(region), ADSB_TIMEOUT_MS);
    })() : null;
    const final = retried ?? res;
    if (!final.ok) {
      detail = { region: region.id, reason: final.reason, status: final.status };
    } else {
      await env.DATA.put(rawKey("adsblol", scheduledMs, region.id), await gzipText(final.text));
      const normalized = normalizeAdsb(JSON.parse(final.text), region, bucketTs, scheduledMs);
      if (!normalized.ok) {
        detail = { region: region.id, reason: "schema" };
      } else {
        records = normalized.records;
        dropped = normalized.dropped;
        await putSnapshotIfNewer(env.DATA, latestFlightRegionKey(region.id), asOf, records);
        ok = true;
        detail = { region: region.id, aircraft: records.length, dropped };
      }
    }
  } catch (error) {
    detail = { region: region.id, reason: "exception", error: String(error) };
  }
  let slotOutcome = { skipped: true };
  let normCommitFailed = false;
  if (FLIGHT_NORM_DEGRADED) {
    slotOutcome = { degraded: "raw-only" };
    if (scheduledMs % (NORM_SLOT_SEC * 1e3) < 6e4) {
      await writeStatus(env, "flight", normSlot, scheduledMs, "degraded", {
        reason: "cpu_ladder_raw_only",
        records: records.length
      });
    }
  } else if (records.length > 0) {
    try {
      const outcome = await upsertNormSlot(env.DATA, "flight", normSlot, NORM_SLOT_SEC, records, mergeById, {
        dropped
      });
      slotOutcome = { written: outcome.written, generation: outcome.generation, records: outcome.records };
    } catch (error) {
      normCommitFailed = true;
      slotOutcome = { ok: false, reason: "norm_commit", error: String(error) };
    }
  }
  if (!ok || normCommitFailed || records.length === 0) {
    await writeStatus(env, "flight", normSlot, scheduledMs, !ok || normCommitFailed ? "failed" : "empty", {
      ...normCommitFailed ? { reason: "norm_commit" } : {},
      ...detail,
      records: records.length,
      dropped
    });
  }
  return {
    ok: ok && !normCommitFailed,
    // 데드맨 스위치 신호 — norm 커밋 실패도 비정상 (재리뷰 H2)
    layer: "flight",
    detail: { slot: normSlot, bucketTs, ...detail, norm: slotOutcome }
  };
}
var GDACS_TIMEOUT_MS = 15e3;
var GDACS_RETRY_DELAY_MS = 2e3;
var PAGES_PER_SLOT = 1;
var PAGES_PER_CYCLE = PAGES_PER_SLOT * 10;
var PAGE_ORDER = ["Red", "Orange", "Green"];
var TC_CACHE_TTL_MS = 6 * 36e5;
var TC_PER_SLOT = 1;
function freshProgress(cycleStart, nowMs) {
  const levels = {};
  for (const level of GDACS_ALERT_LEVELS) {
    levels[level] = { pages: 0, current: 0, state: "pending" };
  }
  return { cycleStart, updatedAt: new Date(nowMs).toISOString(), levels };
}
async function readWeatherProgress(env, cycleStart) {
  const obj = await env.DATA.get(weatherProgressKey(cycleStart));
  if (!obj) return null;
  try {
    const parsed = await obj.json();
    if (parsed?.cycleStart !== cycleStart || typeof parsed.levels !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
async function fetchGdacsPage(env, scheduledMs, cycleStart, level, page) {
  const res = await fetchTextWithRetry(gdacsListUrl(level, page), GDACS_TIMEOUT_MS, GDACS_RETRY_DELAY_MS);
  if (!res.ok) return { ok: false, reason: res.reason, status: res.status };
  await env.DATA.put(
    rawKey("gdacs", scheduledMs, `list_${level.toLowerCase()}_p${page}`),
    await gzipText(res.text)
  );
  const parsed = JSON.parse(res.text);
  const features = Array.isArray(parsed.features) ? parsed.features : null;
  if (features === null) return { ok: false, reason: "schema" };
  const normalized = normalizeGdacsList(parsed, scheduledMs);
  if (!normalized.ok) return { ok: false, reason: "schema" };
  let current = 0;
  for (const f of features) {
    const v = f?.properties?.iscurrent;
    if (v === "true" || v === true) current += 1;
  }
  await env.DATA.put(weatherChunkKey(cycleStart, level, page), JSON.stringify(normalized.records));
  return { ok: true, outcome: { records: normalized.records, features: features.length, current } };
}
function nextLevelState(page, outcome) {
  if (outcome.features < GDACS_PAGE_SIZE) return "complete";
  if (outcome.current === 0) return "complete";
  if (page >= GDACS_PAGE_CAP) return "capped";
  return "pending";
}
async function collectWeatherPages(env, scheduledMs) {
  const cycleStart = weatherCycleStartMs(scheduledMs);
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  try {
    const existing = await readWeatherProgress(env, cycleStart);
    const base = existing ?? freshProgress(cycleStart, scheduledMs);
    const levels = { ...base.levels };
    const processed = [];
    let failures = 0;
    for (let n = 0; n < PAGES_PER_SLOT; n += 1) {
      const level = PAGE_ORDER.find((l) => levels[l]?.state === "pending");
      if (level === void 0) break;
      const lp = levels[level] ?? { pages: 0, current: 0, state: "pending" };
      const page = lp.pages + 1;
      const result = await fetchGdacsPage(env, scheduledMs, cycleStart, level, page);
      if (!result.ok) {
        levels[level] = { ...lp, state: "failed", reason: result.reason };
        processed.push({ level, page, ok: false, reason: result.reason, status: result.status });
        failures += 1;
        continue;
      }
      levels[level] = {
        pages: page,
        current: lp.current + result.outcome.current,
        state: nextLevelState(page, result.outcome)
      };
      processed.push({
        level,
        page,
        ok: true,
        records: result.outcome.records.length,
        current: result.outcome.current
      });
    }
    const totalPages = GDACS_ALERT_LEVELS.reduce((sum, l) => sum + (levels[l]?.pages ?? 0), 0);
    if (totalPages >= PAGES_PER_CYCLE) {
      for (const level of GDACS_ALERT_LEVELS) {
        const lp = levels[level];
        if (lp?.state === "pending") levels[level] = { ...lp, state: "capped", reason: "cycle_budget" };
      }
    }
    const progress = {
      cycleStart,
      updatedAt: new Date(scheduledMs).toISOString(),
      levels
    };
    await env.DATA.put(weatherProgressKey(cycleStart), JSON.stringify(progress));
    if (failures > 0) {
      await writeStatus(env, "weather", normSlot, scheduledMs, "partial", {
        phase: "page",
        reason: "page_fetch_failed",
        processed
      });
    }
    return {
      ok: failures === 0,
      layer: "weather",
      detail: { phase: "page", cycleStart, processed, levels }
    };
  } catch (error) {
    const detail = { phase: "page", reason: "exception", error: String(error) };
    await writeStatus(env, "weather", normSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "weather", detail };
  }
}
async function readWeatherChunks(env, cycleStart, levels) {
  const lists = [];
  const missing = [];
  const keys = [];
  for (const level of GDACS_ALERT_LEVELS) {
    const pages = levels[level]?.pages ?? 0;
    for (let page = 1; page <= pages; page += 1) {
      const key = weatherChunkKey(cycleStart, level, page);
      keys.push(key);
      const obj = await env.DATA.get(key);
      if (!obj) {
        missing.push(`${level}:p${page}`);
        continue;
      }
      lists.push(await obj.json());
    }
  }
  return { lists, missing, keys };
}
async function mergeTcGeometry(env, records, nowMs) {
  const out = [];
  const cones = [];
  let tracks = 0;
  let stale = 0;
  let missing = 0;
  for (const record of records) {
    const isActiveTc = record.payload.gdacsEventType === "TC" && record.status === "active";
    const ids = isActiveTc ? tcIdsOf(record) : null;
    if (ids === null) {
      out.push(record);
      continue;
    }
    const obj = await env.DATA.get(tcTrackKey(ids.eventId, ids.episodeId));
    if (!obj) {
      missing += 1;
      out.push(record);
      continue;
    }
    let cache = null;
    try {
      cache = await obj.json();
    } catch {
      cache = null;
    }
    const fetchedAtMs = cache ? Date.parse(cache.fetchedAt) : NaN;
    if (!cache || !Number.isFinite(fetchedAtMs) || nowMs - fetchedAtMs > TC_CACHE_TTL_MS) {
      stale += 1;
      out.push(record);
      continue;
    }
    const applied = applyTcGeometry(record, cache);
    if (applied.record.geometry.type === "LineString") tracks += 1;
    out.push(applied.record);
    if (applied.cone) cones.push(applied.cone);
  }
  return { records: [...out, ...cones], tracks, cones: cones.length, stale, missing };
}
async function collectWeatherCommit(env, scheduledMs) {
  const cycleStart = weatherCycleStartMs(scheduledMs);
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  const asOf = new Date(scheduledMs).toISOString();
  try {
    const progress = await readWeatherProgress(env, cycleStart);
    if (progress === null) {
      const detail = { phase: "commit", reason: "no_progress", cycleStart };
      await writeStatus(env, "weather", normSlot, scheduledMs, "partial", detail);
      return { ok: false, layer: "weather", detail };
    }
    const unfinished = GDACS_ALERT_LEVELS.filter((l) => {
      const state = progress.levels[l]?.state;
      return state === void 0 || state === "pending" || state === "failed";
    });
    if (unfinished.length > 0) {
      const detail = {
        phase: "commit",
        reason: "chain_incomplete",
        cycleStart,
        unfinished,
        levels: progress.levels
      };
      await writeStatus(env, "weather", normSlot, scheduledMs, "partial", detail);
      return { ok: false, layer: "weather", detail };
    }
    const chunks = await readWeatherChunks(env, cycleStart, progress.levels);
    if (chunks.missing.length > 0) {
      const detail = { phase: "commit", reason: "chunk_missing", cycleStart, missing: chunks.missing };
      await writeStatus(env, "weather", normSlot, scheduledMs, "partial", detail);
      return { ok: false, layer: "weather", detail };
    }
    const deduped = dedupeGdacs(chunks.lists);
    const merged = await mergeTcGeometry(env, deduped, scheduledMs);
    const activeTcs = deduped.filter((r) => r.payload.gdacsEventType === "TC" && r.status === "active");
    const outcome = await upsertNormSlot(
      env.DATA,
      "weather",
      normSlot,
      NORM_SLOT_SEC,
      merged.records,
      mergeByRevision,
      { dropped: 0 }
    );
    await putSnapshotIfNewer(env.DATA, latestLayerKey("weather"), asOf, merged.records);
    const index = {
      updatedAt: asOf,
      tcs: activeTcs.flatMap((r) => {
        const ids = tcIdsOf(r);
        return ids ? [{ eventId: ids.eventId, episodeId: ids.episodeId, name: r.payload.event }] : [];
      })
    };
    await env.DATA.put(TC_INDEX_KEY, JSON.stringify(index));
    await Promise.all(
      [...chunks.keys, weatherProgressKey(cycleStart)].map(
        (key) => env.DATA.delete(key).catch(() => void 0)
      )
    );
    const capped = GDACS_ALERT_LEVELS.filter((l) => progress.levels[l]?.state === "capped");
    if (capped.length > 0) {
      await writeStatus(env, "weather", normSlot, scheduledMs, "partial", {
        phase: "commit",
        reason: "page_capped",
        capped,
        records: merged.records.length
      });
    }
    if (merged.stale > 0 || merged.missing > 0) {
      await writeStatus(env, "weather", normSlot, scheduledMs, "degraded", {
        phase: "commit",
        reason: "tc_track_cache",
        stale: merged.stale,
        missing: merged.missing,
        activeTcs: activeTcs.length
      });
    }
    if (merged.records.length === 0) {
      await writeStatus(env, "weather", normSlot, scheduledMs, "empty", {
        phase: "commit",
        pages: chunks.keys.length
      });
    }
    return {
      ok: capped.length === 0,
      layer: "weather",
      detail: {
        phase: "commit",
        cycleStart,
        slot: normSlot,
        pages: chunks.keys.length,
        records: merged.records.length,
        activeTcs: activeTcs.length,
        tracks: merged.tracks,
        cones: merged.cones,
        trackCacheStale: merged.stale,
        trackCacheMissing: merged.missing,
        ...capped.length > 0 ? { capped } : {},
        norm: { written: outcome.written, generation: outcome.generation, records: outcome.records }
      }
    };
  } catch (error) {
    const detail = { phase: "commit", reason: "exception", error: String(error) };
    await writeStatus(env, "weather", normSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "weather", detail };
  }
}
async function collectWeatherTracks(env, scheduledMs) {
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  try {
    const obj = await env.DATA.get(TC_INDEX_KEY);
    if (!obj) {
      return { ok: true, layer: "weather", detail: { phase: "track", reason: "no_index" } };
    }
    const index = await obj.json();
    const tcs = Array.isArray(index?.tcs) ? index.tcs : [];
    if (tcs.length === 0) {
      return { ok: true, layer: "weather", detail: { phase: "track", tcs: 0 } };
    }
    const cycle = Math.floor(scheduledMs / (WEATHER_CYCLE_SEC * 1e3));
    const fetched = [];
    let failures = 0;
    for (let n = 0; n < TC_PER_SLOT; n += 1) {
      const target = tcs[(cycle + n) % tcs.length];
      if (!target) break;
      const res = await fetchTextWithRetry(
        gdacsGeometryUrl("TC", target.eventId, target.episodeId),
        GDACS_TIMEOUT_MS,
        GDACS_RETRY_DELAY_MS
      );
      if (!res.ok) {
        failures += 1;
        fetched.push({ eventId: target.eventId, ok: false, reason: res.reason, status: res.status });
        continue;
      }
      const geometry = buildTcGeometry(JSON.parse(res.text));
      const cache = {
        eventId: target.eventId,
        episodeId: target.episodeId,
        fetchedAt: new Date(scheduledMs).toISOString(),
        track: geometry.track,
        cone: geometry.cone,
        centroid: geometry.centroid
      };
      await env.DATA.put(tcTrackKey(target.eventId, target.episodeId), JSON.stringify(cache));
      fetched.push({
        eventId: target.eventId,
        episodeId: target.episodeId,
        ok: true,
        trackPoints: geometry.track?.coordinates.length ?? 0,
        conePoints: geometry.cone?.coordinates[0]?.length ?? 0
      });
    }
    if (failures > 0) {
      await writeStatus(env, "weather", normSlot, scheduledMs, "partial", {
        phase: "track",
        reason: "geometry_fetch_failed",
        fetched
      });
    }
    return { ok: failures === 0, layer: "weather", detail: { phase: "track", tcs: tcs.length, fetched } };
  } catch (error) {
    const detail = { phase: "track", reason: "exception", error: String(error) };
    await writeStatus(env, "weather", normSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "weather", detail };
  }
}
var GDELT_TIMEOUT_MS = 15e3;
var GDELT_ZIP_TIMEOUT_MS = 3e4;
var GDELT_RETRY_DELAY_MS = 2e3;
var MAX_NEWS_CSV_BYTES = 2 * 1024 * 1024;
async function collectNews(env, scheduledMs) {
  const fallbackSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  const last = await fetchTextWithRetry(GDELT_LASTUPDATE_URL, GDELT_TIMEOUT_MS, GDELT_RETRY_DELAY_MS);
  if (!last.ok) {
    const detail = { phase: "fetch", step: "lastupdate", reason: last.reason, status: last.status };
    await writeStatus(env, "news", fallbackSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "news", detail };
  }
  const ref = parseLastUpdate(last.text);
  if (!ref) {
    const detail = { phase: "fetch", step: "lastupdate-parse", reason: "schema" };
    await writeStatus(env, "news", fallbackSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "news", detail };
  }
  const normSlot = slotStartSec(ref.fileMs, NORM_SLOT_SEC);
  try {
    const zip = await fetchBytes(ref.url, GDELT_ZIP_TIMEOUT_MS);
    if (!zip.ok) {
      const detail = { phase: "fetch", step: "download", reason: zip.reason, status: zip.status, file: ref.url };
      await writeStatus(env, "news", normSlot, scheduledMs, "failed", detail);
      return { ok: false, layer: "news", detail };
    }
    const rawWritten = await putIfAbsent(env.DATA, gdeltRawZipKey(ref.fileMs), zip.bytes);
    return {
      ok: true,
      layer: "news",
      detail: { phase: "fetch", slot: normSlot, file: ref.url, bytes: zip.bytes.byteLength, rawWritten }
    };
  } catch (error) {
    const detail = { phase: "fetch", reason: "exception", error: String(error), file: ref.url };
    await writeStatus(env, "news", normSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "news", detail };
  }
}
async function collectNewsProcess(env, scheduledMs) {
  const fallbackSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  const last = await fetchTextWithRetry(GDELT_LASTUPDATE_URL, GDELT_TIMEOUT_MS, GDELT_RETRY_DELAY_MS);
  if (!last.ok) {
    const detail = { phase: "process", step: "lastupdate", reason: last.reason, status: last.status };
    await writeStatus(env, "news", fallbackSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "news", detail };
  }
  const ref = parseLastUpdate(last.text);
  if (!ref) {
    const detail = { phase: "process", step: "lastupdate-parse", reason: "schema" };
    await writeStatus(env, "news", fallbackSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "news", detail };
  }
  const normSlot = slotStartSec(ref.fileMs, NORM_SLOT_SEC);
  try {
    let zipBytes = null;
    let recovered = false;
    const rawObj = await env.DATA.get(gdeltRawZipKey(ref.fileMs));
    if (rawObj) {
      zipBytes = new Uint8Array(await rawObj.arrayBuffer());
    } else {
      recovered = true;
      const zip = await fetchBytes(ref.url, GDELT_ZIP_TIMEOUT_MS);
      if (!zip.ok) {
        const detail = { phase: "process", step: "download", reason: zip.reason, status: zip.status, file: ref.url };
        await writeStatus(env, "news", normSlot, scheduledMs, "failed", detail);
        return { ok: false, layer: "news", detail };
      }
      await putIfAbsent(env.DATA, gdeltRawZipKey(ref.fileMs), zip.bytes);
      zipBytes = new Uint8Array(zip.bytes);
    }
    const uncompressed = zipUncompressedSize(zipBytes);
    if (uncompressed !== null && uncompressed > MAX_NEWS_CSV_BYTES) {
      const detail = { phase: "process", reason: "too_large", uncompressed, file: ref.url };
      await writeStatus(env, "news", normSlot, scheduledMs, "degraded", detail);
      return { ok: false, layer: "news", detail };
    }
    const csv = extractCsv(zipBytes);
    if (csv === null) {
      const detail = { phase: "process", step: "unzip", reason: "schema", file: ref.url };
      await writeStatus(env, "news", normSlot, scheduledMs, "failed", detail);
      return { ok: false, layer: "news", detail };
    }
    const csvBytes = csv.length;
    const { records, dropped, rows } = buildNewsRecords(csv, ref.fileMs, scheduledMs);
    const outcome = await upsertNormSlot(env.DATA, "news", normSlot, NORM_SLOT_SEC, records, mergeById, {
      dropped
    });
    await putSnapshotIfNewer(env.DATA, latestLayerKey("news"), new Date(ref.fileMs).toISOString(), records);
    if (records.length === 0) {
      await writeStatus(env, "news", normSlot, scheduledMs, "empty", { phase: "process", rows, dropped, file: ref.url });
    }
    return {
      ok: true,
      layer: "news",
      detail: {
        phase: "process",
        slot: normSlot,
        file: ref.url,
        rows,
        csvBytes,
        cells: records.length,
        dropped,
        recovered,
        norm: { written: outcome.written, generation: outcome.generation, records: outcome.records }
      }
    };
  } catch (error) {
    const detail = { phase: "process", reason: "exception", error: String(error), file: ref.url };
    await writeStatus(env, "news", normSlot, scheduledMs, "failed", detail);
    return { ok: false, layer: "news", detail };
  }
}
var MAX_STATUS_ATTEMPTS = 8;
async function writeStatus(env, layer, slot, scheduledMs, outcome, detail) {
  try {
    const body = JSON.stringify({
      layer,
      slot,
      scheduledMs,
      outcome,
      writtenAt: (/* @__PURE__ */ new Date()).toISOString(),
      detail
    });
    for (let attempt = 0; attempt < MAX_STATUS_ATTEMPTS; attempt += 1) {
      if (await putIfAbsent(env.DATA, statusKey(layer, slot, scheduledMs, attempt), body)) return;
    }
    console.log(JSON.stringify({ statusWriteFailed: { layer, slot, reason: "attempts_exhausted" } }));
  } catch (error) {
    console.log(JSON.stringify({ statusWriteFailed: { layer, slot, error: String(error) } }));
  }
}

// test/fake-r2.ts
function toBytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  return new Uint8Array(value);
}
function objectOf(key, stored) {
  const bytes = stored.body;
  return {
    key,
    etag: stored.etag,
    size: stored.size,
    uploaded: stored.uploaded,
    customMetadata: stored.customMetadata,
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}
var FakeR2 = class {
  store = /* @__PURE__ */ new Map();
  /** put 직전 훅 — 경합(다른 invocation의 선행 쓰기) 시뮬레이션용. seed()는 훅을 우회한다. */
  hooks = {};
  /** list 페이지 크기 상한 — pagination 경로 강제용 (실 R2의 limit보다 작게 자를 수 있음) */
  maxPageSize = 1e3;
  putCount = 0;
  seq = 0;
  /** 훅·조건 없이 직접 주입 (경쟁자 쓰기·사전 상태 세팅) */
  seed(key, value, sizeOverride, customMetadata) {
    const body = toBytes(value);
    this.store.set(key, {
      body,
      etag: `"e${this.seq += 1}"`,
      size: sizeOverride ?? body.byteLength,
      uploaded: new Date((this.seq += 1) * 1e3),
      customMetadata
    });
  }
  textOf(key) {
    const stored = this.store.get(key);
    return stored ? new TextDecoder().decode(stored.body) : null;
  }
  jsonOf(key) {
    const text = this.textOf(key);
    return text === null ? null : JSON.parse(text);
  }
  async get(key) {
    const stored = this.store.get(key);
    return stored ? objectOf(key, stored) : null;
  }
  async head(key) {
    const stored = this.store.get(key);
    return stored ? {
      key,
      etag: stored.etag,
      size: stored.size,
      uploaded: stored.uploaded,
      customMetadata: stored.customMetadata
    } : null;
  }
  async put(key, value, options) {
    await this.hooks.beforePut?.(key);
    const existing = this.store.get(key);
    const cond = options?.onlyIf;
    if (cond) {
      if (cond.etagMatches !== void 0 && (!existing || existing.etag !== cond.etagMatches)) {
        return null;
      }
      if (cond.etagDoesNotMatch === "*" && existing) return null;
    }
    this.putCount += 1;
    const body = toBytes(value);
    const stored = {
      body,
      etag: `"e${this.seq += 1}"`,
      size: body.byteLength,
      uploaded: new Date((this.seq += 1) * 1e3),
      customMetadata: options?.customMetadata
    };
    this.store.set(key, stored);
    return objectOf(key, stored);
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list(options) {
    const prefix = options?.prefix ?? "";
    const limit = Math.min(options?.limit ?? 1e3, this.maxPageSize);
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((k) => {
        const stored = this.store.get(k);
        if (!stored) throw new Error(`fake list race: ${k}`);
        return { key: k, size: stored.size, etag: stored.etag };
      }),
      truncated,
      cursor: truncated ? String(start + limit) : void 0
    };
  }
  keysWithPrefix(prefix) {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
};
function asBucket(fake) {
  return fake;
}

// bench/slot-cpu.ts
var fileCache = /* @__PURE__ */ new Map();
function readFixture(path) {
  const hit = fileCache.get(path);
  if (hit !== void 0) return hit;
  const body = existsSync(path) ? readFileSync(path, "utf8") : "";
  fileCache.set(path, body);
  return body;
}
var FX = process.env.LWP_FX_DIR ?? "";
function gdacsFeature(i, level, current) {
  return {
    type: "Feature",
    bbox: [-1.5 + i * 0.01, 5.2, -1.4 + i * 0.01, 5.3],
    geometry: { type: "Point", coordinates: [-1.45 + i * 0.01, 5.25] },
    properties: {
      eventtype: i % 7 === 0 ? "TC" : "FL",
      eventid: 1e6 + i,
      episodeid: 1 + i % 3,
      eventname: "",
      glide: `FL-2026-000${i}-XYZ`,
      name: `Flood in Region ${i} (level ${level})`,
      description: `Flooding reported in area ${i} with moderate impact and displaced population estimates pending further assessment from local authorities.`,
      htmldescription: `<b>Flood</b> in area ${i} \u2014 impact assessment pending, displaced population unknown, river levels above seasonal average.`,
      icon: "https://www.gdacs.org/images/gdacs_icons/maps/Green/FL.png",
      iconoverall: "https://www.gdacs.org/images/gdacs_icons/maps/Green/FL.png",
      url: {
        geometry: `https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=FL&eventid=${1e6 + i}&episodeid=1`,
        report: `https://www.gdacs.org/report.aspx?eventid=${1e6 + i}&episodeid=1&eventtype=FL`,
        details: `https://www.gdacs.org/flooddetail.aspx?eventid=${1e6 + i}`
      },
      alertlevel: level,
      alertscore: 1,
      episodealertlevel: level,
      episodealertscore: 1,
      istemporary: "false",
      iscurrent: current ? "true" : "false",
      country: `Country ${i % 40}`,
      fromdate: "2026-08-17T00:00:00",
      todate: "2026-08-19T00:00:00",
      datemodified: "2026-08-19T05:22:24",
      iso3: "",
      source: "GDACS",
      sourceid: "",
      severitydata: { severity: 1 + i % 5, severitytext: `Flood severity ${i % 5}`, severityunit: "units" },
      affectedcountries: [{ iso3: "GHA", countryname: `Country ${i % 40}` }]
    }
  };
}
var GDACS_CURRENT_BY_PAGE = {
  Green: [100, 100, 100, 93, 32, 0, 0, 0],
  Orange: [1],
  Red: [0]
};
var GDACS_FEATURES_BY_PAGE = {
  Green: [100, 100, 100, 100, 100, 100, 100, 100],
  Orange: [76],
  Red: [22]
};
function synthGdacsPage(level, page) {
  const total = GDACS_FEATURES_BY_PAGE[level]?.[page - 1] ?? 0;
  const current = GDACS_CURRENT_BY_PAGE[level]?.[page - 1] ?? 0;
  const features = Array.from(
    { length: total },
    (_, i) => gdacsFeature(page * 1e3 + i, level, i < current)
  );
  return JSON.stringify({ type: "FeatureCollection", features });
}
function gdacsPage(level, page) {
  if (FX) {
    const body = readFixture(`${FX}/gdacs-${level}-p${page}.json`);
    if (body.length > 0) return body;
    return JSON.stringify({ type: "FeatureCollection", features: [] });
  }
  return synthGdacsPage(level, page);
}
function usgsBody() {
  if (FX) {
    const body = readFixture(`${FX}/usgs-all-hour.json`);
    if (body.length > 0) return body;
  }
  const features = Array.from({ length: 120 }, (_, i) => ({
    type: "Feature",
    id: `us700${i}`,
    properties: {
      mag: 1 + i % 50 / 10,
      place: `10 km SW of Somewhere ${i}`,
      time: Date.now() - i * 25e3,
      updated: Date.now() - i * 2e4,
      magType: "ml",
      tsunami: 0,
      status: "automatic",
      url: `https://earthquake.usgs.gov/earthquakes/eventpage/us700${i}`
    },
    geometry: { type: "Point", coordinates: [-120 + i * 0.3, 35 + i % 20 * 0.2, 5 + i % 15] }
  }));
  return JSON.stringify({ type: "FeatureCollection", features });
}
function adsbBody() {
  if (FX) {
    const body = readFixture(`${FX}/adsb-point.json`);
    if (body.length > 0) return body;
  }
  const ac = Array.from({ length: 900 }, (_, i) => ({
    hex: (8126464 + i).toString(16),
    flight: `ABC${i}   `,
    lat: 35 + i % 100 * 0.02,
    lon: 139 + i % 100 * 0.02,
    alt_baro: 1e3 + i * 10,
    gs: 220 + i % 200,
    track: i * 7 % 360,
    t: "A320",
    r: `JA${i}`,
    category: "A3",
    seen_pos: 1.2
  }));
  return JSON.stringify({ ac, total: ac.length, now: Date.now() / 1e3 });
}
var GDELT_LAST = () => {
  const fileTs = "20260819231500";
  return `238000 abcdef http://data.gdeltproject.org/gdeltv2/${fileTs}.export.CSV.zip
1 x http://data.gdeltproject.org/gdeltv2/${fileTs}.mentions.CSV.zip
1 x http://data.gdeltproject.org/gdeltv2/${fileTs}.gkg.csv.zip
`;
};
var newsZip = null;
function exportRow(i) {
  const cols = new Array(61).fill("");
  cols[0] = `12345${i}`;
  cols[1] = "20260819";
  cols[31] = String(5 + i % 20);
  cols[33] = String(1 + i % 9);
  cols[52] = `City ${i % 240}, Region, Country`;
  cols[56] = (34 + i % 240 * 0.21).toFixed(4);
  cols[57] = (128 + i % 240 * 0.19).toFixed(4);
  cols[60] = `https://example.com/news/article-${i}-with-a-fairly-long-path-segment`;
  return cols.join("	");
}
async function buildNewsZip() {
  if (newsZip) return newsZip;
  const { zipSync, strToU8 } = await import("fflate");
  if (FX) {
    const body = readFixture(`${FX}/gdelt-export.CSV`);
    if (body.length > 0) {
      newsZip = zipSync({ "20260819231500.export.CSV": strToU8(body) }, { level: 1 });
      return newsZip;
    }
  }
  const rows = Array.from({ length: 2200 }, (_, i) => exportRow(i)).join("\n");
  newsZip = zipSync({ "20260819231500.export.CSV": strToU8(rows) }, { level: 1 });
  return newsZip;
}
function installFetch() {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("earthquake.usgs.gov")) return new Response(usgsBody(), { status: 200 });
    if (url.includes("api.adsb.lol")) return new Response(adsbBody(), { status: 200 });
    if (url.includes("geteventlist")) {
      const u = new URL(url);
      const level = u.searchParams.get("alertlevel") ?? "Green";
      const page = Number(u.searchParams.get("pagenumber") ?? "1");
      return new Response(gdacsPage(level, page), { status: 200 });
    }
    if (url.includes("getgeometry")) {
      const body = FX ? readFixture(`${FX}/gdacs-geometry.json`) : "";
      if (body.length > 0) return new Response(body, { status: 200 });
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), { status: 200 });
    }
    if (url.includes("lastupdate")) return new Response(GDELT_LAST(), { status: 200 });
    if (url.includes("export.CSV.zip")) {
      const bytes = await buildNewsZip();
      return new Response(bytes, { status: 200 });
    }
    throw new Error(`bench: unexpected fetch ${url}`);
  };
}
async function measure(slot, run) {
  const c0 = process.cpuUsage();
  const w0 = performance.now();
  const detail = await run();
  const c1 = process.cpuUsage(c0);
  return {
    slot,
    cpuMs: Math.round((c1.user + c1.system) / 1e3 * 10) / 10,
    wallMs: Math.round(performance.now() - w0),
    detail
  };
}
var WEATHER_PAGE_MINUTES = [6, 11, 14, 22, 26, 30, 36, 43, 46, 51];
var COMMIT_MINUTE = 55;
var TRACK_MINUTE = 57;
var CYCLE_MS = 60 * 6e4;
async function main() {
  installFetch();
  const fake = new FakeR2();
  const env = { DATA: asBucket(fake) };
  const t0 = Date.UTC(2026, 7, 19, 12, 0, 0);
  const results = [];
  const warm = new FakeR2();
  await collectQuakes({ DATA: asBucket(warm) }, t0);
  for (const m of WEATHER_PAGE_MINUTES) await collectWeatherPages({ DATA: asBucket(warm) }, t0 + m * 6e4);
  await collectWeatherCommit({ DATA: asBucket(warm) }, t0 + COMMIT_MINUTE * 6e4);
  await collectWeatherTracks({ DATA: asBucket(warm) }, t0 + TRACK_MINUTE * 6e4);
  await collectNews({ DATA: asBucket(warm) }, t0 + 2 * 6e4);
  await collectNewsProcess({ DATA: asBucket(warm) }, t0 + 4 * 6e4);
  const r0 = REGIONS[0];
  if (r0) await collectFlightRegion({ DATA: asBucket(warm) }, t0 + 1 * 6e4, r0);
  results.push(await measure("quake", () => collectQuakes(env, t0)));
  const region = REGIONS[0];
  if (region) {
    results.push(await measure(`flight:${region.id}`, () => collectFlightRegion(env, t0 + 6e4, region)));
  }
  results.push(await measure("news-fetch", () => collectNews(env, t0 + 2 * 6e4)));
  results.push(await measure("news-process", () => collectNewsProcess(env, t0 + 4 * 6e4)));
  for (const m of WEATHER_PAGE_MINUTES) {
    results.push(await measure(`weather-page(m=${m})`, () => collectWeatherPages(env, t0 + m * 6e4)));
  }
  results.push(await measure("weather-commit", () => collectWeatherCommit(env, t0 + COMMIT_MINUTE * 6e4)));
  results.push(await measure("weather-track", () => collectWeatherTracks(env, t0 + TRACK_MINUTE * 6e4)));
  for (const m of WEATHER_PAGE_MINUTES) await collectWeatherPages(env, t0 + CYCLE_MS + m * 6e4);
  results.push(
    await measure(
      "weather-commit(tracks)",
      () => collectWeatherCommit(env, t0 + CYCLE_MS + COMMIT_MINUTE * 6e4)
    )
  );
  results.push(await measure("quake(2nd)", () => collectQuakes(env, t0 + 20 * 6e4)));
  for (const m of WEATHER_PAGE_MINUTES.slice(0, 4)) {
    results.push(
      await measure(`weather-page(3rd,m=${m})`, () => collectWeatherPages(env, t0 + 2 * CYCLE_MS + m * 6e4))
    );
  }
  results.push(await measure("weather-track(2nd)", () => collectWeatherTracks(env, t0 + CYCLE_MS + TRACK_MINUTE * 6e4)));
  const rows = results.map((r) => ({ slot: r.slot, cpuMs: r.cpuMs, wallMs: r.wallMs }));
  process.stdout.write(`${JSON.stringify({ fixtures: FX || "synthetic", rows }, null, 2)}
`);
  for (const r of results) {
    process.stdout.write(`# ${r.slot} detail: ${JSON.stringify(r.detail)}
`);
  }
  const over = rows.filter((r) => r.cpuMs > 8);
  if (over.length > 0) {
    process.stdout.write(`OVER_BUDGET ${JSON.stringify(over.map((r) => r.slot))}
`);
    process.exitCode = 1;
  }
}
await main();

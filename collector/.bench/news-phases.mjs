// bench/news-phases.ts
import { readFileSync, existsSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";

// src/sources/gdelt.ts
import { unzipSync } from "fflate";
import { inflateRawSync } from "node:zlib";

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

// ../shared/src/r2-keys.ts
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
function normKey(layer, slot2, generation) {
  return `norm/${layer}/dt=${dtOf(slot2)}/slot=${slot2}.g${generation}.json.gz`;
}
function manifestEntryKey(layer, slot2, generation) {
  return `manifest/${layer}/dt=${dtOf(slot2)}/slot=${slot2}.g${generation}.json`;
}
function normSlotPrefix(layer, slot2) {
  return `norm/${layer}/dt=${dtOf(slot2)}/slot=${slot2}.g`;
}
function manifestSlotPrefix(layer, slot2) {
  return `manifest/${layer}/dt=${dtOf(slot2)}/slot=${slot2}.g`;
}
function normPointerKey(dt) {
  return `manifest/pointers/norm/dt=${dt}.json`;
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

// src/sources/gdelt.ts
var NEWS_GRID_DEG = 0.5;
var COL_NUM_MENTIONS = 31;
var COL_NUM_ARTICLES = 33;
var COL_ACTIONGEO_FULLNAME = 52;
var COL_ACTIONGEO_LAT = 56;
var COL_ACTIONGEO_LON = 57;
var COL_SOURCEURL = 60;
var LAST_NEEDED_COL = COL_SOURCEURL;
function gdeltRawZipKey(fileMs2) {
  return `raw/gdelt/dt=${dtOf(Math.floor(fileMs2 / 1e3))}/hour=${hourOf(fileMs2)}/${fileMs2}-export.CSV.zip`;
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
  wanted.forEach((col, slot2) => {
    if (col <= LAST_NEEDED_COL) table[col] = slot2;
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
function buildNewsRecords(csvText, fileMs2, ingestedAtMs) {
  const occurredAt = new Date(fileMs2).toISOString();
  const ingestedAt = new Date(ingestedAtMs).toISOString();
  const fileSec = Math.floor(fileMs2 / 1e3);
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

// src/gzip.ts
import { gunzipSync, gzipSync } from "node:zlib";
var GZIP_LEVEL = 1;
async function gzipText(text2) {
  const out = gzipSync(new TextEncoder().encode(text2), { level: GZIP_LEVEL });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
async function gunzipToText(data) {
  return new TextDecoder().decode(gunzipSync(new Uint8Array(data)));
}

// src/hash.ts
async function contentHash(records) {
  const canonical = records.map((r) => ({ ...r, ingestedAt: "" })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// src/http.ts
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/r2/norm.ts
var mergeById = (existing, incoming) => {
  const byId = /* @__PURE__ */ new Map();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
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
  const text2 = await gunzipToText(await obj.arrayBuffer());
  const parsed = JSON.parse(text2);
  return Array.isArray(parsed.records) ? parsed.records : [];
}
var MAX_COMMIT_ATTEMPTS = 5;
var MAX_GENERATION_PROBES = 8;
async function maxExistingGeneration(bucket, layer, slot2) {
  let maxG = -1;
  for (const prefix of [normSlotPrefix(layer, slot2), manifestSlotPrefix(layer, slot2)]) {
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
async function upsertNormSlot(bucket, layer, slot2, slotDurationSec, incoming, merge, meta) {
  const pointerKey = normPointerKey(dtOf(slot2));
  const slotKey = String(slot2);
  let probeFloor = 0;
  let probesUsed = 0;
  let prepared = null;
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(casBackoffMs());
    const { shard, etag } = await readPointerShard(bucket, pointerKey);
    const current = shard.layers[layer]?.[slotKey];
    const existingRecords = current ? await readSlotRecords(bucket, normKey(layer, slot2, current.g)) : [];
    const merged = merge(existingRecords, incoming);
    const hash = await contentHash(merged);
    if (current && current.hash === hash) {
      return { layer, slot: slot2, written: false, generation: current.g, records: merged.length };
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
        const body = { layer, slot: slot2, slotDurationSec, generation: g, writtenAt, records: merged };
        if (!await putIfAbsent(bucket, normKey(layer, slot2, g), await gzipText(JSON.stringify(body)))) {
          if (!jumped) {
            jumped = true;
            probeFloor = Math.max(probeFloor, await maxExistingGeneration(bucket, layer, slot2) + 1);
          }
          continue;
        }
        const entry = {
          layer,
          slot: slot2,
          generation: g,
          writtenAt,
          hash,
          counts: { records: merged.length, incoming: incoming.length, dropped: meta.dropped }
        };
        if (!await putIfAbsent(bucket, manifestEntryKey(layer, slot2, g), JSON.stringify(entry))) {
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
    if (putOk) return { layer, slot: slot2, written: true, generation, records: merged.length };
    const { shard: afterShard } = await readPointerShard(bucket, pointerKey);
    const committed = afterShard.layers[layer]?.[slotKey];
    if (committed && committed.hash === hash) {
      return { layer, slot: slot2, written: true, generation: committed.g, records: merged.length };
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
    const text2 = this.textOf(key);
    return text2 === null ? null : JSON.parse(text2);
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
function asBucket(fake2) {
  return fake2;
}

// bench/news-phases.ts
var FX = process.env.LWP_FX_DIR ?? "";
function csvBody() {
  if (FX && existsSync(`${FX}/gdelt-export.CSV`)) return readFileSync(`${FX}/gdelt-export.CSV`, "utf8");
  const row = (i) => {
    const cols = new Array(61).fill("");
    cols[31] = String(5 + i % 20);
    cols[33] = String(1 + i % 9);
    cols[52] = `City ${i % 240}, Region, Country`;
    cols[56] = (34 + i % 240 * 0.21).toFixed(4);
    cols[57] = (128 + i % 240 * 0.19).toFixed(4);
    cols[60] = `https://example.com/news/article-${i}-with-a-fairly-long-path-segment`;
    return cols.join("	");
  };
  return Array.from({ length: 2200 }, (_, i) => row(i)).join("\n");
}
function cpu(label, run) {
  const c0 = process.cpuUsage();
  const out = run();
  const c1 = process.cpuUsage(c0);
  process.stdout.write(`${label.padEnd(22)} ${Math.round((c1.user + c1.system) / 1e3 * 10) / 10}ms
`);
  return out;
}
async function cpuAsync(label, run) {
  const c0 = process.cpuUsage();
  const out = await run();
  const c1 = process.cpuUsage(c0);
  process.stdout.write(`${label.padEnd(22)} ${Math.round((c1.user + c1.system) / 1e3 * 10) / 10}ms
`);
  return out;
}
var csv = csvBody();
var zip = zipSync({ "20260819231500.export.CSV": strToU8(csv) }, { level: 1 });
var fileMs = Date.UTC(2026, 7, 19, 23, 15, 0);
process.stdout.write(`csv ${csv.length}B / zip ${zip.byteLength}B
`);
{
  const warm = new FakeR2();
  const t = extractCsv(new Uint8Array(zip));
  const b = buildNewsRecords(t ?? "", fileMs, fileMs);
  const s0 = slotStartSec(fileMs - 36e5, NORM_SLOT_SEC);
  await upsertNormSlot(asBucket(warm), "news", s0, NORM_SLOT_SEC, b.records, mergeById, { dropped: 0 });
  await putSnapshotIfNewer(asBucket(warm), latestLayerKey("news"), new Date(fileMs - 36e5).toISOString(), b.records);
}
var text = cpu("extractCsv(unzip)", () => extractCsv(new Uint8Array(zip)));
var built = cpu("buildNewsRecords", () => buildNewsRecords(text, fileMs, fileMs));
process.stdout.write(`records=${built.records.length} rows=${built.rows}
`);
var fake = new FakeR2();
var slot = slotStartSec(fileMs, NORM_SLOT_SEC);
await cpuAsync(
  "upsertNormSlot",
  () => upsertNormSlot(asBucket(fake), "news", slot, NORM_SLOT_SEC, built.records, mergeById, { dropped: 0 })
);
await cpuAsync(
  "putSnapshotIfNewer",
  () => putSnapshotIfNewer(asBucket(fake), latestLayerKey("news"), new Date(fileMs).toISOString(), built.records)
);
await cpuAsync("rawZip get+decode", async () => {
  fake.seed(gdeltRawZipKey(fileMs), zip);
  const obj = await fake.get(gdeltRawZipKey(fileMs));
  return new Uint8Array(await obj.arrayBuffer());
});
await cpuAsync(
  "chunk PUT(\uC815\uADDC\uD654 \uACB0\uACFC)",
  () => fake.put("staging/news/chunk.json", JSON.stringify(built.records))
);

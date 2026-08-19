/** 슬롯별 CPU 실측 벤치 (PLAN §8.7 CPU 사다리 — Free 하드 10ms/invocation).
 *
 *  왜 필요한가: 프로덕션 `wrangler tail`의 cpuTime은 사후 관측이라 설계 중에는 쓸 수 없다.
 *  이 벤치는 각 슬롯 함수를 fake R2 + stub fetch로 돌리고 `process.cpuUsage()`(user+system)를
 *  invocation당으로 재서, 배포 전에 10ms 예산 위반을 잡는다.
 *  M-시리즈 로컬과 Workers 실측은 절대값이 다르지만(과거 비교: 로컬 ≈ 프로덕션의 0.5~0.8배)
 *  슬롯 간 상대 크기와 회귀 방향은 일치했다 — 게이트는 로컬 8ms(=프로덕션 10ms 마진).
 *
 *  실행: `npm run bench:cpu` (LWP_FX_DIR=<실 GDACS/USGS 응답 디렉터리> 지정 시 실 픽스처,
 *  미지정이면 실측 바이트 크기(135KB/100 features)로 캘리브레이션된 합성 픽스처).
 */
import { readFileSync, existsSync } from 'node:fs';

/** 픽스처 파일은 한 번만 읽어 메모리에 둔다 — 디스크 I/O가 슬롯 CPU 측정에 섞이면
 *  (특히 307KB getgeometry) 측정이 실제 Worker 비용보다 부풀려진다. */
const fileCache = new Map<string, string>();
function readFixture(path: string): string {
  const hit = fileCache.get(path);
  if (hit !== undefined) return hit;
  const body = existsSync(path) ? readFileSync(path, 'utf8') : '';
  fileCache.set(path, body);
  return body;
}
import {
  collectFlightRegion,
  collectNews,
  collectNewsProcess,
  collectQuakes,
  collectWeatherCommit,
  collectWeatherPages,
  collectWeatherTracks,
} from '../src/collect';
import { REGIONS } from '../src/schedule';
import { FakeR2, asBucket } from '../test/fake-r2';
import type { Env } from '../src/types';

const FX = process.env.LWP_FX_DIR ?? '';

/* ── 픽스처 ─────────────────────────────────────────────── */

const GDACS_LEVELS = ['Green', 'Orange', 'Red'] as const;

/** 실 GDACS feature 1건 템플릿 — 합성 픽스처의 바이트/필드 형상 기준 */
function gdacsFeature(i: number, level: string, current: boolean) {
  return {
    type: 'Feature',
    bbox: [-1.5 + i * 0.01, 5.2, -1.4 + i * 0.01, 5.3],
    geometry: { type: 'Point', coordinates: [-1.45 + i * 0.01, 5.25] },
    properties: {
      eventtype: i % 7 === 0 ? 'TC' : 'FL',
      eventid: 1000000 + i,
      episodeid: 1 + (i % 3),
      eventname: '',
      glide: `FL-2026-000${i}-XYZ`,
      name: `Flood in Region ${i} (level ${level})`,
      description: `Flooding reported in area ${i} with moderate impact and displaced population estimates pending further assessment from local authorities.`,
      htmldescription: `<b>Flood</b> in area ${i} — impact assessment pending, displaced population unknown, river levels above seasonal average.`,
      icon: 'https://www.gdacs.org/images/gdacs_icons/maps/Green/FL.png',
      iconoverall: 'https://www.gdacs.org/images/gdacs_icons/maps/Green/FL.png',
      url: {
        geometry: `https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=FL&eventid=${1000000 + i}&episodeid=1`,
        report: `https://www.gdacs.org/report.aspx?eventid=${1000000 + i}&episodeid=1&eventtype=FL`,
        details: `https://www.gdacs.org/flooddetail.aspx?eventid=${1000000 + i}`,
      },
      alertlevel: level,
      alertscore: 1,
      episodealertlevel: level,
      episodealertscore: 1,
      istemporary: 'false',
      iscurrent: current ? 'true' : 'false',
      country: `Country ${i % 40}`,
      fromdate: '2026-08-17T00:00:00',
      todate: '2026-08-19T00:00:00',
      datemodified: '2026-08-19T05:22:24',
      iso3: '',
      source: 'GDACS',
      sourceid: '',
      severitydata: { severity: 1.0 + (i % 5), severitytext: `Flood severity ${i % 5}`, severityunit: 'units' },
      affectedcountries: [{ iso3: 'GHA', countryname: `Country ${i % 40}` }],
    },
  };
}

/** 페이지 크기·current 분포를 2026-08-19 실측에 맞춤 (Green 6페이지에서 current 소진) */
const GDACS_CURRENT_BY_PAGE: Record<string, number[]> = {
  Green: [100, 100, 100, 93, 32, 0, 0, 0],
  Orange: [1],
  Red: [0],
};
const GDACS_FEATURES_BY_PAGE: Record<string, number[]> = {
  Green: [100, 100, 100, 100, 100, 100, 100, 100],
  Orange: [76],
  Red: [22],
};

function synthGdacsPage(level: string, page: number): string {
  const total = GDACS_FEATURES_BY_PAGE[level]?.[page - 1] ?? 0;
  const current = GDACS_CURRENT_BY_PAGE[level]?.[page - 1] ?? 0;
  const features = Array.from({ length: total }, (_, i) =>
    gdacsFeature(page * 1000 + i, level, i < current),
  );
  return JSON.stringify({ type: 'FeatureCollection', features });
}

function gdacsPage(level: string, page: number): string {
  if (FX) {
    const body = readFixture(`${FX}/gdacs-${level}-p${page}.json`);
    if (body.length > 0) return body;
    return JSON.stringify({ type: 'FeatureCollection', features: [] });
  }
  return synthGdacsPage(level, page);
}

function usgsBody(): string {
  if (FX) {
    const body = readFixture(`${FX}/usgs-all-hour.json`);
    if (body.length > 0) return body;
  }
  const features = Array.from({ length: 120 }, (_, i) => ({
    type: 'Feature',
    id: `us700${i}`,
    properties: {
      mag: 1 + (i % 50) / 10,
      place: `10 km SW of Somewhere ${i}`,
      time: Date.now() - i * 25_000,
      updated: Date.now() - i * 20_000,
      magType: 'ml',
      tsunami: 0,
      status: 'automatic',
      url: `https://earthquake.usgs.gov/earthquakes/eventpage/us700${i}`,
    },
    geometry: { type: 'Point', coordinates: [-120 + i * 0.3, 35 + (i % 20) * 0.2, 5 + (i % 15)] },
  }));
  return JSON.stringify({ type: 'FeatureCollection', features });
}

function adsbBody(): string {
  if (FX) {
    const body = readFixture(`${FX}/adsb-point.json`);
    if (body.length > 0) return body;
  }
  const ac = Array.from({ length: 900 }, (_, i) => ({
    hex: (0x7c0000 + i).toString(16),
    flight: `ABC${i}   `,
    lat: 35 + (i % 100) * 0.02,
    lon: 139 + (i % 100) * 0.02,
    alt_baro: 1000 + i * 10,
    gs: 220 + (i % 200),
    track: (i * 7) % 360,
    t: 'A320',
    r: `JA${i}`,
    category: 'A3',
    seen_pos: 1.2,
  }));
  return JSON.stringify({ ac, total: ac.length, now: Date.now() / 1000 });
}

/* ── stub fetch ─────────────────────────────────────────── */

const GDELT_LAST = () => {
  const fileTs = '20260819231500';
  return `238000 abcdef http://data.gdeltproject.org/gdeltv2/${fileTs}.export.CSV.zip\n1 x http://data.gdeltproject.org/gdeltv2/${fileTs}.mentions.CSV.zip\n1 x http://data.gdeltproject.org/gdeltv2/${fileTs}.gkg.csv.zip\n`;
};

let newsZip: Uint8Array | null = null;
/** 실 GDELT export 규모에 맞춘 합성 CSV — 61컬럼 중 실제로 쓰는 컬럼만 채운다
 *  (실측 2026-08-19: 447KB / 약 2,200행 / 0.5° 셀 240여 개). 컬럼 인덱스는
 *  sources/gdelt.ts의 COL_* 상수와 일치해야 측정이 유효하다. */
function exportRow(i: number): string {
  const cols = new Array<string>(61).fill('');
  cols[0] = `12345${i}`;
  cols[1] = '20260819';
  cols[31] = String(5 + (i % 20)); // NumMentions
  cols[33] = String(1 + (i % 9)); // NumArticles
  cols[52] = `City ${i % 240}, Region, Country`; // ActionGeo_FullName
  cols[56] = (34 + (i % 240) * 0.21).toFixed(4); // lat
  cols[57] = (128 + (i % 240) * 0.19).toFixed(4); // lon
  cols[60] = `https://example.com/news/article-${i}-with-a-fairly-long-path-segment`;
  return cols.join('\t');
}

async function buildNewsZip(): Promise<Uint8Array> {
  if (newsZip) return newsZip;
  const { zipSync, strToU8 } = await import('fflate');
  if (FX) {
    const body = readFixture(`${FX}/gdelt-export.CSV`);
    if (body.length > 0) {
      newsZip = zipSync({ '20260819231500.export.CSV': strToU8(body) }, { level: 1 });
      return newsZip;
    }
  }
  const rows = Array.from({ length: 2_200 }, (_, i) => exportRow(i)).join('\n');
  newsZip = zipSync({ '20260819231500.export.CSV': strToU8(rows) }, { level: 1 });
  return newsZip;
}

function installFetch(): void {
  (globalThis as { fetch: unknown }).fetch = async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes('earthquake.usgs.gov')) return new Response(usgsBody(), { status: 200 });
    if (url.includes('api.adsb.lol')) return new Response(adsbBody(), { status: 200 });
    if (url.includes('geteventlist')) {
      const u = new URL(url);
      const level = u.searchParams.get('alertlevel') ?? 'Green';
      const page = Number(u.searchParams.get('pagenumber') ?? '1');
      return new Response(gdacsPage(level, page), { status: 200 });
    }
    if (url.includes('getgeometry')) {
      const body = FX ? readFixture(`${FX}/gdacs-geometry.json`) : '';
      if (body.length > 0) return new Response(body, { status: 200 });
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 });
    }
    if (url.includes('lastupdate')) return new Response(GDELT_LAST(), { status: 200 });
    if (url.includes('export.CSV.zip')) {
      const bytes = await buildNewsZip();
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }
    throw new Error(`bench: unexpected fetch ${url}`);
  };
}

/* ── 측정 ───────────────────────────────────────────────── */

interface Measured {
  slot: string;
  cpuMs: number;
  wallMs: number;
  detail?: unknown;
}

async function measure(slot: string, run: () => Promise<unknown>): Promise<Measured> {
  const c0 = process.cpuUsage();
  const w0 = performance.now();
  const detail = await run();
  const c1 = process.cpuUsage(c0);
  return {
    slot,
    cpuMs: Math.round(((c1.user + c1.system) / 1000) * 10) / 10,
    wallMs: Math.round(performance.now() - w0),
    detail,
  };
}

/** schedule.ts FIXED_SLOTS와 같은 분 배정 (weather 사이클 = 60분) */
const WEATHER_PAGE_MINUTES = [6, 11, 14, 22, 26, 30, 36, 43, 46, 51] as const;
const COMMIT_MINUTE = 55;
const TRACK_MINUTE = 57;
const CYCLE_MS = 60 * 60_000;

async function main(): Promise<void> {
  installFetch();
  const fake = new FakeR2();
  const env: Env = { DATA: asBucket(fake) };
  const t0 = Date.UTC(2026, 7, 19, 12, 0, 0);
  const results: Measured[] = [];

  // 워밍업 — JIT/모듈 초기화 비용을 슬롯 측정에서 분리
  const warm = new FakeR2();
  await collectQuakes({ DATA: asBucket(warm) }, t0);
  for (const m of WEATHER_PAGE_MINUTES) await collectWeatherPages({ DATA: asBucket(warm) }, t0 + m * 60_000);
  await collectWeatherCommit({ DATA: asBucket(warm) }, t0 + COMMIT_MINUTE * 60_000);
  await collectWeatherTracks({ DATA: asBucket(warm) }, t0 + TRACK_MINUTE * 60_000);
  await collectNews({ DATA: asBucket(warm) }, t0 + 2 * 60_000);
  await collectNewsProcess({ DATA: asBucket(warm) }, t0 + 4 * 60_000);
  const r0 = REGIONS[0];
  if (r0) await collectFlightRegion({ DATA: asBucket(warm) }, t0 + 1 * 60_000, r0);

  results.push(await measure('quake', () => collectQuakes(env, t0)));
  const region = REGIONS[0];
  if (region) {
    results.push(await measure(`flight:${region.id}`, () => collectFlightRegion(env, t0 + 60_000, region)));
  }
  results.push(await measure('news-fetch', () => collectNews(env, t0 + 2 * 60_000)));
  results.push(await measure('news-process', () => collectNewsProcess(env, t0 + 4 * 60_000)));
  for (const m of WEATHER_PAGE_MINUTES) {
    results.push(await measure(`weather-page(m=${m})`, () => collectWeatherPages(env, t0 + m * 60_000)));
  }
  results.push(await measure('weather-commit', () => collectWeatherCommit(env, t0 + COMMIT_MINUTE * 60_000)));
  results.push(await measure('weather-track', () => collectWeatherTracks(env, t0 + TRACK_MINUTE * 60_000)));
  // 트랙 캐시가 있는 정상상태 커밋 (트랙·콘 합성 경로 포함) — 페이지 적재는 측정 밖
  for (const m of WEATHER_PAGE_MINUTES) await collectWeatherPages(env, t0 + CYCLE_MS + m * 60_000);
  results.push(
    await measure('weather-commit(tracks)', () =>
      collectWeatherCommit(env, t0 + CYCLE_MS + COMMIT_MINUTE * 60_000),
    ),
  );

  // 2주기 — 기존 norm 슬롯/포인터가 있는 상태(정상 정상상태)의 비용
  results.push(await measure('quake(2nd)', () => collectQuakes(env, t0 + 20 * 60_000)));
  for (const m of WEATHER_PAGE_MINUTES.slice(0, 4)) {
    results.push(
      await measure(`weather-page(3rd,m=${m})`, () => collectWeatherPages(env, t0 + 2 * CYCLE_MS + m * 60_000)),
    );
  }
  results.push(await measure('weather-track(2nd)', () => collectWeatherTracks(env, t0 + CYCLE_MS + TRACK_MINUTE * 60_000)));

  const rows = results.map((r) => ({ slot: r.slot, cpuMs: r.cpuMs, wallMs: r.wallMs }));
  process.stdout.write(`${JSON.stringify({ fixtures: FX || 'synthetic', rows }, null, 2)}\n`);
  for (const r of results) {
    process.stdout.write(`# ${r.slot} detail: ${JSON.stringify(r.detail)}\n`);
  }
  const over = rows.filter((r) => r.cpuMs > 8);
  if (over.length > 0) {
    process.stdout.write(`OVER_BUDGET ${JSON.stringify(over.map((r) => r.slot))}\n`);
    process.exitCode = 1;
  }
}

await main();

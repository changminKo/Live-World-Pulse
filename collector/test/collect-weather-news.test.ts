import { afterEach, describe, expect, test, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { collectNews, collectNewsProcess, collectWeather, collectWeatherCommit } from '../src/collect';
import { gunzipToText } from '../src/gzip';
import { GDACS_PAGE_CAP, GDACS_PAGE_SIZE } from '../src/sources/gdacs';
import { GDELT_LASTUPDATE_URL, gdeltRawZipKey } from '../src/sources/gdelt';
import { latestLayerKey } from '../src/r2/latest';
import type { SnapshotPart } from '../src/r2/latest';
import { NORM_SLOT_SEC, normKey, slotStartSec } from '../src/slots';
import type { Env, NewsRecord, WeatherAlertRecord } from '../src/types';
import { FakeR2, asBucket } from './fake-r2';

function makeEnv(fake: FakeR2): Env {
  return { DATA: asBucket(fake) };
}

type FetchStub = (url: string) => Response | Promise<Response>;

function stubFetch(routes: Array<[match: (url: string) => boolean, respond: FetchStub]>) {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    for (const [match, respond] of routes) {
      if (match(url)) return respond(url);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── GDACS fixtures ──────────────────────────────────────────────

const T_WEATHER = Date.UTC(2026, 7, 19, 12, 2, 0); // m%15==2 (fetch 단계)
const T_COMMIT = Date.UTC(2026, 7, 19, 12, 5, 0); // m%15==5 (norm 커밋 단계, 같은 900s 슬롯)

function gdacsFeature(over: Record<string, unknown> = {}) {
  return {
    properties: {
      eventtype: 'FL',
      eventid: 500,
      episodeid: 1,
      name: 'Flood in Testland',
      alertlevel: 'Green',
      fromdate: '2026-08-18T00:00:00',
      todate: '2026-08-20T00:00:00',
      datemodified: '2026-08-19T11:00:00',
      iscurrent: 'true',
      country: 'Testland',
      severitydata: { severity: 1, severitytext: 'test' },
      url: { report: 'https://www.gdacs.org/report' },
      ...over,
    },
    geometry: { type: 'Point', coordinates: [10.0, 20.0] },
  };
}

function listUrlOf(level: string, page = 1): (u: string) => boolean {
  return (u) =>
    u.includes('geteventlist/SEARCH') &&
    u.includes(`alertlevel=${level}&pagenumber=${page}&pagesize=${GDACS_PAGE_SIZE}`);
}

/** 3레벨 정상 응답 스텁 (page 1로 종결) + 호출 카운터 */
function stubGdacsAll(feats: { green?: unknown[]; orange?: unknown[]; red?: unknown[] } = {}) {
  const calls: string[] = [];
  stubFetch([
    [
      (u) => u.includes('geteventlist/SEARCH'),
      (u) => {
        calls.push(u);
        const feature = /alertlevel=Green/.test(u)
          ? feats.green ?? [gdacsFeature()]
          : /alertlevel=Orange/.test(u)
            ? feats.orange ?? []
            : feats.red ?? [];
        return new Response(JSON.stringify({ features: feature }));
      },
    ],
  ]);
  return calls;
}

describe('collectWeather (fetch 단계) — 페이징 + raw 적재 + latest, norm은 커밋 단계로 분리', () => {
  test('전 레벨 성공 → raw 페이지 적재 + latest.weather 파트 교체, norm은 쓰지 않는다', async () => {
    const green = [gdacsFeature()];
    const orange = [
      gdacsFeature({ eventid: 501, alertlevel: 'Orange', eventtype: 'TC', iscurrent: 'false', todate: '2026-08-19T00:00:00' }),
    ];
    stubGdacsAll({ green, orange, red: [] });
    const fake = new FakeR2();

    const summary = await collectWeather(makeEnv(fake), T_WEATHER);

    expect(summary.ok).toBe(true);
    expect(summary.detail.records).toBe(2);
    // norm 커밋 없음 — m%15==5의 collectWeatherCommit 몫
    expect(fake.keysWithPrefix('norm/weather/')).toHaveLength(0);
    // 레벨별 raw p1 3개 + 체인 완주 마커 3개 (재리뷰 High2)
    const rawKeys = fake.keysWithPrefix('raw/gdacs/');
    expect(rawKeys).toHaveLength(6);
    expect(rawKeys.some((k) => k.includes('list_green_p1'))).toBe(true);
    expect(rawKeys.filter((k) => k.includes('_complete'))).toHaveLength(3);
    const latest = fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!;
    expect(latest.records).toHaveLength(2);
  });

  test('100건 초과 레벨은 다음 페이지 fetch — 두 페이지 union (High2 페이징)', async () => {
    const fullPage = Array.from({ length: GDACS_PAGE_SIZE }, (_, i) => gdacsFeature({ eventid: 1000 + i }));
    const secondPage = [gdacsFeature({ eventid: 2000 })];
    const calls: string[] = [];
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => {
          calls.push(u);
          if (/alertlevel=Green&pagenumber=1&/.test(u)) return new Response(JSON.stringify({ features: fullPage }));
          if (/alertlevel=Green&pagenumber=2&/.test(u)) return new Response(JSON.stringify({ features: secondPage }));
          return new Response(JSON.stringify({ features: [] }));
        },
      ],
    ]);
    const fake = new FakeR2();

    const summary = await collectWeather(makeEnv(fake), T_WEATHER);

    expect(summary.ok).toBe(true);
    expect(summary.detail.records).toBe(GDACS_PAGE_SIZE + 1); // 101건 — 단일 콜 100 cap을 넘겼다
    expect(calls.filter((u) => u.includes('alertlevel=Green')).length).toBe(2);
    expect(calls.filter((u) => u.includes('alertlevel=Orange')).length).toBe(1);
    expect(fake.keysWithPrefix('raw/gdacs/').filter((k) => /list_green_p\d/.test(k)).length).toBe(2);
    expect(fake.keysWithPrefix('raw/gdacs/').some((k) => k.includes('list_green_complete'))).toBe(true);
    expect(summary.detail.capped).toBeUndefined();
  });

  test('페이지 캡 도달 시 capped 신호 — detail + status 원장(partial/page_capped)', async () => {
    const fullPage = Array.from({ length: GDACS_PAGE_SIZE }, (_, i) => gdacsFeature({ eventid: 3000 + i }));
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) =>
          /alertlevel=Green/.test(u)
            ? new Response(JSON.stringify({ features: fullPage })) // 항상 가득 — 캡까지 간다
            : new Response(JSON.stringify({ features: [] })),
      ],
    ]);
    const fake = new FakeR2();

    const summary = await collectWeather(makeEnv(fake), T_WEATHER);

    expect(summary.ok).toBe(true); // 캡은 실패가 아니라 잘림 신호
    expect(summary.detail.capped).toEqual(['Green']);
    expect(fake.keysWithPrefix('raw/gdacs/').filter((k) => /list_green_p\d/.test(k)).length).toBe(GDACS_PAGE_CAP);
    const statusKeys = fake.keysWithPrefix('manifest/status/weather/');
    expect(statusKeys).toHaveLength(1);
    const status = fake.jsonOf<{ outcome: string; detail: { reason?: string; capped?: string[] } }>(statusKeys[0]!)!;
    expect(status.outcome).toBe('partial');
    expect(status.detail.reason).toBe('page_capped');
    expect(status.detail.capped).toEqual(['Green']);
  });

  test('한 레벨 429 실패 → partial: latest 보존 + 429 재시도 없음 (콜 1회)', async () => {
    const calls: string[] = [];
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => {
          calls.push(u);
          if (/alertlevel=Orange/.test(u)) return new Response('slow down', { status: 429 });
          return new Response(JSON.stringify({ features: /alertlevel=Green/.test(u) ? [gdacsFeature()] : [] }));
        },
      ],
    ]);
    const fake = new FakeR2();
    const preserved: SnapshotPart<never> = { asOf: '2026-08-19T11:47:00.000Z', records: [] };
    fake.seed(latestLayerKey('weather'), JSON.stringify(preserved), undefined, { asOf: preserved.asOf });

    const summary = await collectWeather(makeEnv(fake), T_WEATHER);

    expect(summary.ok).toBe(false);
    // 429는 재시도 금지 — Orange 콜은 정확히 1회 (리뷰 Low2: 실제 호출 횟수 검증)
    expect(calls.filter((u) => u.includes('alertlevel=Orange')).length).toBe(1);
    // latest는 교체하지 않는다 — 실패 레벨의 경보 소실 방지
    expect(fake.jsonOf<SnapshotPart<never>>(latestLayerKey('weather'))!.asOf).toBe('2026-08-19T11:47:00.000Z');
    const statusKeys = fake.keysWithPrefix('manifest/status/weather/');
    expect(statusKeys).toHaveLength(1);
    expect(fake.jsonOf<{ outcome: string }>(statusKeys[0]!)!.outcome).toBe('partial');
  });

  test('전 레벨 실패 → failed status + ok=false, latest 미기록', async () => {
    stubFetch([[() => true, () => new Response('nope', { status: 429 })]]);
    const fake = new FakeR2();

    const summary = await collectWeather(makeEnv(fake), T_WEATHER);

    expect(summary.ok).toBe(false);
    expect(fake.keysWithPrefix('norm/weather/')).toHaveLength(0);
    expect(fake.store.has(latestLayerKey('weather'))).toBe(false);
    const statusKeys = fake.keysWithPrefix('manifest/status/weather/');
    expect(fake.jsonOf<{ outcome: string }>(statusKeys[0]!)!.outcome).toBe('failed');
  });
});

describe('collectWeatherCommit (커밋 단계) — raw 되읽기 → 트랙 → norm 커밋 → latest 패치', () => {
  const ring = (lon: number, lat: number) => [
    [lon - 0.1, lat - 0.1],
    [lon + 0.1, lat - 0.1],
    [lon + 0.1, lat + 0.1],
    [lon - 0.1, lat + 0.1],
    [lon - 0.1, lat - 0.1],
  ];
  const geom = {
    features: [
      { properties: { Class: 'Point_Polygon_Point_0' }, geometry: { type: 'Polygon', coordinates: [ring(130, 20)] } },
      { properties: { Class: 'Point_Polygon_Point_1' }, geometry: { type: 'Polygon', coordinates: [ring(132, 24)] } },
      { properties: { Class: 'Point_Centroid' }, geometry: { type: 'Point', coordinates: [132, 24] } },
    ],
  };

  test('fetch 단계의 raw 페이지를 되읽어 norm 커밋 + 활성 TC 트랙 LineString + latest 패치', async () => {
    const tc = gdacsFeature({ eventid: 900, episodeid: 3, eventtype: 'TC', alertlevel: 'Red' });
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) =>
          new Response(JSON.stringify({ features: /alertlevel=Red/.test(u) ? [tc] : [gdacsFeature()] })),
      ],
      [(u) => u.includes('getgeometry'), () => new Response(JSON.stringify(geom))],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);

    await collectWeather(env, T_WEATHER); // m2: raw + latest(Point)
    const summary = await collectWeatherCommit(env, T_COMMIT); // m5: norm + 트랙

    expect(summary.ok).toBe(true);
    expect(summary.detail.recovered).toBe(false);
    // norm 슬롯 커밋 — fetch 분과 같은 900s 슬롯
    const slot = slotStartSec(T_WEATHER, NORM_SLOT_SEC);
    expect(slot).toBe(slotStartSec(T_COMMIT, NORM_SLOT_SEC));
    const stored = fake.store.get(normKey('weather', slot, 0));
    expect(stored).toBeDefined();
    const copy = new Uint8Array(stored!.body);
    const file = JSON.parse(await gunzipToText(copy.buffer as ArrayBuffer)) as {
      records: Array<{ id: string; geometry: { type: string } }>;
    };
    const tcRec = file.records.find((r) => r.id === 'gdacs:900:3')!;
    expect(tcRec.geometry.type).toBe('LineString');
    // latest도 트랙 패치 반영 (전 레벨 raw가 있으므로 교체)
    const latest = fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!;
    const latestTc = latest.records.find((r) => r.id === 'gdacs:900:3')!;
    expect(latestTc.geometry.type).toBe('LineString');
    expect(latestTc.centroid).toEqual([132, 24]);
    // geom raw 적재
    expect(fake.keysWithPrefix('raw/gdacs/').some((k) => k.includes('geom_900_3'))).toBe(true);
  });

  test('raw가 없으면(fetch 분 사망) 인라인 재fetch로 복구 — recovered 표시', async () => {
    stubGdacsAll({ green: [gdacsFeature()], orange: [], red: [] });
    const fake = new FakeR2();

    const summary = await collectWeatherCommit(makeEnv(fake), T_COMMIT);

    expect(summary.ok).toBe(true);
    expect(summary.detail.recovered).toBe(true);
    const slot = slotStartSec(T_COMMIT, NORM_SLOT_SEC);
    expect(fake.store.has(normKey('weather', slot, 0))).toBe(true);
  });

  test('중간 페이지 실패 슬롯(마커 없음) → latest 미갱신 + partial 원장 (재리뷰 High2)', async () => {
    // Green: p1 가득 → p2 429 (체인 중단, 마커 없음). Orange/Red: 완주.
    const fullPage = Array.from({ length: GDACS_PAGE_SIZE }, (_, i) => gdacsFeature({ eventid: 4000 + i }));
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => {
          if (/alertlevel=Green&pagenumber=1&/.test(u)) return new Response(JSON.stringify({ features: fullPage }));
          if (/alertlevel=Green&pagenumber=2&/.test(u)) return new Response('slow down', { status: 429 });
          return new Response(JSON.stringify({ features: [] }));
        },
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);
    const preserved: SnapshotPart<never> = { asOf: '2026-08-19T11:47:00.000Z', records: [] };
    fake.seed(latestLayerKey('weather'), JSON.stringify(preserved), undefined, { asOf: preserved.asOf });

    await collectWeather(env, T_WEATHER); // partial fetch — green raw p1은 남는다
    expect(fake.keysWithPrefix('raw/gdacs/').some((k) => k.includes('list_green_p1'))).toBe(true);
    expect(fake.keysWithPrefix('raw/gdacs/').some((k) => k.includes('list_green_complete'))).toBe(false);

    const summary = await collectWeatherCommit(env, T_COMMIT);

    // norm 커밋은 진행 (union — 부분 raw도 히스토리엔 무해), latest는 보존
    expect(summary.ok).toBe(true);
    expect(summary.detail.latestSkipped).toBe(true);
    expect(summary.detail.incomplete).toEqual(['Green']);
    expect(fake.jsonOf<SnapshotPart<never>>(latestLayerKey('weather'))!.asOf).toBe('2026-08-19T11:47:00.000Z');
    // 커밋 단계 partial 원장 — incomplete_levels 사유
    const statuses = fake
      .keysWithPrefix('manifest/status/weather/')
      .map((k) => fake.jsonOf<{ outcome: string; detail: { phase?: string; reason?: string; incomplete?: string[] } }>(k)!);
    const commitPartial = statuses.find((s) => s.detail.phase === 'commit');
    expect(commitPartial?.outcome).toBe('partial');
    expect(commitPartial?.detail.reason).toBe('incomplete_levels');
    expect(commitPartial?.detail.incomplete).toEqual(['Green']);
  });

  test('같은 scheduledMs 재전달: 1차 완주 후 2차 중간 실패 → 마커 선무효화로 complete 오인 방지 (Med2)', async () => {
    const fake = new FakeR2();
    const env = makeEnv(fake);

    // 1차 시도 — 전 레벨 1페이지 완주 (green 마커 pages=1)
    stubGdacsAll({ green: [gdacsFeature()], orange: [], red: [] });
    await collectWeather(env, T_WEATHER);
    expect(fake.keysWithPrefix('raw/gdacs/').some((k) => k.includes('list_green_complete'))).toBe(true);
    const latestAfterFirst = fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!;

    // 2차 시도 (cron 재전달, 같은 scheduledMs) — green p1 가득 → p2 429 (체인 중단).
    // 구버전이면 1차 마커(pages=1)가 남고 p1도 존재해 페이지 수까지 일치 — complete 오인.
    const fullPage = Array.from({ length: GDACS_PAGE_SIZE }, (_, i) => gdacsFeature({ eventid: 5000 + i }));
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => {
          if (/alertlevel=Green&pagenumber=1&/.test(u)) return new Response(JSON.stringify({ features: fullPage }));
          if (/alertlevel=Green&pagenumber=2&/.test(u)) return new Response('slow down', { status: 429 });
          return new Response(JSON.stringify({ features: [] }));
        },
      ],
    ]);
    await collectWeather(env, T_WEATHER);

    // 선무효화 — 2차 시작 시 1차 green 마커 삭제, 체인 실패라 재기록 없음
    expect(fake.keysWithPrefix('raw/gdacs/').some((k) => k.includes('list_green_complete'))).toBe(false);

    const summary = await collectWeatherCommit(env, T_COMMIT);

    expect(summary.ok).toBe(true);
    expect(summary.detail.latestSkipped).toBe(true);
    expect(summary.detail.incomplete).toEqual(['Green']);
    // latest는 1차 시도의 스냅샷 그대로 (혼합 세대 데이터로 덮지 않는다)
    expect(fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!.asOf).toBe(
      latestAfterFirst.asOf,
    );
  });

  test('마커 페이지 수 ≠ 실제 raw 페이지 → complete 불인정 (Med2 — 세대·페이지 대조)', async () => {
    // green 2페이지 완주 → 마커 pages=2, 이후 p2 raw 소실 시뮬레이션
    const fullPage = Array.from({ length: GDACS_PAGE_SIZE }, (_, i) => gdacsFeature({ eventid: 6000 + i }));
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => {
          if (/alertlevel=Green&pagenumber=1&/.test(u)) return new Response(JSON.stringify({ features: fullPage }));
          if (/alertlevel=Green&pagenumber=2&/.test(u))
            return new Response(JSON.stringify({ features: [gdacsFeature({ eventid: 7000 })] }));
          return new Response(JSON.stringify({ features: [] }));
        },
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);

    await collectWeather(env, T_WEATHER);
    const markerKey = fake.keysWithPrefix('raw/gdacs/').find((k) => k.includes('list_green_complete'))!;
    const p2Key = fake.keysWithPrefix('raw/gdacs/').find((k) => k.includes('list_green_p2'))!;
    expect(markerKey).toBeDefined();
    fake.store.delete(p2Key); // 마커는 pages=2 주장, 실제 raw는 p1뿐

    const summary = await collectWeatherCommit(env, T_COMMIT);

    expect(summary.ok).toBe(true);
    expect(summary.detail.latestSkipped).toBe(true);
    expect(summary.detail.incomplete).toEqual(['Green']);
    // latest는 fetch 단계 스냅샷 유지 — 커밋의 트랙 패치 교체가 일어나지 않았다
    expect(fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!.asOf).toBe(
      new Date(T_WEATHER).toISOString(),
    );
  });
});

// ── GDELT fixtures ──────────────────────────────────────────────

const T_NEWS = Date.UTC(2026, 7, 19, 6, 24, 0); // m%15==9 (fetch 단계)
const T_PROCESS = Date.UTC(2026, 7, 19, 6, 26, 0); // m%15==11 (처리 단계)
const FILE_MS = Date.UTC(2026, 7, 19, 6, 15, 0);
const EXPORT_URL = 'http://data.gdeltproject.org/gdeltv2/20260819061500.export.CSV.zip';
const LASTUPDATE_BODY = `76796 md5 ${EXPORT_URL}\n81910 md5 http://data.gdeltproject.org/gdeltv2/20260819061500.mentions.CSV.zip`;

function exportLine(lat: string, lon: string): string {
  const cols = new Array<string>(61).fill('');
  cols[31] = '10';
  cols[33] = '1'; // NumArticles
  cols[52] = 'Tokyo, Tokyo, Japan';
  cols[56] = lat;
  cols[57] = lon;
  cols[60] = 'https://example.com/a';
  return cols.join('\t');
}

function exportZip(): Uint8Array {
  return zipSync({
    '20260819061500.export.CSV': strToU8([exportLine('35.6', '139.7'), exportLine('35.61', '139.71')].join('\n')),
  });
}

function stubGdelt(over?: { zipStatus?: number; zipBody?: Uint8Array }) {
  const zipped = over?.zipBody ?? exportZip();
  const calls = { lastupdate: 0, zip: 0 };
  stubFetch([
    [
      (u) => u === GDELT_LASTUPDATE_URL,
      () => {
        calls.lastupdate += 1;
        return new Response(LASTUPDATE_BODY);
      },
    ],
    [
      (u) => u === EXPORT_URL,
      () => {
        calls.zip += 1;
        return over?.zipStatus
          ? new Response('err', { status: over.zipStatus })
          : new Response(new Uint8Array(zipped).buffer as ArrayBuffer);
      },
    ],
  ]);
  return calls;
}

describe('collectNews (fetch 단계) — raw zip 적재만, 파싱은 처리 단계로 분리', () => {
  test('성공: raw zip 결정론 키 적재 + norm/latest 미기록 (CPU 분할)', async () => {
    stubGdelt();
    const fake = new FakeR2();

    const summary = await collectNews(makeEnv(fake), T_NEWS);

    expect(summary.ok).toBe(true);
    expect(fake.store.has(gdeltRawZipKey(FILE_MS))).toBe(true);
    expect(fake.keysWithPrefix('norm/news/')).toHaveLength(0);
    expect(fake.store.has(latestLayerKey('news'))).toBe(false);
  });

  test('zip 다운로드 실패 → failed status + 재시도 없음 (콜 1회 — 리뷰 Low2)', async () => {
    const calls = stubGdelt({ zipStatus: 500 });
    const fake = new FakeR2();

    const summary = await collectNews(makeEnv(fake), T_NEWS);

    expect(summary.ok).toBe(false);
    expect(calls.zip).toBe(1); // fetchBytes는 재시도 없음
    const statusKeys = fake.keysWithPrefix('manifest/status/news/');
    expect(statusKeys).toHaveLength(1);
    expect(fake.jsonOf<{ outcome: string }>(statusKeys[0]!)!.outcome).toBe('failed');
  });
});

describe('collectNewsProcess (처리 단계) — raw 되읽기 → 셀 집계 → norm + latest', () => {
  test('fetch 단계가 적재한 raw를 되읽어 처리 — zip 재다운로드 없음', async () => {
    const calls = stubGdelt();
    const fake = new FakeR2();
    const env = makeEnv(fake);

    await collectNews(env, T_NEWS);
    const zipCallsAfterFetch = calls.zip;
    const summary = await collectNewsProcess(env, T_PROCESS);

    expect(summary.ok).toBe(true);
    expect(summary.detail.recovered).toBe(false);
    expect(calls.zip).toBe(zipCallsAfterFetch); // raw에서 읽었다 — 업스트림 재호출 없음
    expect(summary.detail.cells).toBe(1); // 같은 0.5° 셀 2행 → 1셀
    const slot = slotStartSec(FILE_MS, NORM_SLOT_SEC); // 파일 시각 기준 슬롯 (06:15)
    expect(fake.store.has(normKey('news', slot, 0))).toBe(true);
    const latest = fake.jsonOf<SnapshotPart<NewsRecord>>(latestLayerKey('news'))!;
    expect(latest.asOf).toBe('2026-08-19T06:15:00.000Z');
    expect(latest.records[0]?.payload.articleCount).toBe(2);
  });

  test('raw가 없으면(fetch 분 사망) 업스트림 재fetch로 복구 — recovered 표시', async () => {
    stubGdelt();
    const fake = new FakeR2();

    const summary = await collectNewsProcess(makeEnv(fake), T_PROCESS);

    expect(summary.ok).toBe(true);
    expect(summary.detail.recovered).toBe(true);
    expect(fake.store.has(gdeltRawZipKey(FILE_MS))).toBe(true);
  });

  test('같은 파일 재처리(lastupdate 정체) → norm g 불변 + latest 단조 스킵 (멱등 수렴)', async () => {
    stubGdelt();
    const fake = new FakeR2();
    const env = makeEnv(fake);

    const first = await collectNewsProcess(env, T_PROCESS);
    const second = await collectNewsProcess(env, T_PROCESS + 15 * 60_000); // 다음 슬롯인데 파일 그대로

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((first.detail.norm as { written: boolean }).written).toBe(true);
    expect((second.detail.norm as { written: boolean }).written).toBe(false);
    expect(fake.keysWithPrefix('norm/news/')).toHaveLength(1); // g0 하나만
  });

  test('zip 구조 이상 → raw는 남기고 파싱만 실패 기록 (원본 보존)', async () => {
    stubFetch([
      [(u) => u === GDELT_LASTUPDATE_URL, () => new Response(LASTUPDATE_BODY)],
      [(u) => u === EXPORT_URL, () => new Response(strToU8('not a zip').buffer as ArrayBuffer)],
    ]);
    const fake = new FakeR2();

    const summary = await collectNewsProcess(makeEnv(fake), T_PROCESS);

    expect(summary.ok).toBe(false);
    expect((summary.detail as { step: string }).step).toBe('unzip');
    expect(fake.store.has(gdeltRawZipKey(FILE_MS))).toBe(true); // 원본은 보존
    expect(fake.keysWithPrefix('norm/news/')).toHaveLength(0);
  });

  test('해제 크기 가드 초과(팻파일) → degraded 기록 + 파싱 스킵 (리뷰 Low2 — 대형 파일 경로)', async () => {
    // 9MB CSV — MAX_NEWS_CSV_BYTES(8MB) 초과. zip은 압축돼 작지만 central directory의
    // 해제 크기로 해제 전에 판정한다.
    const bigCsv = exportLine('35.6', '139.7').repeat(80_000);
    expect(strToU8(bigCsv).byteLength).toBeGreaterThan(8 * 1024 * 1024);
    stubGdelt({ zipBody: zipSync({ 'big.CSV': strToU8(bigCsv) }) });
    const fake = new FakeR2();

    const summary = await collectNewsProcess(makeEnv(fake), T_PROCESS);

    expect(summary.ok).toBe(false);
    expect((summary.detail as { reason: string }).reason).toBe('too_large');
    expect(fake.keysWithPrefix('norm/news/')).toHaveLength(0);
    const statusKeys = fake.keysWithPrefix('manifest/status/news/');
    expect(fake.jsonOf<{ outcome: string }>(statusKeys[0]!)!.outcome).toBe('degraded');
  });
});

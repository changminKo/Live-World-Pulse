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

const T_WEATHER = Date.UTC(2026, 7, 19, 12, 6, 0); // schedule.ts weather-fetch 슬롯
const T_COMMIT = Date.UTC(2026, 7, 19, 12, 9, 0); // weather-commit 슬롯 (같은 900s 슬롯)

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

describe('collectWeather (fetch 슬롯) — 페이징 + raw 적재만 (정규화·latest는 커밋 슬롯)', () => {
  test('전 레벨 성공 → raw 페이지 + 완주 마커. norm·latest는 쓰지 않는다', async () => {
    const green = [gdacsFeature()];
    const orange = [
      gdacsFeature({ eventid: 501, alertlevel: 'Orange', eventtype: 'TC', iscurrent: 'false', todate: '2026-08-19T00:00:00' }),
    ];
    stubGdacsAll({ green, orange, red: [] });
    const fake = new FakeR2();

    const summary = await collectWeather(makeEnv(fake), T_WEATHER);

    expect(summary.ok).toBe(true);
    expect(summary.detail.pages).toBe(3);
    // CPU 사다리 rung ①: fetch 슬롯은 정규화하지 않는다 — norm도 latest도 커밋 슬롯 몫
    expect(fake.keysWithPrefix('norm/weather/')).toHaveLength(0);
    expect(fake.store.has(latestLayerKey('weather'))).toBe(false);
    // 레벨별 raw p1 3개 + 체인 완주 마커 3개 (재리뷰 High2)
    const rawKeys = fake.keysWithPrefix('raw/gdacs/');
    expect(rawKeys).toHaveLength(6);
    expect(rawKeys.some((k) => k.includes('list_green_p1'))).toBe(true);
    expect(rawKeys.filter((k) => k.includes('_complete'))).toHaveLength(3);
  });

  test('100건 가득 + current 있음 → 다음 페이지 fetch (High2 페이징)', async () => {
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
    expect(calls.filter((u) => u.includes('alertlevel=Green')).length).toBe(2);
    expect(calls.filter((u) => u.includes('alertlevel=Orange')).length).toBe(1);
    expect(fake.keysWithPrefix('raw/gdacs/').filter((k) => /list_green_p\d/.test(k)).length).toBe(2);
    expect(fake.keysWithPrefix('raw/gdacs/').some((k) => k.includes('list_green_complete'))).toBe(true);
    expect(summary.detail.capped).toBeUndefined();
  });

  test('가득 찼지만 current가 0인 페이지에서 조기 종료 — 히스토리 페이징 금지 (CPU 사다리)', async () => {
    const currentPage = Array.from({ length: GDACS_PAGE_SIZE }, (_, i) => gdacsFeature({ eventid: 8000 + i }));
    const historyPage = Array.from({ length: GDACS_PAGE_SIZE }, (_, i) =>
      gdacsFeature({ eventid: 9000 + i, iscurrent: 'false', todate: '2026-08-19T00:00:00' }),
    );
    const calls: string[] = [];
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => {
          calls.push(u);
          if (/alertlevel=Green&pagenumber=1&/.test(u)) return new Response(JSON.stringify({ features: currentPage }));
          if (/alertlevel=Green&pagenumber=2&/.test(u)) return new Response(JSON.stringify({ features: historyPage }));
          return new Response(JSON.stringify({ features: [] }));
        },
      ],
    ]);
    const fake = new FakeR2();

    const summary = await collectWeather(makeEnv(fake), T_WEATHER);

    // p2가 전부 히스토리라 p3는 요청하지 않는다 (캡 2라 어차피 멈추지만 신호는 current)
    expect(calls.filter((u) => u.includes('alertlevel=Green')).length).toBe(2);
    expect(summary.detail.capped).toBeUndefined(); // current 0 종료는 잘림이 아니다
  });

  test('페이지 캡 도달 시 capped 신호 — detail + status 원장(partial/page_capped)', async () => {
    const fullPage = Array.from({ length: GDACS_PAGE_SIZE }, (_, i) => gdacsFeature({ eventid: 3000 + i }));
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) =>
          /alertlevel=Green/.test(u)
            ? new Response(JSON.stringify({ features: fullPage })) // 항상 가득 + 전부 current — 캡까지 간다
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

  test('한 레벨 429 실패 → partial + 429 재시도 없음 (콜 1회)', async () => {
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

    const summary = await collectWeather(makeEnv(fake), T_WEATHER);

    expect(summary.ok).toBe(false);
    // 429는 재시도 금지 — Orange 콜은 정확히 1회 (리뷰 Low2: 실제 호출 횟수 검증)
    expect(calls.filter((u) => u.includes('alertlevel=Orange')).length).toBe(1);
    expect(fake.keysWithPrefix('raw/gdacs/').some((k) => k.includes('list_orange_complete'))).toBe(false);
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

describe('collectWeatherCommit (커밋 슬롯) — raw 되읽기 → 정규화 → norm 커밋 → latest', () => {
  test('fetch 슬롯의 raw 페이지를 되읽어 norm 커밋 + latest 교체. TC 트랙은 강등(Point 유지)', async () => {
    const tc = gdacsFeature({ eventid: 900, episodeid: 3, eventtype: 'TC', alertlevel: 'Red' });
    const calls: string[] = [];
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => {
          calls.push(u);
          return new Response(JSON.stringify({ features: /alertlevel=Red/.test(u) ? [tc] : [gdacsFeature()] }));
        },
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);

    await collectWeather(env, T_WEATHER); // raw만
    const summary = await collectWeatherCommit(env, T_COMMIT); // 정규화 + norm + latest

    expect(summary.ok).toBe(true);
    expect(summary.detail.recovered).toBe(false);
    expect(summary.detail.tracks).toBe('degraded');
    expect(summary.detail.activeTcs).toBe(1);
    // rung ② 강등: getgeometry는 호출하지 않는다
    expect(calls.some((u) => u.includes('getgeometry'))).toBe(false);

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
    expect(tcRec.geometry.type).toBe('Point'); // 트랙 강등 — 경보 자체는 살아 있다

    // latest는 커밋 슬롯이 교체한다
    const latest = fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!;
    expect(latest.records.map((r) => r.id).sort()).toEqual(['gdacs:500:1', 'gdacs:900:3']);
    expect(latest.asOf).toBe(new Date(T_COMMIT).toISOString());

    // TC 강등이 원장에 남는다 (숨기지 않는다)
    const degraded = fake
      .keysWithPrefix('manifest/status/weather/')
      .map((k) => fake.jsonOf<{ outcome: string; detail: { reason?: string } }>(k)!)
      .find((st) => st.outcome === 'degraded');
    expect(degraded?.detail.reason).toBe('tc_track_disabled');
  });

  test('미해제(iscurrent) 경보는 validTo=null — todate는 payload.observedUntil 보존', async () => {
    stubGdacsAll({ green: [gdacsFeature()], orange: [], red: [] });
    const fake = new FakeR2();
    const env = makeEnv(fake);

    await collectWeather(env, T_WEATHER);
    await collectWeatherCommit(env, T_COMMIT);

    const latest = fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!;
    const rec = latest.records.find((r) => r.id === 'gdacs:500:1')!;
    expect(rec.status).toBe('active');
    expect(rec.validTo).toBeNull(); // 미해제 — sliceInterval에서 활성으로 남는다
    expect(rec.payload.observedUntil).toBe('2026-08-20T00:00:00.000Z');
  });

  test('raw가 없으면(fetch 분 사망) 인라인 재fetch로 복구 — recovered 표시', async () => {
    stubGdacsAll({ green: [gdacsFeature()], orange: [], red: [] });
    const fake = new FakeR2();

    const summary = await collectWeatherCommit(makeEnv(fake), T_COMMIT);

    expect(summary.ok).toBe(true);
    expect(summary.detail.recovered).toBe(true);
    const slot = slotStartSec(T_COMMIT, NORM_SLOT_SEC);
    expect(fake.store.has(normKey('weather', slot, 0))).toBe(true);
    expect(fake.store.has(latestLayerKey('weather'))).toBe(true);
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
    const commitPartial = statuses.find((st) => st.detail.phase === 'commit' && st.outcome === 'partial');
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
    // latest는 아예 기록되지 않는다 (혼합 세대 데이터로 덮지 않는다)
    expect(fake.store.has(latestLayerKey('weather'))).toBe(false);
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
    expect(fake.store.has(latestLayerKey('weather'))).toBe(false);
  });
});

// ── GDELT fixtures ──────────────────────────────────────────────

const T_NEWS = Date.UTC(2026, 7, 19, 6, 17, 0); // schedule.ts news-fetch 슬롯
const T_PROCESS = Date.UTC(2026, 7, 19, 6, 19, 0); // news-process 슬롯
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

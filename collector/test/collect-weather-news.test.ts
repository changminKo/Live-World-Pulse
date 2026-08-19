import { afterEach, describe, expect, test, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  collectNews,
  collectNewsProcess,
  collectWeatherCommit,
  collectWeatherPages,
  collectWeatherTracks,
} from '../src/collect';
import { gunzipToText } from '../src/gzip';
import { GDACS_PAGE_CAP, GDACS_PAGE_SIZE } from '../src/sources/gdacs';
import type { TcTrackCache } from '../src/sources/gdacs';
import { GDELT_LASTUPDATE_URL, gdeltRawZipKey } from '../src/sources/gdelt';
import { latestLayerKey } from '../src/r2/latest';
import type { SnapshotPart } from '../src/r2/latest';
import {
  NORM_SLOT_SEC,
  TC_INDEX_KEY,
  WEATHER_STAGING_PREFIX,
  normKey,
  slotStartSec,
  tcTrackKey,
  weatherChunkKey,
  weatherCycleStartMs,
  weatherProgressKey,
} from '../src/slots';
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

/** schedule.ts weather-page 슬롯 10개 (분 6~51, flight 사이에 흩어져 있다) — 같은 60분
 *  사이클, 슬롯당 1페이지. commit 55 → track 57. */
const T_PAGE = [6, 11, 14, 22, 26, 30, 36, 43, 46, 51].map((m) => Date.UTC(2026, 7, 19, 12, m, 0));
const T_COMMIT = Date.UTC(2026, 7, 19, 12, 55, 0); // weather-commit 슬롯
const T_TRACK = Date.UTC(2026, 7, 19, 12, 57, 0); // weather-track 슬롯
const CYCLE = weatherCycleStartMs(T_COMMIT);

/** 진행 마커 본문 (collect.ts 내부 타입의 테스트 사본 — 계약 고정용) */
/** collect.ts PAGES_PER_CYCLE (= PAGES_PER_SLOT 1 × weather-page 슬롯 10) 사본 */
const PAGES_PER_CYCLE_EXPECTED = 10;

interface WeatherProgressBody {
  cycleStart: number;
  updatedAt: string;
  levels: Record<string, { pages: number; current: number; state: string; reason?: string }>;
}

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

describe('collectWeatherPages (페이지 슬롯) — 슬롯당 1페이지 fetch + 즉시 정규화 → 청크', () => {
  test('첫 슬롯은 1페이지만 처리하고 청크·진행 마커를 남긴다 (norm·latest 미기록)', async () => {
    stubGdacsAll({ green: [gdacsFeature()], orange: [], red: [] });
    const fake = new FakeR2();

    const summary = await collectWeatherPages(makeEnv(fake), T_PAGE[0]!);

    expect(summary.ok).toBe(true);
    // PAGE_ORDER = 작은 레벨 먼저 (Red → Orange → Green) — 예산 부족 시 Green만 잘리게.
    // 슬롯당 1페이지가 프로덕션 하드 10ms의 안전선이다 (2페이지 = 13ms 실측).
    const processed = summary.detail.processed as Array<{ level: string; page: number }>;
    expect(processed.map((p) => `${p.level}:${p.page}`)).toEqual(['Red:1']);
    // CPU 사다리: 페이지 슬롯은 norm·latest를 건드리지 않는다
    expect(fake.keysWithPrefix('norm/weather/')).toHaveLength(0);
    expect(fake.store.has(latestLayerKey('weather'))).toBe(false);
    // raw 원문 1개 + 정규화 청크 1개 + 진행 마커 1개
    expect(fake.keysWithPrefix('raw/gdacs/')).toHaveLength(1);
    expect(fake.store.has(weatherChunkKey(CYCLE, 'Red', 1))).toBe(true);
    const progress = fake.jsonOf<WeatherProgressBody>(weatherProgressKey(CYCLE))!;
    expect(progress.levels.Red?.state).toBe('complete');
    expect(progress.levels.Orange?.state).toBe('pending'); // 아직 슬롯 예산 밖
    expect(progress.levels.Green?.state).toBe('pending');
  });

  test('다음 슬롯이 진행 마커를 이어받아 남은 레벨을 끝낸다 — 페이지 재요청 없음', async () => {
    const calls = stubGdacsAll({ green: [gdacsFeature()], orange: [], red: [] });
    const fake = new FakeR2();
    const env = makeEnv(fake);

    await collectWeatherPages(env, T_PAGE[0]!); // Red p1
    const afterFirst = calls.length;
    await collectWeatherPages(env, T_PAGE[1]!); // Orange p1
    const summary = await collectWeatherPages(env, T_PAGE[2]!); // Green p1

    expect(afterFirst).toBe(1);
    expect(calls.length).toBe(3);
    expect(calls[2]).toContain('alertlevel=Green');
    const progress = fake.jsonOf<WeatherProgressBody>(weatherProgressKey(CYCLE))!;
    for (const level of ['Green', 'Orange', 'Red']) {
      expect(progress.levels[level]?.state).toBe('complete');
    }
    // 전 레벨 종료 후의 잉여 슬롯은 아무 콜도 하지 않는다
    const idle = await collectWeatherPages(env, T_PAGE[3]!);
    expect(calls.length).toBe(3);
    expect(idle.detail.processed).toEqual([]);
  });

  test('100건 가득 + current 있음 → 다음 페이지로 이어짐 (슬롯 경계 넘어 계속)', async () => {
    const fullPage = Array.from({ length: GDACS_PAGE_SIZE }, (_, i) => gdacsFeature({ eventid: 1000 + i }));
    const calls: string[] = [];
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => {
          calls.push(u);
          if (/alertlevel=Green&pagenumber=1&/.test(u)) return new Response(JSON.stringify({ features: fullPage }));
          if (/alertlevel=Green&pagenumber=2&/.test(u))
            return new Response(JSON.stringify({ features: [gdacsFeature({ eventid: 2000 })] }));
          return new Response(JSON.stringify({ features: [] }));
        },
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);

    for (const t of T_PAGE.slice(0, 4)) await collectWeatherPages(env, t); // Red·Orange·Green p1·p2

    expect(calls.filter((u) => u.includes('alertlevel=Green')).length).toBe(2);
    expect(fake.store.has(weatherChunkKey(CYCLE, 'Green', 2))).toBe(true);
    const progress = fake.jsonOf<WeatherProgressBody>(weatherProgressKey(CYCLE))!;
    expect(progress.levels.Green?.state).toBe('complete');
    expect(progress.levels.Green?.pages).toBe(2);
  });

  test('가득 찼지만 current가 0인 페이지에서 조기 종료 — 히스토리 페이징 금지', async () => {
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
    const env = makeEnv(fake);

    for (const t of T_PAGE.slice(0, 4)) await collectWeatherPages(env, t);

    expect(calls.filter((u) => u.includes('alertlevel=Green')).length).toBe(2);
    const progress = fake.jsonOf<WeatherProgressBody>(weatherProgressKey(CYCLE))!;
    expect(progress.levels.Green?.state).toBe('complete'); // current 0 종료는 잘림이 아니다
  });

  test('캡까지 가득 차면 capped — 이후 커밋이 ok:false + page_capped로 기록한다', async () => {
    const fullPage = Array.from({ length: GDACS_PAGE_SIZE }, (_, i) => gdacsFeature({ eventid: 3000 + i }));
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) =>
          /alertlevel=Green/.test(u)
            ? new Response(JSON.stringify({ features: fullPage })) // 항상 가득 + 전부 current
            : new Response(JSON.stringify({ features: [] })),
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);

    // 슬롯당 1페이지 × 10슬롯 = 사이클 예산 10 소진 (Red·Orange 1장씩 + Green 8장 = 캡)
    for (const t of T_PAGE) await collectWeatherPages(env, t);

    const progress = fake.jsonOf<WeatherProgressBody>(weatherProgressKey(CYCLE))!;
    expect(progress.levels.Green?.state).toBe('capped');
    // Red·Orange가 1페이지씩 먼저 끝나므로 Green이 쓸 수 있는 예산은 8페이지(= GDACS_PAGE_CAP)
    expect(progress.levels.Green?.pages).toBe(GDACS_PAGE_CAP);
  });

  test('레벨 fetch 429 → 그 레벨 failed + 재시도 없음(콜 1회), 다음 레벨은 계속', async () => {
    const calls: string[] = [];
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => {
          calls.push(u);
          if (/alertlevel=Green/.test(u)) return new Response('slow down', { status: 429 });
          return new Response(JSON.stringify({ features: [] })); // Red·Orange는 즉시 complete
        },
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);

    await collectWeatherPages(env, T_PAGE[0]!); // Red 먼저 (PAGE_ORDER)
    await collectWeatherPages(env, T_PAGE[1]!); // Orange
    const summary = await collectWeatherPages(env, T_PAGE[2]!); // Green → 429

    expect(summary.ok).toBe(false);
    expect(calls.filter((u) => u.includes('alertlevel=Green')).length).toBe(1); // 429 재시도 금지
    const progress = fake.jsonOf<WeatherProgressBody>(weatherProgressKey(CYCLE))!;
    expect(progress.levels.Green?.state).toBe('failed');
    expect(progress.levels.Red?.state).toBe('complete'); // 레벨 격리
    const statusKeys = fake.keysWithPrefix('manifest/status/weather/');
    expect(statusKeys).toHaveLength(1);
    expect(fake.jsonOf<{ outcome: string }>(statusKeys[0]!)!.outcome).toBe('partial');
  });
});

describe('collectWeatherCommit (커밋 슬롯) — 완주 마커 게이트 → 청크 union → norm + latest', () => {
  /** 페이지 슬롯을 전부 돌려 사이클을 완주시킨다 */
  async function runCycle(env: Env): Promise<void> {
    for (const t of T_PAGE) await collectWeatherPages(env, t);
  }

  test('전 레벨 완주 → norm 커밋 + latest 교체 + tc-index 발행 + 스테이징 삭제', async () => {
    stubGdacsAll({ green: [gdacsFeature()], orange: [], red: [] });
    const fake = new FakeR2();
    const env = makeEnv(fake);
    await runCycle(env);

    const summary = await collectWeatherCommit(env, T_COMMIT);

    expect(summary.ok).toBe(true);
    expect(summary.detail.records).toBe(1);
    const normKeys = fake.keysWithPrefix('norm/weather/');
    expect(normKeys).toHaveLength(1);
    const part = fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!;
    expect(part.records).toHaveLength(1);
    expect(part.records[0]!.id).toBe('gdacs:500:1');
    // 스테이징은 커밋이 지운다 (잔재는 daily scan이 회수)
    expect(fake.keysWithPrefix(WEATHER_STAGING_PREFIX)).toHaveLength(0);
    expect(fake.store.has(TC_INDEX_KEY)).toBe(true);
  });

  test('진행 마커 없음 → 아무것도 쓰지 않고 partial (다음 사이클 재시도 — Med1)', async () => {
    stubGdacsAll();
    const fake = new FakeR2();

    const summary = await collectWeatherCommit(makeEnv(fake), T_COMMIT);

    expect(summary.ok).toBe(false);
    expect(summary.detail.reason).toBe('no_progress');
    expect(fake.keysWithPrefix('norm/weather/')).toHaveLength(0);
    expect(fake.store.has(latestLayerKey('weather'))).toBe(false);
    const statusKeys = fake.keysWithPrefix('manifest/status/weather/');
    expect(fake.jsonOf<{ outcome: string }>(statusKeys[0]!)!.outcome).toBe('partial');
  });

  test('레벨 하나가 미완주(pending/failed)면 latest를 건드리지 않는다 — 이전 스냅샷 보존', async () => {
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) =>
          /alertlevel=Red/.test(u)
            ? new Response('nope', { status: 429 })
            : new Response(JSON.stringify({ features: /alertlevel=Green/.test(u) ? [gdacsFeature()] : [] })),
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);
    fake.seed(latestLayerKey('weather'), JSON.stringify({ asOf: '2026-08-19T11:00:00.000Z', records: [] }), undefined, {
      asOf: '2026-08-19T11:00:00.000Z',
    });
    await runCycle(env);

    const summary = await collectWeatherCommit(env, T_COMMIT);

    expect(summary.ok).toBe(false);
    expect(summary.detail.reason).toBe('chain_incomplete');
    expect(summary.detail.unfinished).toEqual(['Red']);
    expect(fake.keysWithPrefix('norm/weather/')).toHaveLength(0);
    // 이전 스냅샷 그대로 (부분 데이터로 덮지 않는다)
    const part = fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!;
    expect(part.asOf).toBe('2026-08-19T11:00:00.000Z');
  });

  test('청크가 사라졌으면 partial(chunk_missing) — 결손 데이터로 latest를 덮지 않는다', async () => {
    stubGdacsAll({ green: [gdacsFeature()], orange: [], red: [] });
    const fake = new FakeR2();
    const env = makeEnv(fake);
    await runCycle(env);
    await fake.delete(weatherChunkKey(CYCLE, 'Green', 1));

    const summary = await collectWeatherCommit(env, T_COMMIT);

    expect(summary.ok).toBe(false);
    expect(summary.detail.reason).toBe('chunk_missing');
    expect(fake.store.has(latestLayerKey('weather'))).toBe(false);
  });

  test('capped 사이클 → 데이터는 싣지만 ok:false + status partial/page_capped (Med2)', async () => {
    // 페이지마다 다른 eventid — 잘리기 전까지의 페이지가 전부 실려야 한다 (dedupe로 접히지 않게)
    const greenPage = (page: number): unknown[] =>
      Array.from({ length: GDACS_PAGE_SIZE }, (_, i) => gdacsFeature({ eventid: 3000 + page * 1000 + i }));
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => {
          const m = /alertlevel=Green&pagenumber=(\d+)&/.exec(u);
          return new Response(JSON.stringify({ features: m ? greenPage(Number(m[1])) : [] }));
        },
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);
    await runCycle(env);

    const summary = await collectWeatherCommit(env, T_COMMIT);

    expect(summary.ok).toBe(false); // 잘림을 ok로 기록하지 않는다
    expect(summary.detail.capped).toEqual(['Green']);
    // 사이클 예산 8페이지를 Green이 다 쓴다 (Red·Orange는 1페이지씩 먼저 끝남)
    expect(summary.detail.records).toBe(GDACS_PAGE_SIZE * GDACS_PAGE_CAP);
    expect(fake.store.has(latestLayerKey('weather'))).toBe(true); // 있는 데이터는 노출
    const capped = fake
      .keysWithPrefix('manifest/status/weather/')
      .map((k) => fake.jsonOf<{ outcome: string; detail: { reason?: string } }>(k)!)
      .filter((s) => s.detail.reason === 'page_capped');
    expect(capped).toHaveLength(1);
    expect(capped[0]!.outcome).toBe('partial');
  });

  test('TC 트랙 캐시가 신선하면 지오메트리를 LineString으로 바꾸고 콘 레코드를 파생한다 (High2)', async () => {
    const tc = gdacsFeature({ eventid: 900, episodeid: 3, eventtype: 'TC', alertlevel: 'Red' });
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => new Response(JSON.stringify({ features: /alertlevel=Red/.test(u) ? [tc] : [] })),
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);
    fake.seed(
      tcTrackKey(900, 3),
      JSON.stringify({
        eventId: 900,
        episodeId: 3,
        fetchedAt: new Date(T_COMMIT - 60_000).toISOString(),
        track: { type: 'LineString', coordinates: [[140.9, 21.3], [135.8, 23.3], [130.1, 25.0]] },
        cone: { type: 'Polygon', coordinates: [[[139, 20], [141, 20], [141, 22], [139, 22], [139, 20]]] },
        centroid: [135.8, 23.3],
      }),
    );
    await runCycle(env);

    const summary = await collectWeatherCommit(env, T_COMMIT);

    expect(summary.detail.tracks).toBe(1);
    expect(summary.detail.cones).toBe(1);
    const part = fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!;
    const main = part.records.find((r) => r.id === 'gdacs:900:3')!;
    expect(main.geometry.type).toBe('LineString');
    expect(main.payload.gdacsGeometryKind).toBe('track');
    expect(main.centroid).toEqual([135.8, 23.3]);
    const cone = part.records.find((r) => r.id === 'gdacs:900:3:cone')!;
    expect(cone.geometry.type).toBe('Polygon');
    expect(cone.payload.gdacsGeometryKind).toBe('cone');
    // 파생 레코드는 같은 시간·등급 (슬라이스 결과가 갈리면 안 된다)
    expect(cone.validFrom).toBe(main.validFrom);
    expect(cone.severity.rank).toBe(main.severity.rank);
    // tc-index는 파생 레코드를 담지 않는다 (sourceId 2조각만)
    const index = fake.jsonOf<{ tcs: Array<{ eventId: number }> }>(TC_INDEX_KEY)!;
    expect(index.tcs).toEqual([{ eventId: 900, episodeId: 3, name: 'Flood in Testland' }]);
  });

  test('TC 트랙 캐시가 낡았으면 합성하지 않고 Point 유지 + degraded 기록 (숨기지 않는다)', async () => {
    const tc = gdacsFeature({ eventid: 901, episodeid: 2, eventtype: 'TC', alertlevel: 'Red' });
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => new Response(JSON.stringify({ features: /alertlevel=Red/.test(u) ? [tc] : [] })),
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);
    fake.seed(
      tcTrackKey(901, 2),
      JSON.stringify({
        eventId: 901,
        episodeId: 2,
        fetchedAt: new Date(T_COMMIT - 7 * 3600_000).toISOString(), // TTL 6h 초과
        track: { type: 'LineString', coordinates: [[1, 2], [3, 4]] },
        cone: null,
        centroid: null,
      }),
    );
    await runCycle(env);

    const summary = await collectWeatherCommit(env, T_COMMIT);

    expect(summary.detail.tracks).toBe(0);
    expect(summary.detail.trackCacheStale).toBe(1);
    const part = fake.jsonOf<SnapshotPart<WeatherAlertRecord>>(latestLayerKey('weather'))!;
    expect(part.records.find((r) => r.id === 'gdacs:901:2')!.geometry.type).toBe('Point');
    const degraded = fake
      .keysWithPrefix('manifest/status/weather/')
      .map((k) => fake.jsonOf<{ outcome: string; detail: { reason?: string } }>(k)!)
      .filter((s) => s.outcome === 'degraded');
    expect(degraded[0]!.detail.reason).toBe('tc_track_cache');
  });

  test('캐시 없는 활성 TC → missing 카운트 + Point 유지 (트랙 슬롯이 다음 회전에 채운다)', async () => {
    const tc = gdacsFeature({ eventid: 902, episodeid: 1, eventtype: 'TC', alertlevel: 'Red' });
    stubFetch([
      [
        (u) => u.includes('geteventlist/SEARCH'),
        (u) => new Response(JSON.stringify({ features: /alertlevel=Red/.test(u) ? [tc] : [] })),
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);
    await runCycle(env);

    const summary = await collectWeatherCommit(env, T_COMMIT);

    expect(summary.detail.trackCacheMissing).toBe(1);
    expect(summary.detail.tracks).toBe(0);
  });
});

describe('collectWeatherTracks (트랙 슬롯) — tc-index 회전 + getgeometry 캐시', () => {
  const geometryResponse = {
    features: [
      { properties: { Class: 'Point_Centroid' }, geometry: { type: 'Point', coordinates: [153.7, 9.4] } },
      {
        properties: { Class: 'Point_Polygon_Point_0' },
        geometry: { type: 'Polygon', coordinates: [[[140, 21], [141, 21], [141, 22], [140, 22], [140, 21]]] },
      },
      {
        properties: { Class: 'Point_Polygon_Point_1' },
        geometry: { type: 'Polygon', coordinates: [[[135, 23], [136, 23], [136, 24], [135, 24], [135, 23]]] },
      },
      {
        properties: { Class: 'Poly_Cones' },
        geometry: { type: 'Polygon', coordinates: [[[139, 20], [141, 20], [141, 22], [139, 22], [139, 20]]] },
      },
    ],
  };

  test('인덱스 없으면 아무 콜도 하지 않는다', async () => {
    const calls: string[] = [];
    stubFetch([[() => true, (u) => { calls.push(u); return new Response('{}'); }]]);
    const fake = new FakeR2();

    const summary = await collectWeatherTracks(makeEnv(fake), T_TRACK);

    expect(summary.ok).toBe(true);
    expect(summary.detail.reason).toBe('no_index');
    expect(calls).toHaveLength(0);
  });

  test('getgeometry 1건 → 트랙 LineString + 콘 Polygon 캐시 (추가 콜 0 — 같은 응답)', async () => {
    const calls: string[] = [];
    stubFetch([
      [
        (u) => u.includes('getgeometry'),
        (u) => {
          calls.push(u);
          return new Response(JSON.stringify(geometryResponse));
        },
      ],
    ]);
    const fake = new FakeR2();
    fake.seed(TC_INDEX_KEY, JSON.stringify({ updatedAt: '2026-08-19T12:11:00.000Z', tcs: [{ eventId: 900, episodeId: 3, name: 'TC A' }] }));

    const summary = await collectWeatherTracks(makeEnv(fake), T_TRACK);

    expect(summary.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('eventid=900');
    const cache = fake.jsonOf<TcTrackCache>(tcTrackKey(900, 3))!;
    expect(cache.track?.coordinates).toHaveLength(2);
    expect(cache.cone?.coordinates[0]).toHaveLength(5);
    expect(cache.centroid).toEqual([153.7, 9.4]);
  });

  test('사이클마다 대상이 회전한다 (활성 TC가 여러 건이어도 슬롯 CPU는 1건 고정)', async () => {
    const calls: string[] = [];
    stubFetch([
      [
        (u) => u.includes('getgeometry'),
        (u) => {
          calls.push(u);
          return new Response(JSON.stringify(geometryResponse));
        },
      ],
    ]);
    const fake = new FakeR2();
    fake.seed(
      TC_INDEX_KEY,
      JSON.stringify({
        updatedAt: '2026-08-19T12:11:00.000Z',
        tcs: [
          { eventId: 900, episodeId: 3, name: 'A' },
          { eventId: 901, episodeId: 1, name: 'B' },
        ],
      }),
    );
    const env = makeEnv(fake);

    await collectWeatherTracks(env, T_TRACK);
    await collectWeatherTracks(env, T_TRACK + 30 * 60_000);

    const ids = calls.map((u) => new URL(u).searchParams.get('eventid'));
    expect(new Set(ids).size).toBe(2);
  });

  test('getgeometry 실패 → partial 기록 + 캐시 미기록 (커밋은 Point 폴백)', async () => {
    stubFetch([[(u) => u.includes('getgeometry'), () => new Response('nope', { status: 429 })]]);
    const fake = new FakeR2();
    fake.seed(TC_INDEX_KEY, JSON.stringify({ updatedAt: '2026-08-19T12:11:00.000Z', tcs: [{ eventId: 900, episodeId: 3, name: 'A' }] }));

    const summary = await collectWeatherTracks(makeEnv(fake), T_TRACK);

    expect(summary.ok).toBe(false);
    expect(fake.store.has(tcTrackKey(900, 3))).toBe(false);
    const statusKeys = fake.keysWithPrefix('manifest/status/weather/');
    expect(fake.jsonOf<{ outcome: string; detail: { reason?: string } }>(statusKeys[0]!)!.detail.reason).toBe(
      'geometry_fetch_failed',
    );
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

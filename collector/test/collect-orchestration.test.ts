import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { collectFlightRegion, collectQuakes } from '../src/collect';
import { gunzipToText } from '../src/gzip';
import { REGIONS } from '../src/schedule';
import { pointUrl } from '../src/sources/adsblol';
import { USGS_ALL_HOUR_URL } from '../src/sources/usgs';
import { NORM_SLOT_SEC, normKey, slotStartSec } from '../src/slots';
import { latestFlightRegionKey, latestLayerKey } from '../src/r2/latest';
import type { SnapshotPart } from '../src/r2/latest';
import type { Env, FlightRecord } from '../src/types';
import { FakeR2, asBucket } from './fake-r2';

function makeEnv(fake: FakeR2): Env {
  return { DATA: asBucket(fake) };
}

function aircraft(hex: string) {
  return { hex, lat: 37.44, lon: 126.95, alt_baro: 35000, gs: 400, track: 90, seen_pos: 1 };
}

function usgsFeature(id: string, timeMs: number) {
  return {
    id,
    properties: { mag: 4.2, magType: 'mb', place: 'test', time: timeMs, updated: timeMs, tsunami: 0, status: 'automatic', url: null },
    geometry: { type: 'Point', coordinates: [142.3, 38.1, 10] },
  };
}

interface SlotFile {
  slot: number;
  slotDurationSec: number;
  records: Array<{ id: string; sourceId: string }>;
}

async function readSlotFile(fake: FakeR2, key: string): Promise<SlotFile> {
  const stored = fake.store.get(key);
  expect(stored, `missing norm file: ${key}`).toBeDefined();
  const copy = new Uint8Array(stored!.body); // SharedArrayBuffer 가능성 제거용 복사
  return JSON.parse(await gunzipToText(copy.buffer as ArrayBuffer)) as SlotFile;
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

beforeEach(() => {
  vi.useFakeTimers();
});

/** fake timer 하에서 promise 완료까지 시간 전진 — 지역 간 sleep(5s)·재시도 sleep을 소화 */
async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = promise.finally(() => {
    settled = true;
  });
  while (!settled) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return wrapped;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('collectQuakes — 15분 norm 슬라이스 (H1) + 스키마 격리 (H3)', () => {
  const T = Date.UTC(2026, 7, 19, 12, 3, 0);

  test('occurredAt 기준 900s 슬롯 분배 — slotDurationSec=900', async () => {
    const feed = {
      features: [
        usgsFeature('q1', Date.UTC(2026, 7, 19, 12, 1, 0)), // slot 12:00
        usgsFeature('q2', Date.UTC(2026, 7, 19, 12, 14, 0)), // slot 12:00
        usgsFeature('q3', Date.UTC(2026, 7, 19, 11, 46, 0)), // slot 11:45
      ],
    };
    stubFetch([[
      (u) => u === USGS_ALL_HOUR_URL,
      () => new Response(JSON.stringify(feed), { status: 200 }),
    ]]);
    const fake = new FakeR2();

    const summary = await collectQuakes(makeEnv(fake), T);

    expect(summary.ok).toBe(true);
    expect(summary.detail.slots).toBe(2);
    const slotA = Date.UTC(2026, 7, 19, 12, 0, 0) / 1000;
    const slotB = Date.UTC(2026, 7, 19, 11, 45, 0) / 1000;
    const fileA = await readSlotFile(fake, normKey('earthquake', slotA, 0));
    const fileB = await readSlotFile(fake, normKey('earthquake', slotB, 0));
    expect(fileA.slotDurationSec).toBe(900);
    expect(fileB.slotDurationSec).toBe(900);
    expect(fileA.records.map((r) => r.sourceId).sort()).toEqual(['q1', 'q2']);
    expect(fileB.records.map((r) => r.sourceId)).toEqual(['q3']);
  });

  test('HTTP 200 오류 JSON(schema)은 실패 처리 — latest 보존 + status 원장', async () => {
    stubFetch([[
      (u) => u === USGS_ALL_HOUR_URL,
      () => new Response(JSON.stringify({ error: 'oops' }), { status: 200 }),
    ]]);
    const fake = new FakeR2();
    const preserved: SnapshotPart<never> = { asOf: '2026-08-19T11:00:00.000Z', records: [] };
    fake.seed(latestLayerKey('earthquake'), JSON.stringify(preserved), undefined, {
      asOf: preserved.asOf,
    });

    const summary = await collectQuakes(makeEnv(fake), T);

    expect(summary.ok).toBe(false);
    expect(summary.detail.reason).toBe('schema');
    // latest 파트는 건드리지 않는다
    expect(fake.jsonOf<SnapshotPart<never>>(latestLayerKey('earthquake'))!.asOf).toBe('2026-08-19T11:00:00.000Z');
    // 실패가 immutable status 원장에 남는다
    const statusKeys = fake.keysWithPrefix('manifest/status/earthquake/');
    expect(statusKeys).toHaveLength(1);
    expect(fake.jsonOf<{ outcome: string }>(statusKeys[0]!)!.outcome).toBe('failed');
  });

  test('성공-empty(features:[])는 empty status로 기록 — 갭과 빈 세계 구분', async () => {
    stubFetch([[
      (u) => u === USGS_ALL_HOUR_URL,
      () => new Response(JSON.stringify({ features: [] }), { status: 200 }),
    ]]);
    const fake = new FakeR2();

    const summary = await collectQuakes(makeEnv(fake), T);

    expect(summary.ok).toBe(true);
    const statusKeys = fake.keysWithPrefix('manifest/status/earthquake/');
    expect(statusKeys).toHaveLength(1);
    expect(fake.jsonOf<{ outcome: string }>(statusKeys[0]!)!.outcome).toBe('empty');
  });
});

const R1 = REGIONS[0]!; // seoul
const R2 = REGIONS[2]!; // london

describe('collectFlightRegion — 1지역 1invocation (CPU 사다리 rung ①) + 실패 격리 + 강등', () => {
  const T1 = Date.UTC(2026, 7, 19, 0, 3, 0); // 900s 슬롯 00:00의 첫 분 아님
  const NORM_SLOT = slotStartSec(T1, NORM_SLOT_SEC);

  test('오류 JSON(schema)은 이 지역 latest 파트를 보존하고 failed 원장을 남긴다', async () => {
    stubFetch([
      [(u) => u === pointUrl(R1), () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 200 })],
    ]);
    const fake = new FakeR2();
    const preserved: SnapshotPart<never> = { asOf: '2026-08-19T00:00:00.000Z', records: [] };
    fake.seed(latestFlightRegionKey(R1.id), JSON.stringify(preserved), undefined, { asOf: preserved.asOf });

    const summary = await runWithTimers(collectFlightRegion(makeEnv(fake), T1, R1));

    expect(summary.ok).toBe(false);
    expect(summary.detail).toMatchObject({ region: R1.id, reason: 'schema' });
    expect(fake.jsonOf<SnapshotPart<never>>(latestFlightRegionKey(R1.id))!.asOf).toBe('2026-08-19T00:00:00.000Z');

    const statusKeys = fake.keysWithPrefix('manifest/status/flight/');
    expect(statusKeys).toHaveLength(1);
    expect(fake.jsonOf<{ outcome: string }>(statusKeys[0]!)!.outcome).toBe('failed');
  });

  test('malformed JSON(파싱 예외)도 같은 invocation 안에서 격리 — 예외가 새지 않는다', async () => {
    stubFetch([[(u) => u === pointUrl(R1), () => new Response('not-json{{{', { status: 200 })]]);
    const fake = new FakeR2();

    const summary = await runWithTimers(collectFlightRegion(makeEnv(fake), T1, R1));

    expect(summary.ok).toBe(false);
    expect(summary.detail).toMatchObject({ region: R1.id, reason: 'exception' });
  });

  test('한 지역의 실패가 다음 invocation의 다른 지역과 무관 (invocation 격리)', async () => {
    stubFetch([
      [(u) => u === pointUrl(R1), () => new Response('boom', { status: 500 })],
      [(u) => u === pointUrl(R2), () => new Response(JSON.stringify({ ac: [aircraft('bbb222')] }), { status: 200 })],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);

    const a = await runWithTimers(collectFlightRegion(env, T1, R1));
    const b = await runWithTimers(collectFlightRegion(env, T1 + 60_000, R2));

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
    expect(fake.jsonOf<SnapshotPart<FlightRecord>>(latestFlightRegionKey(R2.id))!.records).toHaveLength(1);
    expect(fake.store.has(latestFlightRegionKey(R1.id))).toBe(false);
  });

  test('CPU 사다리 강등: flight norm은 쓰지 않는다 — raw·latest는 유지 (raw-only)', async () => {
    stubFetch([
      [(u) => u === pointUrl(R1), () => new Response(JSON.stringify({ ac: [aircraft('aaa111')] }), { status: 200 })],
    ]);
    const fake = new FakeR2();

    const summary = await runWithTimers(collectFlightRegion(makeEnv(fake), T1, R1));

    expect(summary.ok).toBe(true);
    expect(summary.detail.norm).toEqual({ degraded: 'raw-only' });
    // norm 히스토리는 쌓이지 않는다 (Time Machine 갭 — 정직 표시)
    expect(fake.keysWithPrefix('norm/flight/')).toHaveLength(0);
    // raw는 적재 유지 (원본 보존) — 1 invocation = 1지역이므로 1개
    expect(fake.keysWithPrefix('raw/adsblol/')).toHaveLength(1);
    expect(fake.jsonOf<SnapshotPart<FlightRecord>>(latestFlightRegionKey(R1.id))!.records).toHaveLength(1);
    expect(NORM_SLOT).toBe(Date.UTC(2026, 7, 19, 0, 0, 0) / 1000);
  });

  test('강등 상태는 슬롯 첫 분에만 degraded 원장 1회 기록', async () => {
    const T0 = Date.UTC(2026, 7, 19, 0, 0, 0); // 슬롯 첫 분
    stubFetch([
      [
        (u) => u === pointUrl(R1) || u === pointUrl(R2),
        () => new Response(JSON.stringify({ ac: [aircraft('eee555')] }), { status: 200 }),
      ],
    ]);
    const fake = new FakeR2();
    const env = makeEnv(fake);

    await runWithTimers(collectFlightRegion(env, T0, R1));
    await runWithTimers(collectFlightRegion(env, T1, R2)); // 같은 슬롯의 첫 분 아님

    const statusKeys = fake.keysWithPrefix('manifest/status/flight/');
    expect(statusKeys).toHaveLength(1);
    const status = fake.jsonOf<{ outcome: string; detail: { reason?: string } }>(statusKeys[0]!)!;
    expect(status.outcome).toBe('degraded');
    expect(status.detail.reason).toBe('cpu_ladder_raw_only');
  });

  test('재시도 타이밍 실측: 429=10s 후 1회, 일반 오류=5s 후 1회', async () => {
    const calls: number[] = [];
    let count = 0;
    stubFetch([
      [
        (u) => u === pointUrl(R1),
        () => {
          calls.push(Date.now());
          count += 1;
          return count === 1
            ? new Response('slow down', { status: 429 })
            : new Response(JSON.stringify({ ac: [] }), { status: 200 });
        },
      ],
    ]);
    const fake = new FakeR2();
    await runWithTimers(collectFlightRegion(makeEnv(fake), T1, R1));
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBe(10_000); // ADSB_429_RETRY_DELAY_MS

    // 일반 오류는 콜 간 최소 간격(5s) 후 1회
    const calls2: number[] = [];
    let count2 = 0;
    stubFetch([
      [
        (u) => u === pointUrl(R2),
        () => {
          calls2.push(Date.now());
          count2 += 1;
          return count2 === 1
            ? new Response('oops', { status: 500 })
            : new Response(JSON.stringify({ ac: [] }), { status: 200 });
        },
      ],
    ]);
    await runWithTimers(collectFlightRegion(makeEnv(new FakeR2()), T1, R2));
    expect(calls2).toHaveLength(2);
    expect(calls2[1]! - calls2[0]!).toBe(5_000);
  });

  test('같은 scheduledMs의 status 중복 기록은 a0/a1로 비켜 쓴다 (immutable — putIfAbsent)', async () => {
    stubFetch([[(u) => u === pointUrl(R1), () => new Response(JSON.stringify({ ac: [] }), { status: 200 })]]);
    const fake = new FakeR2();
    const env = makeEnv(fake);

    await runWithTimers(collectFlightRegion(env, T1, R1)); // empty status a0
    await runWithTimers(collectFlightRegion(env, T1, R1)); // cron 재전달 시뮬레이션 → a1

    const keys = fake.keysWithPrefix('manifest/status/flight/');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain('.a0.json');
    expect(keys[1]).toContain('.a1.json');
  });

  test('fetch 실패 = ok:false + failed status (데드맨 신호)', async () => {
    stubFetch([[(u) => u === pointUrl(R1), () => new Response('slow down', { status: 429 })]]);
    const fake = new FakeR2();

    const summary = await runWithTimers(collectFlightRegion(makeEnv(fake), T1, R1));

    expect(summary.ok).toBe(false);
    const statusKeys = fake.keysWithPrefix('manifest/status/flight/');
    expect(statusKeys).toHaveLength(1);
    expect(fake.jsonOf<{ outcome: string }>(statusKeys[0]!)!.outcome).toBe('failed');
    expect(fake.keysWithPrefix('norm/flight/')).toHaveLength(0);
  });
});

describe('flight latest 스냅샷 타입 가드', () => {
  test('빈 records도 배열로 저장 (프론트 계약)', async () => {
    const T = Date.UTC(2026, 7, 19, 0, 3, 0);
    stubFetch([[(u) => u === pointUrl(R1), () => new Response(JSON.stringify({ ac: [] }), { status: 200 })]]);
    const fake = new FakeR2();
    await runWithTimers(collectFlightRegion(makeEnv(fake), T, R1));

    const part = fake.jsonOf<SnapshotPart<FlightRecord>>(latestFlightRegionKey(R1.id))!;
    expect(Array.isArray(part.records)).toBe(true);
  });
});

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CAPACITY_LIMIT_BYTES,
  isHalted,
  isScanSlot,
  runDailyCapacityScan,
} from '../src/r2/capacity';
import { HALT_KEY, capacityKey } from '../src/slots';
import { FakeR2, asBucket } from './fake-r2';
import type { CapacityRecord } from '../src/r2/capacity';

describe('daily capacity scan (H4 — §8.6 fail-safe)', () => {
  const T = Date.UTC(2026, 7, 19, 3, 7, 0);

  test('스캔 슬롯 = UTC 03:07 정확히 1분', () => {
    expect(isScanSlot(Date.UTC(2026, 7, 19, 3, 7, 0))).toBe(true);
    expect(isScanSlot(Date.UTC(2026, 7, 19, 3, 7, 59))).toBe(true);
    expect(isScanSlot(Date.UTC(2026, 7, 19, 3, 8, 0))).toBe(false);
    expect(isScanSlot(Date.UTC(2026, 7, 19, 4, 7, 0))).toBe(false);
    expect(isScanSlot(Date.UTC(2026, 7, 19, 0, 7, 0))).toBe(false);
  });

  test('prefix별 paginated LIST 합산 → capacity 기록, 한도 내면 halt 없음', async () => {
    const fake = new FakeR2();
    fake.maxPageSize = 2; // pagination 경로 강제 (5키 → 3페이지)
    for (let i = 0; i < 5; i += 1) fake.seed(`raw/usgs/f${i}.json.gz`, 'x', 100);
    fake.seed('norm/flight/a.json.gz', 'x', 250);
    fake.seed('latest.json', 'x', 50);

    const record = await runDailyCapacityScan(asBucket(fake), T);

    expect(record.totalBytes).toBe(5 * 100 + 250 + 50);
    expect(record.overLimit).toBe(false);
    expect(record.perPrefix['raw/']).toEqual({ bytes: 500, objects: 5 });
    expect(record.perPrefix['norm/']).toEqual({ bytes: 250, objects: 1 });
    // 실측 기록이 manifest/capacity/dt=에 남는다
    const written = fake.jsonOf<CapacityRecord>(capacityKey('2026-08-19'))!;
    expect(written.totalBytes).toBe(record.totalBytes);
    expect(await isHalted(asBucket(fake))).toBe(false);
    // 형식 전환 기록도 함께 보장 (일 1회 경로) — cutoff epoch 계약 포함 (재리뷰 Med1)
    const transition = fake.jsonOf<{ cutoffEpochSec: number; contract: string }>(
      'manifest/format/norm-slot-900.json',
    )!;
    expect(transition.cutoffEpochSec).toBe(1_787_079_821); // 2026-08-18T19:03:41Z 전환 배포
    expect(transition.contract).toContain('slotDurationSec');
  });

  test('halt PUT이 capacity 기록 PUT보다 먼저 — 기록 실패에도 fail-safe는 선다 (재리뷰 Med2)', async () => {
    const fake = new FakeR2();
    fake.seed('norm/flight/huge.json.gz', 'x', CAPACITY_LIMIT_BYTES + 1);
    fake.hooks.beforePut = (key) => {
      if (key === capacityKey('2026-08-19')) throw new Error('capacity record write down');
    };

    await expect(runDailyCapacityScan(asBucket(fake), T)).rejects.toThrow(/capacity record/);

    // 기록 쓰기가 죽어도 halt는 이미 서 있다
    expect(fake.store.has(HALT_KEY)).toBe(true);
    expect(await isHalted(asBucket(fake))).toBe(true);
  });

  test('실측 8GB 초과 → halt 플래그 생성 → isHalted true (fail-closed)', async () => {
    const fake = new FakeR2();
    fake.seed('norm/flight/huge.json.gz', 'x', CAPACITY_LIMIT_BYTES + 1);

    const record = await runDailyCapacityScan(asBucket(fake), T);

    expect(record.overLimit).toBe(true);
    expect(fake.store.has(HALT_KEY)).toBe(true);
    expect(await isHalted(asBucket(fake))).toBe(true);
  });

  test('정확히 한도 = 아직 halt 아님 (경계값)', async () => {
    const fake = new FakeR2();
    fake.seed('norm/flight/edge.json.gz', 'x', CAPACITY_LIMIT_BYTES);

    const record = await runDailyCapacityScan(asBucket(fake), T);

    expect(record.overLimit).toBe(false);
    expect(fake.store.has(HALT_KEY)).toBe(false);
  });
});

describe('스캔 실패 무오탐 (재리뷰 Med2/Low — index.scheduled)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('scan 예외 → halt 미생성 + 수집은 계속 + healthchecks는 실패 판정', async () => {
    const worker = (await import('../src/index')).default;
    const { regionsForMinute } = await import('../src/schedule');
    const { pointUrl } = await import('../src/sources/adsblol');
    const { USGS_ALL_HOUR_URL } = await import('../src/sources/usgs');

    const T = Date.UTC(2026, 7, 19, 3, 7, 0); // 스캔 슬롯
    const fake = new FakeR2();
    // LIST 자체가 죽는 스캔 실패 재현
    fake.list = async () => {
      throw new Error('list unavailable');
    };
    const [r1, r2] = regionsForMinute(T);
    const hcPings: string[] = [];

    vi.useFakeTimers();
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url === USGS_ALL_HOUR_URL) return new Response(JSON.stringify({ features: [] }), { status: 200 });
      if (url === pointUrl(r1) || url === pointUrl(r2)) {
        return new Response(JSON.stringify({ ac: [] }), { status: 200 });
      }
      if (url.startsWith('https://hc.example/ping')) {
        hcPings.push(url);
        return new Response('ok', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const run = worker.scheduled(
      { scheduledTime: T, cron: '* * * * *', noRetry: () => {} } as ScheduledController,
      { DATA: asBucket(fake), HEALTHCHECKS_URL: 'https://hc.example/ping' },
      {} as ExecutionContext,
    );
    let settled = false;
    const wrapped = run.finally(() => {
      settled = true;
    });
    while (!settled) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await wrapped;

    // 스캔 실패는 halt 오탐을 만들지 않는다
    expect(fake.store.has(HALT_KEY)).toBe(false);
    // 수집은 계속됐다 (양 레이어 empty status 원장이 남는다)
    expect(fake.keysWithPrefix('manifest/status/earthquake/')).toHaveLength(1);
    expect(fake.keysWithPrefix('manifest/status/flight/')).toHaveLength(1);
    // 그러나 성공으로 위장하지 않는다 — 데드맨 핑은 /fail
    expect(hcPings).toHaveLength(1);
    expect(hcPings[0]).toBe('https://hc.example/ping/fail');
  });
});

describe('halt 시 수집 스킵 (index.scheduled)', () => {
  test('halt 플래그 존재 → 수집 없이 반환 (외부 fetch 0회·쓰기 0회)', async () => {
    const worker = (await import('../src/index')).default;
    const fake = new FakeR2();
    fake.seed(HALT_KEY, JSON.stringify({ reason: 'test' }));
    const putsBefore = fake.putCount;

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('collect must be skipped while halted');
    }) as typeof fetch;
    try {
      await worker.scheduled(
        { scheduledTime: Date.UTC(2026, 7, 19, 5, 0, 0), cron: '* * * * *', noRetry: () => {} } as ScheduledController,
        { DATA: asBucket(fake) },
        {} as ExecutionContext,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0); // HEALTHCHECKS_URL 미설정 — 핑도 스킵
    expect(fake.putCount).toBe(putsBefore);
  });
});

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CAPACITY_LIMIT_BYTES,
  DAILY_INVOCATION_BUDGET,
  isHalted,
  isScanSlot,
  runDailyCapacityScan,
  runPollRelaxScan,
} from '../src/r2/capacity';
import { POLL_RELAX_KEY } from '../src/proxy';
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

describe('poll-relax producer (리뷰 Med3 — §8.6 quota 방어 ① end-to-end)', () => {
  const T = Date.UTC(2026, 7, 19, 3, 7, 0);
  const CREDS = { CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' };

  function analyticsFetch(requests: number, capture?: { body?: string; auth?: string }): typeof fetch {
    return (async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.cloudflare.com/client/v4/graphql');
      if (capture) {
        capture.body = String(init?.body);
        capture.auth = String((init?.headers as Record<string, string>).Authorization);
      }
      return new Response(
        JSON.stringify({
          data: {
            viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests } }] }] },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
  }

  test('전일 invocation 80% 초과 → POLL_RELAX_KEY PUT (전일 UTC 날짜로 조회)', async () => {
    const fake = new FakeR2();
    const capture: { body?: string; auth?: string } = {};
    const result = await runPollRelaxScan(asBucket(fake), CREDS, T, analyticsFetch(85_000, capture));
    expect(result).toEqual({ status: 'relaxed', date: '2026-08-18', requests: 85_000 });
    expect(capture.auth).toBe('Bearer tok');
    expect(capture.body).toContain('"date":"2026-08-18"'); // 전일 UTC
    expect(capture.body).not.toContain('scriptName'); // 계정 전체 합계 조회 (재리뷰: 100k/day는 계정 한도)
    const flag = fake.jsonOf<{ requests: number; budget: number }>(POLL_RELAX_KEY)!;
    expect(flag.requests).toBe(85_000);
    expect(flag.budget).toBe(DAILY_INVOCATION_BUDGET);
  });

  test('80% 미만 → 기존 플래그 DELETE로 해제', async () => {
    const fake = new FakeR2();
    fake.seed(POLL_RELAX_KEY, '{}');
    const result = await runPollRelaxScan(asBucket(fake), CREDS, T, analyticsFetch(50_000));
    expect(result).toEqual({ status: 'cleared', date: '2026-08-18', requests: 50_000 });
    expect(fake.store.has(POLL_RELAX_KEY)).toBe(false);
  });

  test('정확히 80% = 아직 완화 아님 (경계값)', async () => {
    const fake = new FakeR2();
    const result = await runPollRelaxScan(asBucket(fake), CREDS, T, analyticsFetch(80_000));
    expect(result.status).toBe('cleared');
    expect(fake.store.has(POLL_RELAX_KEY)).toBe(false);
  });

  test('시크릿 미설정 → skipped, 플래그·외부 fetch 불변 (지금 프로덕션 상태)', async () => {
    const fake = new FakeR2();
    fake.seed(POLL_RELAX_KEY, '{}');
    const neverFetch = (async () => {
      throw new Error('must not fetch without credentials');
    }) as typeof fetch;
    expect(await runPollRelaxScan(asBucket(fake), {}, T, neverFetch)).toEqual({
      status: 'skipped',
      reason: 'missing-credentials',
    });
    expect(await runPollRelaxScan(asBucket(fake), { CF_API_TOKEN: 'tok' }, T, neverFetch)).toEqual({
      status: 'skipped',
      reason: 'missing-credentials',
    });
    expect(fake.store.has(POLL_RELAX_KEY)).toBe(true); // 불변
  });

  test('Analytics 실패(HTTP·GraphQL 오류) → error + 플래그 불변 (이미 선 완화 유지)', async () => {
    const fake = new FakeR2();
    fake.seed(POLL_RELAX_KEY, '{}');
    const http500 = (async () => new Response('down', { status: 500 })) as typeof fetch;
    const r1 = await runPollRelaxScan(asBucket(fake), CREDS, T, http500);
    expect(r1.status).toBe('error');
    const gqlError = (async () =>
      new Response(JSON.stringify({ data: null, errors: [{ message: 'quota' }] }), {
        status: 200,
      })) as typeof fetch;
    const r2 = await runPollRelaxScan(asBucket(fake), CREDS, T, gqlError);
    expect(r2.status).toBe('error');
    expect(fake.store.has(POLL_RELAX_KEY)).toBe(true); // 어느 실패에도 불변
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

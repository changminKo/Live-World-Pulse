/** index.scheduled 분 테이블 라우팅 (CPU 사다리 rung ① — 한 invocation에 1작업).
 *  각 분이 자기 작업만 호출하고 다른 소스는 건드리지 않는지, 그리고 각 레이어의
 *  latest 파트가 서로를 지우지 않는지(레이어 보존) 검증. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import worker from '../src/index';
import { latestFlightRegionKey, latestLayerKey } from '../src/r2/latest';
import type { LatestDoc, SnapshotPart } from '../src/r2/latest';
import { LATEST_KEY } from '../src/slots';
import { taskForMinute } from '../src/schedule';
import { pointUrl } from '../src/sources/adsblol';
import { USGS_ALL_HOUR_URL } from '../src/sources/usgs';
import { GDELT_LASTUPDATE_URL } from '../src/sources/gdelt';
import type { Env } from '../src/types';
import { FakeR2, asBucket } from './fake-r2';

const EXPORT_URL = 'http://data.gdeltproject.org/gdeltv2/20260819061500.export.CSV.zip';

function makeEnv(fake: FakeR2): Env {
  return { DATA: asBucket(fake) };
}

/** 모든 소스를 성공 응답으로 스텁하고 URL별 호출 기록을 남긴다 */
function stubAllSources() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url === USGS_ALL_HOUR_URL) return new Response(JSON.stringify({ features: [] }));
    if (url.includes('api.adsb.lol')) return new Response(JSON.stringify({ ac: [] }));
    if (url.includes('geteventlist/SEARCH')) return new Response(JSON.stringify({ features: [] }));
    if (url === GDELT_LASTUPDATE_URL) return new Response(`1 md5 ${EXPORT_URL}`);
    if (url === EXPORT_URL) return new Response(new ArrayBuffer(4)); // zip 아님 — raw 적재만 성공
    throw new Error(`unexpected fetch: ${url}`);
  });
  return calls;
}

async function runScheduled(fake: FakeR2, scheduledTime: number): Promise<void> {
  const settle = worker.scheduled(
    { scheduledTime, cron: '* * * * *', noRetry: () => {} } as ScheduledController,
    makeEnv(fake),
    {} as ExecutionContext,
  );
  // 지역 간 sleep(5s) 소화
  let done = false;
  const wrapped = settle.finally(() => {
    done = true;
  });
  while (!done) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  await wrapped;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('index.scheduled — 분 테이블 라우팅', () => {
  test('flight 분(m=1): 항공기 1지역만 — USGS·GDACS·GDELT 콜 없음', async () => {
    const calls = stubAllSources();
    await runScheduled(new FakeR2(), Date.UTC(2026, 7, 19, 12, 1, 0));

    // rung ①: 한 invocation = 1작업. 지진도 같은 분에 돌지 않는다.
    expect(calls.filter((u) => u.includes('api.adsb.lol')).length).toBe(1);
    expect(calls.some((u) => u === USGS_ALL_HOUR_URL)).toBe(false);
    expect(calls.some((u) => u.includes('gdacs'))).toBe(false);
    expect(calls.some((u) => u.includes('gdelt'))).toBe(false);
  });

  test('quake 분(m=0): USGS만', async () => {
    const calls = stubAllSources();
    await runScheduled(new FakeR2(), Date.UTC(2026, 7, 19, 12, 0, 0));

    expect(calls.some((u) => u === USGS_ALL_HOUR_URL)).toBe(true);
    expect(calls.some((u) => u.includes('api.adsb.lol'))).toBe(false);
  });

  test('weather-fetch 분(m=6): GDACS 3레벨 fetch, 그 외 없음', async () => {
    const calls = stubAllSources();
    await runScheduled(new FakeR2(), Date.UTC(2026, 7, 19, 12, 6, 0));

    expect(calls.filter((u) => u.includes('geteventlist/SEARCH')).length).toBe(3);
    expect(calls.some((u) => u.includes('gdelt'))).toBe(false);
    expect(calls.some((u) => u.includes('api.adsb.lol'))).toBe(false);
  });

  test('news-fetch 분(m=2): GDELT lastupdate+zip raw만 — norm 없음', async () => {
    const calls = stubAllSources();
    const fake = new FakeR2();
    await runScheduled(fake, Date.UTC(2026, 7, 19, 12, 2, 0));

    expect(calls.some((u) => u === GDELT_LASTUPDATE_URL)).toBe(true);
    expect(calls.some((u) => u === EXPORT_URL)).toBe(true);
    expect(calls.some((u) => u.includes('gdacs'))).toBe(false);
    expect(fake.keysWithPrefix('raw/gdelt/')).toHaveLength(1);
    expect(fake.keysWithPrefix('norm/news/')).toHaveLength(0);
  });

  test('커밋·처리 분(m=9 / m=4): GDACS 재fetch 복구 / GDELT raw 되읽기', async () => {
    const calls = stubAllSources();
    const fake = new FakeR2();
    // m=9 — raw가 없으므로 인라인 재fetch 복구 경로
    await runScheduled(fake, Date.UTC(2026, 7, 19, 12, 9, 0));
    expect(calls.filter((u) => u.includes('geteventlist/SEARCH')).length).toBe(3);

    // m=4 — lastupdate로 파일 키 재확인 (zip은 없으면 재fetch)
    const before = calls.length;
    await runScheduled(fake, Date.UTC(2026, 7, 19, 12, 4, 0));
    expect(calls.slice(before).some((u) => u === GDELT_LASTUPDATE_URL)).toBe(true);
  });

  test('idle 분(m=13): 수집 콜 0 — latest 재조립만', async () => {
    const calls = stubAllSources();
    const fake = new FakeR2();
    const seeded: SnapshotPart<never> = { asOf: '2026-08-19T11:47:00.000Z', records: [] };
    fake.seed(latestLayerKey('weather'), JSON.stringify(seeded), undefined, { asOf: seeded.asOf });

    await runScheduled(fake, Date.UTC(2026, 7, 19, 12, 13, 0));

    expect(calls).toHaveLength(0);
    expect(fake.jsonOf<LatestDoc>(LATEST_KEY)!.layers.weather?.asOf).toBe('2026-08-19T11:47:00.000Z');
  });

  test('레이어 보존: flight 분이 weather/news latest 파트를 건드리지 않는다', async () => {
    stubAllSources();
    const fake = new FakeR2();
    const weatherPart: SnapshotPart<never> = { asOf: '2026-08-19T11:47:00.000Z', records: [] };
    const newsPart: SnapshotPart<never> = { asOf: '2026-08-19T11:45:00.000Z', records: [] };
    fake.seed(latestLayerKey('weather'), JSON.stringify(weatherPart), undefined, { asOf: weatherPart.asOf });
    fake.seed(latestLayerKey('news'), JSON.stringify(newsPart), undefined, { asOf: newsPart.asOf });

    const T = Date.UTC(2026, 7, 19, 12, 1, 0);
    const task = taskForMinute(T);
    expect(task.kind).toBe('flight');
    await runScheduled(fake, T);

    expect(fake.jsonOf<SnapshotPart<never>>(latestLayerKey('weather'))!.asOf).toBe('2026-08-19T11:47:00.000Z');
    expect(fake.jsonOf<SnapshotPart<never>>(latestLayerKey('news'))!.asOf).toBe('2026-08-19T11:45:00.000Z');
    if (task.kind === 'flight') {
      expect(fake.store.has(latestFlightRegionKey(task.region.id))).toBe(true);
      expect(pointUrl(task.region)).toContain('api.adsb.lol'); // 스텁 라우팅 전제 확인
    }

    // invocation 말미 통합 latest.json 재조립 (재리뷰 High1) — 기존 파트도 함께 실린다
    const latest = fake.jsonOf<LatestDoc>(LATEST_KEY)!;
    expect(latest.layers.weather?.asOf).toBe('2026-08-19T11:47:00.000Z');
    expect(latest.partial).toBeDefined(); // 이 분엔 대부분의 지역 파트가 없다 — 정직 표기
  });
});

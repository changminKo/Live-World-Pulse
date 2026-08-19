/** index.scheduled 슬롯 라우팅 (리뷰 Low2 — due 분기 미커버) —
 *  weather/news fetch·커밋 슬롯이 정확한 분에만 실행되고,
 *  각 레이어의 latest 파트가 서로를 지우지 않는지(레이어 보존) 검증. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import worker from '../src/index';
import { latestFlightRegionKey, latestLayerKey } from '../src/r2/latest';
import type { LatestDoc, SnapshotPart } from '../src/r2/latest';
import { LATEST_KEY } from '../src/slots';
import { regionsForMinute } from '../src/schedule';
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

describe('index.scheduled — weather/news due 라우팅', () => {
  test('일반 분(m%15==1): 지진+항공기만 — GDACS/GDELT 콜 없음', async () => {
    const calls = stubAllSources();
    await runScheduled(new FakeR2(), Date.UTC(2026, 7, 19, 12, 1, 0));

    expect(calls.some((u) => u === USGS_ALL_HOUR_URL)).toBe(true);
    expect(calls.filter((u) => u.includes('api.adsb.lol')).length).toBe(2);
    expect(calls.some((u) => u.includes('gdacs'))).toBe(false);
    expect(calls.some((u) => u.includes('gdelt'))).toBe(false);
  });

  test('m%15==2: GDACS fetch 단계 실행 (3레벨), GDELT 없음', async () => {
    const calls = stubAllSources();
    await runScheduled(new FakeR2(), Date.UTC(2026, 7, 19, 12, 2, 0));

    expect(calls.filter((u) => u.includes('geteventlist/SEARCH')).length).toBe(3);
    expect(calls.some((u) => u.includes('gdelt'))).toBe(false);
  });

  test('m%15==9: GDELT fetch 단계 실행 (lastupdate+zip), GDACS 없음', async () => {
    const calls = stubAllSources();
    const fake = new FakeR2();
    await runScheduled(fake, Date.UTC(2026, 7, 19, 12, 9, 0));

    expect(calls.some((u) => u === GDELT_LASTUPDATE_URL)).toBe(true);
    expect(calls.some((u) => u === EXPORT_URL)).toBe(true);
    expect(calls.some((u) => u.includes('gdacs'))).toBe(false);
    // fetch 단계는 raw만 — norm 없음
    expect(fake.keysWithPrefix('raw/gdelt/')).toHaveLength(1);
    expect(fake.keysWithPrefix('norm/news/')).toHaveLength(0);
  });

  test('m%15==5/11: 커밋·처리 단계 실행 — 각각 GDACS 재fetch 복구 / GDELT raw 되읽기', async () => {
    const calls = stubAllSources();
    const fake = new FakeR2();
    // m5 — raw가 없으므로 인라인 재fetch 경로
    await runScheduled(fake, Date.UTC(2026, 7, 19, 12, 5, 0));
    expect(calls.filter((u) => u.includes('geteventlist/SEARCH')).length).toBe(3);

    // m11 — lastupdate로 파일 키 재확인 (zip은 없으면 재fetch)
    const before = calls.length;
    await runScheduled(fake, Date.UTC(2026, 7, 19, 12, 11, 0));
    expect(calls.slice(before).some((u) => u === GDELT_LASTUPDATE_URL)).toBe(true);
  });

  test('레이어 보존: 지진+항공기 분이 weather/news latest 파트를 건드리지 않는다', async () => {
    stubAllSources();
    const fake = new FakeR2();
    const weatherPart: SnapshotPart<never> = { asOf: '2026-08-19T11:47:00.000Z', records: [] };
    const newsPart: SnapshotPart<never> = { asOf: '2026-08-19T11:45:00.000Z', records: [] };
    fake.seed(latestLayerKey('weather'), JSON.stringify(weatherPart), undefined, { asOf: weatherPart.asOf });
    fake.seed(latestLayerKey('news'), JSON.stringify(newsPart), undefined, { asOf: newsPart.asOf });

    const T = Date.UTC(2026, 7, 19, 12, 1, 0);
    await runScheduled(fake, T);

    // weather/news 파트 불변, 지진·항공기 파트는 생성
    expect(fake.jsonOf<SnapshotPart<never>>(latestLayerKey('weather'))!.asOf).toBe('2026-08-19T11:47:00.000Z');
    expect(fake.jsonOf<SnapshotPart<never>>(latestLayerKey('news'))!.asOf).toBe('2026-08-19T11:45:00.000Z');
    expect(fake.store.has(latestLayerKey('earthquake'))).toBe(true);
    const [r1] = regionsForMinute(T);
    expect(fake.store.has(latestFlightRegionKey(r1.id))).toBe(true);
    expect(pointUrl(r1)).toContain('api.adsb.lol'); // 스텁 라우팅 전제 확인

    // invocation 말미 통합 latest.json 재조립 (재리뷰 High1) — 기존 파트도 함께 실린다
    const latest = fake.jsonOf<LatestDoc>(LATEST_KEY)!;
    expect(latest.layers.weather?.asOf).toBe('2026-08-19T11:47:00.000Z');
    expect(latest.layers.earthquake).toBeDefined();
    expect(latest.partial).toBeDefined(); // 이 분엔 일부 지역 파트가 없다 — 정직 표기
  });
});

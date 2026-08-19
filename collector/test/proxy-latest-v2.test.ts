/** latest 통합본 조립 계약 (재리뷰 High1 — 조립은 Collector, 프록시는 1 GET):
 *  - assembleLatest: 파트 문자열 concat → latest.json (LatestDoc shape, 프론트 계약 불변)
 *  - 누락 파트 = 필드 생략 + partial 메타 (Med1)
 *  - 프록시 /api/latest: 통합본 단일 GET + R2 etag 304 (Med2), R2 예외는 503 (Med1) */
import { beforeEach, describe, expect, test } from 'vitest';
import worker from '../src/index';
import { resetProxyStateForTests } from '../src/proxy';
import { assembleLatest, latestFlightRegionKey, latestLayerKey, putSnapshotIfNewer } from '../src/r2/latest';
import type { LatestDoc } from '../src/r2/latest';
import { LATEST_KEY } from '../src/slots';
import type { Env } from '../src/types';
import { FakeR2, asBucket } from './fake-r2';

function env(fake: FakeR2): Env {
  return { DATA: asBucket(fake) };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://collector.test${path}`, { headers });
}

beforeEach(() => {
  resetProxyStateForTests();
});

describe('assembleLatest — 파트 문자열 concat → 통합 latest.json', () => {
  test('레이어·지역 파트를 LatestDoc shape로 조립 + 누락 파트는 partial 메타', async () => {
    const fake = new FakeR2();
    const bucket = asBucket(fake);
    await putSnapshotIfNewer(bucket, latestLayerKey('earthquake'), '2026-08-19T00:01:00.000Z', [
      { id: 'usgs:q1' },
    ]);
    await putSnapshotIfNewer(bucket, latestFlightRegionKey('seoul'), '2026-08-19T00:00:54.000Z', [
      { id: 'adsblol:aaa111:900' },
    ]);
    await putSnapshotIfNewer(bucket, latestFlightRegionKey('tokyo'), '2026-08-19T00:00:54.000Z', []);

    const result = await assembleLatest(bucket);

    expect(result.written).toBe(true);
    expect(result.partial).toEqual([
      'weather',
      'news',
      'flight:london',
      'flight:frankfurt',
      'flight:newyork',
      'flight:losangeles',
    ]);
    const doc = fake.jsonOf<LatestDoc>(LATEST_KEY)!;
    expect(doc.layers.earthquake?.asOf).toBe('2026-08-19T00:01:00.000Z');
    expect(doc.layers.earthquake?.records).toHaveLength(1);
    expect(doc.layers.flight?.regions.seoul?.records).toHaveLength(1);
    expect(doc.layers.flight?.regions.tokyo?.records).toEqual([]);
    // 없는 레이어(weather/news)는 프로퍼티 자체가 없다 — 기존 latest.json 의미론과 동일
    expect(doc.layers.weather).toBeUndefined();
    expect(doc.partial).toContain('weather');
    expect(typeof doc.updatedAt).toBe('string');
  });

  test('전 파트 존재 시 partial 프로퍼티 자체가 없다 (직렬화 바이트 계약)', async () => {
    const fake = new FakeR2();
    const bucket = asBucket(fake);
    for (const layer of ['earthquake', 'weather', 'news'] as const) {
      await putSnapshotIfNewer(bucket, latestLayerKey(layer), '2026-08-19T00:01:00.000Z', []);
    }
    for (const region of ['seoul', 'tokyo', 'london', 'frankfurt', 'newyork', 'losangeles']) {
      await putSnapshotIfNewer(bucket, latestFlightRegionKey(region), '2026-08-19T00:01:00.000Z', []);
    }

    const result = await assembleLatest(bucket);

    expect(result.partial).toEqual([]);
    const doc = fake.jsonOf<LatestDoc>(LATEST_KEY)!;
    expect('partial' in doc).toBe(false);
    expect(doc.layers.weather?.records).toEqual([]);
    expect(Object.keys(doc.layers.flight?.regions ?? {})).toHaveLength(6);
  });

  test('파트 전무(콜드 스타트) → PUT 스킵 (written=false, latest.json 미생성)', async () => {
    const fake = new FakeR2();

    const result = await assembleLatest(asBucket(fake));

    expect(result.written).toBe(false);
    expect(fake.store.has(LATEST_KEY)).toBe(false);
  });

  test('손상 파트(잘린 JSON) → PUT 스킵 + 이전 통합본 보존 (Med1 파트 검증)', async () => {
    const fake = new FakeR2();
    const bucket = asBucket(fake);
    await putSnapshotIfNewer(bucket, latestLayerKey('earthquake'), '2026-08-19T00:01:00.000Z', [
      { id: 'usgs:q1' },
    ]);
    await putSnapshotIfNewer(bucket, latestLayerKey('weather'), '2026-08-19T00:01:00.000Z', []);
    const baseline = await assembleLatest(bucket);
    expect(baseline.written).toBe(true);
    expect(baseline.invalid).toEqual([]);
    const baselineDoc = fake.textOf(LATEST_KEY)!;

    // weather 파트가 잘린 채 저장된 상황 (업로드 중단·오염) — concat 조립이면 통합본 전체가 깨진다
    fake.seed(latestLayerKey('weather'), '{"asOf":"2026-08-19T00:02:00.000Z","records":[', undefined, {
      asOf: '2026-08-19T00:02:00.000Z',
    });
    const result = await assembleLatest(bucket);

    expect(result.written).toBe(false);
    expect(result.invalid).toEqual(['weather']);
    // 이전 통합본 보존 — 여전히 유효한 JSON
    expect(fake.textOf(LATEST_KEY)).toBe(baselineDoc);
    expect(() => JSON.parse(fake.textOf(LATEST_KEY)!)).not.toThrow();
  });

  test('빈 문자열 파트도 invalid — 길이>2 + 중괄호 경량 검증', async () => {
    const fake = new FakeR2();
    const bucket = asBucket(fake);
    await putSnapshotIfNewer(bucket, latestLayerKey('earthquake'), '2026-08-19T00:01:00.000Z', []);
    fake.seed(latestLayerKey('news'), '', undefined, { asOf: '2026-08-19T00:01:00.000Z' });

    const result = await assembleLatest(bucket);

    expect(result.written).toBe(false);
    expect(result.invalid).toEqual(['news']);
    expect(fake.store.has(LATEST_KEY)).toBe(false);
  });
});

describe('GET /api/latest — 통합본 단일 GET (파트 9 GET 금지)', () => {
  test('통합본 통과 + R2 etag 기반 304, R2 GET은 폴링당 1회', async () => {
    const fake = new FakeR2();
    const bucket = asBucket(fake);
    await putSnapshotIfNewer(bucket, latestLayerKey('earthquake'), '2026-08-19T00:01:00.000Z', []);
    await assembleLatest(bucket);

    let gets = 0;
    const counting = new Proxy(fake, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return async (key: string) => {
            gets += 1;
            return target.get(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const first = await worker.fetch(get('/api/latest'), env(counting as FakeR2));
    expect(first.status).toBe(200);
    expect(gets).toBe(1); // 재리뷰 High1 — 파트 9 GET이면 여기서 터진다
    const doc = (await first.json()) as LatestDoc;
    expect(doc.layers.earthquake?.asOf).toBe('2026-08-19T00:01:00.000Z');

    const etag = first.headers.get('etag')!;
    const cached = await worker.fetch(get('/api/latest', { 'if-none-match': etag }), env(fake));
    expect(cached.status).toBe(304);

    // 파트 갱신 + 재조립 → R2 etag가 바뀌어 재검증 미스
    await putSnapshotIfNewer(bucket, latestLayerKey('earthquake'), '2026-08-19T00:02:00.000Z', []);
    await assembleLatest(bucket);
    const changed = await worker.fetch(get('/api/latest', { 'if-none-match': etag }), env(fake));
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  test('R2 GET 예외 → 503 + Retry-After (500 금지 — Med1)', async () => {
    const fake = new FakeR2();
    const throwing = new Proxy(fake, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return async () => {
            throw new Error('r2 down');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const res = await worker.fetch(get('/api/latest'), env(throwing as FakeR2));

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
  });
  // 통합본 미존재(콜드 스타트) → 404는 proxy.test.ts의 기존 '/api/latest' 스위트가 검증한다.
});

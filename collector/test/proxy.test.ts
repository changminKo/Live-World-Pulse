/** 읽기 프록시 (PLAN §8.6 공개 접근 경로·quota 방어) — 라우팅·ETag 304·CORS·rate limit */
import { beforeEach, describe, expect, test } from 'vitest';
import worker from '../src/index';
import {
  POLL_RELAX_KEY,
  TokenBucketRateLimiter,
  handleApi,
  resetProxyStateForTests,
} from '../src/proxy';
import { gzipText, gunzipToText } from '../src/gzip';
import { LATEST_KEY, dtOf, normKey, normPointerKey } from '../src/slots';
import type { Env } from '../src/types';
import { FakeR2, asBucket } from './fake-r2';

const SLOT = 1_787_000_400; // 900 정렬 epoch 초
const DT = dtOf(SLOT);

function env(fake: FakeR2, overrides: Partial<Env> = {}): Env {
  return { DATA: asBucket(fake), ...overrides };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://collector.test${path}`, { headers });
}

async function seedNorm(fake: FakeR2, generation: number, records: unknown[]): Promise<string> {
  const body = JSON.stringify({
    layer: 'earthquake',
    slot: SLOT,
    slotDurationSec: 900,
    generation,
    writtenAt: '2026-08-19T00:00:00.000Z',
    records,
  });
  fake.seed(normKey('earthquake', SLOT, generation), await gzipText(body));
  return body;
}

function seedPointer(fake: FakeR2, generation: number): void {
  fake.seed(
    normPointerKey(DT),
    JSON.stringify({ layers: { earthquake: { [String(SLOT)]: { g: generation, hash: 'h' } } } }),
  );
}

/** node 테스트 환경엔 caches.default가 없음 — Cache API 경로 검증용 최소 fake */
class FakeCache {
  readonly store = new Map<string, ArrayBuffer>();
  async match(req: Request): Promise<Response | undefined> {
    const bytes = this.store.get(req.url);
    return bytes ? new Response(bytes.slice(0)) : undefined;
  }
  async put(req: Request, res: Response): Promise<void> {
    this.store.set(req.url, await res.arrayBuffer());
  }
}

beforeEach(() => {
  resetProxyStateForTests();
});

describe('GET /api/latest (LIVE 폴링 — no-cache + ETag)', () => {
  test('latest.json 통과 + no-cache + ETag + CORS', async () => {
    const fake = new FakeR2();
    fake.seed(LATEST_KEY, JSON.stringify({ updatedAt: 'x', layers: {} }));
    const res = await worker.fetch(get('/api/latest'), env(fake));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toContain('ETag');
    expect(await res.json()).toEqual({ updatedAt: 'x', layers: {} });
  });

  test('If-None-Match: * → 304 (RFC 9110 — 존재 자체 매치)', async () => {
    const fake = new FakeR2();
    fake.seed(LATEST_KEY, '{}');
    const res = await worker.fetch(get('/api/latest', { 'if-none-match': '*' }), env(fake));
    expect(res.status).toBe(304);
  });

  test('If-None-Match 일치 → 304 (바디 없음, ETag 유지)', async () => {
    const fake = new FakeR2();
    fake.seed(LATEST_KEY, JSON.stringify({ updatedAt: 'x', layers: {} }));
    const first = await worker.fetch(get('/api/latest'), env(fake));
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const second = await worker.fetch(get('/api/latest', { 'if-none-match': etag ?? '' }), env(fake));
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
    expect(await second.text()).toBe('');
  });

  test('ETag 불일치·weak 목록 판정', async () => {
    const fake = new FakeR2();
    fake.seed(LATEST_KEY, '{}');
    const first = await worker.fetch(get('/api/latest'), env(fake));
    const etag = first.headers.get('etag') ?? '';
    const weak = await worker.fetch(
      get('/api/latest', { 'if-none-match': `"stale", W/${etag}` }),
      env(fake),
    );
    expect(weak.status).toBe(304);
    const miss = await worker.fetch(get('/api/latest', { 'if-none-match': '"stale"' }), env(fake));
    expect(miss.status).toBe(200);
  });

  test('완화 플래그 존재 → X-Poll-Interval: 180 (§8.6 quota 방어 ①)', async () => {
    const fake = new FakeR2();
    fake.seed(LATEST_KEY, '{}');
    fake.seed(POLL_RELAX_KEY, '{}');
    const res = await worker.fetch(get('/api/latest'), env(fake));
    expect(res.headers.get('x-poll-interval')).toBe('180');
  });

  test('플래그 없으면 X-Poll-Interval 미포함', async () => {
    const fake = new FakeR2();
    fake.seed(LATEST_KEY, '{}');
    const res = await worker.fetch(get('/api/latest'), env(fake));
    expect(res.headers.get('x-poll-interval')).toBeNull();
  });

  test('latest.json 미존재(콜드 스타트) → 404', async () => {
    const res = await worker.fetch(get('/api/latest'), env(new FakeR2()));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/norm/{layer}/{slot} (unpinned=no-cache+ETag / pinned=immutable)', () => {
  test('unpinned: 포인터 최신 g resolve + gzip 통과 + no-cache + g 기반 ETag (리뷰 Med1)', async () => {
    const fake = new FakeR2();
    const body = await seedNorm(fake, 2, [{ id: 'usgs:q1' }]);
    seedPointer(fake, 2);
    const res = await worker.fetch(get(`/api/norm/earthquake/${SLOT}`), env(fake));
    expect(res.status).toBe(200);
    // unpinned URL은 g가 정정으로 바뀔 수 있다 — immutable 금지
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('etag')).toBe('"g2"');
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('x-norm-generation')).toBe('2');
    expect(await gunzipToText(await res.arrayBuffer())).toBe(body);
  });

  test('unpinned 재검증: g 불변 → 304, g 상승(정정) → 200 새 g (리뷰 Med1 회귀)', async () => {
    const fake = new FakeR2();
    await seedNorm(fake, 1, [{ id: 'usgs:q1' }]);
    seedPointer(fake, 1);
    const first = await worker.fetch(get(`/api/norm/earthquake/${SLOT}`), env(fake));
    expect(first.headers.get('etag')).toBe('"g1"');
    // g 불변 — 브라우저 재검증은 304로 바디 생략
    const same = await worker.fetch(
      get(`/api/norm/earthquake/${SLOT}`, { 'if-none-match': '"g1"' }),
      env(fake),
    );
    expect(same.status).toBe(304);
    expect(same.headers.get('x-norm-generation')).toBe('1');
    // 정정 발생: 포인터 g1→g2 — 옛 ETag로 재검증하면 새 바디가 즉시 닿는다
    await seedNorm(fake, 2, [{ id: 'usgs:q1', revision: 2 }]);
    seedPointer(fake, 2);
    const bumped = await worker.fetch(
      get(`/api/norm/earthquake/${SLOT}`, { 'if-none-match': '"g1"' }),
      env(fake),
    );
    expect(bumped.status).toBe(200);
    expect(bumped.headers.get('etag')).toBe('"g2"');
    expect(bumped.headers.get('x-norm-generation')).toBe('2');
  });

  test('?g= 핀 — 포인터 shard 없이 직접 통과 + versioned URL만 immutable', async () => {
    const fake = new FakeR2();
    await seedNorm(fake, 5, []);
    const res = await worker.fetch(get(`/api/norm/earthquake/${SLOT}?g=5`), env(fake));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-norm-generation')).toBe('5');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  test('slot 의미 검증: 900s 비정렬·epoch 범위 밖·선행 0·비canonical g → 404 (리뷰 Low1)', async () => {
    const fake = new FakeR2();
    await seedNorm(fake, 1, []);
    seedPointer(fake, 1);
    const e = env(fake);
    expect((await worker.fetch(get(`/api/norm/earthquake/${SLOT + 60}`), e)).status).toBe(404); // 900 비정렬
    expect((await worker.fetch(get('/api/norm/earthquake/900'), e)).status).toBe(404); // < 2020
    expect((await worker.fetch(get('/api/norm/earthquake/4102444800'), e)).status).toBe(404); // >= 2100
    expect((await worker.fetch(get(`/api/norm/earthquake/0${SLOT}`), e)).status).toBe(404); // 선행 0
    expect((await worker.fetch(get(`/api/norm/earthquake/${SLOT}?g=01`), e)).status).toBe(404); // 비canonical g
    // 대조군 — 같은 seed에서 canonical 경로는 살아 있다
    expect((await worker.fetch(get(`/api/norm/earthquake/${SLOT}`), e)).status).toBe(200);
  });

  test('404 경로: 미지 레이어 / 포인터 없음 / 엔트리 없음 / 바디 없음', async () => {
    const fake = new FakeR2();
    expect((await worker.fetch(get(`/api/norm/volcano/${SLOT}`), env(fake))).status).toBe(404);
    expect((await worker.fetch(get(`/api/norm/earthquake/${SLOT}`), env(fake))).status).toBe(404);
    seedPointer(fake, 0);
    expect((await worker.fetch(get(`/api/norm/flight/${SLOT}`), env(fake))).status).toBe(404);
    // 포인터는 g0을 가리키지만 바디 미존재 (비정상 상태 — 500이 아니라 404로 수렴)
    expect((await worker.fetch(get(`/api/norm/earthquake/${SLOT}`), env(fake))).status).toBe(404);
  });

  test('Cache API 히트 시 R2 재조회 없이 서빙 (Class B 절감 경로)', async () => {
    const fake = new FakeR2();
    await seedNorm(fake, 1, [{ id: 'usgs:q1' }]);
    seedPointer(fake, 1);
    const cache = new FakeCache();
    const url = new URL(`https://collector.test/api/norm/earthquake/${SLOT}`);
    const first = await handleApi(get(url.pathname), env(fake), url, { cache: cache as unknown as Cache });
    expect(first.status).toBe(200);
    expect(cache.store.size).toBe(1);
    // R2에서 바디를 지워도 캐시로 서빙 — 포인터는 여전히 읽는다 (resolve는 캐시 안 함)
    fake.store.delete(normKey('earthquake', SLOT, 1));
    const second = await handleApi(get(url.pathname), env(fake), url, { cache: cache as unknown as Cache });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-norm-generation')).toBe('1');
  });

  test('내부 Cache API 키는 ?g별 분리 — 정정 g가 옛 캐시에 은폐되지 않는다 (리뷰 Low3)', async () => {
    const fake = new FakeR2();
    const body1 = await seedNorm(fake, 1, [{ id: 'usgs:q1' }]);
    const body2 = await seedNorm(fake, 2, [{ id: 'usgs:q1', revision: 2 }]);
    const cache = new FakeCache();
    const deps = { cache: cache as unknown as Cache };
    const u1 = new URL(`https://collector.test/api/norm/earthquake/${SLOT}?g=1`);
    const u2 = new URL(`https://collector.test/api/norm/earthquake/${SLOT}?g=2`);
    const r1 = await handleApi(get(u1.pathname + u1.search), env(fake), u1, deps);
    const r2 = await handleApi(get(u2.pathname + u2.search), env(fake), u2, deps);
    expect(cache.store.size).toBe(2); // g별 별도 엔트리
    expect(await gunzipToText(await r1.arrayBuffer())).toBe(body1);
    expect(await gunzipToText(await r2.arrayBuffer())).toBe(body2);
  });
});

describe('GET /api/manifest/{date} (포인터 shard — 60s)', () => {
  test('통과 + max-age=60 + ETag/304', async () => {
    const fake = new FakeR2();
    seedPointer(fake, 3);
    const res = await worker.fetch(get(`/api/manifest/${DT}`), env(fake));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const etag = res.headers.get('etag') ?? '';
    const revalidate = await worker.fetch(get(`/api/manifest/${DT}`, { 'if-none-match': etag }), env(fake));
    expect(revalidate.status).toBe(304);
  });

  test('형식 위반·미존재 날짜 → 404', async () => {
    const fake = new FakeR2();
    expect((await worker.fetch(get('/api/manifest/20260819'), env(fake))).status).toBe(404);
    expect((await worker.fetch(get('/api/manifest/2026-08-19'), env(fake))).status).toBe(404);
  });

  test('달력 의미 검증: 2026-99-99·2026-02-30·범위 밖 연도 → 404 (리뷰 Low1)', async () => {
    const fake = new FakeR2();
    const e = env(fake);
    expect((await worker.fetch(get('/api/manifest/2026-99-99'), e)).status).toBe(404);
    expect((await worker.fetch(get('/api/manifest/2026-02-30'), e)).status).toBe(404);
    expect((await worker.fetch(get('/api/manifest/2026-13-01'), e)).status).toBe(404);
    expect((await worker.fetch(get('/api/manifest/1999-01-01'), e)).status).toBe(404); // < 2020
    expect((await worker.fetch(get('/api/manifest/2100-01-01'), e)).status).toBe(404); // >= 2100
  });
});

describe('CORS·메서드·미지 경로', () => {
  test('OPTIONS 프리플라이트 → 204 + 허용 메서드·헤더', async () => {
    const res = await worker.fetch(
      new Request('https://collector.test/api/latest', { method: 'OPTIONS' }),
      env(new FakeR2()),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toContain('If-None-Match');
  });

  test('GET·OPTIONS 외 메서드 → 405', async () => {
    const res = await worker.fetch(
      new Request('https://collector.test/api/latest', { method: 'POST' }),
      env(new FakeR2()),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, OPTIONS');
  });

  test('미지 /api 경로 → 404 (루트·게이트 fallthrough 금지)', async () => {
    const fake = new FakeR2();
    expect((await worker.fetch(get('/api/unknown'), env(fake))).status).toBe(404);
    expect((await worker.fetch(get('/api'), env(fake))).status).toBe(404);
    // 프록시 추가 후에도 루트 헬스는 불변
    expect((await worker.fetch(get('/'), env(fake))).status).toBe(200);
  });
});

describe('IP rate limit (§8.6 quota 방어 ③ — 토큰 버킷, isolate 근사)', () => {
  test('burst 30 소진 → 429 + Retry-After, 타 IP는 독립', async () => {
    const fake = new FakeR2();
    fake.seed(LATEST_KEY, '{}');
    const e = env(fake);
    let last: Response | null = null;
    for (let i = 0; i < 31; i += 1) {
      last = await worker.fetch(get('/api/latest', { 'cf-connecting-ip': '1.2.3.4' }), e);
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBe('60');
    // 429에도 CORS는 실려야 브라우저가 상태를 읽는다
    expect(last?.headers.get('access-control-allow-origin')).toBe('*');
    const other = await worker.fetch(get('/api/latest', { 'cf-connecting-ip': '5.6.7.8' }), e);
    expect(other.status).toBe(200);
  });

  test('OPTIONS 반복도 rate limit을 우회하지 못한다 (리뷰 High1 회귀)', async () => {
    const fake = new FakeR2();
    const e = env(fake);
    let last: Response | null = null;
    for (let i = 0; i < 31; i += 1) {
      last = await worker.fetch(
        new Request('https://collector.test/api/latest', {
          method: 'OPTIONS',
          headers: { 'cf-connecting-ip': '9.9.9.9' },
        }),
        e,
      );
    }
    expect(last?.status).toBe(429);
  });

  test('POST(405 경로)도 예산을 소모한다 — 메서드 분기 전 제한 (리뷰 High1 회귀)', async () => {
    const fake = new FakeR2();
    fake.seed(LATEST_KEY, '{}');
    const e = env(fake);
    for (let i = 0; i < 30; i += 1) {
      const res = await worker.fetch(
        new Request('https://collector.test/api/latest', {
          method: 'POST',
          headers: { 'cf-connecting-ip': '7.7.7.7' },
        }),
        e,
      );
      expect(res.status).toBe(405);
    }
    // burst를 POST로 다 태웠으면 정상 GET도 429 — 우회 경로가 없다는 증거
    const after = await worker.fetch(get('/api/latest', { 'cf-connecting-ip': '7.7.7.7' }), e);
    expect(after.status).toBe(429);
  });

  test('토큰 버킷 재충전 — burst 소진 후 경과 시간 비례로만 회복 (주입 시계)', () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter(2, 4, 1_000, () => now);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true); // burst 4 소진
    expect(limiter.allow('ip')).toBe(false);
    now = 500; // 0.5창 경과 → 재충전 1개 (2/창 × 0.5)
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(false);
    now = 3_000; // 충분히 경과해도 burst 상한(4)을 넘지 않는다
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(false);
  });
});

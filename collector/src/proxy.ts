/** 읽기 프록시 — PLAN §8.6 '공개 접근 경로 계약' + 'quota 방어'.
 *  r2.dev 공개 URL 금지 → 읽기는 이 Worker 프록시(*.workers.dev) 경유.
 *
 *  collector와 같은 Worker에 동거하는 이유: 같은 R2 바인딩·같은 무료 invocation
 *  예산(100k req/day)을 쓰므로 별도 Worker 분리는 예산을 늘리지 않고 배포 표면만 늘린다.
 *
 *  라우트:
 *    GET /api/latest              → latest.json 통과 (no-cache + ETag/304 — LIVE 1req/폴 계약)
 *    GET /api/norm/{layer}/{slot} → 포인터 shard에서 최신 g resolve → norm gz 통과
 *                                   (unpinned = no-cache + g 기반 ETag/304 — g 상승(정정)이 닿아야 함)
 *                                   ?g={n} 핀 시 포인터 read 생략 + immutable (versioned URL만 장기 캐시)
 *    GET /api/manifest/{date}     → norm 포인터 shard 통과 (타임라인 갭 밴드용, 60s)
 *    OPTIONS /api/*               → CORS 프리플라이트
 *    그 외 /api/*                 → 404
 *  rate limit은 메서드 분기보다 먼저 — /api 전 invocation이 예산 가드를 지난다 (아래 주석). */
import { LATEST_KEY, NORM_SLOT_SEC, dtOf, normKey, normPointerKey } from './slots';
import type { PointerShard } from './r2/norm';
import type { Env, LayerId } from './types';

/** CORS 허용 오리진 화이트리스트 — 지금은 전면 개방('*').
 *  Pages 도메인 확정 시 이 상수만 ['https://<pages-domain>']으로 좁힌다.
 *  주의: CORS는 브라우저 정책일 뿐 방어가 아니다 (§8.6) — abuse 방어는 아래 rate limit. */
const ALLOWED_ORIGINS: readonly string[] = ['*'];

/** §8.6 quota 방어 ① 완화 플래그 — daily capacity scan이 전일 invocation 80% 초과 시 PUT.
 *  프록시는 존재 여부만 읽는다 (갱신은 capacity.ts daily scan 몫 — 그쪽 TODO 참조). */
export const POLL_RELAX_KEY = 'manifest/flags/poll-relax.json';
/** 완화 시 클라에 지시하는 폴링 주기(초): 60s → 180s (§8.6) */
const RELAXED_POLL_INTERVAL_SEC = 180;
/** 플래그 HEAD를 폴링마다 치지 않기 위한 isolate 로컬 TTL 캐시 —
 *  근사임에 주의: isolate별 최대 60s 늦게 반영되지만 완화 지시가 정밀할 필요는 없다. */
const POLL_FLAG_TTL_MS = 60_000;

/** shared LayerId 문자열 집합 (타입은 컴파일 타임 전용이라 런타임 검증용 사본) */
const LAYER_IDS: ReadonlySet<LayerId> = new Set(['earthquake', 'weather', 'flight', 'news']);

function isLayerId(value: string): value is LayerId {
  return LAYER_IDS.has(value as LayerId);
}

/** 예산 역산 허용치 (리뷰 High1 — Workers Free 100k req/day):
 *  지속 15req/min → 단일 IP 최악 21,600/day = 예산의 21.6%. 여전히 크지만, 이 카운터는
 *  isolate(콜로·프로세스) 단위 인메모리 근사라 전역 상한이 될 수 없고(§8.6이 의도적으로
 *  정확 전역 카운터를 두지 않기로 계약), 더 좁히면 legit LIVE 폴링(1req/60s) 오탐 위험이
 *  커진다 — 이 수치로 수용. burst 30은 Time Machine 스크럽(수 슬라이스 연속 조회) 흡수용.
 *  분산·실시간 초과의 하드 방어는 플랫폼 Error 1027 fail-closed (§8.6 ②). */
const RATE_LIMIT_SUSTAINED_PER_WINDOW = 15;
const RATE_LIMIT_BURST = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 10_000;

/** IP 토큰 버킷 rate limit (§8.6 quota 방어 ③ — 비브라우저 abuse 대비).
 *  burst 상한에서 시작해 windowMs당 sustainedPerWindow개 재충전 — 지속률과 순간 burst를 분리. */
export class TokenBucketRateLimiter {
  private buckets = new Map<string, { tokens: number; updatedAtMs: number }>();

  constructor(
    private readonly sustainedPerWindow: number,
    private readonly burst: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** true = 허용, false = 토큰 고갈 (재충전 대기) */
  allow(key: string): boolean {
    const t = this.now();
    if (this.buckets.size >= MAX_TRACKED_IPS) this.prune(t);
    const prev = this.buckets.get(key) ?? { tokens: this.burst, updatedAtMs: t };
    const refilled = Math.min(
      this.burst,
      prev.tokens + ((t - prev.updatedAtMs) / this.windowMs) * this.sustainedPerWindow,
    );
    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, updatedAtMs: t });
      return false;
    }
    this.buckets.set(key, { tokens: refilled - 1, updatedAtMs: t });
    return true;
  }

  /** 완전 재충전 시간 이상 조용한 키 = 상태 불필요 — 제거. 그래도 가득이면 전체 리셋
   *  (fail-open: 방어 공백 한 창을 허용하고 legit 사용자를 잠그지 않는다) */
  private prune(nowMs: number): void {
    const fullRefillMs = (this.burst / this.sustainedPerWindow) * this.windowMs;
    const alive = new Map(
      [...this.buckets].filter(([, b]) => nowMs - b.updatedAtMs < fullRefillMs),
    );
    this.buckets = alive.size >= MAX_TRACKED_IPS ? new Map() : alive;
  }
}

/** isolate 수명 동안 유지되는 프록시 상태 — 테스트는 resetProxyStateForTests()로 격리 */
let rateLimiter = new TokenBucketRateLimiter(
  RATE_LIMIT_SUSTAINED_PER_WINDOW,
  RATE_LIMIT_BURST,
  RATE_LIMIT_WINDOW_MS,
);
let pollFlagCache: { relaxed: boolean; expiresAtMs: number } | null = null;

export function resetProxyStateForTests(): void {
  rateLimiter = new TokenBucketRateLimiter(
    RATE_LIMIT_SUSTAINED_PER_WINDOW,
    RATE_LIMIT_BURST,
    RATE_LIMIT_WINDOW_MS,
  );
  pollFlagCache = null;
}

export interface ProxyDeps {
  /** Worker Cache API 인스턴스 — 미지정 시 caches.default (node 테스트 환경엔 없음 → null) */
  cache?: Cache | null;
}

/** slot 선행 0 금지(canonical) — 같은 리소스가 복수 문자열로 표현되면 캐시 키가 갈라진다 */
const NORM_PATH_RE = /^\/api\/norm\/([a-z]+)\/([1-9]\d{0,9})$/;
const MANIFEST_PATH_RE = /^\/api\/manifest\/(\d{4}-\d{2}-\d{2})$/;
/** generation canonical 형식 — 선행 0 금지 (내부 Cache API 키 유일성), g=0은 유효 */
const GENERATION_RE = /^(0|[1-9]\d{0,5})$/;

/** 서빙 가능한 epoch 범위 — 계약 밖 사용자 문자열이 R2 키로 흘러가는 것을 차단 (리뷰 Low1).
 *  900s 정렬 강제: cutoff 이전 legacy 60/180s 슬롯은 공개 계약 밖 (capacity.ts 전환 기록 참조). */
const SLOT_EPOCH_MIN_SEC = 1_577_836_800; // 2020-01-01T00:00:00Z
const SLOT_EPOCH_MAX_SEC = 4_102_444_800; // 2100-01-01T00:00:00Z

function isServableSlot(slot: number): boolean {
  return (
    Number.isInteger(slot) &&
    slot % NORM_SLOT_SEC === 0 &&
    slot >= SLOT_EPOCH_MIN_SEC &&
    slot < SLOT_EPOCH_MAX_SEC
  );
}

/** 달력 유효성 + 서빙 epoch 범위 — 2026-99-99 같은 형식만 맞는 문자열 차단 (리뷰 Low1) */
function isServableDate(date: string): boolean {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  if (new Date(t).toISOString().slice(0, 10) !== date) return false;
  const sec = t / 1_000;
  return sec >= SLOT_EPOCH_MIN_SEC && sec < SLOT_EPOCH_MAX_SEC;
}

export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  deps: ProxyDeps = {},
): Promise<Response> {
  const cors = corsHeaders(request.headers.get('origin'));

  // 리뷰 High1: rate limit이 메서드 분기보다 먼저 — OPTIONS/POST 반복도 invocation을
  // 소모하므로(무료 100k/day) /api 전 요청이 예외 없이 예산 가드를 지난다.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!rateLimiter.allow(ip)) {
    // 클라 계약(§8.6): 429/1027 수신 시 지수 백오프 — 재시도 폭주 금지
    return json(429, { error: 'rate limited' }, { ...cors, 'Retry-After': '60' });
  }

  if (request.method === 'OPTIONS') return preflight(cors);
  if (request.method !== 'GET') {
    return json(405, { error: 'method not allowed' }, { ...cors, Allow: 'GET, OPTIONS' });
  }

  if (url.pathname === '/api/latest') return latestRoute(request, env, cors);

  const norm = NORM_PATH_RE.exec(url.pathname);
  if (norm) {
    const layer = norm[1] ?? '';
    const slotStr = norm[2] ?? '';
    return normRoute(request, env, cors, layer, slotStr, url.searchParams.get('g'), deps);
  }

  const manifest = MANIFEST_PATH_RE.exec(url.pathname);
  if (manifest) return manifestRoute(request, env, cors, manifest[1] ?? '');

  return notFound(cors);
}

/** GET /api/latest — LIVE 폴링 단일 응답 (§8.6: 4레이어 각각이 아니라 1req/폴).
 *  통합본은 Collector가 매 분 말미에 재조립해 둔 latest.json (r2/latest.ts
 *  assembleLatest) — 프록시는 폴링당 **R2 GET 1회**만 (재리뷰 High1: 폴링당
 *  파트 9 GET은 월 ~2,050만 Class B로 무료 1,000만 초과).
 *  ETag = R2 객체 자체 etag (Med2 — 단일 객체라 updatedAt 포함 본문 전체가 입력).
 *  R2 장애(GET throw)는 500 대신 503 + Retry-After (Med1 — 클라 백오프 계약). */
async function latestRoute(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  try {
    const [relaxed, obj] = await Promise.all([isPollRelaxed(env.DATA), env.DATA.get(LATEST_KEY)]);
    if (!obj) return notFound(cors);
    const pollHeader: Record<string, string> = relaxed
      ? { 'X-Poll-Interval': String(RELAXED_POLL_INTERVAL_SEC) }
      : {};
    const etag = httpEtagOf(obj);
    const headers: Record<string, string> = { ...cors, 'Cache-Control': 'no-cache', ETag: etag, ...pollHeader };
    if (etagSatisfies(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(await obj.arrayBuffer(), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    console.log(JSON.stringify({ latestRouteFailed: String(error) }));
    return json(503, { error: 'temporarily unavailable' }, { ...cors, 'Retry-After': '30' });
  }
}

/** GET /api/norm/{layer}/{slot}[?g=n] — 캐시 정책이 pinned 여부로 갈린다 (리뷰 Med1):
 *  - unpinned: 포인터가 가리키는 g가 정정(g 상승)으로 바뀌는 URL — no-cache + g 기반
 *    ETag 재검증. g 불변이면 304(바디 생략), 상승하면 새 바디가 즉시 닿는다.
 *  - ?g= pinned: versioned URL(내용 불변) — 브라우저 immutable 장기 캐시.
 *    최신 g는 /api/manifest/{date}(60s)로 알아내 핀하는 것이 계약 (PLAN §8.6). */
async function normRoute(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  layer: string,
  slotStr: string,
  gParam: string | null,
  deps: ProxyDeps,
): Promise<Response> {
  if (!isLayerId(layer)) return notFound(cors);
  const slot = Number(slotStr);
  if (!isServableSlot(slot)) return notFound(cors);

  const pinned = gParam !== null;
  let generation: number;
  if (pinned) {
    if (!GENERATION_RE.test(gParam)) return notFound(cors);
    generation = Number(gParam); // 핀 요청 — 포인터 read 생략 (Class B 절감)
  } else {
    const pointer = await env.DATA.get(normPointerKey(dtOf(slot)));
    if (!pointer) return notFound(cors);
    const shard = (await pointer.json()) as PointerShard;
    const entry = shard.layers?.[layer]?.[String(slot)];
    if (!entry) return notFound(cors);
    generation = entry.g;
  }

  const etag = `"g${generation}"`; // 포인터 g 기반 — URL 스코프라 slot/layer 간 충돌 없음
  const baseHeaders: Record<string, string> = {
    ...cors,
    'Cache-Control': pinned ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: etag,
    'X-Norm-Generation': String(generation),
  };
  // unpinned만 재검증 — pinned는 immutable이라 브라우저가 If-None-Match를 보내지 않는다
  if (!pinned && etagSatisfies(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  // Worker Cache API — R2 Class B 절감용이지 invocation 절감이 아니다 (§8.6:
  // 캐시 히트여도 Worker invocation 1회는 그대로 과금·카운트된다).
  // 캐시 키는 g 포함 versioned 합성 URL — 공개 URL을 그대로 키로 쓰면 unversioned라
  // 정정(g 상승)이 캐시에 영구 은폐된다.
  // 주의: 기본 *.workers.dev 배포에선 Cache API가 no-op — custom domain/route 연결 시
  // 활성된다. 그때까지 절감 실효 없음(§8.6은 Class B 무료 한도 직접 검산으로 방어),
  // 코드는 계약대로 두고 match 미스로 자연 통과한다.
  const cache = deps.cache !== undefined ? deps.cache : defaultCache();
  const cacheKey = new Request(`https://lwp-r2-cache.internal/norm/${layer}/${slot}/g${generation}`);
  const hit = cache ? await cache.match(cacheKey) : undefined;

  let bytes: ArrayBuffer;
  if (hit) {
    bytes = await hit.arrayBuffer();
  } else {
    const obj = await env.DATA.get(normKey(layer, slot, generation));
    if (!obj) return notFound(cors);
    bytes = await obj.arrayBuffer();
    if (cache) {
      await cache.put(
        cacheKey,
        new Response(bytes, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }),
      );
    }
  }

  // 저장 바디가 이미 gzip이므로 재압축 없이 통과 — encodeBody: 'manual'이 없으면
  // Workers 런타임이 자동 인코딩 경로로 바디를 이중 처리한다.
  return new Response(bytes, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    },
    encodeBody: 'manual',
  });
}

/** GET /api/manifest/{date} — norm 포인터 shard 통과 (타임라인 갭 밴드·?g= 핀의 근거).
 *  포인터는 CAS로 계속 갱신되는 객체라 짧은 캐시(60s) + ETag 재검증. */
async function manifestRoute(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  date: string,
): Promise<Response> {
  if (!isServableDate(date)) return notFound(cors);
  const obj = await env.DATA.get(normPointerKey(date));
  if (!obj) return notFound(cors);
  const etag = httpEtagOf(obj);
  const headers: Record<string, string> = {
    ...cors,
    'Cache-Control': 'public, max-age=60',
    ETag: etag,
  };
  if (etagSatisfies(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(await obj.arrayBuffer(), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function isPollRelaxed(bucket: R2Bucket): Promise<boolean> {
  const now = Date.now();
  if (pollFlagCache && now < pollFlagCache.expiresAtMs) return pollFlagCache.relaxed;
  const relaxed = (await bucket.head(POLL_RELAX_KEY)) !== null;
  pollFlagCache = { relaxed, expiresAtMs: now + POLL_FLAG_TTL_MS };
  return relaxed;
}

/** R2 httpEtag(quoted) 우선 — 테스트 fake는 etag 필드만 두므로 폴백 */
function httpEtagOf(obj: { httpEtag?: string; etag: string }): string {
  return obj.httpEtag ?? obj.etag;
}

/** If-None-Match 판정 — 목록·weak(W/)·'*' 허용 */
function etagSatisfies(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((token) => {
    const v = token.trim().replace(/^W\//, '');
    return v === '*' || v === etag;
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : origin !== null && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : null;
  // 비허용 오리진: CORS 헤더 없이 처리 → 브라우저가 응답을 차단 (서버 측 차단은 rate limit 몫)
  if (allowed === null) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Expose-Headers': 'ETag, X-Poll-Interval, X-Norm-Generation',
    ...(allowed === '*' ? {} : { Vary: 'Origin' }),
  };
}

function preflight(cors: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'If-None-Match',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function notFound(cors: Record<string, string>): Response {
  return json(404, { error: 'not found' }, cors);
}

function json(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function defaultCache(): Cache | null {
  const cs = (globalThis as { caches?: { default?: Cache } }).caches;
  return cs?.default ?? null;
}

/** daily capacity scan (PLAN §8.6 fail-safe 이중 관측).
 *  ① 일 1회(UTC 03:07) prefix별 paginated LIST로 실측 용량 산출 → manifest/capacity/dt=.json 기록
 *     (기대치 누적이 아니라 실측 — lifecycle 삭제 실패를 잡는 유일한 방법)
 *  ② 실측 8GB 초과 시 halt 플래그 PUT → 이후 invocation은 수집 스킵 (자동 과금 차단).
 *     해제는 수동 삭제만 (wrangler r2 object delete lwp-data/manifest/halt.json). */
import { HALT_KEY, capacityKey, dtOf } from '../slots';
import { POLL_RELAX_KEY } from '../proxy';
import { putIfAbsent } from './norm';

export const CAPACITY_LIMIT_BYTES = 8 * 1024 ** 3; // 8GB — §8.6 fail-safe 선
export const SCAN_HOUR_UTC = 3;
export const SCAN_MINUTE_UTC = 7;

/** 버킷 전체를 덮는 top-level prefix 목록 — 새 top-level 경로 추가 시 여기도 갱신 (§8.6 표와 정렬) */
const SCAN_PREFIXES = ['raw/', 'norm/', 'agg/', 'pin/', 'manifest/', 'latest.json'] as const;

/** norm 60s/180s → 900s 슬라이스 형식 전환 기록 — 초기 수 시간분 옛 슬롯은 재작성하지 않는다.
 *
 *  cutoff 계약 (재리뷰 Med1):
 *  - cutoffEpochSec = 900s 코드가 배포된 시각 (wrangler deployments 실측 2026-08-18T19:03:41.540Z).
 *  - slot >= cutoff: 항상 900s 키 (slot % 900 === 0).
 *  - slot < cutoff: legacy 60s(earthquake)/180s(flight) 키일 수 있고, 지진 all_hour 백필이
 *    cutoff 직후 과거 슬롯에 900s 파일을 쓴 것과 혼재 — 각 파일의 slotDurationSec 필드가 판정 기준.
 *  - 경계 키 충돌: 900의 배수는 60·180의 배수이기도 하므로 15분 정각의 legacy 슬롯은
 *    900s 슬롯과 같은 slot= 값(키 공간)을 공유한다. 이 경우 덮어쓰기가 아니라 generation
 *    상승(g+1)으로 merge되며 포인터·slotDurationSec이 최종 상태를 판정한다 (slots-keys 테스트 참조). */
const NORM_900_CUTOFF_EPOCH_SEC = 1_787_079_821; // 2026-08-18T19:03:41Z (전환 배포)
const FORMAT_TRANSITION_KEY = 'manifest/format/norm-slot-900.json';
const FORMAT_TRANSITION_BODY = JSON.stringify({
  change: 'norm slot slice 60s(earthquake)/180s(flight) → 900s all layers',
  cutoffEpochSec: NORM_900_CUTOFF_EPOCH_SEC,
  cutoffAt: '2026-08-18T19:03:41.540Z',
  contract:
    'slot >= cutoffEpochSec: 900s keys. slot < cutoffEpochSec: legacy 60/180s keys, possibly mixed with 900s backfill — slotDurationSec in each file is authoritative. Legacy slots at 15-min marks share the slot= key space with 900s slots; they merge via generation bump, never overwrite.',
});

export interface PrefixUsage {
  bytes: number;
  objects: number;
}

export interface CapacityRecord {
  dt: string;
  measuredAt: string;
  totalBytes: number;
  limitBytes: number;
  overLimit: boolean;
  perPrefix: Record<string, PrefixUsage>;
}

export function isScanSlot(scheduledMs: number): boolean {
  const d = new Date(scheduledMs);
  return d.getUTCHours() === SCAN_HOUR_UTC && d.getUTCMinutes() === SCAN_MINUTE_UTC;
}

/** halt 플래그 존재 = 수집 전면 정지 (HEAD 1회/분 — Class B) */
export async function isHalted(bucket: R2Bucket): Promise<boolean> {
  return (await bucket.head(HALT_KEY)) !== null;
}

export async function runDailyCapacityScan(
  bucket: R2Bucket,
  nowMs: number,
): Promise<CapacityRecord> {
  const perPrefix: Record<string, PrefixUsage> = {};
  let totalBytes = 0;

  for (const prefix of SCAN_PREFIXES) {
    const usage = await sumPrefix(bucket, prefix);
    perPrefix[prefix] = usage;
    totalBytes += usage.bytes;
  }

  const dt = dtOf(Math.floor(nowMs / 1000));
  const record: CapacityRecord = {
    dt,
    measuredAt: new Date(nowMs).toISOString(),
    totalBytes,
    limitBytes: CAPACITY_LIMIT_BYTES,
    overLimit: totalBytes > CAPACITY_LIMIT_BYTES,
    perPrefix,
  };
  // 재리뷰 Med2 — halt가 capacity 기록보다 먼저: 기록 PUT이 실패해도 fail-safe는 반드시 선다
  if (record.overLimit) {
    await bucket.put(
      HALT_KEY,
      JSON.stringify({
        reason: 'capacity over fail-safe limit',
        totalBytes,
        limitBytes: CAPACITY_LIMIT_BYTES,
        measuredAt: record.measuredAt,
        resolve: 'shrink retention/agg, then delete this object manually to resume',
      }),
    );
  }

  await bucket.put(capacityKey(dt), JSON.stringify(record));

  // 일 1회 저빈도 경로에 얹는 형식 전환 기록 — 이미 있으면 no-op
  await putIfAbsent(bucket, FORMAT_TRANSITION_KEY, FORMAT_TRANSITION_BODY);

  return record;
}

/** §8.6 quota 방어 ① producer (리뷰 Med3) — daily scan에서 전일 Worker invocation을
 *  Cloudflare GraphQL Analytics로 조회해 무료 예산(100k/day) 80% 초과면 POLL_RELAX_KEY
 *  PUT(프록시가 X-Poll-Interval: 180 지시), 미만이면 DELETE로 해제.
 *  - CF_API_TOKEN·CF_ACCOUNT_ID 미설정: 로그만 남기고 스킵 (지금은 미등록 — 코드만 준비).
 *  - Analytics 조회 실패: 플래그 불변 — 일시 장애로 이미 선 완화를 풀지 않는다 (fail-safe 방향). */
export const DAILY_INVOCATION_BUDGET = 100_000;
export const POLL_RELAX_THRESHOLD = 0.8;
const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const ANALYTICS_TIMEOUT_MS = 10_000;

export type PollRelaxResult =
  | { status: 'skipped'; reason: 'missing-credentials' }
  | { status: 'relaxed' | 'cleared'; date: string; requests: number }
  | { status: 'error'; error: string };

export interface PollRelaxEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

export async function runPollRelaxScan(
  bucket: R2Bucket,
  env: PollRelaxEnv,
  nowMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<PollRelaxResult> {
  const token = env.CF_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  if (!token || !account) return { status: 'skipped', reason: 'missing-credentials' };

  const date = dtOf(Math.floor(nowMs / 1_000) - 86_400); // 전일 UTC
  try {
    const requests = await fetchDailyInvocations(fetchFn, token, account, date);
    if (requests > DAILY_INVOCATION_BUDGET * POLL_RELAX_THRESHOLD) {
      await bucket.put(
        POLL_RELAX_KEY,
        JSON.stringify({
          date,
          requests,
          budget: DAILY_INVOCATION_BUDGET,
          threshold: POLL_RELAX_THRESHOLD,
          setAt: new Date(nowMs).toISOString(),
        }),
      );
      return { status: 'relaxed', date, requests };
    }
    await bucket.delete(POLL_RELAX_KEY);
    return { status: 'cleared', date, requests };
  } catch (error: unknown) {
    return { status: 'error', error: String(error) };
  }
}

interface InvocationsQueryResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }>;
      }>;
    };
  };
  errors?: Array<{ message?: string }> | null;
}

async function fetchDailyInvocations(
  fetchFn: typeof fetch,
  token: string,
  account: string,
  date: string,
): Promise<number> {
  // 스크립트 필터 없이 계정 전체 합계 — Workers Free 100k/day는 계정 한도라
  // 같은 계정의 다른 Worker·Pages Functions 사용량까지 포함해야 80% 판정이 보수적으로 맞다.
  const query = `query LwpDailyInvocations($accountTag: string!, $date: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 1000, filter: { date: $date }) {
        sum { requests }
      }
    }
  }
}`;
  const res = await fetchFn(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { accountTag: account, date } }),
    signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`analytics http ${res.status}`);
  const body = (await res.json()) as InvocationsQueryResponse;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`analytics graphql: ${body.errors[0]?.message ?? 'unknown'}`);
  }
  const groups = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (!groups) throw new Error('analytics response missing workersInvocationsAdaptive');
  return groups.reduce((total, g) => total + (g.sum?.requests ?? 0), 0);
}

async function sumPrefix(bucket: R2Bucket, prefix: string): Promise<PrefixUsage> {
  let bytes = 0;
  let objects = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      bytes += obj.size;
      objects += 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { bytes, objects };
}

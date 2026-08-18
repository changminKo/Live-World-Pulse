/** daily capacity scan (PLAN §8.6 fail-safe 이중 관측).
 *  ① 일 1회(UTC 03:07) prefix별 paginated LIST로 실측 용량 산출 → manifest/capacity/dt=.json 기록
 *     (기대치 누적이 아니라 실측 — lifecycle 삭제 실패를 잡는 유일한 방법)
 *  ② 실측 8GB 초과 시 halt 플래그 PUT → 이후 invocation은 수집 스킵 (자동 과금 차단).
 *     해제는 수동 삭제만 (wrangler r2 object delete lwp-data/manifest/halt.json). */
import { HALT_KEY, capacityKey, dtOf } from '../slots';
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

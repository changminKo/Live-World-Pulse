/** R2 키 규약 (PLAN §8.6 표 + §8.7 멱등성 계약) — collector slots.ts에서 승격. 시간은 전부 UTC.
 *  주의: OBSERVATION_BUCKET_SEC(180)는 §5 Observation ID 전용,
 *  norm 파일 슬라이스는 전 레이어 NORM_SLOT_SEC(900) — 두 상수를 혼용하지 말 것. */
import type { LayerId, Source } from './types';

/** §5 Observation ID 계약: sourceId = `${entityId}:${bucketTs}`, bucketTs = floor(epochSec/180)*180 */
export const OBSERVATION_BUCKET_SEC = 180;
/** §8.6 norm 슬라이스 계약: 전 레이어 15분(900s) 파일 슬롯 */
export const NORM_SLOT_SEC = 900;

/** slot 시작 epoch 초 = floor(epochSec / slotSec) * slotSec */
export function slotStartSec(epochMs: number, slotSec: number): number {
  return Math.floor(epochMs / 1000 / slotSec) * slotSec;
}

/** UTC YYYY-MM-DD */
export function dtOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

/** UTC HH */
export function hourOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 13);
}

/** raw/{source}/dt={YYYY-MM-DD}/hour={HH}/{epochMs}-{name}.json.gz */
export function rawKey(source: Source, epochMs: number, name: string): string {
  const sec = Math.floor(epochMs / 1000);
  return `raw/${source}/dt=${dtOf(sec)}/hour=${hourOf(epochMs)}/${epochMs}-${name}.json.gz`;
}

/** norm/{layer}/dt={date}/slot={slotStart}.g{generation}.json.gz — versioned key (§8.7) */
export function normKey(layer: LayerId, slot: number, generation: number): string {
  return `norm/${layer}/dt=${dtOf(slot)}/slot=${slot}.g${generation}.json.gz`;
}

/** manifest/{layer}/dt={date}/slot={t}.g{generation}.json — immutable 수집 원장 엔트리 */
export function manifestEntryKey(layer: LayerId, slot: number, generation: number): string {
  return `manifest/${layer}/dt=${dtOf(slot)}/slot=${slot}.g${generation}.json`;
}

/** 고아 generation 점프용 prefix (norm.ts probe 소진 방지 — LIST로 존재 최대 g 탐색) */
export function normSlotPrefix(layer: LayerId, slot: number): string {
  return `norm/${layer}/dt=${dtOf(slot)}/slot=${slot}.g`;
}
export function manifestSlotPrefix(layer: LayerId, slot: number): string {
  return `manifest/${layer}/dt=${dtOf(slot)}/slot=${slot}.g`;
}

/** manifest/pointers/norm/dt={date}.json — 슬롯별 최신 generation 포인터 (일 단위 shard, CAS) */
export function normPointerKey(dt: string): string {
  return `manifest/pointers/norm/dt=${dt}.json`;
}

/** manifest/status/{layer}/dt={date}/slot={t}.{scheduledMs}.a{attempt}.json —
 *  수집 시도별 immutable 상태 원장 (성공-empty·부분 실패·전면 실패를 갭과 구분).
 *  attempt 순번: 같은 scheduledMs의 중복 기록 시도도 덮어쓰지 않고 비켜 쓴다 (putIfAbsent 전제) */
export function statusKey(layer: LayerId, slot: number, scheduledMs: number, attempt: number): string {
  return `manifest/status/${layer}/dt=${dtOf(slot)}/slot=${slot}.${scheduledMs}.a${attempt}.json`;
}

/** manifest/capacity/dt={date}.json — daily capacity scan 실측 기록 (§8.6 fail-safe ①) */
export function capacityKey(dt: string): string {
  return `manifest/capacity/dt=${dt}.json`;
}

export const LATEST_KEY = 'latest.json';
/** §8.6 fail-safe ②: 이 키가 존재하면 수집 전면 정지 (수동 삭제로만 해제) */
export const HALT_KEY = 'manifest/halt.json';

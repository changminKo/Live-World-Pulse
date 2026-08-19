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

/* ── weather 파이프라인 스테이징 (2026-08-19 CPU 사다리 — 페이지 청크 분할) ──
 *  GDACS 커밋을 한 invocation에서 하면 페이지 6~8개(810KB+)를 한 번에
 *  gunzip+parse해 Free 하드 10ms를 3배 초과했다 (프로덕션 26ms 실측).
 *  그래서 페이지 슬롯이 **가져온 즉시 정규화**해 청크로 남기고, 커밋 슬롯은
 *  정규화된 청크(합계 ~200KB)만 읽는다. 스테이징은 커밋이 지우고,
 *  남은 잔재는 daily capacity scan이 2시간 경과분을 청소한다. */

/** weather 수집 사이클 = 60분 (시간당 1회). 사이클 시작 epoch ms가 스테이징 키의 세대.
 *  30분 → 60분 완화 사유 (2026-08-19 프로덕션 실측): GDACS 리스트 페이지 1장(135KB)의
 *  [fetch → raw gzip PUT → parse → 정규화 → 청크 PUT]이 Workers에서 ~6.5ms다
 *  (슬롯당 2장 = 13ms 실측). 그래서 슬롯당 1장으로 내렸고, 실측 수요 8장(Green 6 +
 *  Orange 1 + Red 1)을 담으려면 사이클당 페이지 슬롯 8개가 필요하다 → 시간당 1사이클.
 *  경보는 시간 단위로 움직이므로(GDACS `datemodified` 실측) 60분 갱신은 수용 가능하고,
 *  프론트 stale 임계(weather 60분 × 2 = 120분)와도 정합한다. */
export const WEATHER_CYCLE_SEC = 3600;

/** 사이클 시작 epoch ms — 스테이징 키/진행 마커의 세대 식별자 */
export function weatherCycleStartMs(epochMs: number): number {
  return slotStartSec(epochMs, WEATHER_CYCLE_SEC) * 1000;
}

export const WEATHER_STAGING_PREFIX = 'staging/weather/';

/** staging/weather/cycle={cycleStartMs}/ — 사이클 단위 스테이징 prefix */
export function weatherCyclePrefix(cycleStartMs: number): string {
  return `${WEATHER_STAGING_PREFIX}cycle=${cycleStartMs}/`;
}

/** 정규화된 페이지 청크 — 본문은 WeatherAlertRecord[] JSON 배열 (커밋이 parse) */
export function weatherChunkKey(cycleStartMs: number, level: string, page: number): string {
  return `${weatherCyclePrefix(cycleStartMs)}${level.toLowerCase()}-p${page}.json`;
}

/** 사이클 진행 마커 — 레벨별 페이지 수·종료 상태. 커밋의 완주 게이트(Med1) */
export function weatherProgressKey(cycleStartMs: number): string {
  return `${weatherCyclePrefix(cycleStartMs)}progress.json`;
}

/** 활성 TC 인덱스 (커밋이 발행, 트랙 슬롯이 읽음) — 작은 목록 하나 */
export const TC_INDEX_KEY = 'weather/tc-index.json';

/** TC 트랙·콘 캐시 — getgeometry 1회 결과. 커밋이 읽어 경보 지오메트리에 합성 */
export function tcTrackKey(eventId: number, episodeId: number): string {
  return `weather/tracks/${eventId}-${episodeId}.json`;
}

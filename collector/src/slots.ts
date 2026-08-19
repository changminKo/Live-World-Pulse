/** R2 키 규약은 shared로 승격 (PLAN §8.6·§8.7 — 프론트 Worker 프록시와 공유 계약).
 *  기존 임포트 경로 유지를 위한 재수출 — 키 문자열은 1바이트도 불변. */
export {
  HALT_KEY,
  LATEST_KEY,
  NORM_SLOT_SEC,
  OBSERVATION_BUCKET_SEC,
  capacityKey,
  dtOf,
  hourOf,
  manifestEntryKey,
  manifestSlotPrefix,
  normKey,
  normPointerKey,
  normSlotPrefix,
  rawKey,
  slotStartSec,
  statusKey,
} from '@lwp/shared';

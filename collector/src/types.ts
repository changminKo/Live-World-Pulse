/** 데이터 모델은 shared 계약(PLAN §5 전문)에서 승격·공유 — 여기는 재수출 + collector 고유 타입만.
 *  Phase 0a 실구현 레이어는 earthquake + flight 부분집합 (NormRecord). */
export type {
  EarthquakePayload,
  EarthquakeRecord,
  FlightRecord,
  FlightStatePayload,
  Geometry,
  Iso,
  LayerId,
  Observation,
  Occurrence,
  Position,
  RecordBase,
  Severity,
  SeverityRank,
  Source,
  WorldRecord,
} from '@lwp/shared';
import type { EarthquakeRecord, FlightRecord } from '@lwp/shared';

/** Phase 0a 수집 대상 부분집합 — weather/news 어댑터 추가 시 WorldRecord로 수렴 */
export type NormRecord = EarthquakeRecord | FlightRecord;

export interface Env {
  DATA: R2Bucket;
  HEALTHCHECKS_URL?: string;
  /** /__gates/* 인증 시크릿 — 미설정 시 게이트 전체 404 (fail-closed) */
  GATE_TOKEN?: string;
}

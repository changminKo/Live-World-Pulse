/** 데이터 모델은 shared 계약(PLAN §5 전문)에서 승격·공유 — 여기는 재수출 + collector 고유 타입만.
 *  Phase 1: 4레이어 전부 수집 (NormRecord = WorldRecord로 수렴 완료). */
export type {
  EarthquakePayload,
  EarthquakeRecord,
  FlightRecord,
  FlightStatePayload,
  Geometry,
  Interval,
  Iso,
  LayerId,
  NewsPayload,
  NewsRecord,
  Observation,
  Occurrence,
  Position,
  RecordBase,
  Severity,
  SeverityRank,
  Source,
  WeatherAlertPayload,
  WeatherAlertRecord,
  WorldRecord,
} from '@lwp/shared';
import type { WorldRecord } from '@lwp/shared';

/** Phase 0a에는 earthquake+flight 부분집합이었다 — Phase 1에서 전 레이어로 수렴 */
export type NormRecord = WorldRecord;

export interface Env {
  DATA: R2Bucket;
  HEALTHCHECKS_URL?: string;
  /** /__gates/* 인증 시크릿 — 미설정 시 게이트 전체 404 (fail-closed) */
  GATE_TOKEN?: string;
  /** daily poll-relax scan용 GraphQL Analytics 자격 (§8.6 quota 방어 ①) — 둘 다 있어야 동작, 미설정 시 스킵 */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

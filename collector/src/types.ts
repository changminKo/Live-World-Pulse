/** PLAN §5 데이터 모델 — Phase 0a 부분집합 (earthquake + flight).
 *  좌표는 GeoJSON 순서 [lon, lat] — 라벨드 튜플로 컴파일 타임 강제.
 *  시간은 전부 UTC ISO-8601 / epoch ms. */

export type Iso = string;
export type LayerId = 'earthquake' | 'weather' | 'flight' | 'news';

export type Position = [lon: number, lat: number, alt?: number];

/** 0a는 Point만 필요 (지진 진앙, 항공기 표본) */
export type Geometry = { type: 'Point'; coordinates: Position };

/** 레이어 간 물리량 비교가 아니라 시각 인코딩 순위 (CAP 등급 차용) */
export type SeverityRank = 0 | 1 | 2 | 3 | 4; // unknown|minor|moderate|severe|extreme

export interface Severity {
  rank: SeverityRank;
  raw?: number;
  unit?: 'Mww' | 'mps' | 'hPa' | 'count';
  label?: string;
}

export interface RecordBase {
  id: string; // `${source}:${sourceId}` 멱등 키
  source: 'usgs' | 'adsblol';
  sourceId: string;
  layer: LayerId;
  /** 원본 정정 시 증가. USGS는 feed의 updated(epoch ms)를 그대로 사용 —
   *  stateless 수집기에서 단조 증가를 보장하는 유일한 원본 신호. */
  revision: number;
  observedAt: Iso;
  ingestedAt: Iso;
  geometry: Geometry;
  centroid: [lon: number, lat: number];
  /** 0a 스텁 ('' 고정) — H3 res-3 부여는 Phase 1 agg 구현과 함께 */
  h3r3: string;
  severity: Severity;
}

/** (1) Occurrence — 한 시점 발생 사건 (지진) */
export interface Occurrence<P> extends RecordBase {
  kind: 'occurrence';
  occurredAt: Iso;
  payload: P;
}

/** (3) Observation — 연속 존재 개체의 시각 t 표본 (항공기).
 *  ID 계약: sourceId = `${entityId}:${bucketTs}`, bucketTs = floor(epochSec/180)*180 */
export interface Observation<P> extends RecordBase {
  kind: 'observation';
  entityId: string; // icao24 hex
  sampledAt: Iso;
  payload: P;
}

export interface EarthquakePayload {
  type: 'earthquake';
  magnitude: number | null;
  magType: string | null;
  depthKm: number | null;
  place: string | null;
  tsunami: boolean;
  status: string | null;
  url: string | null;
}

export interface FlightStatePayload {
  type: 'flight';
  regionId: string;
  callsign: string | null;
  altBaroFt: number | 'ground' | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  aircraftType: string | null;
  registration: string | null;
  category: string | null;
  seenPosSec: number | null;
}

export type EarthquakeRecord = Occurrence<EarthquakePayload>;
export type FlightRecord = Observation<FlightStatePayload>;
export type NormRecord = EarthquakeRecord | FlightRecord;

export interface Env {
  DATA: R2Bucket;
  HEALTHCHECKS_URL?: string;
  /** /__gates/* 인증 시크릿 — 미설정 시 게이트 전체 404 (fail-closed) */
  GATE_TOKEN?: string;
}

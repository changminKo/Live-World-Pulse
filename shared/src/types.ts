/** PLAN §5 데이터 모델 전문 — 프론트(web/)와 Collector가 공유하는 계약.
 *  좌표는 GeoJSON 순서 [lon, lat] — 라벨드 튜플로 컴파일 타임 강제.
 *  시간은 전부 UTC ISO-8601 / epoch ms. bitemporal replay(asKnownAt) 미지원 (§5 $0 결정). */

export type Iso = string; // ISO-8601, 항상 UTC
export type LayerId = 'earthquake' | 'weather' | 'flight' | 'news';
export type Source = 'usgs' | 'nws' | 'wmo' | 'gdacs' | 'adsblol' | 'gdelt';

/** GeoJSON 좌표는 [lon, lat]. 라벨드 튜플로 순서 실수를 컴파일 타임에 잡는다. */
export type Position = [lon: number, lat: number, alt?: number];
export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] } // 태풍 트랙, 항적
  | { type: 'Polygon'; coordinates: Position[][] } // 경보 구역
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

/** 레이어 간 '물리량 비교'가 아니라 '시각 인코딩 순위'. CAP 등급 차용. */
export type SeverityRank = 0 | 1 | 2 | 3 | 4; // unknown|minor|moderate|severe|extreme

export interface Severity {
  rank: SeverityRank;
  raw?: number; // 원본값 보존 (M7.1의 7.1)
  unit?: 'Mww' | 'mps' | 'hPa' | 'count';
  label?: string; // 'M7.1', 'Typhoon Warning', '42 reports'
}

/** 공통: 출처 / 멱등키 / 양시간 / 지오메트리 */
export interface RecordBase {
  id: string; // `${source}:${sourceId}` 멱등 키
  source: Source;
  sourceId: string; // 원본 고유 ID → 멱등 키 (파일 내 레코드 병합 기준)
  layer: LayerId;
  /** 원본 정정 시 증가 (USGS 규모 정정). USGS는 feed의 updated(epoch ms)를 그대로 사용 —
   *  stateless 수집기에서 단조 증가를 보장하는 유일한 원본 신호. */
  revision: number;
  observedAt: Iso; // 원본이 관측/발표한 시각
  ingestedAt: Iso; // 우리가 알게 된 시각 (수집 지연 관찰용)
  geometry: Geometry;
  centroid: [lon: number, lat: number]; // 렌더/클러스터링 캐시
  /** H3 res-3 셀 — LOD 집계 조인 키 (Phase 0a 스텁 '' — 부여는 Phase 1 agg와 함께) */
  h3r3: string;
  severity: Severity;
}

/** (1) Occurrence — 한 시점에 발생하고 끝난 사건. 지진, 뉴스. */
export interface Occurrence<P> extends RecordBase {
  kind: 'occurrence';
  occurredAt: Iso;
  payload: P;
}

/** (2) Interval — 지속 구간을 갖는 상태. 기상 경보. */
export interface Interval<P> extends RecordBase {
  kind: 'interval';
  validFrom: Iso;
  validTo: Iso | null; // null = 미해제
  status: 'active' | 'updated' | 'cancelled' | 'expired';
  payload: P;
}

/** (3) Observation — 연속 존재 개체의 시각 t 표본. 항공기, 태풍 중심.
 *  ID 계약 (반복 표본이라 공통 규칙과 다름): sourceId = `${entityId}:${bucketTs}`,
 *  bucketTs = floor(epochSec/180)*180 (OBSERVATION_BUCKET_SEC — r2-keys.ts). */
export interface Observation<P> extends RecordBase {
  kind: 'observation';
  entityId: string; // icao24 hex / 태풍 국제번호
  sampledAt: Iso;
  payload: P;
}

/* ── 레이어별 payload — discriminated union (`metadata: Record<string, unknown>` 백 금지) ── */

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

/** 확정 코어 (Phase 0b — 이후 필드 추가는 optional로만, 기존 필드 변경 금지).
 *  CAP 공통 + 소스별 optional (WMO/NWS/GDACS — PLAN §4.2).
 *  capSeverity 또는 gdacsAlertLevel → severity.rank 매핑 (둘 다 null이면 rank 0). */
export interface WeatherAlertPayload {
  type: 'weatherAlert';
  event: string | null; // 'Typhoon Warning'
  headline: string | null;
  areaDesc: string | null;
  capSeverity: 'Minor' | 'Moderate' | 'Severe' | 'Extreme' | null; // CAP 소스 (WMO/NWS)
  gdacsAlertLevel: 'Green' | 'Orange' | 'Red' | null; // GDACS 원본 등급 보존 (rank 1/2/4 매핑)
  gdacsEventType: string | null; // GDACS 이벤트 종류 (TC/FL/...) — 비GDACS는 null
  url: string | null;
  /** optional 추가 (2026-08-19): GDACS `todate`는 경보 해제 시각이 아니라 **관측
   *  데이터 종료 시각**이다 — validTo로 쓰면 미해제 경보가 전부 과거 구간이 되어
   *  interval 슬라이스에서 사라진다(실측 422/422 소실). 미해제 경보는 validTo=null로
   *  두고 원본 todate는 여기에 보존한다. 해제된 경보는 validTo와 같은 값. */
  observedUntil?: Iso | null;
  /** optional 추가 (2026-08-19): 같은 경보에서 파생된 지오메트리 종류 구분.
   *  'track' = TC 중심 경로 LineString(레코드 본체), 'cone' = 예보 불확실성 콘 Polygon
   *  (sourceId에 `:cone` 접미가 붙은 파생 레코드). 없으면 리스트 그대로의 Point.
   *  GDACS getgeometry는 **TC에만** 트랙/콘을 준다 — 홍수 등 비TC 경보의 영역 폴리곤은
   *  이벤트당 1콜이라 $0 예산에서 미수집 (백로그 — PLAN §4.2). */
  gdacsGeometryKind?: 'track' | 'cone';
}

/** 확정 코어 (Phase 0b — 이후 필드 추가는 optional로만, 기존 필드 변경 금지).
 *  MVP 표현 = 도시/지역별 카운트 집계 (PLAN §4.4 — 기사 단위 마커 후순위).
 *  GDELT raw 파일(ActionGeo) 기반 — placeName은 집계 키, sampleUrl은 대표 기사. */
export interface NewsPayload {
  type: 'news';
  placeName: string | null; // 'Tokyo'
  articleCount: number;
  sampleUrl: string | null;
}

export type EarthquakeRecord = Occurrence<EarthquakePayload>;
export type NewsRecord = Occurrence<NewsPayload>;
export type WeatherAlertRecord = Interval<WeatherAlertPayload>;
export type FlightRecord = Observation<FlightStatePayload>;

/** Track은 저장 타입이 아니라 Observation[]을 entityId로 접은 파생 뷰. */
export type WorldRecord = EarthquakeRecord | NewsRecord | WeatherAlertRecord | FlightRecord;

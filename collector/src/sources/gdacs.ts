/** GDACS 어댑터 (PLAN §4.2 — Phase 1 weather 0단계 소스. WMO CAP·NWS는 후속).
 *  실측 주의 (docs/review/research/gdacs.md + 2026-08-19 재실측):
 *  - SEARCH 기본은 Orange/Red만. `alertlevel=Green;Orange;Red` 통합 지정은 서버가
 *    ';'를 파라미터 구분자로 먹어 Green 단독 + iscurrent=true 100건 캡으로 동작
 *    (current Orange가 캡에 잘려나가는 것 실측 확인) → **레벨별 3콜 + dedupe**로 우회.
 *  - TC 트랙포인트는 Point가 아니라 소형 Polygon (Class=Point_Polygon_Point_{n})
 *    → ring 평균 centroid 추출, n 순서로 LineString 구성. 같은 getgeometry 응답에
 *    예보 불확실성 콘(Class=Poly_Cones, 단일 ring 215점)도 들어 있어 추가 콜 없이 쓴다.
 *  - **비TC 경보(홍수·산불 등)의 영역 폴리곤은 수집하지 않는다** — getgeometry가
 *    이벤트당 1콜이라 활성 400건이면 400콜이고, $0·10ms 예산에 들어가지 않는다 (백로그).
 *  - 타임스탬프는 UTC인데 zone 표기가 없다 ("2026-08-19T05:22:24") → Z 보정 필수. */
import { validateLonLat } from '../coords';
import type { NormalizeOutcome } from './usgs';
import type { Position, SeverityRank, WeatherAlertPayload, WeatherAlertRecord } from '../types';

export const GDACS_ALERT_LEVELS = ['Green', 'Orange', 'Red'] as const;
export type GdacsAlertLevel = (typeof GDACS_ALERT_LEVELS)[number];

/** 종료 후에도 잠시 보이는 경보 유예 창 — 이 창을 지난 expired는 슬롯에 싣지 않는다
 *  (레벨별 콜이 2025년까지의 히스토리를 항상 되돌려주므로 무한 재적재 방지) */
export const RECENT_EXPIRED_WINDOW_MS = 48 * 3600_000;

/** 페이지 크기 — 서버 기본이자 상한 100 (Swagger·실측 2026-08-19) */
export const GDACS_PAGE_SIZE = 100;
/** 레벨당 페이지 안전 캡 — 히스토리 무한 페이징 방어. 캡 도달 = capped 신호로 기록.
 *  2026-08-19 재리뷰 Med2로 4 → 8 복원:
 *  - 캡 4는 실제 데이터를 잘랐다. 실측(2026-08-19 23:16 UTC) Green current 분포는
 *    p1~p3 각 100 / p4 93 / p5 32 / p6 0 — 즉 **총 425건이고 종료 판정은 p6**인데,
 *    캡 4는 p5의 32건을 통째로 버리면서 fetch를 ok로 기록했다.
 *  - CPU는 캡이 아니라 **분할**로 해결한다: 페이지는 슬롯당 PAGES_PER_SLOT개씩만
 *    가져와 즉시 정규화하고(collect.ts collectWeatherPages), 커밋 슬롯은 정규화된
 *    청크만 읽는다. 캡을 올려도 invocation당 파싱량은 늘지 않는다.
 *  - 캡 도달은 여전히 잘림이다: status 원장 `page_capped` + 커밋 결과 partial
 *    (ok 아님 — 재리뷰 Med2). */
export const GDACS_PAGE_CAP = 8;

export function gdacsListUrl(level: GdacsAlertLevel, page = 1): string {
  return `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=${level}&pagenumber=${page}&pagesize=${GDACS_PAGE_SIZE}`;
}

export function gdacsGeometryUrl(eventType: string, eventId: number, episodeId: number): string {
  return `https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=${encodeURIComponent(eventType)}&eventid=${eventId}&episodeid=${episodeId}`;
}

interface GdacsFeature {
  properties?: {
    eventtype?: unknown;
    eventid?: unknown;
    episodeid?: unknown;
    name?: unknown;
    alertlevel?: unknown;
    fromdate?: unknown;
    todate?: unknown;
    datemodified?: unknown;
    iscurrent?: unknown;
    country?: unknown;
    severitydata?: { severity?: unknown; severitytext?: unknown };
    url?: { report?: unknown };
  };
  geometry?: { type?: unknown; coordinates?: unknown };
}

const RANK_BY_LEVEL: Record<GdacsAlertLevel, SeverityRank> = { Green: 1, Orange: 2, Red: 4 };

/** zone 미표기 GDACS 시각 → UTC ISO. 파싱 불능이면 null */
export function gdacsUtcIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const s = value.trim();
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** 레벨별 리스트 1건 정규화. 유예 창 밖의 expired는 records에 싣지 않고 스킵(dropped 아님) */
export function normalizeGdacsList(
  resp: unknown,
  ingestedAtMs: number,
): NormalizeOutcome<WeatherAlertRecord> {
  const features = (resp as { features?: unknown })?.features;
  if (!Array.isArray(features)) return { ok: false, reason: 'schema' };

  const ingestedAt = new Date(ingestedAtMs).toISOString();
  const records: WeatherAlertRecord[] = [];
  let dropped = 0;

  for (const raw of features as GdacsFeature[]) {
    const p = raw?.properties ?? {};
    const eventId = numOrNull(p.eventid);
    const episodeId = numOrNull(p.episodeid);
    const eventType = strOrNull(p.eventtype);
    const level = strOrNull(p.alertlevel) as GdacsAlertLevel | null;
    const validFrom = gdacsUtcIso(p.fromdate);
    if (eventId === null || episodeId === null || !eventType || !level || !(level in RANK_BY_LEVEL) || !validFrom) {
      dropped += 1;
      continue;
    }
    const coords = raw?.geometry?.coordinates as unknown[] | undefined;
    const lonLat = Array.isArray(coords) ? validateLonLat(coords[0], coords[1]) : null;
    if (!lonLat) {
      dropped += 1;
      continue;
    }
    const [lon, lat] = lonLat;

    // GDACS `todate` 계약 정정 (2026-08-19): todate는 **경보 해제 시각이 아니라 관측
    // 데이터가 끝난 시각**이다. 미해제(iscurrent) 경보도 todate가 과거로 나오기 때문에
    // 그대로 validTo로 쓰면 sliceInterval(validFrom ≤ T < validTo)에서 전부 탈락한다
    // (프로덕션 실측: latest 422건 중 활성 0건). 미해제는 validTo=null(§5 '미해제')로
    // 두고 원본 todate는 payload.observedUntil에 보존한다.
    const observedUntil = gdacsUtcIso(p.todate);
    const isCurrent = p.iscurrent === 'true' || p.iscurrent === true;
    const validTo = isCurrent ? null : observedUntil;
    if (!isCurrent && (!observedUntil || Date.parse(observedUntil) < ingestedAtMs - RECENT_EXPIRED_WINDOW_MS)) {
      continue; // 히스토리 잔재 — 갭이 아니라 의도된 스킵
    }

    const modified = gdacsUtcIso(p.datemodified) ?? validFrom;
    const payload: WeatherAlertPayload = {
      type: 'weatherAlert',
      event: strOrNull(p.name),
      headline: strOrNull(p.severitydata?.severitytext),
      areaDesc: strOrNull(p.country),
      capSeverity: null,
      gdacsAlertLevel: level,
      gdacsEventType: eventType,
      url: strOrNull(p.url?.report),
      observedUntil,
    };

    const sourceId = `${eventId}:${episodeId}`;
    records.push({
      id: `gdacs:${sourceId}`,
      source: 'gdacs',
      sourceId,
      layer: 'weather',
      revision: Date.parse(modified),
      observedAt: modified,
      ingestedAt,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      centroid: [lon, lat],
      h3r3: '',
      severity: {
        rank: RANK_BY_LEVEL[level],
        raw: numOrNull(p.severitydata?.severity) ?? undefined,
        label: `${eventType} ${level}`,
      },
      kind: 'interval',
      validFrom,
      validTo,
      status: isCurrent ? 'active' : 'expired',
      payload,
    });
  }

  return { ok: true, records, dropped };
}

/** 레벨별 3콜 union — 같은 (eventid, episodeid)는 revision(datemodified) 큰 쪽 유지 */
export function dedupeGdacs(lists: readonly WeatherAlertRecord[][]): WeatherAlertRecord[] {
  const byId = new Map<string, WeatherAlertRecord>();
  for (const list of lists) {
    for (const r of list) {
      const prev = byId.get(r.id);
      if (!prev || r.revision >= prev.revision) byId.set(r.id, r);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface TcTrack {
  track: { type: 'LineString'; coordinates: Position[] } | null;
  centroid: [lon: number, lat: number] | null;
}

/** getgeometry 1회에서 뽑는 TC 지오메트리 전부 (2026-08-19 실측 응답 구조):
 *  - `Point_Centroid` ×1 — 현재 중심
 *  - `Point_Polygon_Point_{n}` ×N — 트랙포인트(소형 Polygon) → ring centroid → LineString
 *  - `Poly_Cones` ×1 — 예보 불확실성 콘 (단일 ring 215점, ~4KB)
 *  - `Poly_Red|Orange|Green` ×10씩, `Line_Line_{n}` — 풍속 반경/구간선 (미사용)
 *  cone은 파생 레코드(sourceId `:cone`)의 지오메트리로 쓴다 — 같은 응답이라 추가 콜 0. */
export interface TcGeometry extends TcTrack {
  cone: { type: 'Polygon'; coordinates: Position[][] } | null;
}

/** 경도 산술평균이 0으로 붕괴하는 경계 — 정반대 방향 벡터가 상쇄된 상태 */
const LON_MEAN_EPS = 1e-9;
const DEG = Math.PI / 180;

/** 소형 Polygon ring 평균 centroid (마지막 닫힘 중복점 제거) — 시각 표시용 근사.
 *  경도는 **구면 평균**이다: 각도를 단위벡터(cos/sin)로 바꿔 평균한 뒤 atan2로 복원한다.
 *  산술평균을 쓰면 ±180을 걸친 ring(예: 179.5와 −179.5)이 약 0도 — 지구 반대편 —
 *  으로 튀고, 그 오차가 트랙 LineString에 그대로 실려 소비 측 언랩으로도 복구되지 않는다.
 *  위도는 극 근처 왜곡이 작고 wrap이 없어 산술평균 유지. */
function ringCentroid(ring: unknown): [number, number] | null {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const pts = ring.slice(0, -1).filter(
    (c): c is [number, number] =>
      Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number',
  );
  const first = pts[0];
  if (first === undefined) return null;
  const lat = pts.reduce((s, c) => s + c[1], 0) / pts.length;
  let x = 0;
  let y = 0;
  for (const [lonDeg] of pts) {
    x += Math.cos(lonDeg * DEG);
    y += Math.sin(lonDeg * DEG);
  }
  // 벡터 합이 0에 가까우면 방향이 정의되지 않는다(정반대 점들이 상쇄) → 첫 점 경도 사용
  const lon = Math.hypot(x, y) < LON_MEAN_EPS ? first[0] : Math.atan2(y, x) / DEG;
  return validateLonLat(lon, lat);
}

/** 폴리곤 ring 좌표 검증·변환 — 유효 좌표 3점 미만이면 null (렌더 불가) */
function validRing(ring: unknown): Position[] | null {
  if (!Array.isArray(ring)) return null;
  const out: Position[] = [];
  for (const c of ring) {
    const pos = Array.isArray(c) ? validateLonLat(c[0], c[1]) : null;
    if (pos) out.push([pos[0], pos[1]]);
  }
  return out.length >= 3 ? out : null;
}

/** getgeometry 응답 → TC 트랙 LineString + 예보 콘 Polygon + 중심점.
 *  트랙은 트랙포인트 Polygon의 ring centroid를 index 순으로 이은 선이다.
 *  주의: 날짜변경선을 넘는 트랙은 lon이 ±180에서 점프한다 — 저장은 원본 그대로,
 *  보간·렌더 wrap은 소비 측 책임 (PLAN 테스트 규칙의 보간 경계와 동일 계약). */
export function buildTcGeometry(geomResp: unknown): TcGeometry {
  const features = (geomResp as { features?: unknown })?.features;
  if (!Array.isArray(features)) return { track: null, centroid: null, cone: null };

  const points: Array<{ index: number; pos: [number, number] }> = [];
  let centroid: [number, number] | null = null;
  let cone: TcGeometry['cone'] = null;

  for (const f of features as GdacsFeature[]) {
    const cls = strOrNull((f?.properties as { Class?: unknown } | undefined)?.Class);
    const geom = f?.geometry;
    if (!cls || !geom) continue;

    if (cls === 'Point_Centroid' && geom.type === 'Point') {
      const c = geom.coordinates as unknown[];
      centroid = Array.isArray(c) ? validateLonLat(c[0], c[1]) : null;
      continue;
    }
    if (cls === 'Poly_Cones' && geom.type === 'Polygon') {
      const rings = geom.coordinates as unknown[];
      const outer = Array.isArray(rings) ? validRing(rings[0]) : null;
      if (outer) cone = { type: 'Polygon', coordinates: [outer] };
      continue;
    }
    const m = /^Point_Polygon_Point_(\d+)$/.exec(cls);
    if (m && geom.type === 'Polygon') {
      const rings = geom.coordinates as unknown[];
      const pos = Array.isArray(rings) ? ringCentroid(rings[0]) : null;
      if (pos) points.push({ index: Number(m[1]), pos });
    }
  }

  points.sort((a, b) => a.index - b.index);
  const track =
    points.length >= 2
      ? { type: 'LineString' as const, coordinates: points.map((p): Position => [p.pos[0], p.pos[1]]) }
      : null;
  return { track, centroid, cone };
}

/** 하위 호환 별칭 — 트랙만 쓰는 호출부/테스트 유지 (cone은 buildTcGeometry로) */
export function buildTcTrack(geomResp: unknown): TcTrack {
  const { track, centroid } = buildTcGeometry(geomResp);
  return { track, centroid };
}

/** TC 트랙 캐시 본문 — 트랙 슬롯이 쓰고 커밋 슬롯이 읽는다 (getgeometry 응답의 요약).
 *  fetchedAt으로 신선도를 판정한다 — 낡은 캐시는 합성하지 않고 Point 폴백 + 원장 기록. */
export interface TcTrackCache {
  eventId: number;
  episodeId: number;
  fetchedAt: string;
  track: TcGeometry['track'];
  cone: TcGeometry['cone'];
  centroid: [lon: number, lat: number] | null;
}

/** 활성 TC 인덱스 본문 — 커밋 슬롯이 발행, 트랙 슬롯이 회전 대상으로 읽는다 */
export interface TcIndex {
  updatedAt: string;
  tcs: Array<{ eventId: number; episodeId: number; name: string | null }>;
}

/** 경보 레코드에서 (eventId, episodeId) 복원 — sourceId = `${eventId}:${episodeId}` 계약 */
export function tcIdsOf(record: WeatherAlertRecord): { eventId: number; episodeId: number } | null {
  const parts = record.sourceId.split(':');
  if (parts.length !== 2) return null; // 파생(:cone) 레코드는 대상 아님
  const eventId = Number(parts[0]);
  const episodeId = Number(parts[1]);
  return Number.isInteger(eventId) && Number.isInteger(episodeId) ? { eventId, episodeId } : null;
}

/** TC 트랙 캐시 합성 (커밋 슬롯) — 원본 경보의 지오메트리를 트랙 LineString으로 바꾸고,
 *  콘이 있으면 파생 폴리곤 레코드를 하나 더 만든다.
 *  - 파생 레코드 id = `gdacs:{eventId}:{episodeId}:cone` (§5 `${source}:${sourceId}` 계약 유지)
 *  - 시간·등급·status는 원본과 동일 (같은 경보의 다른 표현이므로 슬라이스 결과가 갈리면 안 된다)
 *  - centroid는 캐시의 Point_Centroid가 있으면 그것을(더 정확), 없으면 원본 유지 */
export function applyTcGeometry(
  record: WeatherAlertRecord,
  cache: TcTrackCache,
): { record: WeatherAlertRecord; cone: WeatherAlertRecord | null } {
  const centroid = cache.centroid ?? record.centroid;
  const withTrack: WeatherAlertRecord =
    cache.track === null
      ? { ...record, centroid }
      : {
          ...record,
          geometry: cache.track,
          centroid,
          payload: { ...record.payload, gdacsGeometryKind: 'track' },
        };
  if (cache.cone === null) return { record: withTrack, cone: null };
  const coneSourceId = `${record.sourceId}:cone`;
  const cone: WeatherAlertRecord = {
    ...record,
    id: `gdacs:${coneSourceId}`,
    sourceId: coneSourceId,
    geometry: cache.cone,
    centroid,
    payload: { ...record.payload, gdacsGeometryKind: 'cone' },
  };
  return { record: withTrack, cone };
}

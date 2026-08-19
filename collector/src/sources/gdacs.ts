/** GDACS 어댑터 (PLAN §4.2 — Phase 1 weather 0단계 소스. WMO CAP·NWS는 후속).
 *  실측 주의 (docs/review/research/gdacs.md + 2026-08-19 재실측):
 *  - SEARCH 기본은 Orange/Red만. `alertlevel=Green;Orange;Red` 통합 지정은 서버가
 *    ';'를 파라미터 구분자로 먹어 Green 단독 + iscurrent=true 100건 캡으로 동작
 *    (current Orange가 캡에 잘려나가는 것 실측 확인) → **레벨별 3콜 + dedupe**로 우회.
 *  - TC 트랙포인트는 Point가 아니라 소형 Polygon (Class=Point_Polygon_Point_{n})
 *    → ring 평균 centroid 추출, n 순서로 LineString 구성.
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
/** 레벨당 페이지 안전 캡 — 히스토리 무한 페이징 방어. 캡 도달 = capped 신호로 기록
 *  (2026-08-19 실측: Green current가 300건+ — 단일 콜 100건 캡으로 조용히 누락됐던 리뷰 High). */
export const GDACS_PAGE_CAP = 10;

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

    const validTo = gdacsUtcIso(p.todate);
    const isCurrent = p.iscurrent === 'true' || p.iscurrent === true;
    if (!isCurrent && (!validTo || Date.parse(validTo) < ingestedAtMs - RECENT_EXPIRED_WINDOW_MS)) {
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

/** 소형 Polygon ring 평균 centroid (마지막 닫힘 중복점 제거) — 시각 표시용 근사 */
function ringCentroid(ring: unknown): [number, number] | null {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const pts = ring.slice(0, -1).filter(
    (c): c is [number, number] =>
      Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number',
  );
  if (pts.length === 0) return null;
  const lon = pts.reduce((s, c) => s + c[0], 0) / pts.length;
  const lat = pts.reduce((s, c) => s + c[1], 0) / pts.length;
  return validateLonLat(lon, lat);
}

/** getgeometry 응답 → TC 트랙 LineString (트랙포인트 Polygon centroid, index 순).
 *  주의: 날짜변경선을 넘는 트랙은 lon이 ±180에서 점프한다 — 저장은 원본 그대로,
 *  보간·렌더 wrap은 소비 측 책임 (PLAN 테스트 규칙의 보간 경계와 동일 계약). */
export function buildTcTrack(geomResp: unknown): TcTrack {
  const features = (geomResp as { features?: unknown })?.features;
  if (!Array.isArray(features)) return { track: null, centroid: null };

  const points: Array<{ index: number; pos: [number, number] }> = [];
  let centroid: [number, number] | null = null;

  for (const f of features as GdacsFeature[]) {
    const cls = strOrNull((f?.properties as { Class?: unknown } | undefined)?.Class);
    const geom = f?.geometry;
    if (!cls || !geom) continue;

    if (cls === 'Point_Centroid' && geom.type === 'Point') {
      const c = geom.coordinates as unknown[];
      centroid = Array.isArray(c) ? validateLonLat(c[0], c[1]) : null;
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
  return { track, centroid };
}

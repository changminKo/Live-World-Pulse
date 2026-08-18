import { validateLonLat } from '../coords';
import type { EarthquakePayload, EarthquakeRecord, Severity } from '../types';

/** USGS all_hour feed — 유일한 브라우저 직접 fetch 허용 소스지만 수집도 백엔드에서 한다 (히스토리 축적) */
export const USGS_ALL_HOUR_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson';

interface UsgsFeature {
  id?: unknown;
  properties?: {
    mag?: unknown;
    magType?: unknown;
    place?: unknown;
    time?: unknown;
    updated?: unknown;
    tsunami?: unknown;
    status?: unknown;
    url?: unknown;
  };
  geometry?: { coordinates?: unknown };
}

/** 스키마 검증 union — HTTP 200이어도 기대 배열이 없으면 오류 JSON으로 판정 (빈 세계와 구분).
 *  ok:false를 정상 빈 결과로 취급하면 latest가 비워지고 갭이 성공으로 위장된다. */
export type NormalizeOutcome<T> =
  | { ok: true; records: T[]; dropped: number }
  | { ok: false; reason: 'schema' };

/** CAP 등급 근사 매핑 — 시각 인코딩 순위일 뿐 물리량 비교 아님 (PLAN §5) */
export function quakeSeverity(mag: number | null): Severity {
  if (mag === null || !Number.isFinite(mag)) return { rank: 0 };
  const rank = mag >= 7 ? 4 : mag >= 5.5 ? 3 : mag >= 4 ? 2 : 1;
  return { rank, raw: mag, label: `M${mag}` };
}

export function normalizeUsgs(feed: unknown, ingestedAtMs: number): NormalizeOutcome<EarthquakeRecord> {
  const features = (feed as { features?: unknown })?.features;
  if (!Array.isArray(features)) return { ok: false, reason: 'schema' };

  const ingestedAt = new Date(ingestedAtMs).toISOString();
  const records: EarthquakeRecord[] = [];
  let dropped = 0;

  for (const raw of features as UsgsFeature[]) {
    const sourceId = typeof raw?.id === 'string' ? raw.id : null;
    const props = raw?.properties ?? {};
    const coords = raw?.geometry?.coordinates;
    const timeMs = typeof props.time === 'number' && Number.isFinite(props.time) ? props.time : null;
    if (!sourceId || timeMs === null || !Array.isArray(coords)) {
      dropped += 1;
      continue;
    }
    const lonLat = validateLonLat(coords[0], coords[1]);
    if (!lonLat) {
      dropped += 1;
      continue;
    }
    const [lon, lat] = lonLat;
    const depthKm = typeof coords[2] === 'number' && Number.isFinite(coords[2]) ? coords[2] : null;
    const mag = typeof props.mag === 'number' && Number.isFinite(props.mag) ? props.mag : null;
    const occurredAt = new Date(timeMs).toISOString();
    const revision =
      typeof props.updated === 'number' && Number.isFinite(props.updated) ? props.updated : timeMs;

    const payload: EarthquakePayload = {
      type: 'earthquake',
      magnitude: mag,
      magType: typeof props.magType === 'string' ? props.magType : null,
      depthKm,
      place: typeof props.place === 'string' ? props.place : null,
      tsunami: props.tsunami === 1,
      status: typeof props.status === 'string' ? props.status : null,
      url: typeof props.url === 'string' ? props.url : null,
    };

    records.push({
      id: `usgs:${sourceId}`,
      source: 'usgs',
      sourceId,
      layer: 'earthquake',
      revision,
      observedAt: occurredAt,
      ingestedAt,
      geometry: { type: 'Point', coordinates: depthKm === null ? [lon, lat] : [lon, lat, -depthKm * 1000] },
      centroid: [lon, lat],
      h3r3: '',
      severity: quakeSeverity(mag),
      kind: 'occurrence',
      occurredAt,
      payload,
    });
  }

  return { ok: true, records, dropped };
}

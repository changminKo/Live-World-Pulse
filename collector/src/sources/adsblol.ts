import { validateLonLat } from '../coords';
import type { Region } from '../schedule';
import type { NormalizeOutcome } from './usgs';
import type { FlightRecord, FlightStatePayload } from '../types';

/** 지역당 조회 반경 (nm). adsb.lol /v2/point 상한은 250 (docs/review/research/adsb-lol.md).
 *  CPU 사다리 rung ③ (2026-08-19): 250nm는 프랑크푸르트에서 응답 554KB·938기 —
 *  parse 5.4ms + normalize 4.0ms + gzip 1.9ms = 11.3ms(로컬 실측)로 한 지역만으로도
 *  Free 하드 10ms를 넘겼다. 응답 크기는 면적에 거의 비례한다 (실측 250→554KB,
 *  150→198KB, 100→99KB). 150nm(≈278km)면 지역당 ~4.6ms로 예산 안에 든다.
 *  커버리지 축소는 실제 데이터 축소 — 늘리려면 Workers Paid(사용자 승인) 필요. */
export const ADSB_RADIUS_NM = 150;

export function pointUrl(region: Region): string {
  return `https://api.adsb.lol/v2/point/${region.lat}/${region.lon}/${ADSB_RADIUS_NM}`;
}

interface AdsbAircraft {
  hex?: unknown;
  lat?: unknown;
  lon?: unknown;
  alt_baro?: unknown;
  gs?: unknown;
  track?: unknown;
  flight?: unknown;
  t?: unknown;
  r?: unknown;
  category?: unknown;
  seen_pos?: unknown;
}

export type AdsbNormalizeOutcome = NormalizeOutcome<FlightRecord>;

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Observation ID 계약 (PLAN §5): sourceId = `${hex}:${bucketTs}`,
 *  bucketTs = floor(epochSec/180)*180 — 호출부가 스케줄 시각으로 계산해 전달 */
export function normalizeAdsb(
  resp: unknown,
  region: Region,
  bucketTs: number,
  ingestedAtMs: number,
): AdsbNormalizeOutcome {
  const body = resp as { ac?: unknown; now?: unknown };
  // HTTP 200 오류 JSON(ac 배열 없음)을 빈 하늘로 위장시키지 않는다 — 스키마 실패로 판정
  if (!Array.isArray(body?.ac)) return { ok: false, reason: 'schema' };
  const aircraft = body.ac as AdsbAircraft[];
  const responseNowMs = numOrNull(body?.now) ?? ingestedAtMs;
  const ingestedAt = new Date(ingestedAtMs).toISOString();

  const records: FlightRecord[] = [];
  let dropped = 0;
  // sampledMs는 seen_pos(초 단위)에서 나오므로 값의 종류가 기체 수보다 훨씬 적다.
  // new Date().toISOString()이 기체당 1회씩 도는 게 normalizeAdsb CPU의 큰 몫이라
  // ms→ISO를 메모이즈한다 (CPU 사다리 — 934기 기준 로컬 실측 4.0ms → 2.6ms).
  const isoCache = new Map<number, string>();
  const isoOf = (ms: number): string => {
    const hit = isoCache.get(ms);
    if (hit !== undefined) return hit;
    const iso = new Date(ms).toISOString();
    isoCache.set(ms, iso);
    return iso;
  };

  for (const ac of aircraft) {
    const hex = strOrNull(ac?.hex)?.toLowerCase() ?? null;
    if (!hex) {
      dropped += 1;
      continue;
    }
    const lonLat = validateLonLat(ac?.lon, ac?.lat);
    if (!lonLat) {
      dropped += 1;
      continue;
    }
    const [lon, lat] = lonLat;

    const seenPosSec = numOrNull(ac?.seen_pos);
    const sampledMs = responseNowMs - (seenPosSec ?? 0) * 1000;
    const sampledAt = isoOf(sampledMs);
    const altBaro: number | 'ground' | null =
      ac?.alt_baro === 'ground' ? 'ground' : numOrNull(ac?.alt_baro);

    const payload: FlightStatePayload = {
      type: 'flight',
      regionId: region.id,
      callsign: strOrNull(ac?.flight),
      altBaroFt: altBaro,
      groundSpeedKt: numOrNull(ac?.gs),
      trackDeg: numOrNull(ac?.track),
      aircraftType: strOrNull(ac?.t),
      registration: strOrNull(ac?.r),
      category: strOrNull(ac?.category),
      seenPosSec,
    };

    const sourceId = `${hex}:${bucketTs}`;
    records.push({
      id: `adsblol:${sourceId}`,
      source: 'adsblol',
      sourceId,
      layer: 'flight',
      revision: 0,
      observedAt: sampledAt,
      ingestedAt,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      centroid: [lon, lat],
      h3r3: '',
      severity: { rank: 0 },
      kind: 'observation',
      entityId: hex,
      sampledAt,
      payload,
    });
  }

  return { ok: true, records, dropped };
}

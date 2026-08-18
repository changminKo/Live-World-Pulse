import { validateLonLat } from '../coords';
import type { Region } from '../schedule';
import type { NormalizeOutcome } from './usgs';
import type { FlightRecord, FlightStatePayload } from '../types';

/** adsb.lol /v2/point — radius 최대 250nm (docs/review/research/adsb-lol.md 실측) */
export function pointUrl(region: Region): string {
  return `https://api.adsb.lol/v2/point/${region.lat}/${region.lon}/250`;
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
    const sampledAt = new Date(sampledMs).toISOString();
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

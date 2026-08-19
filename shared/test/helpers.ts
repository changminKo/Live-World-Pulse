import type {
  EarthquakePayload,
  FlightStatePayload,
  Interval,
  Observation,
  Occurrence,
  RecordBase,
  WeatherAlertPayload,
} from '../src/types';

const base = (sourceId: string): RecordBase => ({
  id: `usgs:${sourceId}`,
  source: 'usgs',
  sourceId,
  layer: 'earthquake',
  revision: 0,
  observedAt: '2026-08-19T00:00:00.000Z',
  ingestedAt: '2026-08-19T00:00:30.000Z',
  geometry: { type: 'Point', coordinates: [139.7, 35.6] },
  centroid: [139.7, 35.6],
  h3r3: '',
  severity: { rank: 2 },
});

export const quakePayload: EarthquakePayload = {
  type: 'earthquake',
  magnitude: 5.1,
  magType: 'mww',
  depthKm: 10,
  place: 'Tokyo',
  tsunami: false,
  status: 'reviewed',
  url: null,
};

export function occurrenceAt(sourceId: string, occurredAt: string): Occurrence<EarthquakePayload> {
  return { ...base(sourceId), kind: 'occurrence', occurredAt, payload: quakePayload };
}

export const alertPayload: WeatherAlertPayload = {
  type: 'weatherAlert',
  event: 'Typhoon Warning',
  headline: null,
  areaDesc: null,
  capSeverity: 'Severe',
  gdacsAlertLevel: null,
  gdacsEventType: null,
  url: null,
};

export function intervalOf(
  sourceId: string,
  validFrom: string,
  validTo: string | null,
): Interval<WeatherAlertPayload> {
  return {
    ...base(sourceId),
    source: 'wmo',
    id: `wmo:${sourceId}`,
    layer: 'weather',
    kind: 'interval',
    validFrom,
    validTo,
    status: 'active',
    payload: alertPayload,
  };
}

export const flightPayload: FlightStatePayload = {
  type: 'flight',
  regionId: 'seoul',
  callsign: 'KAL001',
  altBaroFt: 35000,
  groundSpeedKt: 480,
  trackDeg: 90,
  aircraftType: null,
  registration: null,
  category: null,
  seenPosSec: 0,
};

export function observationAt(
  entityId: string,
  sampledAt: string,
): Observation<FlightStatePayload> {
  const bucketTs = Math.floor(Date.parse(sampledAt) / 1000 / 180) * 180;
  return {
    ...base(`${entityId}:${bucketTs}`),
    id: `adsblol:${entityId}:${bucketTs}`,
    source: 'adsblol',
    layer: 'flight',
    kind: 'observation',
    entityId,
    sampledAt,
    payload: flightPayload,
  };
}

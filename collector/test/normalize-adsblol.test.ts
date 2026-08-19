import { describe, expect, test } from 'vitest';
import { ADSB_RADIUS_NM, normalizeAdsb, pointUrl } from '../src/sources/adsblol';
import type { AdsbNormalizeOutcome } from '../src/sources/adsblol';
import { REGIONS } from '../src/schedule';

function ok(outcome: AdsbNormalizeOutcome) {
  if (!outcome.ok) throw new Error('expected ok normalize outcome');
  return outcome;
}

const SEOUL = REGIONS[0]!;
const T_INGEST = Date.UTC(2026, 7, 19, 0, 3, 12);
const BUCKET_TS = Date.UTC(2026, 7, 19, 0, 3, 0) / 1000; // floor(epochSec/180)*180

function aircraft(overrides: Record<string, unknown> = {}) {
  return {
    hex: '7C2BA6',
    lat: 37.44,
    lon: 126.95,
    alt_baro: 35000,
    gs: 452.1,
    track: 187.3,
    flight: 'KAL123  ',
    t: 'B77W',
    r: 'HL8218',
    category: 'A5',
    seen_pos: 2.5,
    ...overrides,
  };
}

describe('adsb.lol 정규화 → Observation<FlightStatePayload> (PLAN §5 ID 계약)', () => {
  test('sourceId = `${hex}:${bucketTs}`, entityId = hex 소문자', () => {
    // Arrange
    const resp = { ac: [aircraft()], total: 1, now: T_INGEST - 1000, ptime: 12 };

    // Act
    const { records, dropped } = ok(normalizeAdsb(resp, SEOUL, BUCKET_TS, T_INGEST));

    // Assert
    expect(dropped).toBe(0);
    const r = records[0]!;
    expect(r.id).toBe(`adsblol:7c2ba6:${BUCKET_TS}`);
    expect(r.sourceId).toBe(`7c2ba6:${BUCKET_TS}`);
    expect(r.entityId).toBe('7c2ba6');
    expect(r.kind).toBe('observation');
    expect(r.layer).toBe('flight');
    expect(r.revision).toBe(0);
  });

  test('[lon, lat] 순서 + sampledAt = now - seen_pos', () => {
    const now = T_INGEST - 1000;
    const { records } = ok(normalizeAdsb({ ac: [aircraft()], now }, SEOUL, BUCKET_TS, T_INGEST));
    const r = records[0]!;
    expect(r.centroid).toEqual([126.95, 37.44]); // lon 먼저
    expect(r.geometry.coordinates).toEqual([126.95, 37.44]);
    expect(Date.parse(r.sampledAt)).toBe(now - 2500);
    expect(r.payload).toMatchObject({
      type: 'flight',
      regionId: 'seoul',
      callsign: 'KAL123',
      altBaroFt: 35000,
      groundSpeedKt: 452.1,
      trackDeg: 187.3,
      aircraftType: 'B77W',
    });
  });

  test('alt_baro "ground" 문자열 보존', () => {
    const { records } = ok(
      normalizeAdsb({ ac: [aircraft({ alt_baro: 'ground' })] }, SEOUL, BUCKET_TS, T_INGEST),
    );
    expect(records[0]!.payload.altBaroFt).toBe('ground');
  });

  test('좌표 결손·null island·hex 결손 드롭 + 카운터', () => {
    const resp = {
      ac: [
        aircraft(),
        aircraft({ hex: 'aaaaaa', lat: undefined, lon: undefined }), // mlat 무좌표
        aircraft({ hex: 'bbbbbb', lat: 0, lon: 0 }), // null island
        aircraft({ hex: '' }), // hex 결손
      ],
    };
    const { records, dropped } = ok(normalizeAdsb(resp, SEOUL, BUCKET_TS, T_INGEST));
    expect(records).toHaveLength(1);
    expect(dropped).toBe(3);
  });

  test('ac 배열 없는 응답 = 스키마 실패 (HTTP 200 오류 JSON을 빈 하늘로 위장 금지)', () => {
    expect(normalizeAdsb({ total: 0 }, SEOUL, BUCKET_TS, T_INGEST)).toEqual({
      ok: false,
      reason: 'schema',
    });
    // 진짜 빈 하늘(ac: [])은 정상 빈 결과
    expect(normalizeAdsb({ ac: [] }, SEOUL, BUCKET_TS, T_INGEST)).toEqual({
      ok: true,
      records: [],
      dropped: 0,
    });
  });

  test('엔드포인트 URL — /v2/point/{lat}/{lon}/{ADSB_RADIUS_NM} (CPU 사다리로 150nm)', () => {
    expect(ADSB_RADIUS_NM).toBe(150);
    expect(pointUrl(SEOUL)).toBe(`https://api.adsb.lol/v2/point/37.5/127/${ADSB_RADIUS_NM}`);
  });
});

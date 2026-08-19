/** 구계약 norm 읽기 보정 (재리뷰 Med3) — 옛 파일을 재작성하지 않고 읽는 쪽에서 맞춘다. */
import { describe, expect, test } from 'vitest';
import { reconcileLegacyRecords, reconcileLegacyWeather, sliceInterval } from '../src/index';
import type { WeatherAlertRecord } from '../src/index';

function alert(over: Partial<WeatherAlertRecord> = {}): WeatherAlertRecord {
  return {
    id: 'gdacs:500:1',
    source: 'gdacs',
    sourceId: '500:1',
    layer: 'weather',
    revision: Date.parse('2026-08-19T11:00:00Z'),
    observedAt: '2026-08-19T11:00:00.000Z',
    ingestedAt: '2026-08-19T11:05:00.000Z',
    geometry: { type: 'Point', coordinates: [10, 20] },
    centroid: [10, 20],
    h3r3: '',
    severity: { rank: 1 },
    kind: 'interval',
    validFrom: '2026-08-18T00:00:00.000Z',
    validTo: null,
    status: 'active',
    payload: {
      type: 'weatherAlert',
      event: 'Flood',
      headline: null,
      areaDesc: null,
      capSeverity: null,
      gdacsAlertLevel: 'Green',
      gdacsEventType: 'FL',
      url: null,
    },
    ...over,
  };
}

describe('reconcileLegacyWeather', () => {
  test('구계약(active + validTo 과거) → validTo null, 원본은 observedUntil로 보존', () => {
    const legacy = alert({ status: 'active', validTo: '2026-08-19T00:00:00.000Z' });

    const fixed = reconcileLegacyWeather(legacy);

    expect(fixed.validTo).toBeNull();
    expect(fixed.payload.observedUntil).toBe('2026-08-19T00:00:00.000Z');
    expect(legacy.validTo).toBe('2026-08-19T00:00:00.000Z'); // 입력 불변
  });

  test('보정 전에는 활성 경보가 슬라이스에서 전부 탈락한다 (프로덕션 422/422 소실 재현)', () => {
    const T = Date.parse('2026-08-19T12:00:00Z');
    const legacy = alert({ status: 'active', validTo: '2026-08-19T00:00:00.000Z' });

    expect(sliceInterval([legacy], T)).toHaveLength(0);
    expect(sliceInterval([reconcileLegacyWeather(legacy)], T)).toHaveLength(1);
  });

  test('신계약 레코드는 참조까지 그대로 (idempotent — 이중 적용 안전)', () => {
    const current = alert();
    expect(reconcileLegacyWeather(current)).toBe(current);
    expect(reconcileLegacyWeather(reconcileLegacyWeather(current))).toBe(current);
  });

  test('해제된 경보(expired + validTo)는 건드리지 않는다 — 실제 종료 시각이다', () => {
    const expired = alert({ status: 'expired', validTo: '2026-08-19T00:00:00.000Z' });
    expect(reconcileLegacyWeather(expired)).toBe(expired);
  });

  test('GDACS가 아닌 소스(NWS/WMO CAP)는 validTo가 진짜 해제 시각이라 보정 대상이 아니다', () => {
    const nws = alert({ source: 'nws', status: 'active', validTo: '2026-08-19T18:00:00.000Z' });
    expect(reconcileLegacyWeather(nws)).toBe(nws);
  });

  test('reconcileLegacyRecords는 weather interval만 손댄다', () => {
    const legacy = alert({ status: 'active', validTo: '2026-08-19T00:00:00.000Z' });
    const [fixed] = reconcileLegacyRecords([legacy]) as WeatherAlertRecord[];
    expect(fixed!.validTo).toBeNull();
  });
});

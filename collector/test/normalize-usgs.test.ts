import { describe, expect, test } from 'vitest';
import { normalizeUsgs, quakeSeverity } from '../src/sources/usgs';
import type { EarthquakeRecord } from '../src/types';
import type { NormalizeOutcome } from '../src/sources/usgs';

function ok(outcome: NormalizeOutcome<EarthquakeRecord>) {
  if (!outcome.ok) throw new Error('expected ok normalize outcome');
  return outcome;
}

const T_INGEST = Date.UTC(2026, 7, 19, 3, 0, 0);

function feature(overrides: Record<string, unknown> = {}, coords: unknown[] = [142.3, 38.1, 28]) {
  return {
    id: 'us7000abcd',
    properties: {
      mag: 7.1,
      magType: 'mww',
      place: 'off the east coast of Honshu, Japan',
      time: Date.UTC(2026, 7, 19, 2, 32, 0),
      updated: Date.UTC(2026, 7, 19, 2, 40, 0),
      tsunami: 1,
      status: 'reviewed',
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd',
      ...overrides,
    },
    geometry: { type: 'Point', coordinates: coords },
  };
}

describe('USGS 정규화 → Occurrence<EarthquakePayload> (PLAN §5)', () => {
  test('필드 매핑 — id 멱등키·[lon,lat] 순서·UTC·revision=updated', () => {
    // Act
    const { records, dropped } = ok(normalizeUsgs({ features: [feature()] }, T_INGEST));

    // Assert
    expect(dropped).toBe(0);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.id).toBe('usgs:us7000abcd');
    expect(r.source).toBe('usgs');
    expect(r.kind).toBe('occurrence');
    expect(r.layer).toBe('earthquake');
    expect(r.centroid).toEqual([142.3, 38.1]); // [lon, lat]
    expect(r.geometry.coordinates.slice(0, 2)).toEqual([142.3, 38.1]);
    expect(r.occurredAt).toBe('2026-08-19T02:32:00.000Z');
    expect(r.observedAt).toBe(r.occurredAt);
    expect(r.ingestedAt).toBe('2026-08-19T03:00:00.000Z');
    expect(r.revision).toBe(Date.UTC(2026, 7, 19, 2, 40, 0));
    expect(r.payload).toMatchObject({
      type: 'earthquake',
      magnitude: 7.1,
      depthKm: 28,
      tsunami: true,
    });
  });

  test('severity — CAP rank + raw 원본값 보존', () => {
    expect(quakeSeverity(7.1)).toEqual({ rank: 4, raw: 7.1, label: 'M7.1' });
    expect(quakeSeverity(5.6).rank).toBe(3);
    expect(quakeSeverity(4.0).rank).toBe(2);
    expect(quakeSeverity(2.1).rank).toBe(1);
    expect(quakeSeverity(null)).toEqual({ rank: 0 });
  });

  test('mag null(미산정 이벤트)은 드롭하지 않고 rank 0으로 보존', () => {
    const { records, dropped } = ok(normalizeUsgs({ features: [feature({ mag: null })] }, T_INGEST));
    expect(dropped).toBe(0);
    expect(records[0]!.severity.rank).toBe(0);
    expect(records[0]!.payload.magnitude).toBeNull();
  });

  test('null island·좌표 불량·time 결손은 드롭 + 카운터', () => {
    const bad = [
      feature({}, [0, 0, 10]), // null island
      feature({}, ['x', 38.1, 10]), // 좌표 타입 불량
      feature({ time: null }), // time 결손
    ];
    const { records, dropped } = ok(normalizeUsgs({ features: [feature(), ...bad] }, T_INGEST));
    expect(records).toHaveLength(1);
    expect(dropped).toBe(3);
  });

  test('features 배열 없는 응답 = 스키마 실패 (오류 JSON을 빈 세계로 위장 금지)', () => {
    expect(normalizeUsgs({ error: 'oops' }, T_INGEST)).toEqual({ ok: false, reason: 'schema' });
    expect(normalizeUsgs(null, T_INGEST)).toEqual({ ok: false, reason: 'schema' });
    // 진짜 빈 시간대(features: [])는 정상 빈 결과
    expect(normalizeUsgs({ features: [] }, T_INGEST)).toEqual({ ok: true, records: [], dropped: 0 });
  });
});

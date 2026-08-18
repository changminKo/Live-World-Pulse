import { describe, expect, test } from 'vitest';
import { contentHash } from '../src/hash';
import { mergeById, mergeByRevision } from '../src/r2/norm';
import type { EarthquakeRecord } from '../src/types';

function quake(sourceId: string, revision: number, mag: number): EarthquakeRecord {
  const occurredAt = '2026-08-19T02:32:00.000Z';
  return {
    id: `usgs:${sourceId}`,
    source: 'usgs',
    sourceId,
    layer: 'earthquake',
    revision,
    observedAt: occurredAt,
    ingestedAt: new Date().toISOString(),
    geometry: { type: 'Point', coordinates: [142.3, 38.1] },
    centroid: [142.3, 38.1],
    h3r3: '',
    severity: { rank: 4, raw: mag, label: `M${mag}` },
    kind: 'occurrence',
    occurredAt,
    payload: {
      type: 'earthquake',
      magnitude: mag,
      magType: 'mww',
      depthKm: 28,
      place: 'test',
      tsunami: false,
      status: 'automatic',
      url: null,
    },
  };
}

describe('슬롯 병합 + generation 해시 판정 (PLAN §8.7)', () => {
  test('mergeByRevision — 높은 revision이 이김 (USGS 사후 정정)', () => {
    const old = quake('a', 100, 6.8);
    const corrected = quake('a', 200, 7.1);
    expect(mergeByRevision([old], [corrected])[0]!.payload).toMatchObject({ magnitude: 7.1 });
    // 역순 도착(구버전이 뒤에) — 되돌림 방지
    expect(mergeByRevision([corrected], [old])[0]!.payload).toMatchObject({ magnitude: 7.1 });
  });

  test('mergeById — id 유니온, 신규 우선 (항공기 지역 누적)', () => {
    const a = quake('a', 1, 5.0);
    const b = quake('b', 1, 5.5);
    const merged = mergeById([a], [b]);
    expect(merged.map((r) => r.sourceId)).toEqual(['a', 'b']);
  });

  test('contentHash — ingestedAt 차이는 무시, 내용 동일이면 해시 동일 (g0 유지 근거)', async () => {
    const r1 = quake('a', 100, 6.8);
    const r2 = { ...quake('a', 100, 6.8), ingestedAt: '2030-01-01T00:00:00.000Z' };
    expect(await contentHash([r1])).toBe(await contentHash([r2]));
  });

  test('contentHash — revision 정정은 해시 변경 (새 generation 발행 근거)', async () => {
    expect(await contentHash([quake('a', 100, 6.8)])).not.toBe(
      await contentHash([quake('a', 200, 7.1)]),
    );
  });

  test('contentHash — 레코드 순서 무관 결정론', async () => {
    const a = quake('a', 1, 5.0);
    const b = quake('b', 1, 5.5);
    expect(await contentHash([a, b])).toBe(await contentHash([b, a]));
  });
});

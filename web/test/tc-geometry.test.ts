import { describe, expect, it } from 'vitest';
import type { Position, WeatherAlertRecord } from '@lwp/shared';
import { buildTcFeatures } from '../src/world/map/tc-geometry';

/** TC 지오메트리 피처 변환 — 날짜변경선 언랩·hatch 파생·Point 제외 (CLAUDE.md 테스트 규칙:
 *  보간/좌표 경계와 어댑터 변환이 단위 테스트 최우선 대상) */

const base = {
  source: 'gdacs',
  layer: 'weather',
  revision: 1,
  observedAt: '2026-08-20T00:00:00.000Z',
  ingestedAt: '2026-08-20T00:00:00.000Z',
  h3r3: '',
  kind: 'interval',
  validFrom: '2026-08-20T00:00:00.000Z',
  validTo: null,
  status: 'active',
  severity: { rank: 1 as const, label: 'Orange' },
  payload: {
    type: 'weatherAlert' as const,
    event: 'Tropical Cyclone TEST-26',
    headline: null,
    areaDesc: null,
    capSeverity: null,
    gdacsAlertLevel: 'Orange',
    gdacsEventType: 'TC',
    url: null,
  },
} as unknown as WeatherAlertRecord;

const trackRecord = (coordinates: [number, number][]): WeatherAlertRecord =>
  ({
    ...base,
    id: 'gdacs:1:1',
    sourceId: '1:1',
    centroid: coordinates[0],
    geometry: { type: 'LineString', coordinates },
  }) as unknown as WeatherAlertRecord;

const coneRecord = (coordinates: [number, number][][]): WeatherAlertRecord =>
  ({
    ...base,
    id: 'gdacs:1:1:cone',
    sourceId: '1:1:cone',
    centroid: coordinates[0]?.[0],
    geometry: { type: 'Polygon', coordinates },
  }) as unknown as WeatherAlertRecord;

describe('buildTcFeatures', () => {
  it('트랙 LineString을 track 피처로 만든다', () => {
    const features = buildTcFeatures([trackRecord([[140, 20], [138, 22]])]);
    expect(features).toHaveLength(1);
    const [track] = features;
    expect(track?.properties).toEqual({ id: 'gdacs:1:1', rank: 1, kind: 'track' });
    expect(track?.geometry.coordinates).toEqual([[140, 20], [138, 22]]);
  });

  it('날짜변경선을 넘는 트랙 경도를 연속으로 언랩한다 (지구 반대편 가로지르기 방지)', () => {
    const features = buildTcFeatures([
      trackRecord([[178, 20], [-179, 21], [-176, 22]]),
    ]);
    expect(features[0]?.geometry.coordinates).toEqual([
      [178, 20],
      [181, 21],
      [184, 22],
    ]);
  });

  it('서→동 반대 방향 교차도 대칭으로 언랩한다', () => {
    const features = buildTcFeatures([trackRecord([[-178, 5], [179, 6]])]);
    expect(features[0]?.geometry.coordinates).toEqual([
      [-178, 5],
      [-181, 6],
    ]);
  });

  it('예보 콘 Polygon은 cone 피처 + 파생 hatch 선들을 만든다', () => {
    const cone = {
      ...base,
      id: 'gdacs:1:1:cone',
      sourceId: '1:1:cone',
      centroid: [138, 23],
      geometry: {
        type: 'Polygon',
        coordinates: [[[136, 20], [141, 20], [141, 26], [136, 26], [136, 20]]],
      },
    } as unknown as WeatherAlertRecord;
    const features = buildTcFeatures([cone]);
    const kinds = features.map((f) => f.properties.kind);
    expect(kinds[0]).toBe('cone');
    expect(kinds.filter((k) => k === 'hatch').length).toBeGreaterThan(0);
    expect(features.every((f) => f.properties.id === 'gdacs:1:1:cone')).toBe(true);
  });

  it('날짜변경선을 걸친 콘도 빗금을 만든다 (언랩을 hatch 전에 적용 — 사후 리뷰 Med1)', () => {
    // 원본 좌표의 lonSpan은 356° — 언랩을 나중에 하면 hatch 스팬 가드에 걸려 빗금이 0개가 된다
    const features = buildTcFeatures([
      coneRecord([
        [
          [178, 20],
          [-178, 20],
          [-178, 26],
          [178, 26],
          [178, 20],
        ],
      ]),
    ]);
    const hatches = features.filter((f) => f.properties.kind === 'hatch');
    expect(hatches.length).toBeGreaterThan(0);
    // 콘·빗금 모두 언랩된 연속 경도 (178…182) — ±180 점프가 남아 있으면 안 된다
    const cone = features.find((f) => f.properties.kind === 'cone');
    expect(cone?.geometry.coordinates).toEqual([
      [
        [178, 20],
        [182, 20],
        [182, 26],
        [178, 26],
        [178, 20],
      ],
    ]);
    for (const h of hatches) {
      for (const [lon] of h.geometry.coordinates as Position[]) {
        expect(lon).toBeGreaterThan(177);
        expect(lon).toBeLessThan(183);
      }
    }
  });

  it('구멍 ring도 외곽 기준으로 언랩하고 빗금을 뚫는다', () => {
    const outer: [number, number][] = [
      [176, 10],
      [-176, 10],
      [-176, 26],
      [176, 26],
      [176, 10],
    ];
    // 구멍의 첫 점이 음수 쪽 — 독립 언랩하면 360° 밀려 지구 반대편에 뚫린다
    const hole: [number, number][] = [
      [-179, 16],
      [179, 16],
      [179, 20],
      [-179, 20],
      [-179, 16],
    ];
    const features = buildTcFeatures([coneRecord([outer, hole])]);
    const cone = features.find((f) => f.properties.kind === 'cone');
    const holeRing = (cone?.geometry.coordinates as Position[][])[1] ?? [];
    expect(holeRing.map(([lon]) => lon)).toEqual([181, 179, 179, 181, 181]);

    // 구멍 내부(경도 179~181, 위도 17~19)를 지나는 빗금 세그먼트가 없다 = even-odd로 뚫렸다
    const hatches = features.filter((f) => f.properties.kind === 'hatch');
    expect(hatches.length).toBeGreaterThan(0);
    const insideHole = (p: Position): boolean =>
      p[0] > 179.2 && p[0] < 180.8 && p[1] > 16.2 && p[1] < 19.8;
    expect(
      hatches.some((h) => (h.geometry.coordinates as Position[]).every(insideHole)),
    ).toBe(false);
  });

  it('극지(±85 이상) 트랙·콘 좌표를 그대로 보존한다 (사후 리뷰 Low1)', () => {
    const track = buildTcFeatures([
      trackRecord([
        [179, 86],
        [-179, 88],
        [-170, 89],
      ]),
    ]);
    expect(track[0]?.geometry.coordinates).toEqual([
      [179, 86],
      [181, 88],
      [190, 89],
    ]);

    const polarCone = buildTcFeatures([
      coneRecord([
        [
          [10, 84],
          [20, 84],
          [20, 89],
          [10, 89],
          [10, 84],
        ],
      ]),
    ]);
    expect(polarCone.filter((f) => f.properties.kind === 'hatch').length).toBeGreaterThan(0);
    const south = buildTcFeatures([
      trackRecord([
        [-179, -86],
        [179, -88],
      ]),
    ]);
    expect(south[0]?.geometry.coordinates).toEqual([
      [-179, -86],
      [-181, -88],
    ]);
  });

  it('Point 경보는 제외한다 (마커는 deck 담당)', () => {
    const point = {
      ...base,
      id: 'gdacs:2:1',
      sourceId: '2:1',
      centroid: [10, 10],
      geometry: { type: 'Point', coordinates: [10, 10] },
    } as unknown as WeatherAlertRecord;
    expect(buildTcFeatures([point])).toEqual([]);
  });
});

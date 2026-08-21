import { describe, expect, test } from 'vitest';
import {
  buildGraticule,
  surfaceOverrideFor,
  SURFACE_COLORS,
} from '../src/world/map/surface-contrast';

/** Rec.709 luma (0-255 감마 공간) — DESIGN §2.3 대비 계약과 동일 정의 */
function luma(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const SPACE_LUMA = luma('#0c0c0c'); // 우주 배경 --bg-0

describe('SURFACE_COLORS — DESIGN §2.3 대비 계약', () => {
  test('표면(육지·해양)은 luma 34~40 범위이고 우주 배경 대비 ΔL ≥ 22', () => {
    for (const key of ['land', 'ocean'] as const) {
      const l = luma(SURFACE_COLORS[key]);
      expect(l).toBeGreaterThanOrEqual(34);
      expect(l).toBeLessThanOrEqual(40);
      expect(l - SPACE_LUMA).toBeGreaterThanOrEqual(22);
    }
  });

  test('육지가 해양보다 약간 밝다 (상대 단차 유지)', () => {
    expect(luma(SURFACE_COLORS.land)).toBeGreaterThan(luma(SURFACE_COLORS.ocean));
  });

  test('빙붕·빙하는 육지보다 밝다 (현실 순서)', () => {
    expect(luma(SURFACE_COLORS.ice)).toBeGreaterThan(luma(SURFACE_COLORS.land));
  });
});

describe('surfaceOverrideFor — OpenFreeMap dark 레이어 매칭', () => {
  test('background(육지) → land', () => {
    expect(surfaceOverrideFor({ id: 'background', type: 'background' })).toEqual({
      property: 'background-color',
      value: SURFACE_COLORS.land,
    });
  });

  test('water fill → ocean, waterway line → ocean', () => {
    expect(surfaceOverrideFor({ id: 'water', type: 'fill' })).toEqual({
      property: 'fill-color',
      value: SURFACE_COLORS.ocean,
    });
    expect(surfaceOverrideFor({ id: 'waterway', type: 'line' })).toEqual({
      property: 'line-color',
      value: SURFACE_COLORS.ocean,
    });
  });

  test('빙붕·빙하 fill → ice', () => {
    expect(surfaceOverrideFor({ id: 'landcover_ice_shelf', type: 'fill' })).toEqual({
      property: 'fill-color',
      value: SURFACE_COLORS.ice,
    });
    expect(surfaceOverrideFor({ id: 'landcover_glacier', type: 'fill' })).toEqual({
      property: 'fill-color',
      value: SURFACE_COLORS.ice,
    });
  });

  test('경계선·라벨·도로는 손대지 않는다', () => {
    expect(surfaceOverrideFor({ id: 'boundary_country_z0-4', type: 'line' })).toBeNull();
    expect(surfaceOverrideFor({ id: 'place_city', type: 'symbol' })).toBeNull();
    expect(surfaceOverrideFor({ id: 'highway_minor', type: 'line' })).toBeNull();
    // water_name은 symbol — water 이름을 포함해도 매칭되면 안 된다
    expect(surfaceOverrideFor({ id: 'water_name', type: 'symbol' })).toBeNull();
  });
});

describe('buildGraticule — 30° 경위선', () => {
  const fc = buildGraticule();

  test('경선 12개(-180..150) + 위선 5개(-60..60) = 17개', () => {
    expect(fc.features).toHaveLength(17);
  });

  test('major는 적도·본초자오선 딱 2개', () => {
    expect(fc.features.filter((f) => f.properties.major)).toHaveLength(2);
  });

  test('좌표는 [lon, lat] 순서·유효 범위 (경선은 ±80 위도에서 끊김)', () => {
    for (const f of fc.features) {
      for (const [lon, lat] of f.geometry.coordinates) {
        expect(lon).toBeGreaterThanOrEqual(-180);
        expect(lon).toBeLessThanOrEqual(180);
        expect(lat).toBeGreaterThanOrEqual(-80);
        expect(lat).toBeLessThanOrEqual(80);
      }
    }
  });

  test('정점 간격 ≤5° — globe 셰이더 평면 보간 대비 구면 밀착', () => {
    for (const f of fc.features) {
      const coords = f.geometry.coordinates;
      for (let i = 1; i < coords.length; i += 1) {
        const prev = coords[i - 1];
        const cur = coords[i];
        if (!prev || !cur) throw new Error(`정점 누락: index ${i}`);
        const dLon = Math.abs(cur[0] - prev[0]);
        const dLat = Math.abs(cur[1] - prev[1]);
        expect(Math.max(dLon, dLat)).toBeLessThanOrEqual(5);
      }
    }
  });
});

/** 폴리곤 빗금 기하 (재리뷰 Low1) — 스캔라인이 폴리곤 **내부만** 채우는지 단정. */
import { describe, expect, test } from 'vitest';
import { hatchPolygon } from '../src/world/deck/hatch';
import type { Position } from '@lwp/shared';

/** 반시계 사각형 ring (닫힘점 포함) */
function square(minLon: number, minLat: number, size: number): Position[] {
  return [
    [minLon, minLat],
    [minLon + size, minLat],
    [minLon + size, minLat + size],
    [minLon, minLat + size],
    [minLon, minLat],
  ];
}

/** 점이 사각형 안(경계 포함 여유)에 있는지 */
function inside(p: Position, minLon: number, minLat: number, size: number): boolean {
  const eps = 1e-9;
  return (
    p[0] >= minLon - eps && p[0] <= minLon + size + eps && p[1] >= minLat - eps && p[1] <= minLat + size + eps
  );
}

describe('hatchPolygon', () => {
  test('사각형에 빗금이 여러 줄 생기고 모든 끝점이 폴리곤 안에 있다', () => {
    const segments = hatchPolygon([square(10, 20, 4)]);

    expect(segments.length).toBeGreaterThan(3);
    for (const [a, b] of segments) {
      expect(inside(a!, 10, 20, 4)).toBe(true);
      expect(inside(b!, 10, 20, 4)).toBe(true);
    }
  });

  test('45° 방향 — 각 세그먼트의 lat - lon(u)이 양 끝에서 같다', () => {
    for (const [a, b] of hatchPolygon([square(0, 0, 6)])) {
      const ua = a![1] - a![0];
      const ub = b![1] - b![0];
      expect(Math.abs(ua - ub)).toBeLessThan(1e-9);
    }
  });

  test('구멍 ring을 함께 주면 even-odd로 구멍이 뚫린다 (내부 구간이 2개로 쪼개짐)', () => {
    const outer = square(0, 0, 12);
    const hole = square(4, 4, 4).slice().reverse();
    const withHole = hatchPolygon([outer, hole]);
    const solid = hatchPolygon([outer]);

    expect(withHole.length).toBeGreaterThan(solid.length);
  });

  test('좌표 3점 미만·빈 입력은 빗금 없음', () => {
    expect(hatchPolygon([])).toEqual([]);
    expect(hatchPolygon([[[0, 0], [1, 1]]])).toEqual([]);
  });

  test('전지구·날짜변경선 횡단 의심 폴리곤은 건너뛴다 (lon 점프로 빗금이 어긋난다)', () => {
    expect(hatchPolygon([square(-179, 0, 358)])).toEqual([]);
  });

  test('세그먼트 수에 상한이 있다 (프레임 예산 — 오목 폴리곤 폭발 방지)', () => {
    // 톱니 폴리곤: 스캔라인당 교점이 많아진다
    const teeth: Position[] = [];
    for (let i = 0; i < 40; i += 1) {
      teeth.push([i * 0.2, i % 2 === 0 ? 0 : 3]);
    }
    for (let i = 39; i >= 0; i -= 1) {
      teeth.push([i * 0.2, 8]);
    }
    expect(hatchPolygon([teeth]).length).toBeLessThanOrEqual(240);
  });
});

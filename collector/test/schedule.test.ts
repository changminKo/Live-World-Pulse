import { describe, expect, test } from 'vitest';
import { REGIONS, regionsForMinute } from '../src/schedule';

describe('스케줄 배분 (m%3 — PLAN §8.7)', () => {
  // 2026-08-19T00:00:00Z = 1755561600000 — 분 단위 정렬 기준점
  const T0 = Date.UTC(2026, 7, 19, 0, 0, 0);
  const MIN = 60_000;

  test('m%3==0 → 서울·도쿄', () => {
    // Arrange: epoch 분이 3의 배수인 시각
    const base = Math.floor(T0 / MIN);
    const t = (base + ((3 - (base % 3)) % 3)) * MIN;

    // Act
    const [a, b] = regionsForMinute(t);

    // Assert
    expect(a.id).toBe('seoul');
    expect(b.id).toBe('tokyo');
  });

  test('m%3==1 → 런던·프랑크푸르트, m%3==2 → 뉴욕·LA', () => {
    const base = Math.floor(T0 / MIN);
    const t0 = (base + ((3 - (base % 3)) % 3)) * MIN;

    const [c, d] = regionsForMinute(t0 + MIN);
    expect([c.id, d.id]).toEqual(['london', 'frankfurt']);

    const [e, f] = regionsForMinute(t0 + 2 * MIN);
    expect([e.id, f.id]).toEqual(['newyork', 'losangeles']);
  });

  test('3분 주기 순환 — t와 t+3분은 같은 지역쌍', () => {
    const t = T0 + 7 * MIN;
    const [a1, b1] = regionsForMinute(t);
    const [a2, b2] = regionsForMinute(t + 3 * MIN);
    expect([a1.id, b1.id]).toEqual([a2.id, b2.id]);
  });

  test('6지역 좌표가 PLAN §8.7 계약과 일치', () => {
    expect(REGIONS.map((r) => [r.lat, r.lon])).toEqual([
      [37.5, 127.0],
      [35.68, 139.77],
      [51.51, -0.13],
      [50.0, 8.6],
      [40.71, -74.01],
      [34.05, -118.25],
    ]);
  });
});

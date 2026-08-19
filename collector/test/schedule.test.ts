import { describe, expect, test } from 'vitest';
import {
  REGIONS,
  isNewsMinute,
  isNewsProcessMinute,
  isWeatherCommitMinute,
  isWeatherMinute,
  regionsForMinute,
} from '../src/schedule';

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

  test('weather 슬롯 m%15==2 / news 슬롯 m%15==9 — 서로 다른 분에 분산', () => {
    const t = (minute: number) => Date.UTC(2026, 7, 19, 12, minute, 0);

    expect(isWeatherMinute(t(2))).toBe(true);
    expect(isWeatherMinute(t(17))).toBe(true);
    expect(isWeatherMinute(t(9))).toBe(false);
    expect(isNewsMinute(t(9))).toBe(true);
    expect(isNewsMinute(t(24))).toBe(true);
    expect(isNewsMinute(t(2))).toBe(false);

    // 한 시간 내 어떤 분에도 weather·news가 같은 invocation에 겹치지 않는다
    for (let m = 0; m < 60; m += 1) {
      expect(isWeatherMinute(t(m)) && isNewsMinute(t(m))).toBe(false);
    }
  });

  test('CPU 분할 슬롯 — fetch/커밋 4슬롯이 서로·capacity scan(m%15==7)과 비겹침, 무거운 지역쌍(m%3==1) 회피', () => {
    const t = (minute: number) => Date.UTC(2026, 7, 19, 12, minute, 0);

    expect(isWeatherCommitMinute(t(5))).toBe(true);
    expect(isWeatherCommitMinute(t(20))).toBe(true);
    expect(isNewsProcessMinute(t(11))).toBe(true);
    expect(isNewsProcessMinute(t(26))).toBe(true);

    for (let m = 0; m < 60; m += 1) {
      const due = [
        isWeatherMinute(t(m)),
        isWeatherCommitMinute(t(m)),
        isNewsMinute(t(m)),
        isNewsProcessMinute(t(m)),
      ].filter(Boolean).length;
      // 한 분에 weather/news 작업은 최대 1개 + 커밋 슬롯은 daily scan 분(m%15==7)과 비겹침
      expect(due).toBeLessThanOrEqual(1);
      if (due === 1) expect(m % 15).not.toBe(7);
      // 커밋(무거운 파싱) 분은 런던·프랑크푸르트(m%3==1) 분을 피한다
      if (isWeatherCommitMinute(t(m)) || isNewsProcessMinute(t(m))) {
        expect(m % 3).not.toBe(1);
      }
    }
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

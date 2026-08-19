/** 분 단위 태스크 테이블 계약 (PLAN §8.7 + CPU 사다리 rung ① — 한 invocation에 1작업).
 *  검증 축: ① 분 → 작업이 정확히 1개 ② 슬롯 배분(주기) ③ 지역 라운드로빈 균등·최대 간격
 *  ④ capacity scan 분(03:13)이 수집 작업과 겹치지 않음. */
import { describe, expect, test } from 'vitest';
import { MINUTE_TASKS, REGIONS, taskForMinute } from '../src/schedule';
import { SCAN_HOUR_UTC, SCAN_MINUTE_UTC } from '../src/r2/capacity';
import { TEMPORAL_SPEC } from '@lwp/shared';

const at = (minute: number): number => Date.UTC(2026, 7, 19, 12, minute, 0);

function countOf(kind: string): number {
  return MINUTE_TASKS.filter((t) => t.kind === kind).length;
}

describe('MINUTE_TASKS — 분 → 작업 1개', () => {
  test('60분 전부 정확히 1개 작업으로 채워진다', () => {
    expect(MINUTE_TASKS).toHaveLength(60);
    for (const task of MINUTE_TASKS) {
      expect(typeof task.kind).toBe('string');
    }
  });

  test('슬롯 배분 — flight 36 / quake 6 / weather 2+2 / news 4+4 / idle 6', () => {
    expect(countOf('flight')).toBe(36);
    expect(countOf('quake')).toBe(6);
    expect(countOf('weather-fetch')).toBe(2);
    expect(countOf('weather-commit')).toBe(2);
    expect(countOf('news-fetch')).toBe(4);
    expect(countOf('news-process')).toBe(4);
    expect(countOf('idle')).toBe(6);
  });

  test('taskForMinute는 UTC 분of시간만 본다 (stateless·결정론)', () => {
    for (let m = 0; m < 60; m += 1) {
      expect(taskForMinute(at(m))).toEqual(MINUTE_TASKS[m]);
      // 다른 시각·다른 날짜라도 같은 분이면 같은 작업
      expect(taskForMinute(Date.UTC(2027, 0, 1, 5, m, 30))).toEqual(MINUTE_TASKS[m]);
    }
  });

  test('weather는 fetch → commit 순서, news도 fetch → process 순서', () => {
    const minutesOf = (kind: string): number[] =>
      MINUTE_TASKS.flatMap((t, m) => (t.kind === kind ? [m] : []));

    expect(minutesOf('weather-fetch')).toEqual([6, 36]);
    expect(minutesOf('weather-commit')).toEqual([9, 39]);
    expect(minutesOf('news-fetch')).toEqual([2, 17, 32, 47]);
    expect(minutesOf('news-process')).toEqual([4, 19, 34, 49]);
    // 커밋은 같은 900s norm 슬롯 안에 있어야 raw 되읽기가 성립한다
    for (const [f, c] of [
      [6, 9],
      [36, 39],
    ]) {
      expect(Math.floor(f! / 15)).toBe(Math.floor(c! / 15));
    }
    for (const [f, c] of [
      [2, 4],
      [17, 19],
      [32, 34],
      [47, 49],
    ]) {
      expect(Math.floor(f! / 15)).toBe(Math.floor(c! / 15));
    }
  });
});

describe('flight 지역 라운드로빈', () => {
  test('6지역이 시간당 정확히 6회씩 — 편향 없음', () => {
    const counts = new Map<string, number>();
    for (const task of MINUTE_TASKS) {
      if (task.kind !== 'flight') continue;
      counts.set(task.region.id, (counts.get(task.region.id) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([...REGIONS.map((r) => r.id)].sort());
    for (const [, n] of counts) expect(n).toBe(6);
  });

  test('지역별 최대 재방문 간격 < TEMPORAL_SPEC.flight tolerance (stale 상시 오탐 금지)', () => {
    const spec = TEMPORAL_SPEC.flight;
    expect(spec.temporalMode).toBe('sampled');
    const toleranceMin = spec.temporalMode === 'sampled' ? spec.toleranceMs / 60_000 : 0;

    for (const region of REGIONS) {
      const minutes = MINUTE_TASKS.flatMap((t, m) => (t.kind === 'flight' && t.region.id === region.id ? [m] : []));
      expect(minutes.length).toBe(6);
      let maxGap = 0;
      for (let i = 0; i < minutes.length; i += 1) {
        const next = i + 1 < minutes.length ? minutes[i + 1]! : minutes[0]! + 60; // 시간 경계 wrap
        maxGap = Math.max(maxGap, next - minutes[i]!);
      }
      expect(maxGap).toBeLessThan(toleranceMin);
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

describe('capacity scan 분 격리', () => {
  test('scan 분(03:13)은 idle — 전수 LIST가 수집 작업과 CPU를 다투지 않는다', () => {
    expect(SCAN_HOUR_UTC).toBe(3);
    expect(MINUTE_TASKS[SCAN_MINUTE_UTC]?.kind).toBe('idle');
  });
});

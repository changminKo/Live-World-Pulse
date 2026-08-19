/** 분 단위 태스크 디스패처 — CPU 사다리 rung ① "한 invocation에 1작업" (PLAN §8.7).
 *
 *  2026-08-19 재설계 사유 (실측 근거):
 *  Workers Free는 invocation당 CPU 하드 10ms다. 기존 스케줄은 매분 [지진 + 항공기
 *  2지역 + latest 조립]을 한 invocation에 몰아넣었고, 로컬 실측(process.cpuUsage,
 *  M-시리즈)만으로도 지진 2.4ms + 항공기 지역 13.0ms × 2 + 조립 2.3ms ≈ 30ms —
 *  프로덕션 tail은 100% `outcome=exceededCpu(cpuTime 10)`, weather/news 슬롯은
 *  2시간 넘게 한 번도 완주하지 못했다 (latest asOf 10:05에서 정지).
 *
 *  그래서 스케줄을 "분 → 작업 1개" 테이블로 바꿨다. cron은 그대로 1분 1개이고,
 *  각 invocation은 아래 MINUTE_TASKS[분]의 작업 **하나**만 수행한 뒤 latest를
 *  재조립한다 (조립은 byte concat으로 ~0.3ms — r2/latest.ts 헤더 참조).
 *
 *  주기 (rung ③ 완화 — 시간당 60 invocation 배분):
 *  - flight  36슬롯: 6지역 라운드로빈 → 지역당 시간당 6회 = 10분 주기
 *    (기존 3분 주기에서 완화. shared TEMPORAL_SPEC.flight tolerance 20분과 짝)
 *  - quake    6슬롯: 10분 주기. 프론트는 USGS를 브라우저에서 직접 폴링하므로
 *    (CLAUDE.md CORS 예외) 수집기 주기는 norm 히스토리 해상도만 결정한다
 *  - weather  fetch 2 + commit 2: 30분 주기 (GDACS 경보는 시간 단위로 움직인다)
 *  - news     fetch 4 + process 4: 15분 주기 (GDELT 파일 주기와 동일)
 *  - idle     6슬롯: 조립만. capacity scan(03:13 UTC)이 앉는 자리이기도 하다 */

export interface Region {
  id: string;
  lat: number;
  lon: number;
}

export const REGIONS: readonly Region[] = [
  { id: 'seoul', lat: 37.5, lon: 127.0 },
  { id: 'tokyo', lat: 35.68, lon: 139.77 },
  { id: 'london', lat: 51.51, lon: -0.13 },
  { id: 'frankfurt', lat: 50.0, lon: 8.6 },
  { id: 'newyork', lat: 40.71, lon: -74.01 },
  { id: 'losangeles', lat: 34.05, lon: -118.25 },
] as const;

export type MinuteTask =
  | { kind: 'quake' }
  | { kind: 'flight'; region: Region }
  | { kind: 'weather-fetch' }
  | { kind: 'weather-commit' }
  | { kind: 'news-fetch' }
  | { kind: 'news-process' }
  | { kind: 'idle' };

export type MinuteTaskKind = MinuteTask['kind'];

/** 비-flight 고정 슬롯 (분of시간). 나머지 분은 전부 flight 라운드로빈.
 *  weather는 fetch → 3분 뒤 commit (raw 적재 완료 후 되읽기), news도 동일 간격. */
const FIXED_SLOTS: ReadonlyArray<readonly [minute: number, kind: MinuteTaskKind]> = [
  [0, 'quake'],
  [2, 'news-fetch'],
  [4, 'news-process'],
  [6, 'weather-fetch'],
  [9, 'weather-commit'],
  [10, 'quake'],
  [13, 'idle'], // capacity scan 자리 (03:13 UTC)
  [17, 'news-fetch'],
  [19, 'news-process'],
  [20, 'quake'],
  [22, 'idle'],
  [25, 'idle'],
  [30, 'quake'],
  [32, 'news-fetch'],
  [34, 'news-process'],
  [36, 'weather-fetch'],
  [39, 'weather-commit'],
  [40, 'quake'],
  [43, 'idle'],
  [47, 'news-fetch'],
  [49, 'news-process'],
  [50, 'quake'],
  [52, 'idle'],
  [55, 'idle'],
] as const;

/** 분(0~59) → 작업 1개. 고정 슬롯 24개 + flight 36개(6지역 × 6회) = 60. */
export const MINUTE_TASKS: readonly MinuteTask[] = (() => {
  const fixed = new Map<number, MinuteTaskKind>(FIXED_SLOTS.map(([m, k]) => [m, k]));
  const table: MinuteTask[] = [];
  let flightIndex = 0;
  for (let m = 0; m < 60; m += 1) {
    const kind = fixed.get(m);
    if (kind === undefined) {
      const region = REGIONS[flightIndex % REGIONS.length];
      flightIndex += 1;
      if (!region) throw new Error('REGIONS empty');
      table.push({ kind: 'flight', region });
      continue;
    }
    if (kind === 'flight') throw new Error('FIXED_SLOTS must not declare flight');
    table.push({ kind });
  }
  return table;
})();

/** 이 invocation이 수행할 단 하나의 작업. UTC 분of시간만 본다 (stateless·결정론). */
export function taskForMinute(epochMs: number): MinuteTask {
  const minute = Math.floor(epochMs / 60_000) % 60;
  const task = MINUTE_TASKS[minute];
  if (!task) throw new Error(`no task for minute ${minute}`);
  return task;
}

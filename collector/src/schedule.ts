/** 분 단위 태스크 디스패처 — CPU 사다리 rung ① "한 invocation에 1작업" (PLAN §8.7).
 *
 *  2026-08-19 1차 재설계 사유 (실측 근거):
 *  Workers Free는 invocation당 CPU 하드 10ms다. 최초 스케줄은 매분 [지진 + 항공기
 *  2지역 + latest 조립]을 한 invocation에 몰아넣었고, 프로덕션 tail은 100%
 *  `outcome=exceededCpu(cpuTime 10)`, weather/news 슬롯은 2시간 넘게 한 번도 완주하지
 *  못했다. 그래서 스케줄을 "분 → 작업 1개" 테이블로 바꿨다.
 *
 *  2026-08-19 2차 재설계 (사후 리뷰 High1 — 분할이 아직 부족했다):
 *  1작업/분으로 바꾼 뒤에도 tail 실측이 weather-commit 26ms · quake 13ms로 남았다
 *  (kill은 안 났지만 Free의 비보장 유예에 기댄 상태 — 정상 동작이 아니다).
 *  두 슬롯의 비용 구조가 달랐다:
 *  - weather-commit: GDACS 페이지 6~8개(원문 810KB+)를 한 invocation에서 gunzip+parse.
 *    → **페이지 자체를 분할**한다. weather-page 슬롯이 슬롯당 PAGES_PER_SLOT(2)개만
 *      가져와 **즉시 정규화**해 청크로 남기고, weather-commit은 정규화된 청크
 *      (합계 ~200KB)만 읽는다. 파싱은 파이프라인 전체에서 1회로 유지된다.
 *  - quake: all_hour 1시간 창을 15분 norm 슬롯 4~5개로 쪼개 매번 전부 upsert했다
 *    (슬롯당 R2 왕복 6회 × 5 = 30회). → **현재 슬롯 + 직전 슬롯만** 커밋하고
 *      주기를 15분으로 맞춘다 (QUAKE_COMMIT_SLOTS). 15분 주기 × 2슬롯이면 모든 슬롯이
 *      정확히 두 번(현재·직전) 커밋돼 커버리지 손실이 없다.
 *
 *  주기 (시간당 60 invocation 배분 — 아래 FIXED_SLOTS + 나머지 flight):
 *  - flight  36슬롯: 6지역 라운드로빈 → 지역당 시간당 6회 = 10분 주기 (변경 없음.
 *    shared TEMPORAL_SPEC.flight tolerance 20분 = 2주기와 짝)
 *  - quake    3슬롯: 20분 주기. 프론트는 USGS를 브라우저에서 직접 60초 폴링하므로
 *    (CLAUDE.md CORS 예외) 수집기 주기는 norm 히스토리 해상도만 결정한다.
 *    all_hour 창이 60분이라 20분 주기에서도 유실 없음
 *  - weather  page 10 + commit 1 + track 1 = 12슬롯, **사이클 60분**
 *    (페이지 1장/슬롯 — 프로덕션 실측 2장 13ms → 1장 ~7ms. 실측 수요 8장 + 여유 2장)
 *  - news     fetch 4 + process 4: 15분 주기 (GDELT 파일 주기와 동일)
 *  - idle     1슬롯(분 13): capacity scan(03:13 UTC)이 앉는 자리 */

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
  | { kind: 'weather-page' }
  | { kind: 'weather-commit' }
  | { kind: 'weather-track' }
  | { kind: 'news-fetch' }
  | { kind: 'news-process' }
  | { kind: 'idle' };

export type MinuteTaskKind = MinuteTask['kind'];

/** 비-flight 고정 슬롯 (분of시간). 나머지 분은 전부 flight 라운드로빈.
 *
 *  weather 사이클 = 60분 (shared WEATHER_CYCLE_SEC = 시간 경계). 사이클 안에서
 *  page ×10 → commit(55) → track(57) 순서이고, commit은 진행 마커가 "전 레벨 종료"일 때만
 *  latest를 교체한다 (시간 간격 의존 제거 — 재리뷰 Med1). track 슬롯은 commit이 발행한
 *  tc-index를 읽으므로 commit 뒤에 둔다.
 *
 *  페이지 슬롯을 **한 덩어리로 붙이지 않고 흩어 놓은 이유**: 연속으로 놓으면 그 구간에
 *  flight 슬롯이 없어 특정 지역의 재방문 간격이 23분까지 벌어졌다 (TEMPORAL_SPEC.flight
 *  tolerance 20분 초과 = 상시 stale 오탐). 지금 배치의 지역 최대 간격은 13분이다
 *  (schedule 테스트가 이 불변식을 지킨다). */
const FIXED_SLOTS: ReadonlyArray<readonly [minute: number, kind: MinuteTaskKind]> = [
  [0, 'quake'],
  [2, 'news-fetch'],
  [4, 'news-process'],
  [6, 'weather-page'],
  [11, 'weather-page'],
  [13, 'idle'], // capacity scan 자리 (03:13 UTC)
  [14, 'weather-page'],
  [17, 'news-fetch'],
  [19, 'news-process'],
  [20, 'quake'],
  [22, 'weather-page'],
  [26, 'weather-page'],
  [30, 'weather-page'],
  [32, 'news-fetch'],
  [34, 'news-process'],
  [36, 'weather-page'],
  [40, 'quake'],
  [43, 'weather-page'],
  [46, 'weather-page'],
  [47, 'news-fetch'],
  [49, 'news-process'],
  [51, 'weather-page'],
  [55, 'weather-commit'],
  [57, 'weather-track'],
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

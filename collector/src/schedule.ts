/** 스케줄 디스패처 (PLAN §8.7 스케줄 계약):
 *  분 m%3==0 → 지역 1·2 (서울·도쿄), m%3==1 → 지역 3·4 (런던·프랑크푸르트),
 *  m%3==2 → 지역 5·6 (뉴욕·LA). 지역당 3분 주기. 지진은 매분.
 *  Phase 1: weather(GDACS)는 m%15==2, news(GDELT)는 m%15==9 — 서로 다른 분에 분산. */

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

export function regionsForMinute(epochMs: number): [Region, Region] {
  const m = Math.floor(epochMs / 60_000) % 3;
  const a = REGIONS[m * 2];
  const b = REGIONS[m * 2 + 1];
  if (!a || !b) throw new Error(`invalid region slot m=${m}`);
  return [a, b];
}

/** weather/news 2단 분할 (CPU 사다리 — §8.7 invocation 분할 극대화, 2026-08-19):
 *  Free 플랜 하드 10ms/invocation 예산에서 fetch+raw 적재와 norm 커밋/무거운 파싱을
 *  같은 분에 두면 초과한다. fetch 분과 처리 분을 나누고, 항공기 무거운 지역쌍
 *  (m%3==1 런던·프랑크푸르트)과 겹치지 않는 분(m%3∈{0,2})만 골랐다.
 *  daily capacity scan(03:07, m%15==7)과도 비겹침. */

/** weather(GDACS) fetch 슬롯 — 15분 주기, m%15==2 (m%3==2 뉴욕·LA 경량쌍) */
export const WEATHER_SLOT_MINUTE = 2;
/** weather norm 커밋+TC 트랙 슬롯 — m%15==5 (m%3==2 경량쌍) */
export const WEATHER_COMMIT_MINUTE = 5;
/** news(GDELT) fetch(zip raw 적재) 슬롯 — 15분 주기, m%15==9 */
export const NEWS_SLOT_MINUTE = 9;
/** news 파싱·norm 커밋 슬롯 — m%15==11 (m%3==2 경량쌍) */
export const NEWS_PROCESS_MINUTE = 11;

function minuteMod15(epochMs: number): number {
  return Math.floor(epochMs / 60_000) % 15;
}

export function isWeatherMinute(epochMs: number): boolean {
  return minuteMod15(epochMs) === WEATHER_SLOT_MINUTE;
}

export function isWeatherCommitMinute(epochMs: number): boolean {
  return minuteMod15(epochMs) === WEATHER_COMMIT_MINUTE;
}

export function isNewsMinute(epochMs: number): boolean {
  return minuteMod15(epochMs) === NEWS_SLOT_MINUTE;
}

export function isNewsProcessMinute(epochMs: number): boolean {
  return minuteMod15(epochMs) === NEWS_PROCESS_MINUTE;
}

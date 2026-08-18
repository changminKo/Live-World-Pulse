/** 스케줄 디스패처 (PLAN §8.7 스케줄 계약):
 *  분 m%3==0 → 지역 1·2 (서울·도쿄), m%3==1 → 지역 3·4 (런던·프랑크푸르트),
 *  m%3==2 → 지역 5·6 (뉴욕·LA). 지역당 3분 주기. 지진은 매분. */

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

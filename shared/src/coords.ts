/** 좌표 검증 (PLAN §10 운영): null island(0,0)·NaN·범위 밖 드롭 + 카운터는 호출부에서 집계.
 *  collector/src/coords.ts에서 승격 — LIVE(web)·수집(collector) 동일 규칙 (PLAN §8.4). */
export function validateLonLat(lon: unknown, lat: unknown): [lon: number, lat: number] | null {
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon === 0 && lat === 0) return null; // null island
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return [lon, lat];
}

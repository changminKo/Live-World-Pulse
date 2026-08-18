import { describe, expect, test } from 'vitest';
import { validateLonLat } from '../src/coords';

describe('좌표 검증 (null island·NaN·범위 — PLAN §10)', () => {
  test('정상 좌표는 [lon, lat] 순서 그대로 반환', () => {
    expect(validateLonLat(139.77, 35.68)).toEqual([139.77, 35.68]);
  });

  test('null island (0,0) 드롭', () => {
    expect(validateLonLat(0, 0)).toBeNull();
  });

  test('NaN·Infinity 드롭', () => {
    expect(validateLonLat(NaN, 35)).toBeNull();
    expect(validateLonLat(139, Infinity)).toBeNull();
  });

  test('숫자 아닌 입력 드롭', () => {
    expect(validateLonLat('139.77', 35.68)).toBeNull();
    expect(validateLonLat(undefined, null)).toBeNull();
  });

  test('범위 밖 드롭 (lon ±180, lat ±90)', () => {
    expect(validateLonLat(181, 0)).toBeNull();
    expect(validateLonLat(0, 91)).toBeNull();
    expect(validateLonLat(-180, -90)).toEqual([-180, -90]); // 경계값은 유효
  });

  test('축 하나만 0인 좌표는 유효 (적도/본초자오선)', () => {
    expect(validateLonLat(0, 51.51)).toEqual([0, 51.51]);
    expect(validateLonLat(127.0, 0)).toEqual([127.0, 0]);
  });
});

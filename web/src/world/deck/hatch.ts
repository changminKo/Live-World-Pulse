import type { Position } from '@lwp/shared';

/** 경보 폴리곤 빗금(hatch) 생성 — DESIGN §2.1 "면은 낮은 알파 채움 + 빗금" (재리뷰 Low1).
 *
 *  왜 기하로 만드나: deck의 폴리곤 채움에 패턴을 넣으려면 텍스처(커스텀 셰이더)나
 *  `@deck.gl/extensions`의 PathStyleExtension이 필요하고, globe 위 클리핑용
 *  MaskExtension은 금지 목록이다 (CLAUDE.md). 그래서 빗금선을 **폴리곤 내부로 정확히
 *  잘라** PathLayer로 그린다 — 의존성 0, globe에서도 동작.
 *
 *  방식: 45° 빗금은 `lat - lon = c` 꼴 직선족이다. 좌표를 (u, v) = (lat - lon, lat + lon)로
 *  바꾸면 이 직선족이 "u = c 수평선"이 되므로 표준 스캔라인이 된다. u를 spacing씩 훑어
 *  각 변과의 교점 v를 모으고 정렬 후 짝지어 내부 구간만 남긴다 (even-odd 규칙 — 구멍 ring도
 *  같은 배열에 넣으면 자동으로 뚫린다). 역변환은 lon = (v - u) / 2, lat = (v + u) / 2.
 *
 *  좌표계 주의: 도(degree) 공간에서 자르므로 고위도에서는 화면상 각도가 45°가 아니다.
 *  시각 텍스처가 목적이므로 수용한다 (측지 정확도가 필요한 값이 아니다).
 *  **호출 측 계약**: 날짜변경선을 넘는 폴리곤은 링을 미리 언랩해서 넘겨야 한다
 *  (`map/tc-geometry.ts`의 `unwrapRings`). 원본 ±180 점프 좌표를 그대로 넣으면 lonSpan이
 *  340°가 되어 아래 스팬 가드에 걸려 빗금이 통째로 사라진다. 가드는 언랩 후에도 반구를
 *  넘는 **진짜 전지구 폴리곤**만 걸러내는 안전장치다. */

/** 폴리곤당 빗금선 수 목표 — 너무 촘촘하면 면이 막히고, 너무 드물면 텍스처가 안 읽힌다 */
const TARGET_LINES = 12;
/** 폴리곤당 세그먼트 상한 — 오목·다중 ring에서 세그먼트가 폭발하지 않게 (프레임 예산) */
const MAX_SEGMENTS = 240;
/** 언랩 후에도 경도/위도 스팬이 이보다 크면 전지구 폴리곤 — 빗금 생략(텍스처 의미 없음) */
const SPAN_LIMIT_DEG = 170;

interface Bounds {
  minU: number;
  maxU: number;
  lonSpan: number;
  latSpan: number;
}

function boundsOf(rings: readonly Position[][]): Bounds | null {
  let minU = Infinity;
  let maxU = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      const u = lat - lon;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minU) || maxU <= minU) return null;
  return { minU, maxU, lonSpan: maxLon - minLon, latSpan: maxLat - minLat };
}

/** 폴리곤(외곽 + 구멍 ring 포함) → 45° 빗금 세그먼트 목록.
 *  빈 배열 = 빗금 없음 (너무 작음·경계 이상·좌표 부족). 입력은 변경하지 않는다. */
export function hatchPolygon(rings: readonly Position[][]): Position[][] {
  const usable = rings.filter((r) => r.length >= 3);
  if (usable.length === 0) return [];
  const bounds = boundsOf(usable);
  if (bounds === null) return [];
  if (bounds.lonSpan > SPAN_LIMIT_DEG || bounds.latSpan > SPAN_LIMIT_DEG) return [];

  const spacing = (bounds.maxU - bounds.minU) / (TARGET_LINES + 1);
  if (!(spacing > 0)) return [];

  const segments: Position[][] = [];
  for (let u = bounds.minU + spacing; u < bounds.maxU && segments.length < MAX_SEGMENTS; u += spacing) {
    const crossings: number[] = [];
    for (const ring of usable) {
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (!a || !b) continue;
        const ua = a[1] - a[0];
        const ub = b[1] - b[0];
        // 반열린 구간 판정 — 정점을 지나는 스캔라인의 이중 계수 방지 (even-odd 정합성)
        if (ua === ub) continue;
        if (u < Math.min(ua, ub) || u >= Math.max(ua, ub)) continue;
        const t = (u - ua) / (ub - ua);
        const va = a[1] + a[0];
        const vb = b[1] + b[0];
        crossings.push(va + t * (vb - va));
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((x, y) => x - y);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const v0 = crossings[i];
      const v1 = crossings[i + 1];
      if (v0 === undefined || v1 === undefined || v1 - v0 <= 0) continue;
      segments.push([
        [(v0 - u) / 2, (v0 + u) / 2],
        [(v1 - u) / 2, (v1 + u) / 2],
      ]);
      if (segments.length >= MAX_SEGMENTS) break;
    }
  }
  return segments;
}

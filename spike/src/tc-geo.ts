/** TC 트랙 후보 비교 하네스용 대권 보간 유틸 (spike 전용 — web 번들 아님).
 *  후보 (c) "PathLayer + 좌표 subdivision"의 세분화 구현: 각 세그먼트를 대권(구면 선형
 *  보간, slerp)으로 stepDeg 이하 간격으로 쪼갠다. 날짜변경선 wrap은 3D 벡터 slerp라
 *  자연히 처리되고, 출력 경도는 이전 점 기준 ±180 언랩으로 연속화한다. */
export type LonLat = [lon: number, lat: number];

const DEG = Math.PI / 180;

function toVec([lon, lat]: LonLat): [number, number, number] {
  const p = lat * DEG;
  const l = lon * DEG;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

function toLonLat(v: [number, number, number]): LonLat {
  const [x, y, z] = v;
  return [Math.atan2(y, x) / DEG, Math.asin(Math.max(-1, Math.min(1, z))) / DEG];
}

/** 두 점 사이 대권 각거리(도) */
export function angularDistanceDeg(a: LonLat, b: LonLat): number {
  const va = toVec(a);
  const vb = toVec(b);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  return Math.acos(dot) / DEG;
}

/** 경도 언랩 — 직전 점에서 ±180을 넘지 않도록 2π 배수 보정 (PathLayer 좌표 연속성) */
function unwrap(prevLon: number, lon: number): number {
  let out = lon;
  while (out - prevLon > 180) out -= 360;
  while (out - prevLon < -180) out += 360;
  return out;
}

/** 트랙 좌표열을 대권 보간으로 세분화 (세그먼트 각거리 > stepDeg 인 구간만 분할) */
export function subdivideGreatCircle(path: LonLat[], stepDeg = 0.5): LonLat[] {
  if (path.length < 2) return [...path];
  const out: LonLat[] = [path[0]];
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const omegaDeg = angularDistanceDeg(a, b);
    const steps = Math.max(1, Math.ceil(omegaDeg / stepDeg));
    const va = toVec(a);
    const vb = toVec(b);
    const omega = omegaDeg * DEG;
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      let v: [number, number, number];
      if (omega < 1e-9) {
        v = vb;
      } else {
        const k0 = Math.sin((1 - t) * omega) / Math.sin(omega);
        const k1 = Math.sin(t * omega) / Math.sin(omega);
        v = [va[0] * k0 + vb[0] * k1, va[1] * k0 + vb[1] * k1, va[2] * k0 + vb[2] * k1];
      }
      const [lon, lat] = toLonLat(v);
      const prev = out[out.length - 1];
      out.push([unwrap(prev[0], lon), lat]);
    }
  }
  return out;
}

/** 폴리곤 ring 세분화 — 콘 폴리곤 후보 (d) 비교용 */
export function subdivideRing(ring: LonLat[], stepDeg = 0.5): LonLat[] {
  return subdivideGreatCircle(ring, stepDeg);
}

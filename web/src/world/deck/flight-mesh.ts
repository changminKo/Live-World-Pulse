/** 항공기 삼각 메시 — globe 위 IconLayer 금지(#9554)의 대안 (스파이크 확정, DESIGN §2.1).
 *  +Y가 기수(북쪽) — getOrientation yaw로 track 회전. 단위 크기, sizeScale이 미터 환산.
 *  SimpleMeshLayer는 positions 외에 normals·texCoords attribute를 단정한다 — 평면 실루엣이라
 *  normals는 전부 +Z, texCoords는 0 채움. */

const VERTICES = new Float32Array([
  // 기수 (북)
  0, 1, 0,
  // 좌후미
  -0.55, -0.7, 0,
  // 우후미
  0.55, -0.7, 0,
]);

const NORMALS = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
const TEX_COORDS = new Float32Array([0, 0, 0, 1, 1, 1]);

export const FLIGHT_MESH = {
  attributes: {
    positions: { size: 3, value: VERTICES },
    normals: { size: 3, value: NORMALS },
    texCoords: { size: 2, value: TEX_COORDS },
  },
} as const;

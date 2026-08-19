/** 사각 메시 — globe 위 IconLayer 금지(#9554) 아래 shape 이중 인코딩 (DESIGN §2.1).
 *  뉴스 = 채운 사각 (원=지진과 실루엣 대비 최대), 기상 경보 Point 폴백 = 사각 테두리
 *  (폴리곤 채움+빗금 보더의 점 대응 — 원+빗금 불가). flight-mesh와 동일 계약:
 *  단위 크기·sizeScale 미터 환산, 평면 실루엣이라 normals 전부 +Z, texCoords 0 채움. */

const buildMesh = (vertices: Float32Array) => {
  const vertexCount = vertices.length / 3;
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) normals[i * 3 + 2] = 1;
  return {
    attributes: {
      positions: { size: 3, value: vertices },
      normals: { size: 3, value: normals },
      texCoords: { size: 2, value: new Float32Array(vertexCount * 2) },
    },
  } as const;
};

/** 채운 단위 사각 (±0.5) — 삼각형 2개 */
export const SQUARE_MESH = buildMesh(
  new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0,
    -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]),
);

/** 사각 테두리 (외곽 ±0.5, 내곽 ±0.3) — 변마다 사다리꼴 2삼각, 총 8삼각 24정점 */
const OUT = 0.5;
const IN = 0.3;
const frameVertices: number[] = [];
const quad = (
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): void => {
  frameVertices.push(a[0], a[1], 0, b[0], b[1], 0, c[0], c[1], 0);
  frameVertices.push(a[0], a[1], 0, c[0], c[1], 0, d[0], d[1], 0);
};
quad([-OUT, IN], [-IN, IN], [-IN, -IN], [-OUT, -IN]); // 좌변
quad([IN, IN], [OUT, IN], [OUT, -IN], [IN, -IN]); // 우변
quad([-OUT, OUT], [OUT, OUT], [OUT, IN], [-OUT, IN]); // 상변
quad([-OUT, -IN], [OUT, -IN], [OUT, -OUT], [-OUT, -OUT]); // 하변

export const SQUARE_FRAME_MESH = buildMesh(new Float32Array(frameVertices));

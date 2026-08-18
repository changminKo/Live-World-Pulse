import type { EngineHandle, LonLat } from '../engines/types';
import { SENTINELS, angularDistanceDeg } from '../payload/generate';

export const POINTS_LAYER_ID = 'points';
const MAX_PICK_OBJECTS = 50_000;
/**
 * 카메라 중심으로부터 이 각거리 이내면 "가시"로 간주.
 * z2 globe 수평선은 카메라 유한 거리 탓에 ~75°에서 잘림 (실측: 원반 반경 315px/326px).
 * 90°(반구)나 85°는 과대 — 수평선 밖 점을 소실로 오판한다. 5° 마진 둔 70°.
 */
const VISIBLE_ANGULAR_DEG = 70;

/**
 * 기준 2 — 마커 카운트 (DESIGN §4-2).
 * pickObjects maxObjects 함정 회피: 뷰포트 4분할 + maxObjects 명시, id 중복 제거.
 * 항공기는 틱으로 움직이므로 제외 — layerIds로 30k 점 레이어만.
 */
export function countVisibleMarkers(
  engine: EngineHandle,
  viewport: { width: number; height: number },
): number {
  const ids = new Set<string>();
  const halfW = Math.floor(viewport.width / 2);
  const halfH = Math.floor(viewport.height / 2);
  const quadrants = [
    { x: 0, y: 0 },
    { x: halfW, y: 0 },
    { x: 0, y: halfH },
    { x: halfW, y: halfH },
  ];
  for (const q of quadrants) {
    const infos = engine.pickObjects({
      x: q.x,
      y: q.y,
      width: halfW,
      height: halfH,
      layerIds: [POINTS_LAYER_ID],
      maxObjects: MAX_PICK_OBJECTS,
    });
    for (const info of infos) {
      if (info.id) ids.add(info.id);
    }
  }
  return ids.size;
}

export interface SentinelCheckResult {
  expected: string[]; // 현 pose에서 보여야 하는 센티널 id
  hit: string[];
  miss: string[];
}

/**
 * project 좌표 중심 나선 스캔 — 반경 r=0..maxR 원주 픽셀들을 radius:0으로 픽,
 * 대상 id가 top인 픽셀 첫 발견 반경 반환 (없으면 Infinity).
 *
 * deck pickObject({radius:r})는 radius 내 top-most "1개"만 반환 — 30k 고밀도에서
 * 겹친 일반 점이 최근접이면 r을 늘려도 같은 점만 나와 영구 miss가 된다 (실측 확인).
 * DESIGN §4-3의 의도(project점 ↔ 실제 픽 가능 위치 거리)를 보존하는 등가 측정.
 */
function scanForId(
  engine: EngineHandle,
  targetId: string,
  cx: number,
  cy: number,
  maxR: number,
): number {
  for (let r = 0; r <= maxR; r++) {
    const samples: { x: number; y: number }[] = [];
    if (r === 0) {
      samples.push({ x: cx, y: cy });
    } else {
      const steps = Math.max(8, Math.ceil(2 * Math.PI * r) / 2);
      for (let i = 0; i < steps; i++) {
        const a = (2 * Math.PI * i) / steps;
        samples.push({
          x: Math.round(cx + r * Math.cos(a)),
          y: Math.round(cy + r * Math.sin(a)),
        });
      }
    }
    for (const s of samples) {
      const info = engine.pickObject({ x: s.x, y: s.y, radius: 0 });
      if (info?.id === targetId) return r;
    }
  }
  return Infinity;
}

/** 기준 2 — 센티널 전수 검사: project → 나선 스캔 반경 8px 내 발견 (DESIGN §4-2) */
export function checkSentinels(
  engine: EngineHandle,
  viewport: { width: number; height: number },
): SentinelCheckResult {
  const center = engine.getCameraPose().center;
  const expected = SENTINELS.filter(
    (s) => angularDistanceDeg(center, s.position) < VISIBLE_ANGULAR_DEG,
  );
  const hit: string[] = [];
  const miss: string[] = [];
  for (const s of expected) {
    const px = engine.project(s.position);
    if (
      px.x < 0 ||
      px.y < 0 ||
      px.x > viewport.width ||
      px.y > viewport.height
    ) {
      // 화면 밖 projection은 검사 대상에서 제외 (가시 반구여도 뷰포트 밖일 수 있음)
      continue;
    }
    const r = scanForId(engine, s.id, Math.round(px.x), Math.round(px.y), 8);
    if (isFinite(r)) hit.push(s.id);
    else miss.push(s.id);
  }
  return {
    expected: expected.map((s) => s.id),
    hit,
    miss,
  };
}

export interface PickingErrorCase {
  sentinelId: string;
  kind: 'center' | 'rim' | 'dateline';
  /** 첫 hit 반경 px. r=10까지 miss면 Infinity(픽킹 불능) → JSON에선 -1 */
  errorPx: number;
}

/**
 * 기준 3 — 픽킹 오차 (DESIGN §4-3).
 * screen = project(lngLat) → 나선 스캔 r=0..10, 대상 센티널이 top인 첫 반경이 오차.
 * (pickObject radius 스캔은 top-most 1개 한계로 고밀도에서 무의미 — scanForId 주석 참조)
 */
export function measurePickingError(
  engine: EngineHandle,
  cases: { sentinelId: string; kind: PickingErrorCase['kind'] }[],
): PickingErrorCase[] {
  return cases.map(({ sentinelId, kind }) => {
    const sentinel = SENTINELS.find((s) => s.id === sentinelId);
    if (!sentinel) return { sentinelId, kind, errorPx: Infinity };
    const px = engine.project(sentinel.position);
    const errorPx = scanForId(engine, sentinelId, Math.round(px.x), Math.round(px.y), 10);
    return { sentinelId, kind, errorPx };
  });
}

/** pose P 기준 픽킹 케이스: 중앙 1 + 림 2 (DESIGN §4-3) */
export const POSE_P_PICK_CASES: { sentinelId: string; kind: PickingErrorCase['kind'] }[] = [
  { sentinelId: 'sentinel-6', kind: 'center' },
  { sentinelId: 'sentinel-7', kind: 'rim' },
  { sentinelId: 'sentinel-8', kind: 'rim' },
];

/** 날짜변경선 pose(center [179.9, 0]) 픽킹 케이스: lon ±179.9 센티널 4점 */
export const DATELINE_PICK_CASES: { sentinelId: string; kind: PickingErrorCase['kind'] }[] = [
  { sentinelId: 'sentinel-0', kind: 'dateline' },
  { sentinelId: 'sentinel-1', kind: 'dateline' },
  { sentinelId: 'sentinel-2', kind: 'dateline' },
  { sentinelId: 'sentinel-3', kind: 'dateline' },
];

export const DATELINE_POSE_CENTER: LonLat = [179.9, 0];

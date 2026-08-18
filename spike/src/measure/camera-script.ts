import type { CameraStep, EngineHandle, LonLat } from '../engines/types';

/** 검사 pose P — 마커 카운트·픽킹의 기준 자세 (DESIGN §4-2) */
export const POSE_P: CameraStep = {
  center: [139.7, 35.6],
  zoom: 2,
  bearing: 0,
  pitch: 0,
  durationMs: 1_500,
};

const TOKYO: LonLat = [139.7, 35.6];
const NEW_YORK: LonLat = [-74.01, 40.71];
const SAO_PAULO: LonLat = [-46.63, -23.55];
const LONDON: LonLat = [-0.13, 51.51];

/** 자동 카메라 시퀀스 ~30초, 3후보 동일 (DESIGN §4-1) */
export const CAMERA_SCRIPT: { name: string; step: CameraStep }[] = [
  // 1. 팬: 도쿄 → 뉴욕 → 상파울루 (9s)
  { name: 'pan-tokyo-ny', step: { center: NEW_YORK, zoom: 1.5, durationMs: 4_500 } },
  { name: 'pan-ny-saopaulo', step: { center: SAO_PAULO, zoom: 1.5, durationMs: 4_500 } },
  // 2. 줌인: z1.5 → z6 (런던, 5s)
  { name: 'zoom-in-london', step: { center: LONDON, zoom: 6, durationMs: 5_000 } },
  // 3. 회전: bearing 0→180→0 @ z3 (6s — C는 N/A, 어댑터가 로그)
  { name: 'rotate-180', step: { center: LONDON, zoom: 3, bearing: 180, durationMs: 3_000 } },
  { name: 'rotate-back', step: { center: LONDON, zoom: 3, bearing: 0, durationMs: 3_000 } },
  // 4. 날짜변경선 횡단 팬: lon 160 → -160 (5s)
  { name: 'dateline-enter', step: { center: [160, 0], zoom: 2.5, durationMs: 2_000 } },
  { name: 'dateline-cross', step: { center: [-160, 0], zoom: 2.5, durationMs: 3_000 } },
  // 5. 줌아웃 z6 → z1.5 복귀 (5s)
  { name: 'zoom-out', step: { center: TOKYO, zoom: 1.5, durationMs: 5_000 } },
];

export interface CameraScriptResult {
  startedAtMs: number;
  endedAtMs: number;
  steps: { name: string; durationMs: number }[];
}

export async function runCameraScript(
  engine: EngineHandle,
  log: (msg: string) => void,
): Promise<CameraScriptResult> {
  const startedAtMs = performance.now();
  const steps: CameraScriptResult['steps'] = [];
  for (const { name, step } of CAMERA_SCRIPT) {
    log(`camera: ${name}`);
    const t0 = performance.now();
    await engine.flyTo(step);
    steps.push({ name, durationMs: Math.round(performance.now() - t0) });
  }
  return { startedAtMs, endedAtMs: performance.now(), steps };
}

/** 기준 5 — z0↔z14 왕복 (DESIGN §4-5) */
export async function runZoomRoundtrip(
  engine: EngineHandle,
  log: (msg: string) => void,
): Promise<void> {
  log('roundtrip: z14 (Tokyo)');
  await engine.flyTo({ center: TOKYO, zoom: 14, durationMs: 4_000 });
  await sleep(3_000);
  log('roundtrip: back to z1.5');
  await engine.flyTo({ center: TOKYO, zoom: 1.5, durationMs: 4_000 });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

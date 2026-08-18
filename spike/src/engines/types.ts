/** 좌표는 전부 GeoJSON 순서 [lon, lat] — CLAUDE.md 계약 */
export type LonLat = [lon: number, lat: number];

export type Rgba = [number, number, number, number];

export interface EventPoint {
  id: string;
  position: LonLat;
  radiusPx: number;
  color: Rgba;
  isSentinel: boolean;
}

export interface Aircraft {
  id: string;
  position: LonLat;
  heading: number; // deg, 0=북, 시계방향
}

export interface Route {
  id: string;
  source: LonLat;
  target: LonLat;
}

export interface CityLabel {
  id: string;
  position: LonLat;
  text: string;
}

export interface Payload {
  points: EventPoint[];
  aircraft: Aircraft[];
  arcs: Route[];
  labels: CityLabel[];
}

export interface CameraStep {
  center: LonLat;
  zoom: number;
  bearing?: number; // C 미지원 — 어댑터가 무시 + 'bearing skipped' 로그
  pitch?: number; // 동일
  durationMs: number;
}

export interface CameraPose {
  center: LonLat;
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface PickInfo {
  id: string | null;
  layerId: string | null;
  x: number;
  y: number;
}

export interface EngineHandle {
  /** 5초 틱마다 새 payload 주입 — naive 교체(새 배열 참조)를 일부러 사용 */
  setPayload(p: Payload): void;
  /** 카메라 스크립트 스텝 실행. 완료 Promise. */
  flyTo(step: CameraStep): Promise<void>;
  /** lngLat → 화면 px (픽킹 오차 검사용) */
  project(lngLat: LonLat): { x: number; y: number };
  /** deck 픽킹 프록시 */
  pickObject(opts: { x: number; y: number; radius: number }): PickInfo | null;
  pickObjects(opts: {
    x: number;
    y: number;
    width: number;
    height: number;
    layerIds?: string[];
    maxObjects?: number;
  }): PickInfo[];
  /** 현재 카메라 pose 스냅샷 (동일 pose 재현 검사용) */
  getCameraPose(): CameraPose;
  destroy(): void;
}

export interface LayerOptions {
  /** SimpleMeshLayer 실패 시 ?mesh=0 → ScatterplotLayer 폴백 (DESIGN §3-2) */
  useMesh: boolean;
}

export type EngineFactory = (
  container: HTMLElement,
  initialPayload: Payload,
  layerOpts: LayerOptions,
  log: (msg: string) => void,
) => Promise<EngineHandle>;

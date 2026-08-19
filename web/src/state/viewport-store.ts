import { create } from 'zustand';

/** 지도 카메라의 디바운스 사본 (CLAUDE.md 하드 룰 — viewport 전역 상태 금지).
 *  진짜 viewport는 maplibre 인스턴스 소유. 여기엔 200~300ms 디바운스 스냅샷만 발행되고,
 *  패널·URL 등 비지도 UI가 구독한다. 지도 조작 경로에서 이 스토어를 읽지 말 것. */
export interface ViewportSnapshot {
  /** GeoJSON 순서 유지 — [lon, lat] 의미의 개별 필드 */
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

interface ViewportState {
  snapshot: ViewportSnapshot | null;
  setSnapshot: (next: ViewportSnapshot) => void;
}

export const useViewportStore = create<ViewportState>()((set) => ({
  snapshot: null,
  setSnapshot: (next) => set({ snapshot: next }),
}));

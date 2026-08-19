import type maplibregl from 'maplibre-gl';
import type { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import { useLiveStore } from '../../data/live-store';
import { useWorldUiStore } from '../../state/world-ui-store';
import { createLayerBuilder } from './layer-factory';

/** LIVE 스토어 ↔ deck overlay 연결 — React 리렌더 밖 (지도 조작 경로에서 전역 상태 미독).
 *  rebuild는 스토어 변경·zoomend에서만. 펄스는 rAF로 uniform만 갱신 (탭 숨김·reduced-motion 정지). */

const PULSE_DURATION_MS = 1_200; // DESIGN --dur-pulse
const ZOOM_BUCKET = 0.25;

/** MapboxOverlay 픽킹 표면 — deck 공개 API지만 @deck.gl/mapbox 타입 선언에 없어 보강 */
interface PickableOverlay {
  pickObject(params: { x: number; y: number; radius?: number }): PickingInfo | null;
}

export function attachLiveLayers(map: maplibregl.Map, overlay: MapboxOverlay): () => void {
  let disposed = false;
  let rafId = 0;
  let pulsePhase = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // 캐시 수명 = 이 attach(=deck overlay) 수명 — Layer 인스턴스는 deck 간 재사용 금지
  const buildLayers = createLayerBuilder();

  const rebuild = (): void => {
    if (disposed) return;
    const live = useLiveStore.getState();
    const ui = useWorldUiStore.getState();
    overlay.setProps({
      layers: buildLayers({
        quakes: live.earthquake.records,
        flightRegions: live.flightRegions,
        quakeArrivals: live.quakeArrivals,
        enabled: ui.enabled,
        selectedId: ui.selectedId,
        zoomBucket: Math.round(map.getZoom() / ZOOM_BUCKET) * ZOOM_BUCKET,
        pulsePhase,
        reducedMotion: reducedMotion.matches,
      }),
    });
    syncPulseLoop();
  };

  // ── 펄스 rAF — 대상 있을 때만, uniform 변조 전용 (attribute 재계산 없음) ──
  const pulseTick = (now: number): void => {
    rafId = 0;
    if (disposed) return;
    pulsePhase = (now % PULSE_DURATION_MS) / PULSE_DURATION_MS;
    rebuild(); // memo 팩토리 — 펄스 레이어 외 인스턴스 전부 재사용
  };
  const syncPulseLoop = (): void => {
    const shouldRun =
      !disposed &&
      !document.hidden &&
      !reducedMotion.matches &&
      useLiveStore.getState().quakeArrivals.length > 0 &&
      useWorldUiStore.getState().enabled.includes('earthquake');
    if (shouldRun && rafId === 0) rafId = requestAnimationFrame(pulseTick);
    if (!shouldRun && rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  // ── 클릭 픽킹 (hover 픽킹 금지 — PLAN §8.3 픽킹 패스 절약) ──
  const onClick = (e: maplibregl.MapMouseEvent): void => {
    const info = (overlay as unknown as PickableOverlay).pickObject({
      x: e.point.x,
      y: e.point.y,
      radius: 6,
    });
    const picked = (info?.object as { id?: string } | undefined)?.id ?? null;
    useWorldUiStore.getState().select(picked);
  };
  map.on('click', onClick);

  const unsubLive = useLiveStore.subscribe(rebuild);
  const unsubUi = useWorldUiStore.subscribe(rebuild);
  map.on('zoomend', rebuild);
  const onVisibility = (): void => syncPulseLoop();
  document.addEventListener('visibilitychange', onVisibility);
  reducedMotion.addEventListener('change', rebuild);

  rebuild();

  return () => {
    disposed = true;
    if (rafId !== 0) cancelAnimationFrame(rafId);
    unsubLive();
    unsubUi();
    map.off('zoomend', rebuild);
    map.off('click', onClick);
    document.removeEventListener('visibilitychange', onVisibility);
    reducedMotion.removeEventListener('change', rebuild);
  };
}

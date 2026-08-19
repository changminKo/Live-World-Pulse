import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { useViewportStore } from '../state/viewport-store';
import { cancelUrlUpdate, readInitialCamera, scheduleUrlUpdate } from '../state/url-sync';
import { debounceTrailing } from '../lib/debounce';
import { attachLiveLayers } from './deck/attach-live-layers';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'; // 키 불요 (PLAN §8.2 실측 확정)

/** 느린 자동 회전 — 1회전 4분 (관제실 미학, 과장 금지) */
const AUTO_ROTATE_DEG_PER_SEC = 360 / 240;
const AUTO_ROTATE_RESUME_MS = 5_000;
const VIEWPORT_DEBOUNCE_MS = 250;
const VIEWPORT_MAX_WAIT_MS = 1_000; // 연속 이동 중에도 1초마다는 사본 발행 (starvation 방지)

/** 하드 룰 준수 지점 (CLAUDE.md):
 *  - interleaved: false 고정 (#9592 깊이/컬링 — globe 위 interleaved 금지)
 *  - attach 순서: style.load → setProjection(globe) → load → addControl(overlay) (#9466)
 *  - sky 컬러 스펙 금지 (#5230 mercator 전용) — 대기광은 공식 globe 예제의
 *    atmosphere-blend 단일 속성만 사용
 *  - viewport 전역 상태 금지 — 지도 인스턴스 소유, 전역엔 디바운스 사본만 발행 */
function initGlobe(container: HTMLDivElement): () => void {
  const camera = readInitialCamera();
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: [camera.lng, camera.lat],
    zoom: camera.zoom,
  });

  map.on('style.load', () => {
    map.setProjection({ type: 'globe' });
    // 공식 globe 예제 방식 대기광 — 줌인 시 페이드아웃 (z5→z7)
    map.setSky({
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
    });
  });

  map.on('error', (e) => {
    console.error('[globe] maplibre error:', e.error?.message ?? e);
  });

  if (import.meta.env.DEV) {
    // dev 전용 진단 핸들 (기계 검증 스크립트·dev 오버레이용) — 프로덕션 번들 제외
    (window as unknown as Record<string, unknown>).__lwpMap = map;
  }

  // deck overlay — interleaved: false 고정 (하드 룰), 레이어는 attachLiveLayers가 스토어에서 구동
  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  let detachLayers: (() => void) | undefined;
  map.on('load', () => {
    map.addControl(overlay as unknown as maplibregl.IControl);
    detachLayers = attachLiveLayers(map, overlay);
    if (import.meta.env.DEV) {
      // deck 레이어 목록·픽킹 검증용 핸들 (verify:layers) — 프로덕션 번들 제외
      (window as unknown as Record<string, unknown>).__lwpDeck = overlay;
    }
  });

  // ── 자동 회전 (idle 시) ──
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let interacting = false;
  let disposed = false;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;

  const spin = () => {
    if (disposed || interacting || document.hidden || reducedMotion.matches) return;
    const center = map.getCenter();
    center.lng += AUTO_ROTATE_DEG_PER_SEC; // 1초 스텝 — moveend 체인으로 연속 회전
    map.easeTo({ center, duration: 1_000, easing: (n) => n, essential: false });
  };

  const pauseSpin = () => {
    interacting = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      interacting = false;
      spin();
    }, AUTO_ROTATE_RESUME_MS);
  };

  map.on('moveend', spin);
  map.on('mousedown', pauseSpin);
  map.on('touchstart', pauseSpin);
  map.on('wheel', pauseSpin);

  const onVisibility = () => {
    if (!document.hidden) spin();
  };
  document.addEventListener('visibilitychange', onVisibility);
  map.once('load', spin);

  // ── viewport 사본 = 250ms trailing 디바운스 + maxWait 1s, URL = 300ms + maxWait 1s.
  // 이동이 멈추면 1회, 연속 이동(자동 회전)이라도 1초마다는 반영 — starvation 방지
  // (CLAUDE.md 디바운스 규율 유지: 매 프레임 발행이 아니라 상한 있는 디바운스). ──
  const publishViewport = debounceTrailing(() => {
    const center = map.getCenter().wrap();
    useViewportStore.getState().setSnapshot({
      lng: center.lng,
      lat: center.lat,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    });
  }, VIEWPORT_DEBOUNCE_MS, VIEWPORT_MAX_WAIT_MS);
  const onMove = () => {
    publishViewport.run();
    // 매 move마다 300ms 타이머 리셋 — 멈춘 뒤 1회만 replaceState (마지막 호출의 카메라가 최종값)
    const center = map.getCenter().wrap();
    scheduleUrlUpdate({ lng: center.lng, lat: center.lat, zoom: map.getZoom() });
  };
  map.on('move', onMove);

  return () => {
    disposed = true;
    clearTimeout(resumeTimer);
    // 이탈 직전 300ms 내 카메라 변화는 의도적으로 버린다 — cleanup 시점엔 이미 목적지
    // URL이라 flush하면 오염 (재검증 Med 재현). 유실 폭 = 최대 300ms 이동뿐.
    publishViewport.cancel();
    cancelUrlUpdate();
    detachLayers?.();
    document.removeEventListener('visibilitychange', onVisibility);
    map.remove(); // overlay는 map.remove()가 컨트롤로 함께 해제
  };
}

export default function GlobeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // WebGL2 미지원 폴백 — 빈 화면 금지 (PLAN §10 복원력)
    if (!document.createElement('canvas').getContext('webgl2')) {
      setUnsupported(true);
      return;
    }
    return initGlobe(container);
  }, []);

  return (
    <div className="space-bg relative h-full w-full overflow-hidden">
      {/* absolute/inset 금지 — maplibre가 컨테이너에 .maplibregl-map{position:relative}를
          주입해 position 유틸을 덮어쓰고 높이가 0이 된다. h-full/w-full만 사용. */}
      <div
        ref={containerRef}
        className="h-full w-full"
        role="img"
        aria-label="3D 지구본 — 전 세계 이벤트 지도 (동일 데이터는 우측 이벤트 로그에서 텍스트로 제공)"
      />
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="max-w-sm border border-[var(--border)] bg-[var(--bg-1)] p-4 text-center text-[length:var(--text-md)] text-[var(--text-hi)]">
            이 브라우저는 WebGL2를 지원하지 않아 지구본을 표시할 수 없습니다. 최신 브라우저에서
            다시 열어주세요.
          </p>
        </div>
      )}
    </div>
  );
}

import { Deck, _GlobeView, LinearInterpolator } from '@deck.gl/core';
import { GeoJsonLayer } from '@deck.gl/layers';
import countriesUrl from '../../fixtures/ne_110m_countries.geojson?url';
import { makeLayers } from '../layers';
import type {
  CameraStep,
  EngineFactory,
  EngineHandle,
  LayerOptions,
  LonLat,
  Payload,
  PickInfo,
} from './types';

interface GlobeViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  [key: string]: unknown;
}

/**
 * 후보 C: deck.gl 단독 _GlobeView (maplibre 없음) — 폴백 1순위.
 * 베이스맵 없음: 다크 clearColor + 국경 GeoJsonLayer(로컬 fixture, 네트워크 의존 0).
 * GlobeView 공식 제약: bearing/pitch 미지원 — 어댑터가 무시하고 로그만 남긴다 (DESIGN §2-2).
 * 텍스처 구·TileLayer 시도 금지 (GlobeView에서 experimental — 스파이크 범위 밖).
 */
const factory: EngineFactory = async (container, initialPayload, layerOpts, log) => {
  const canvas = document.createElement('canvas');
  // 다크 배경 — 베이스맵 없음. deck v9 parameters엔 clearColor가 없어(luma v9 타입) CSS로 동일 효과.
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;background:#0a0a0d';
  container.appendChild(canvas);

  let viewState: GlobeViewState = { longitude: 139.7, latitude: 35.6, zoom: 1.5 };

  const countriesLayer = new GeoJsonLayer({
    id: 'countries',
    data: countriesUrl,
    stroked: true,
    filled: false,
    getLineColor: [90, 95, 110, 180],
    getLineWidth: 1,
    lineWidthUnits: 'pixels',
    pickable: false,
  });

  const buildLayers = (p: Payload) => [countriesLayer, ...makeLayers(p, layerOpts)];

  const deck = new Deck({
    canvas,
    views: new _GlobeView(),
    initialViewState: viewState,
    controller: true,
    layers: buildLayers(initialPayload),
    onViewStateChange: ({ viewState: vs }) => {
      viewState = vs as GlobeViewState;
    },
    onError: (e) => log(`deck error: ${e.message}`),
  });

  log('engine-c: _GlobeView ready (bearing/pitch N/A)');

  const projectViaViewport = (lngLat: LonLat): { x: number; y: number } => {
    const viewports = (deck as unknown as { getViewports(): { project(xyz: number[]): number[] }[] }).getViewports();
    const vp = viewports?.[0];
    if (!vp) return { x: -1, y: -1 };
    const [x, y] = vp.project([lngLat[0], lngLat[1]]);
    return { x, y };
  };

  const handle: EngineHandle = {
    setPayload(p: Payload) {
      deck.setProps({ layers: buildLayers(p) });
    },

    flyTo(step: CameraStep) {
      if (step.bearing || step.pitch) {
        log(`bearing/pitch skipped (GlobeView 미지원): bearing=${step.bearing ?? 0} pitch=${step.pitch ?? 0}`);
      }
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(fallback);
          resolve();
        };
        const fallback = setTimeout(done, step.durationMs + 1_000);
        // 날짜변경선 최단 경로: 목표 lon을 현재 lon ±180 이내로 정규화
        let targetLon = step.center[0];
        while (targetLon - viewState.longitude > 180) targetLon -= 360;
        while (targetLon - viewState.longitude < -180) targetLon += 360;
        deck.setProps({
          initialViewState: {
            longitude: targetLon,
            latitude: step.center[1],
            zoom: step.zoom,
            transitionDuration: step.durationMs,
            transitionInterpolator: new LinearInterpolator(['longitude', 'latitude', 'zoom']),
            onTransitionEnd: done,
          },
        });
      });
    },

    project: projectViaViewport,

    pickObject(opts) {
      const info = deck.pickObject({ x: opts.x, y: opts.y, radius: opts.radius });
      return info ? toPickInfo(info) : null;
    },

    pickObjects(opts) {
      return deck
        .pickObjects({
          x: opts.x,
          y: opts.y,
          width: opts.width,
          height: opts.height,
          layerIds: opts.layerIds,
          maxObjects: opts.maxObjects,
        })
        .map(toPickInfo);
    },

    getCameraPose() {
      return {
        center: [viewState.longitude, viewState.latitude],
        zoom: viewState.zoom,
        bearing: 0,
        pitch: 0,
      };
    },

    destroy() {
      deck.finalize();
      canvas.remove();
    },
  };

  return handle;
};

interface DeckPickedInfo {
  object?: { id?: string };
  layer?: { id: string } | null;
  x: number;
  y: number;
}

function toPickInfo(info: DeckPickedInfo): PickInfo {
  return {
    id: info.object?.id ?? null,
    layerId: info.layer?.id ?? null,
    x: info.x,
    y: info.y,
  };
}

export default factory;

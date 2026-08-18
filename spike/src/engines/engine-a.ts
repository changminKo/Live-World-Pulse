import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
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

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'; // 키 불요 (DESIGN 부록)

/**
 * 후보 A: maplibre-gl 5.24 globe + MapboxOverlay overlaid.
 * 후보 B는 이 팩토리를 interleaved: true로 재사용 (코드 중복 0, DESIGN §2-3).
 *
 * 하드 룰: sky 스펙 추가 금지(mercator 전용 — maplibre #5230),
 * GlobeControl(수동 globe↔mercator 토글) 금지 (#9466).
 */
export function createMaplibreEngine(
  interleaved: boolean,
): EngineFactory {
  return (container, initialPayload, layerOpts, log) =>
    new Promise<EngineHandle>((resolve, reject) => {
      const map = new maplibregl.Map({
        container,
        style: STYLE_URL,
        center: [139.7, 35.6],
        zoom: 1.5,
        attributionControl: false,
      });

      // attach 순서 고정 (#9466이 attach 순서에 따라 다르게 깨진다고 보고됨):
      // style.load → setProjection(globe) → load → addControl(overlay)
      map.on('style.load', () => {
        map.setProjection({ type: 'globe' });
        log('projection: globe set (style.load)');
      });

      map.on('error', (e) => {
        log(`maplibre error: ${e.error?.message ?? 'unknown'}`);
      });

      const overlay = new MapboxOverlay({
        interleaved,
        layers: makeLayers(initialPayload, layerOpts),
      });

      const loadTimeout = setTimeout(
        () => reject(new Error('maplibre load timeout (20s)')),
        20_000,
      );

      map.on('load', () => {
        clearTimeout(loadTimeout);
        map.addControl(overlay as unknown as maplibregl.IControl);
        log(`overlay attached (interleaved=${interleaved})`);
        resolve(buildHandle(map, overlay, layerOpts));
      });
    });
}

function buildHandle(
  map: maplibregl.Map,
  overlay: MapboxOverlay,
  layerOpts: LayerOptions,
): EngineHandle {
  return {
    setPayload(p: Payload) {
      overlay.setProps({ layers: makeLayers(p, layerOpts) });
    },

    flyTo(step: CameraStep) {
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(fallback);
          resolve();
        };
        // moveend 미발화 대비 폴백 (essential 애니메이션이어도 안전망)
        const fallback = setTimeout(done, step.durationMs + 1_000);
        map.once('moveend', done);
        map.easeTo({
          center: step.center,
          zoom: step.zoom,
          bearing: step.bearing ?? 0,
          pitch: step.pitch ?? 0,
          duration: step.durationMs,
          essential: true,
        });
      });
    },

    project(lngLat: LonLat) {
      const p = map.project(lngLat);
      return { x: p.x, y: p.y };
    },

    pickObject(opts) {
      const info = overlay.pickObject({
        x: opts.x,
        y: opts.y,
        radius: opts.radius,
      });
      return info ? toPickInfo(info) : null;
    },

    pickObjects(opts) {
      return overlay
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
      const c = map.getCenter();
      return {
        center: [c.lng, c.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
    },

    destroy() {
      map.removeControl(overlay as unknown as maplibregl.IControl);
      map.remove();
    },
  };
}

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

const factory: EngineFactory = createMaplibreEngine(false);
export default factory;

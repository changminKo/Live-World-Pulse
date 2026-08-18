import { ScatterplotLayer, ArcLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import type { Layer } from '@deck.gl/core';
import type { Aircraft, CityLabel, EventPoint, LayerOptions, Payload, Route } from './engines/types';

/**
 * 항공기 삼각형 메시 — 정점 3개, +y가 기수(북쪽). IconLayer 금지(#9554)의 주 대안.
 * globe 위 SimpleMeshLayer 동작 여부 자체가 스파이크 검증 항목 (DESIGN §3-2).
 */
const AIRCRAFT_MESH = {
  attributes: {
    positions: {
      value: new Float32Array([0, 2, 0, -1, -1, 0, 1, -1, 0]),
      size: 3,
    },
  },
};

const AIRCRAFT_COLOR: [number, number, number, number] = [255, 255, 255, 230];
const AIRCRAFT_SIZE_SCALE = 50_000; // 모델 단위(m) 배율 — z1.5에서 ~수 px

/** 공통 deck 레이어 팩토리 — 3후보 동일 (비교 공정성의 핵심, DESIGN §2-1) */
export function makeLayers(payload: Payload, opts: LayerOptions): Layer[] {
  const aircraftLayer = opts.useMesh
    ? new SimpleMeshLayer<Aircraft>({
        id: 'aircraft',
        data: payload.aircraft,
        mesh: AIRCRAFT_MESH,
        getPosition: (d) => d.position,
        getOrientation: (d) => [0, -d.heading, 0], // yaw = -heading
        getColor: AIRCRAFT_COLOR,
        sizeScale: AIRCRAFT_SIZE_SCALE,
        pickable: false,
      })
    : new ScatterplotLayer<Aircraft>({
        id: 'aircraft',
        data: payload.aircraft,
        getPosition: (d) => d.position,
        getFillColor: AIRCRAFT_COLOR,
        getRadius: 3,
        radiusUnits: 'pixels',
        pickable: false,
      });

  return [
    new ScatterplotLayer<EventPoint>({
      id: 'points',
      data: payload.points,
      getPosition: (d) => d.position,
      getRadius: (d) => d.radiusPx,
      radiusUnits: 'pixels',
      getFillColor: (d) => d.color,
      pickable: true,
    }),
    aircraftLayer,
    new ArcLayer<Route>({
      id: 'arcs',
      data: payload.arcs,
      greatCircle: true,
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getSourceColor: [90, 140, 255, 160],
      getTargetColor: [255, 120, 200, 160],
      getWidth: 1,
      pickable: false,
    }),
    new TextLayer<CityLabel>({
      id: 'labels',
      data: payload.labels,
      billboard: true,
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getSize: 12,
      getColor: [230, 232, 238, 255],
      pickable: false,
    }),
  ];
}

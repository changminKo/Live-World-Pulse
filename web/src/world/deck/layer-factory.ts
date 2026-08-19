import { ScatterplotLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import type { Layer } from '@deck.gl/core';
import type { EarthquakeRecord, FlightRecord, LayerId, SeverityRank } from '@lwp/shared';
import type { QuakeArrival } from '../../data/live-store';
import type { FlightRegionSlice } from '../../data/latest-source';
import { FLIGHT_MESH } from './flight-mesh';

/** deck 레이어 팩토리 — DESIGN §2.1(shape 1차 식별자)·§2.2(rank 색·크기 이중 인코딩).
 *  참조 관리: 입력이 같으면 같은 Layer 인스턴스 반환 (매 폴/프레임 전체 재생성 금지 —
 *  attribute 재계산은 data 참조가 바뀔 때만 일어난다, PLAN §8.3 성능 병목 ①). */

/** DESIGN §2.2 quake rank 0~4 확정 hex → RGB */
const QUAKE_RANK_RGB: Record<SeverityRank, [number, number, number]> = {
  0: [241, 84, 0], // #f15400
  1: [255, 104, 24], // #ff6818
  2: [255, 129, 62], // #ff813e
  3: [255, 153, 99], // #ff9963
  4: [255, 178, 137], // #ffb289
};
/** 크기 변조 병행 — 밝기 단독 의존 금지 (DESIGN §2.2) */
const RANK_SIZE_MUL: Record<SeverityRank, number> = { 0: 1.0, 1: 1.15, 2: 1.3, 3: 1.45, 4: 1.6 };
/** DESIGN --layer-flight #4cc9f0 */
const FLIGHT_RGB: [number, number, number] = [76, 201, 240];
const SELECTED_RGB: [number, number, number, number] = [255, 255, 255, 255];

const quakeRadiusPx = (d: EarthquakeRecord): number => {
  const mag = d.payload.magnitude ?? 1;
  return Math.max(3, 3 + mag * 1.6) * RANK_SIZE_MUL[d.severity.rank];
};

/** 줌별 항공기 메시 크기(m) — z1.5 전역 뷰에서도 실루엣, z8+에선 과대 방지 */
const flightSizeMeters = (zoom: number): number =>
  Math.max(1_500, Math.min(90_000, 140_000 / 2 ** zoom));

export interface BuildLayersInput {
  quakes: EarthquakeRecord[];
  /** 지역 단위 참조 안정 슬라이스 (리뷰 Med4) — 변한 지역의 레이어만 재생성 */
  flightRegions: readonly FlightRegionSlice[];
  quakeArrivals: QuakeArrival[];
  enabled: readonly LayerId[];
  selectedId: string | null;
  /** 0.25 단위 버킷 줌 — 항공기 크기 재계산 트리거 (매 프레임 churn 방지) */
  zoomBucket: number;
  /** 펄스 진행도 0~1 (uniform만 변조 — attribute 재계산 없음) */
  pulsePhase: number;
  reducedMotion: boolean;
}

/** 빌더 인스턴스 — 캐시를 deck overlay 수명에 묶는다.
 *  주의: 모듈 레벨 캐시 금지 — Layer 인스턴스는 deck 인스턴스당 1회만 initialize 가능해서
 *  (assert !internalState) 지도 재마운트(StrictMode 이중 마운트 포함) 시 재사용하면 터진다. */
export type LayerBuilder = (input: BuildLayersInput) => Layer[];

export function createLayerBuilder(): LayerBuilder {
  const layerCache = new Map<string, { keys: readonly unknown[]; layer: Layer }>();

  /** 입력 동일 시 이전 인스턴스 재사용 — deck이 같은 참조면 diff 자체를 스킵 */
  const memoLayer = (id: string, keys: readonly unknown[], make: () => Layer): Layer => {
    const prev = layerCache.get(id);
    if (
      prev &&
      prev.keys.length === keys.length &&
      keys.every((k, i) => Object.is(k, prev.keys[i]))
    ) {
      return prev.layer;
    }
    const layer = make();
    layerCache.set(id, { keys, layer });
    return layer;
  };

  /** 펄스 대상 배열 참조 안정화 — 매 프레임 filter로 새 배열을 만들면 data 참조가 바뀌어
   *  attribute가 프레임마다 재계산된다 (PLAN §8.3 병목 ① 회피) */
  let pulseDataCache: {
    quakes: EarthquakeRecord[];
    arrivals: QuakeArrival[];
    data: EarthquakeRecord[];
  } | null = null;

  const pulseDataOf = (quakes: EarthquakeRecord[], arrivals: QuakeArrival[]): EarthquakeRecord[] => {
    if (pulseDataCache && pulseDataCache.quakes === quakes && pulseDataCache.arrivals === arrivals) {
      return pulseDataCache.data;
    }
    const arrivedIds = new Set(arrivals.map((a) => a.id));
    const data = quakes.filter((d) => arrivedIds.has(d.id));
    pulseDataCache = { quakes, arrivals, data };
    return data;
  };

  return function buildLayers(input: BuildLayersInput): Layer[] {
    const layers: Layer[] = [];
    const quakesOn = input.enabled.includes('earthquake');
    const flightsOn = input.enabled.includes('flight');

    if (quakesOn && input.quakes.length > 0) {
      layers.push(
        memoLayer('quakes', [input.quakes, input.selectedId], () =>
          new ScatterplotLayer<EarthquakeRecord>({
            id: 'quakes',
            data: input.quakes,
            pickable: true,
            radiusUnits: 'pixels',
            lineWidthUnits: 'pixels',
            stroked: true,
            getPosition: (d) => d.centroid,
            getRadius: quakeRadiusPx,
            getFillColor: (d) => QUAKE_RANK_RGB[d.severity.rank],
            getLineColor: (d) => (d.id === input.selectedId ? SELECTED_RGB : [0, 0, 0, 0]),
            getLineWidth: 1.5,
            updateTriggers: { getLineColor: input.selectedId },
          }),
        ),
      );

      // 등장 펄스 링 — 최근 도착 지진만. reduced-motion 시 정적 링 (DESIGN §5).
      // 이산 이벤트 보간 금지 — 위치는 고정, radiusScale/opacity uniform만 변조.
      const pulseData = pulseDataOf(input.quakes, input.quakeArrivals);
      if (pulseData.length > 0) {
        const phase = input.reducedMotion ? 0.5 : input.pulsePhase;
        layers.push(
          memoLayer(
            'quake-pulse',
            [pulseData, input.reducedMotion ? 'static' : phase],
            () =>
              new ScatterplotLayer<EarthquakeRecord>({
                id: 'quake-pulse',
                data: pulseData,
                pickable: false,
                radiusUnits: 'pixels',
                lineWidthUnits: 'pixels',
                stroked: true,
                filled: false,
                getPosition: (d) => d.centroid,
                getRadius: quakeRadiusPx,
                getLineColor: (d) => QUAKE_RANK_RGB[d.severity.rank],
                getLineWidth: 1.5,
                // uniform만 변조 — 매 프레임 attribute 재계산 없음
                radiusScale: input.reducedMotion ? 1.8 : 1 + 2.2 * phase,
                opacity: input.reducedMotion ? 0.35 : Math.max(0, 1 - phase),
              }),
          ),
        );
      }
    }

    if (flightsOn) {
      // 지역 단위 레이어 — 지역별 3분 주기라 60s 폴에서 대부분 지역은 무변경.
      // records 참조가 안정(latest-source Med4)하므로 변한 지역의 레이어만 재생성된다.
      // attribute 자체의 사전계산(binary attributes, Float32Array)은 Phase 1 과제 (PLAN §8.3).
      for (const region of input.flightRegions) {
        if (region.records.length === 0) continue;
        layers.push(
          memoLayer(
            `flights-${region.key}`,
            [region.records, input.selectedId, input.zoomBucket],
            () =>
              new SimpleMeshLayer<FlightRecord>({
                id: `flights-${region.key}`,
                data: region.records,
                mesh: FLIGHT_MESH,
                pickable: true,
                getPosition: (d) => d.centroid,
                // track = 북 기준 시계방향 / deck yaw = 반시계 — 부호 반전
                getOrientation: (d) => [0, -(d.payload.trackDeg ?? 0), 0],
                getColor: (d) => (d.id === input.selectedId ? SELECTED_RGB : FLIGHT_RGB),
                sizeScale: flightSizeMeters(input.zoomBucket),
                updateTriggers: { getColor: input.selectedId },
              }),
          ),
        );
      }
    }

    // 리스트에서 빠진 레이어는 deck이 finalize한다 — 그 인스턴스를 재사용하면
    // _initialize가 이중 호출돼 assert (토글 off→on 재현). 캐시에서 함께 제거.
    const aliveIds = new Set(layers.map((l) => l.id));
    for (const id of layerCache.keys()) {
      if (!aliveIds.has(id)) layerCache.delete(id);
    }

    return layers;
  };
}

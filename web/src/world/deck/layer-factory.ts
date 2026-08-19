import { GeoJsonLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import type { Layer } from '@deck.gl/core';
import type {
  EarthquakeRecord,
  FlightRecord,
  LayerId,
  NewsRecord,
  Position,
  SeverityRank,
  WeatherAlertRecord,
} from '@lwp/shared';
import type { QuakeArrival } from '../../data/live-store';
import type { FlightRegionSlice } from '../../data/latest-source';
import { FLIGHT_MESH } from './flight-mesh';
import { hatchPolygon } from './hatch';
import { SQUARE_FRAME_MESH, SQUARE_MESH } from './square-mesh';

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
/** DESIGN §2.2 alert rank 0~4 확정 hex → RGB */
const ALERT_RANK_RGB: Record<SeverityRank, [number, number, number]> = {
  0: [255, 61, 61], // #ff3d3d
  1: [255, 84, 84], // #ff5454
  2: [255, 107, 107], // #ff6b6b
  3: [255, 130, 130], // #ff8282
  4: [255, 153, 153], // #ff9999
};
/** DESIGN §2.2 news rank 0~4 확정 hex → RGB */
const NEWS_RANK_RGB: Record<SeverityRank, [number, number, number]> = {
  0: [181, 127, 0], // #b57f00
  1: [240, 168, 0], // #f0a800
  2: [255, 192, 45], // #ffc02d
  3: [255, 210, 104], // #ffd268
  4: [255, 227, 163], // #ffe3a3
};
/** 크기 변조 병행 — 밝기 단독 의존 금지 (DESIGN §2.2) */
const RANK_SIZE_MUL: Record<SeverityRank, number> = { 0: 1.0, 1: 1.15, 2: 1.3, 3: 1.45, 4: 1.6 };
/** DESIGN --layer-flight #4cc9f0 */
const FLIGHT_RGB: [number, number, number] = [76, 201, 240];
const SELECTED_RGB: [number, number, number, number] = [255, 255, 255, 255];
/** 경보 폴리곤 채움 알파 (낮게 — 아래 지도가 비쳐야 함) */
const ALERT_FILL_ALPHA = 45;
/** 빗금 알파 — 채움보다 진하게(형태를 읽히게), 마커보다 연하게 */
const ALERT_HATCH_ALPHA = 110;

const quakeRadiusPx = (d: EarthquakeRecord): number => {
  const mag = d.payload.magnitude ?? 1;
  return Math.max(3, 3 + mag * 1.6) * RANK_SIZE_MUL[d.severity.rank];
};

/** 줌별 항공기 메시 크기(m) — z1.5 전역 뷰에서도 실루엣, z8+에선 과대 방지 */
const flightSizeMeters = (zoom: number): number =>
  Math.max(1_500, Math.min(90_000, 140_000 / 2 ** zoom));

/** 줌별 사각 마커 기준 크기(m) — 항공기보다 약간 작게 (마커 밀도 419+196).
 *  `120_000 / 2**zoom`은 화면상 약 1.5px로 **줌 무관 상수 크기**를 만든다 (m/px가
 *  78_271/2**zoom이므로). 채운 사각(뉴스)은 1.5px면 점으로 읽히고 정중앙 픽킹도 잡힌다. */
const squareSizeMeters = (zoom: number): number =>
  Math.max(1_200, Math.min(80_000, 120_000 / 2 ** zoom));

/** 기상 경보 Point 마커 배율 — **속이 빈 테두리**라 채운 사각과 같은 크기면
 *  테두리 두께가 0.2 × 1.5px ≈ 0.3px로 서브픽셀이 되어 렌더도 픽킹도 안 됐다
 *  (2026-08-19 verify:layers 실측: z8에서 pickObjects 0건, 정중앙은 구멍).
 *  4배(≈6px, 테두리 ≈1.2px)로 올려 테두리가 실제 픽셀을 갖게 한다 —
 *  DESIGN §2.1의 shape 구분(테두리 vs 채움)을 유지하는 최소 크기다. */
const ALERT_POINT_SIZE_MUL = 4;

/** 뉴스 크기 = articleCount 로그 스케일 (1→0.75, 10→1.25, 100→1.75 — 실측 1~149) */
const newsScaleOf = (d: NewsRecord): [number, number, number] => {
  const s = 0.75 + 0.5 * Math.log10(Math.max(1, d.payload.articleCount));
  return [s, s, 1];
};

const alertPointScaleOf = (d: WeatherAlertRecord): [number, number, number] => {
  const s = RANK_SIZE_MUL[d.severity.rank];
  return [s, s, 1];
};

/** GeoJsonLayer 픽킹 계약 — attach가 info.object.id를 읽으므로 Feature 루트에 id 부착 */
interface AlertFeature {
  type: 'Feature';
  id: string;
  geometry: WeatherAlertRecord['geometry'];
  properties: { rank: SeverityRank };
}

/** 빗금 한 줄 — PathLayer data (rank는 색, 폴리곤 id는 픽킹 제외용으로 보관하지 않는다:
 *  빗금은 장식이라 pickable=false다) */
interface HatchLine {
  path: Position[];
  rank: SeverityRank;
}

/** 기상 경보 지오메트리 3분할 — 폴리곤(면)·트랙(LineString)·점 폴백 (DESIGN §2.1)
 *  + 폴리곤에서 파생한 빗금선 (재리뷰 Low1) */
interface WeatherSplit {
  polygons: AlertFeature[];
  hatch: HatchLine[];
  tracks: WeatherAlertRecord[];
  points: WeatherAlertRecord[];
}

function splitWeather(records: WeatherAlertRecord[]): WeatherSplit {
  const polygons: AlertFeature[] = [];
  const hatch: HatchLine[] = [];
  const tracks: WeatherAlertRecord[] = [];
  const points: WeatherAlertRecord[] = [];
  for (const r of records) {
    if (r.geometry.type === 'Polygon' || r.geometry.type === 'MultiPolygon') {
      polygons.push({
        type: 'Feature',
        id: r.id,
        geometry: r.geometry,
        properties: { rank: r.severity.rank },
      });
      const ringSets: Position[][][] =
        r.geometry.type === 'Polygon' ? [r.geometry.coordinates] : r.geometry.coordinates;
      for (const rings of ringSets) {
        for (const path of hatchPolygon(rings)) hatch.push({ path, rank: r.severity.rank });
      }
    } else if (r.geometry.type === 'LineString') {
      tracks.push(r);
    } else {
      points.push(r);
    }
  }
  return { polygons, hatch, tracks, points };
}

export interface BuildLayersInput {
  quakes: EarthquakeRecord[];
  /** 지역 단위 참조 안정 슬라이스 (리뷰 Med4) — 변한 지역의 레이어만 재생성 */
  flightRegions: readonly FlightRegionSlice[];
  /** 60분 사이클 데이터 — latest-source가 asOf 불변 시 배열 참조를 유지 (memo 히트) */
  alerts: WeatherAlertRecord[];
  news: NewsRecord[];
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

  /** 지오메트리 3분할 캐시 — records 참조가 같으면(사이클 무변경) 재분할 금지 */
  let weatherSplitCache: { records: WeatherAlertRecord[]; split: WeatherSplit } | null = null;
  const weatherSplitOf = (records: WeatherAlertRecord[]): WeatherSplit => {
    if (weatherSplitCache && weatherSplitCache.records === records) return weatherSplitCache.split;
    const split = splitWeather(records);
    weatherSplitCache = { records, split };
    return split;
  };

  return function buildLayers(input: BuildLayersInput): Layer[] {
    const layers: Layer[] = [];
    const quakesOn = input.enabled.includes('earthquake');
    const flightsOn = input.enabled.includes('flight');
    const weatherOn = input.enabled.includes('weather');
    const newsOn = input.enabled.includes('news');

    // ── 기상 경보 — 면(폴리곤)이 마커 아래 깔리도록 최하단 배치 (DESIGN §2.1) ──
    if (weatherOn && input.alerts.length > 0) {
      const { polygons, hatch, tracks, points } = weatherSplitOf(input.alerts);

      if (polygons.length > 0) {
        layers.push(
          memoLayer('alert-areas', [polygons, input.selectedId], () =>
            new GeoJsonLayer<AlertFeature['properties']>({
              id: 'alert-areas',
              // shared Geometry는 라벨드 튜플 Position이라 GeoJSON.Position(number[])과
              // 명목상 불일치 — 런타임 형상은 동일 (GeoJSON 순서 [lon, lat] 계약)
              data: polygons as unknown as GeoJSON.Feature[],
              pickable: true,
              stroked: true,
              filled: true,
              lineWidthUnits: 'pixels',
              getFillColor: (f) => [...ALERT_RANK_RGB[f.properties.rank], ALERT_FILL_ALPHA],
              getLineColor: (f) => {
                const feature = f as unknown as AlertFeature;
                return feature.id === input.selectedId
                  ? SELECTED_RGB
                  : [...ALERT_RANK_RGB[f.properties.rank], 220];
              },
              getLineWidth: 1.5,
              updateTriggers: { getLineColor: input.selectedId },
            }),
          ),
        );
      }

      // 빗금 — 폴리곤 면 위, 마커 아래. 장식이라 pickable=false (픽킹은 폴리곤 본체가 받는다).
      // billboard: globe에서 선 리본이 지표를 벗어나 보이는 문제의 회피책 (아래 트랙 주석 참조).
      if (hatch.length > 0) {
        layers.push(
          memoLayer('alert-hatch', [hatch], () =>
            new PathLayer<HatchLine>({
              id: 'alert-hatch',
              data: hatch,
              pickable: false,
              billboard: true,
              widthUnits: 'pixels',
              getPath: (d) => d.path as unknown as number[],
              getColor: (d) => [...ALERT_RANK_RGB[d.rank], ALERT_HATCH_ALPHA],
              getWidth: 1,
            }),
          ),
        );
      }

      // TC 트랙 — 위치 연속(태풍 중심 경로)만 선 표현 (이산 이벤트 보간 금지와 무관).
      //
      // 스파이크 이관 7 결론 (2026-08-19): globe 위 PathLayer의 기본 압출은 **지표면
      // 접평면**에서 일어나므로, 낮은 고도각에서 리본이 지구 실루엣 밖으로 떠 보인다.
      // `billboard: true`로 두면 압출이 스크린 공간(카메라를 향함)에서 일어나 선이 항상
      // 지표에 붙어 보인다. GreatCircleLayer는 @deck.gl/geo-layers 추가 의존이고
      // 좌표 세분화(subdivision)는 원인이 chord sag가 아니라 압출면이므로 효과가 없다
      // — 그래서 billboard가 답이다 (verify:layers의 저pitch 스크린샷으로 확인).
      if (tracks.length > 0) {
        layers.push(
          memoLayer('alert-tracks', [tracks, input.selectedId], () =>
            new PathLayer<WeatherAlertRecord>({
              id: 'alert-tracks',
              data: tracks,
              pickable: true,
              billboard: true,
              widthUnits: 'pixels',
              // PathGeometry 선언은 flat number[]지만 런타임은 [[lon,lat],...] 중첩도 수용
              getPath: (d) =>
                (d.geometry.type === 'LineString'
                  ? d.geometry.coordinates
                  : []) as unknown as number[],
              getColor: (d) =>
                d.id === input.selectedId ? SELECTED_RGB : ALERT_RANK_RGB[d.severity.rank],
              getWidth: 2.5,
              updateTriggers: { getColor: input.selectedId },
            }),
          ),
        );
      }

      // Point 지오메트리 폴백 — 사각 테두리 마커 (원+빗금 불가 — DESIGN §2.1 shape 계약)
      if (points.length > 0) {
        layers.push(
          memoLayer('alert-points', [points, input.selectedId, input.zoomBucket], () =>
            new SimpleMeshLayer<WeatherAlertRecord>({
              id: 'alert-points',
              data: points,
              mesh: SQUARE_FRAME_MESH,
              pickable: true,
              getPosition: (d) => d.centroid,
              getColor: (d) =>
                d.id === input.selectedId ? SELECTED_RGB : ALERT_RANK_RGB[d.severity.rank],
              getScale: alertPointScaleOf,
              sizeScale: squareSizeMeters(input.zoomBucket) * ALERT_POINT_SIZE_MUL,
              updateTriggers: { getColor: input.selectedId },
            }),
          ),
        );
      }
    }

    // ── 뉴스 — 채운 사각, 크기 = articleCount 로그 스케일 (집계 셀 중심 좌표) ──
    if (newsOn && input.news.length > 0) {
      layers.push(
        memoLayer('news', [input.news, input.selectedId, input.zoomBucket], () =>
          new SimpleMeshLayer<NewsRecord>({
            id: 'news',
            data: input.news,
            mesh: SQUARE_MESH,
            pickable: true,
            getPosition: (d) => d.centroid,
            getColor: (d) =>
              d.id === input.selectedId ? SELECTED_RGB : NEWS_RANK_RGB[d.severity.rank],
            getScale: newsScaleOf,
            sizeScale: squareSizeMeters(input.zoomBucket),
            updateTriggers: { getColor: input.selectedId },
          }),
        ),
      );
    }

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
      // 지역 단위 레이어 — 지역별 10분 주기(collector schedule.ts)라 60s 폴에서 대부분 지역은 무변경.
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

/** TC 트랙 렌더 후보 비교 하네스 (스파이크 이관 7 — globe 위 선이 지구 밖으로 뜨는 문제).
 *
 *  같은 실데이터(GDACS 활성 TC 트랙·콘, fixtures/tc-live.json)를 후보별로 렌더해
 *  같은 pose에서 스크린샷·픽셀 계측한다. 엔진은 확정안 그대로 — maplibre 5.24 globe +
 *  MapboxOverlay overlaid (interleaved 금지, IconLayer 금지).
 *
 *  URL 파라미터:
 *    cand = path | billboard | gc | subdiv | cull | cull2 | maplibre | none | probe   (선 후보)
 *    poly = none | plain | subdiv                 (콘 폴리곤 후보)
 *    engine = deck | native                       (콘 채움·외곽·빗금을 그리는 엔진)
 *    measure = none | fill | hatch                (계측 격리 모드 — 해당 요소만 불투명 마젠타)
 *    style = flat | basemap                       (flat = 배경색만 → 픽셀 계측 결정론)
 *    pose = globe | zoom | lowpitch | back | cglobe | czoom | clowpitch | cback | chorizon | cedge
 *    at=lon,lat & z= & p= & b=                  (pose 대신 임의 카메라 — 탐색용)
 *    hide = 1                                     (선/폴리곤 없이 지구 디스크만 → 마스크)
 *
 *  빗금은 **프로덕션 구현**(web/src/world/deck/hatch.ts)을 그대로 import해 계측한다 —
 *  하네스가 다른 알고리즘을 재구현하면 증거가 프로덕션을 대변하지 못한다 (사후 리뷰 Med2).
 */
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, GeoJsonLayer, ArcLayer, ScatterplotLayer } from '@deck.gl/layers';
import { GreatCircleLayer } from '@deck.gl/geo-layers';
import tcLive from '../fixtures/tc-live.json';
import { hatchPolygon } from '../../web/src/world/deck/hatch';
import { subdivideGreatCircle, subdivideRing, type LonLat } from './tc-geo';

type TrackFixture = {
  geometry: { type: string; coordinates: number[][] | number[][][] };
  event: string;
  kind: string;
};

const FIXTURES = tcLive as unknown as Record<string, TrackFixture>;

/** 선 후보 공통 색 — 픽셀 계측용 순수 마젠타 (베이스맵·경보 색과 절대 안 겹침) */
const LINE_RGBA: [number, number, number, number] = [255, 0, 255, 255];
const CONE_FILL: [number, number, number, number] = [255, 0, 255, 60];
const CONE_LINE: [number, number, number, number] = [255, 0, 255, 255];

const POSES = {
  globe: { center: [-160, 25] as [number, number], zoom: 1.5, pitch: 0, bearing: 0 },
  zoom: { center: [-160, 25] as [number, number], zoom: 4, pitch: 0, bearing: 0 },
  lowpitch: { center: [-160, 25] as [number, number], zoom: 3.4, pitch: 60, bearing: 0 },
  back: { center: [20, 25] as [number, number], zoom: 1.5, pitch: 0, bearing: 0 },
  // 콘(SAUDEL-26, lon 132…153) 계측용 — 트랙 pose에서는 콘이 화면 밖이라 픽셀이 0이 된다
  cglobe: { center: [142, 22] as [number, number], zoom: 1.5, pitch: 0, bearing: 0 },
  czoom: { center: [142, 22] as [number, number], zoom: 4, pitch: 0, bearing: 0 },
  clowpitch: { center: [142, 22] as [number, number], zoom: 3.4, pitch: 60, bearing: 0 },
  cback: { center: [-38, 22] as [number, number], zoom: 1.5, pitch: 0, bearing: 0 },
  // 콘이 화면 중앙이 아니라 **수평선 쪽**에 놓이는 pose — 선 후보의 lowpitch와 같은 조건
  chorizon: { center: [160, 5] as [number, number], zoom: 3.4, pitch: 60, bearing: 0 },
  cedge: { center: [110, 22] as [number, number], zoom: 2.5, pitch: 60, bearing: 0 },
} as const;

const FLAT_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'globe-bg', type: 'background', paint: { 'background-color': '#12233a' } }],
};
const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';

interface TrackDatum {
  id: string;
  event: string;
  path: LonLat[];
}

function tracks(subdivide: boolean): TrackDatum[] {
  return Object.entries(FIXTURES)
    .filter(([, v]) => v.geometry.type === 'LineString')
    .map(([id, v]) => {
      const raw = v.geometry.coordinates as unknown as LonLat[];
      return { id, event: v.event, path: subdivide ? subdivideGreatCircle(raw, 0.5) : raw };
    });
}

function coneRings(subdivide: boolean): { id: string; ring: LonLat[] }[] {
  return Object.entries(FIXTURES)
    .filter(([, v]) => v.geometry.type === 'Polygon')
    .map(([id, v]) => {
      const ring = (v.geometry.coordinates as unknown as LonLat[][])[0];
      return { id, ring: subdivide ? subdivideRing(ring, 0.5) : ring };
    });
}

/** 지구 뒤쪽(수평선 너머) 정점 제거 — 연속 구간만 남겨 여러 path로 쪼갠다.
 *  maplibre transform.isLocationOccluded()가 globe 구면 가림 판정을 그대로 준다. */
function cullOccluded(map: maplibregl.Map, path: LonLat[]): LonLat[][] {
  const tr = (map as unknown as { transform: { isLocationOccluded(l: maplibregl.LngLat): boolean } })
    .transform;
  const out: LonLat[][] = [];
  let run: LonLat[] = [];
  for (const p of path) {
    const occluded = tr.isLocationOccluded(new maplibregl.LngLat(p[0], p[1]));
    if (occluded) {
      if (run.length > 1) out.push(run);
      run = [];
    } else {
      run.push(p);
    }
  }
  if (run.length > 1) out.push(run);
  return out;
}

/** 수평선 너머 판정 — public API만 사용 (transform 내부 접근 없음).
 *  globe에서 수평선 너머 점은 project()가 화면 어딘가로 보내지만, 그 화면점을
 *  unproject()하면 **앞면의 다른 좌표**가 나온다 (구-광선 교점이 앞면에서 잡히므로).
 *  왕복 오차 > TOL 이면 "이 화면점은 그 좌표가 아니다" = 지구 뒤(또는 수평선 너머). */
const ROUNDTRIP_TOL_DEG = 0.25;

function isBeyondHorizon(map: maplibregl.Map, [lon, lat]: LonLat): boolean {
  const back = map.unproject(map.project([lon, lat]));
  const dLon = Math.abs(((back.lng - lon + 540) % 360) - 180);
  const dLat = Math.abs(back.lat - lat);
  return dLat > ROUNDTRIP_TOL_DEG || dLon > ROUNDTRIP_TOL_DEG;
}

/** 마지막 가시점 ↔ 첫 비가시점 사이의 수평선 교차점을 이분법으로 찾아 끝점을 붙인다 */
function horizonCrossing(map: maplibregl.Map, visible: LonLat, hidden: LonLat): LonLat {
  let a = visible;
  let b = hidden;
  for (let i = 0; i < 12; i += 1) {
    const mid: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (isBeyondHorizon(map, mid)) b = mid;
    else a = mid;
  }
  return a;
}

/** 수평선 기준 클리핑 — 가시 구간만 남기고 경계는 교차점으로 마감 */
function clipToHorizon(map: maplibregl.Map, path: LonLat[]): LonLat[][] {
  const out: LonLat[][] = [];
  let run: LonLat[] = [];
  for (let i = 0; i < path.length; i += 1) {
    const p = path[i];
    if (isBeyondHorizon(map, p)) {
      if (run.length > 0) {
        run.push(horizonCrossing(map, run[run.length - 1], p));
        if (run.length > 1) out.push(run);
        run = [];
      }
      continue;
    }
    if (run.length === 0 && i > 0) run.push(horizonCrossing(map, p, path[i - 1]));
    run.push(p);
  }
  if (run.length > 1) out.push(run);
  return out;
}

/** 투영 오차 계측용 — 트랙 정점을 deck 점으로 찍는다 (nearest pick으로 위치 역산) */
function probeLayers() {
  const verts = tracks(false).flatMap((t) => t.path.map((p) => ({ lon: p[0], lat: p[1] })));
  return [
    new ScatterplotLayer<{ lon: number; lat: number }>({
      id: 'tc-line',
      data: verts,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 3,
      radiusUnits: 'pixels',
      getFillColor: LINE_RGBA,
      pickable: true,
    }),
  ];
}

function lineLayers(cand: string, map?: maplibregl.Map) {
  if (cand === 'none') return []; // 콘만 계측/표시하는 모드
  if (cand === 'probe') return probeLayers();
  if (cand === 'cull2' && map) {
    const data = tracks(false).flatMap((t) =>
      clipToHorizon(map, t.path).map((seg, i) => ({ id: `${t.id}#${i}`, event: t.event, path: seg })),
    );
    return [
      new PathLayer<{ id: string; event: string; path: LonLat[] }>({
        id: 'tc-line',
        data,
        getPath: (d) => d.path,
        getColor: LINE_RGBA,
        getWidth: 3,
        widthUnits: 'pixels',
        billboard: true,
        capRounded: true,
        jointRounded: true,
        pickable: true,
      }),
    ];
  }
  if (cand === 'cull' && map) {
    const data = tracks(false).flatMap((t) =>
      cullOccluded(map, t.path).map((seg, i) => ({ id: `${t.id}#${i}`, event: t.event, path: seg })),
    );
    return [
      new PathLayer<{ id: string; event: string; path: LonLat[] }>({
        id: 'tc-line',
        data,
        getPath: (d) => d.path,
        getColor: LINE_RGBA,
        getWidth: 3,
        widthUnits: 'pixels',
        billboard: true,
        capRounded: true,
        jointRounded: true,
        pickable: true,
      }),
    ];
  }
  if (cand === 'maplibre') return [];
  if (cand === 'gc' || cand === 'gc0' || cand === 'arc') {
    // GreatCircleLayer는 source/target 쌍만 받는다 → 트랙을 세그먼트로 분해
    const segs = tracks(false).flatMap((t) =>
      t.path.slice(1).map((to, i) => ({ id: `${t.id}#${i}`, from: t.path[i], to })),
    );
    const Ctor = cand === 'arc' ? ArcLayer : GreatCircleLayer;
    return [
      new Ctor<(typeof segs)[number]>({
        id: 'tc-line',
        data: segs,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getSourceColor: LINE_RGBA,
        getTargetColor: LINE_RGBA,
        getWidth: 3,
        widthUnits: 'pixels',
        getHeight: cand === 'gc0' ? 0 : 1,
        pickable: true,
      }),
    ];
  }
  const subdivide = cand === 'subdiv';
  const billboard = cand === 'billboard';
  return [
    new PathLayer<TrackDatum>({
      id: 'tc-line',
      data: tracks(subdivide),
      getPath: (d) => d.path,
      getColor: LINE_RGBA,
      getWidth: 3,
      widthUnits: 'pixels',
      billboard,
      capRounded: true,
      jointRounded: true,
      pickable: true,
    }),
  ];
}

/** 콘 링별 빗금 세그먼트 — 프로덕션 hatchPolygon 그대로 (계측 대상 = 실제 코드) */
function hatchSegments(subdivide: boolean): { id: string; path: LonLat[] }[] {
  return coneRings(subdivide).flatMap((c) =>
    hatchPolygon([c.ring]).map((seg, i) => ({ id: `${c.id}#h${i}`, path: seg as LonLat[] })),
  );
}

function coneFeatures(subdivide: boolean) {
  return coneRings(subdivide).map((c) => ({
    type: 'Feature' as const,
    properties: { id: c.id },
    geometry: { type: 'Polygon' as const, coordinates: [c.ring] },
  }));
}

type MeasureMode = 'none' | 'fill' | 'hatch';

/** deck 엔진 콘 레이어 — measure 모드면 계측 대상만 불투명 마젠타로 격리해 그린다 */
function polyLayers(poly: string, measure: MeasureMode) {
  if (poly === 'none') return [];
  const subdivide = poly === 'subdiv';
  if (measure === 'hatch') {
    return [
      new PathLayer<{ id: string; path: LonLat[] }>({
        id: 'tc-hatch',
        data: hatchSegments(subdivide),
        getPath: (d) => d.path,
        getColor: LINE_RGBA,
        getWidth: 2,
        widthUnits: 'pixels',
        pickable: false,
      }),
    ];
  }
  const cone = new GeoJsonLayer({
    id: 'tc-cone',
    data: { type: 'FeatureCollection', features: coneFeatures(subdivide) },
    filled: true,
    stroked: measure === 'none',
    // fill 계측은 알파 60으로는 배경과 구분이 안 된다 → 불투명 마젠타로 격리
    getFillColor: measure === 'fill' ? CONE_LINE : CONE_FILL,
    getLineColor: CONE_LINE,
    getLineWidth: 2,
    lineWidthUnits: 'pixels',
    pickable: true,
  });
  if (measure === 'fill') return [cone];
  return [
    cone,
    new PathLayer<{ id: string; path: LonLat[] }>({
      id: 'tc-hatch',
      data: hatchSegments(subdivide),
      getPath: (d) => d.path,
      getColor: LINE_RGBA,
      getWidth: 1,
      widthUnits: 'pixels',
      pickable: false,
    }),
  ];
}

/** maplibre 네이티브 콘 — 채움·외곽·빗금 (프로덕션 web/src/world/map/tc-geometry.ts와 같은 구성) */
function addNativeCone(map: maplibregl.Map, poly: string, measure: MeasureMode): void {
  if (poly === 'none') return;
  const subdivide = poly === 'subdiv';
  map.addSource('tc-cone-src', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: coneFeatures(subdivide) },
  });
  map.addSource('tc-hatch-src', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: hatchSegments(subdivide).map((h) => ({
        type: 'Feature' as const,
        properties: { id: h.id },
        geometry: { type: 'LineString' as const, coordinates: h.path },
      })),
    },
  });
  if (measure !== 'hatch') {
    map.addLayer({
      id: 'tc-cone-native',
      type: 'fill',
      source: 'tc-cone-src',
      paint: { 'fill-color': '#ff00ff', 'fill-opacity': measure === 'fill' ? 1 : 0.24 },
    });
  }
  if (measure === 'none') {
    map.addLayer({
      id: 'tc-cone-outline-native',
      type: 'line',
      source: 'tc-cone-src',
      paint: { 'line-color': '#ff00ff', 'line-width': 2 },
    });
  }
  if (measure !== 'fill') {
    map.addLayer({
      id: 'tc-hatch-native',
      type: 'line',
      source: 'tc-hatch-src',
      paint: { 'line-color': '#ff00ff', 'line-width': measure === 'hatch' ? 2 : 1 },
    });
  }
}

function boot(): void {
  const params = new URLSearchParams(location.search);
  const cand = params.get('cand') ?? 'path';
  const poly = params.get('poly') ?? 'none';
  const engine = params.get('engine') ?? 'deck';
  const measure = (params.get('measure') ?? 'none') as MeasureMode;
  const styleId = params.get('style') ?? 'flat';
  const poseId = (params.get('pose') ?? 'globe') as keyof typeof POSES;
  const hide = params.get('hide') === '1';
  const named = POSES[poseId] ?? POSES.globe;
  // 임의 카메라 override (탐색용) — lon,lat / zoom / pitch
  const at = params.get('at');
  const pose = at
    ? {
        center: at.split(',').map(Number).slice(0, 2) as [number, number],
        zoom: Number(params.get('z') ?? named.zoom),
        pitch: Number(params.get('p') ?? named.pitch),
        bearing: Number(params.get('b') ?? named.bearing),
      }
    : named;

  const container = document.getElementById('app');
  if (!container) throw new Error('#app 없음');

  const map = new maplibregl.Map({
    container,
    style: styleId === 'basemap' ? BASEMAP_STYLE : FLAT_STYLE,
    center: pose.center,
    zoom: pose.zoom,
    pitch: pose.pitch,
    bearing: pose.bearing,
    attributionControl: false,
  });
  map.on('style.load', () => map.setProjection({ type: 'globe' }));

  const overlay = new MapboxOverlay({
    interleaved: false,
    layers: [],
  });

  // measure 모드는 계측 대상만 남긴다 — 선이 같이 그려지면 마젠타 픽셀이 섞인다
  const refresh = (): void => {
    if (hide) {
      overlay.setProps({ layers: [] });
      return;
    }
    const deckPoly = engine === 'deck' ? polyLayers(poly, measure) : [];
    const deckLine = measure === 'none' ? lineLayers(cand, map) : [];
    overlay.setProps({ layers: [...deckPoly, ...deckLine] });
  };

  map.on('load', () => {
    map.addControl(overlay as unknown as maplibregl.IControl);
    refresh();
    if (cand === 'cull' || cand === 'cull2') map.on('move', refresh);
    if (engine === 'native' && !hide) addNativeCone(map, poly, measure);
    if (cand === 'maplibre' && !hide && measure === 'none') {
      map.addSource('tc-line-src', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: tracks(false).map((t) => ({
            type: 'Feature',
            properties: { id: t.id, event: t.event },
            geometry: { type: 'LineString', coordinates: t.path },
          })),
        },
      });
      map.addLayer({
        id: 'tc-line-native',
        type: 'line',
        source: 'tc-line-src',
        paint: { 'line-color': '#ff00ff', 'line-width': 3 },
      });
    }
    const trackPts = tracks(cand === 'subdiv').reduce((n, t) => n + t.path.length, 0);
    (window as unknown as Record<string, unknown>).__tc = {
      map,
      overlay,
      ready: true,
      cand,
      poly,
      engine,
      measure,
      pose: poseId,
      trackPts,
      hatchSegs: poly === 'none' ? 0 : hatchSegments(poly === 'subdiv').length,
      vertices: tracks(false).flatMap((t) => t.path),
      roundtrip: (lonLat: LonLat) => {
        const back = map.unproject(map.project(lonLat));
        return [back.lng - lonLat[0], back.lat - lonLat[1]];
      },
      project: (lonLat: LonLat) => {
        const p = map.project(lonLat);
        return [p.x, p.y];
      },
    };
  });
}

boot();

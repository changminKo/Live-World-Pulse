import type maplibregl from 'maplibre-gl'; // 타입 전용 — 런타임 의존 없음 (단위 테스트 가능)
import type { Position, SeverityRank, WeatherAlertRecord } from '@lwp/shared';
import { hatchPolygon } from '../deck/hatch';

/** TC 트랙·예보 콘 = **maplibre 네이티브 레이어** (deck 아님).
 *
 *  근거 (docs/spike/RESULT-tc-track.md, 2026-08-20 실측):
 *  globe에서 deck overlaid의 좌표 투영은 pitch 0에서만 maplibre와 일치한다(≤1px).
 *  pitch를 주면 수평선 부근 정점이 최대 59px 이상 어긋나고, 수평선 너머 정점은
 *  아예 지구 실루엣 밖 허공에 그려진다(deck은 구면 가림·수평선 클리핑을 안 한다).
 *  선/면은 정점이 넓게 퍼져 이 오차가 즉시 형태로 드러나므로 — 저고도각에서 트랙이
 *  허공으로 뻗는 현상(스파이크 이관 7) — 면·선 지오메트리는 maplibre가 그린다.
 *  maplibre 네이티브 line/fill은 구면 셰이더라 어느 pose에서도 지표에 밀착하고
 *  수평선에서 정확히 잘린다 (실측: 지구 밖 픽셀 0). 마커(점)는 deck 유지 —
 *  점은 pitch 0 기준 오차 ≤1px이고 SimpleMeshLayer 회전 등 deck 기능이 필요하다.
 *
 *  hatch는 폴리곤에서 파생한 선이라 같은 이유로 여기서 그린다 (hatch.ts 재사용). */

/** DESIGN §2.2 alert rank 0~4 확정 hex — deck ALERT_RANK_RGB와 같은 값 */
const ALERT_RANK_HEX: Record<SeverityRank, string> = {
  0: '#ff3d3d',
  1: '#ff5454',
  2: '#ff6b6b',
  3: '#ff8282',
  4: '#ff9999',
};
const SELECTED_HEX = '#ffffff';
const FILL_OPACITY = 0.18;
const HATCH_OPACITY = 0.43;

export const TC_SOURCE_ID = 'alert-geometry';
export const TC_LAYER_AREAS = 'alert-areas';
export const TC_LAYER_AREAS_OUTLINE = 'alert-areas-outline';
export const TC_LAYER_HATCH = 'alert-hatch';
export const TC_LAYER_TRACKS = 'alert-tracks';
/** 픽킹 대상 — 빗금은 장식이라 제외 (deck 계약과 동일) */
export const TC_PICKABLE_LAYERS = [TC_LAYER_TRACKS, TC_LAYER_AREAS, TC_LAYER_AREAS_OUTLINE];

type GeometryKind = 'track' | 'cone' | 'hatch';

interface TcFeature {
  type: 'Feature';
  properties: { id: string; rank: SeverityRank; kind: GeometryKind };
  geometry:
    | { type: 'LineString'; coordinates: Position[] }
    | { type: 'Polygon'; coordinates: Position[][] };
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** 경도 언랩 — `ref` 기준 ±180을 넘지 않게 360의 배수만 더한다 */
function unwrapAgainst(lon: number, ref: number): number {
  let out = lon;
  while (out - ref > 180) out -= 360;
  while (out - ref < -180) out += 360;
  return out;
}

/** 날짜변경선 연속화 — 직전 점 기준 ±180을 넘지 않게 경도를 언랩한다.
 *  안 하면 ±180을 넘는 트랙이 지구 반대편을 가로지르는 선으로 그려진다.
 *  `anchor`가 주어지면 첫 점도 그 기준으로 맞춘다 (같은 폴리곤의 구멍 ring 정렬용). */
function unwrapLon(path: readonly Position[], anchor?: number): Position[] {
  const out: Position[] = [];
  for (const point of path) {
    const prev = out[out.length - 1];
    const ref = prev?.[0] ?? anchor;
    if (ref === undefined) {
      out.push([point[0], point[1]]);
      continue;
    }
    out.push([unwrapAgainst(point[0], ref), point[1]]);
  }
  return out;
}

/** 폴리곤 ring 집합 언랩 — 외곽 ring을 먼저 언랩하고, 구멍 ring은 그 첫 점을 앵커로 맞춘다.
 *  구멍을 독립 언랩하면 첫 점이 외곽과 다른 쪽 ±180에 있을 때 360° 밀려 엉뚱한 자리에 뚫린다.
 *  hatch는 이 **언랩된** 링에서 계산해야 한다 — 원본 좌표로 계산하면 날짜변경선 콘의
 *  lonSpan이 340°가 되어 hatch.ts의 스팬 가드에 걸려 빗금이 통째로 사라진다. */
function unwrapRings(rings: readonly Position[][]): Position[][] {
  const out: Position[][] = [];
  let anchor: number | undefined;
  for (const ring of rings) {
    const unwrapped = unwrapLon(ring, anchor);
    out.push(unwrapped);
    anchor ??= unwrapped[0]?.[0];
  }
  return out;
}

/** rank → 색 (선택 시 흰색) 데이터 기반 표현식 */
function colorExpr(selectedId: string | null): maplibregl.ExpressionSpecification {
  const byRank: unknown[] = ['match', ['get', 'rank']];
  for (const rank of [0, 1, 2, 3, 4] as SeverityRank[]) {
    byRank.push(rank, ALERT_RANK_HEX[rank]);
  }
  byRank.push(ALERT_RANK_HEX[0]); // fallback
  if (selectedId === null) return byRank as unknown as maplibregl.ExpressionSpecification;
  return [
    'case',
    ['==', ['get', 'id'], selectedId],
    SELECTED_HEX,
    byRank,
  ] as unknown as maplibregl.ExpressionSpecification;
}

/** 기상 경보 레코드 → TC 지오메트리 피처 (선/면만. Point 마커는 deck 담당) */
export function buildTcFeatures(records: readonly WeatherAlertRecord[]): TcFeature[] {
  const features: TcFeature[] = [];
  for (const r of records) {
    if (r.geometry.type === 'LineString') {
      features.push({
        type: 'Feature',
        properties: { id: r.id, rank: r.severity.rank, kind: 'track' },
        geometry: { type: 'LineString', coordinates: unwrapLon(r.geometry.coordinates) },
      });
      continue;
    }
    if (r.geometry.type !== 'Polygon' && r.geometry.type !== 'MultiPolygon') continue;
    const ringSets: Position[][][] =
      r.geometry.type === 'Polygon' ? [r.geometry.coordinates] : r.geometry.coordinates;
    for (const rawRings of ringSets) {
      // 언랩을 hatch **전에** 적용한다 — 순서가 바뀌면 날짜변경선 콘의 빗금이 사라진다
      const rings = unwrapRings(rawRings);
      features.push({
        type: 'Feature',
        properties: { id: r.id, rank: r.severity.rank, kind: 'cone' },
        geometry: { type: 'Polygon', coordinates: rings },
      });
      for (const path of hatchPolygon(rings)) {
        features.push({
          type: 'Feature',
          properties: { id: r.id, rank: r.severity.rank, kind: 'hatch' },
          geometry: { type: 'LineString', coordinates: path },
        });
      }
    }
  }
  return features;
}

export interface TcGeometryHandle {
  /** 스토어 변경 시 호출 — 레코드 참조가 같으면 setData를 건너뛴다 */
  update(input: {
    alerts: readonly WeatherAlertRecord[];
    enabled: boolean;
    selectedId: string | null;
  }): void;
  /** 화면 좌표에서 트랙/콘 픽킹 — deck 픽이 빈 경우에만 쓴다 */
  pick(point: { x: number; y: number }): string | null;
  dispose(): void;
}

/** map에 TC 지오메트리 소스·레이어를 붙인다 (map 'load' 이후 호출) */
export function attachTcGeometry(map: maplibregl.Map): TcGeometryHandle {
  map.addSource(TC_SOURCE_ID, { type: 'geojson', data: EMPTY });

  map.addLayer({
    id: TC_LAYER_AREAS,
    type: 'fill',
    source: TC_SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'cone'],
    paint: { 'fill-color': colorExpr(null), 'fill-opacity': FILL_OPACITY },
  });
  map.addLayer({
    id: TC_LAYER_AREAS_OUTLINE,
    type: 'line',
    source: TC_SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'cone'],
    paint: { 'line-color': colorExpr(null), 'line-width': 1.5, 'line-opacity': 0.86 },
  });
  map.addLayer({
    id: TC_LAYER_HATCH,
    type: 'line',
    source: TC_SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'hatch'],
    paint: { 'line-color': colorExpr(null), 'line-width': 1, 'line-opacity': HATCH_OPACITY },
  });
  map.addLayer({
    id: TC_LAYER_TRACKS,
    type: 'line',
    source: TC_SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'track'],
    paint: { 'line-color': colorExpr(null), 'line-width': 2.5 },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });

  const ALL_LAYERS = [TC_LAYER_AREAS, TC_LAYER_AREAS_OUTLINE, TC_LAYER_HATCH, TC_LAYER_TRACKS];
  let lastAlerts: readonly WeatherAlertRecord[] | null = null;
  let lastSelectedId: string | null = null;
  let lastEnabled = true;
  let disposed = false;

  return {
    update({ alerts, enabled, selectedId }) {
      if (disposed) return;
      if (enabled !== lastEnabled) {
        for (const id of ALL_LAYERS) {
          map.setLayoutProperty(id, 'visibility', enabled ? 'visible' : 'none');
        }
        lastEnabled = enabled;
      }
      if (alerts !== lastAlerts) {
        const source = map.getSource(TC_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
        source?.setData({
          type: 'FeatureCollection',
          features: buildTcFeatures(alerts) as unknown as GeoJSON.Feature[],
        });
        lastAlerts = alerts;
      }
      if (selectedId !== lastSelectedId) {
        const expr = colorExpr(selectedId);
        map.setPaintProperty(TC_LAYER_AREAS, 'fill-color', expr);
        map.setPaintProperty(TC_LAYER_AREAS_OUTLINE, 'line-color', expr);
        map.setPaintProperty(TC_LAYER_HATCH, 'line-color', expr);
        map.setPaintProperty(TC_LAYER_TRACKS, 'line-color', expr);
        lastSelectedId = selectedId;
      }
    },

    pick({ x, y }) {
      if (disposed || !lastEnabled) return null;
      const PAD = 6; // deck 픽킹 radius와 동일 (선은 가늘어 정확 클릭이 어렵다)
      const hits = map.queryRenderedFeatures(
        [
          [x - PAD, y - PAD],
          [x + PAD, y + PAD],
        ],
        { layers: TC_PICKABLE_LAYERS.filter((id) => map.getLayer(id) !== undefined) },
      );
      const id = hits[0]?.properties?.id;
      return typeof id === 'string' ? id : null;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // map.remove() 이후엔 스타일이 없다 — 존재할 때만 정리
      for (const id of ALL_LAYERS) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(TC_SOURCE_ID)) map.removeSource(TC_SOURCE_ID);
    },
  };
}

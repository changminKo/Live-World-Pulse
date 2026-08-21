import type maplibregl from 'maplibre-gl'; // 타입 전용 — 런타임 의존 없음 (단위 테스트 가능)
import type { Position } from '@lwp/shared';

/** 지구 표면 대비 오버라이드 + 그라티큘 (DESIGN §2.3 대비 계약).
 *
 *  문제 (2026-08-21 실측): OpenFreeMap dark 기본값은 background(육지)가
 *  rgb(12,12,12) — 우주 배경 #0c0c0c와 동일해 지구 원반이 우주에 녹아 사라지고,
 *  water도 rgb(27,27,29)(ΔL 15)라 마커가 허공에 떠 보인다.
 *
 *  해법: 스타일 JSON 포크·자체 호스팅 없이 런타임 paint 오버라이드로 표면을
 *  luma 34~40으로 올린다 (우주 #0c0c0c luma 12 대비 ΔL ≥ 22 — 계약 수치와
 *  측정법은 DESIGN §2.3, 자동 검증은 web/scripts/verify-contrast.mjs).
 *  기본 스타일과 달리 육지 > 해양으로 두 표면의 상대 단차도 확보한다. */

/** 표면 색 (luma = Rec.709 0.2126R+0.7152G+0.0722B, 0-255) */
export const SURFACE_COLORS = {
  /** 육지 — background 레이어. luma 39.7 */
  land: '#242830',
  /** 해양 — water fill·waterway line. luma 34.7 (육지보다 약간 어둡게) */
  ocean: '#1f232b',
  /** 빙붕·빙하 — 현실 순서대로 육지보다 밝게. luma 46.8 */
  ice: '#2b2f38',
} as const;

/** 그라티큘 — 표면(luma 35~40)보다 살짝 밝고 마커(rank 색)보다 훨씬 어둡게.
 *  #9e9e9e(--text-lo) α0.09 → 해양 위 실효 luma ≈ +11. 데이터가 주인공. */
const GRATICULE_COLOR = '#9e9e9e';
const GRATICULE_OPACITY_MINOR = 0.09;
const GRATICULE_OPACITY_MAJOR = 0.16; // 적도·본초자오선만 살짝 진하게
const GRATICULE_WIDTH_MINOR = 0.6;
const GRATICULE_WIDTH_MAJOR = 0.9;

const GRATICULE_STEP_DEG = 30;
/** 경선은 극 수렴 잡음을 피해 ±80°에서 끊는다 */
const MERIDIAN_LAT_MAX = 80;
/** 위선은 ±60°까지 — 고위도 위선은 저줌에서 원반 가장자리 잡음만 만든다 */
const PARALLEL_LAT_MAX = 60;
/** globe 셰이더가 정점 사이를 평면 보간하므로 5° 간격 정점으로 구면 밀착 */
const VERTEX_STEP_DEG = 5;

export const GRATICULE_SOURCE_ID = 'graticule';
export const GRATICULE_LAYER_ID = 'graticule-lines';

interface GraticuleFeature {
  type: 'Feature';
  properties: { major: boolean };
  geometry: { type: 'LineString'; coordinates: Position[] };
}

/** 30° 간격 경선·위선 GeoJSON — 순수 함수 (단위 테스트 대상) */
export function buildGraticule(): { type: 'FeatureCollection'; features: GraticuleFeature[] } {
  const features: GraticuleFeature[] = [];
  for (let lon = -180; lon < 180; lon += GRATICULE_STEP_DEG) {
    const coordinates: Position[] = [];
    for (let lat = -MERIDIAN_LAT_MAX; lat <= MERIDIAN_LAT_MAX; lat += VERTEX_STEP_DEG) {
      coordinates.push([lon, lat]);
    }
    features.push({
      type: 'Feature',
      properties: { major: lon === 0 },
      geometry: { type: 'LineString', coordinates },
    });
  }
  for (let lat = -PARALLEL_LAT_MAX; lat <= PARALLEL_LAT_MAX; lat += GRATICULE_STEP_DEG) {
    const coordinates: Position[] = [];
    for (let lon = -180; lon <= 180; lon += VERTEX_STEP_DEG) {
      coordinates.push([lon, lat]);
    }
    features.push({
      type: 'Feature',
      properties: { major: lat === 0 },
      geometry: { type: 'LineString', coordinates },
    });
  }
  return { type: 'FeatureCollection', features };
}

export interface SurfaceOverride {
  property: 'background-color' | 'fill-color' | 'line-color';
  value: string;
}

/** 스타일 레이어 → 오버라이드 규칙 (id 패턴 매칭 — 스타일 포크 없이 런타임 적용).
 *  순수 함수 (단위 테스트 대상). null = 손대지 않는다. */
export function surfaceOverrideFor(layer: { id: string; type: string }): SurfaceOverride | null {
  if (layer.type === 'background') {
    return { property: 'background-color', value: SURFACE_COLORS.land };
  }
  if (layer.type === 'fill' && (layer.id.includes('ice_shelf') || layer.id.includes('glacier'))) {
    return { property: 'fill-color', value: SURFACE_COLORS.ice };
  }
  if (layer.type === 'fill' && layer.id === 'water') {
    return { property: 'fill-color', value: SURFACE_COLORS.ocean };
  }
  if (layer.type === 'line' && layer.id.includes('waterway')) {
    return { property: 'line-color', value: SURFACE_COLORS.ocean };
  }
  return null;
}

/** 표면 밝기 오버라이드 적용 — style.load 이후 호출.
 *  원격 스타일(OpenFreeMap)이 레이어 id를 바꾸면 매칭이 조용히 실패해 ΔL 계약이
 *  깨진다 (리뷰 Low). 그래서 필수 3종(land·water·waterway)이 하나라도 안 잡히면
 *  dev에서 경고한다 — 프로덕션 렌더는 막지 않는다(부분 적용이라도 현행보다 낫다). */
export function applySurfaceContrast(map: maplibregl.Map): void {
  const hit = { land: 0, water: 0, waterway: 0 };
  for (const layer of map.getStyle()?.layers ?? []) {
    const override = surfaceOverrideFor(layer);
    if (!override) continue;
    map.setPaintProperty(layer.id, override.property, override.value);
    if (override.property === 'background-color') hit.land += 1;
    else if (layer.id === 'water') hit.water += 1;
    else hit.waterway += 1;
  }
  if (import.meta.env.DEV) {
    const missing = Object.entries(hit)
      .filter(([, n]) => n === 0)
      .map(([k]) => k);
    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[surface-contrast] 미매칭 레이어: ${missing.join(', ')} — 원격 스타일 변경 의심. ` +
          'verify:contrast로 ΔL 계약 재확인 필요 (DESIGN §2.3)',
      );
    }
  }
}

/** 그라티큘 소스·레이어 추가 — style.load 이후 호출.
 *  삽입 위치: 첫 line/symbol 레이어 앞 = 면(fill) 위·경계선/도로/라벨 아래.
 *  TC 지오메트리·deck 마커는 이후에 붙으므로 항상 그라티큘 위에 온다. */
export function addGraticule(map: maplibregl.Map): void {
  if (map.getSource(GRATICULE_SOURCE_ID)) return;
  map.addSource(GRATICULE_SOURCE_ID, {
    type: 'geojson',
    data: buildGraticule() as unknown as GeoJSON.FeatureCollection,
  });
  const beforeId = (map.getStyle()?.layers ?? []).find(
    (l) => l.type === 'line' || l.type === 'symbol',
  )?.id;
  map.addLayer(
    {
      id: GRATICULE_LAYER_ID,
      type: 'line',
      source: GRATICULE_SOURCE_ID,
      paint: {
        'line-color': GRATICULE_COLOR,
        'line-opacity': [
          'case',
          ['get', 'major'],
          GRATICULE_OPACITY_MAJOR,
          GRATICULE_OPACITY_MINOR,
        ],
        'line-width': ['case', ['get', 'major'], GRATICULE_WIDTH_MAJOR, GRATICULE_WIDTH_MINOR],
      },
    },
    beforeId,
  );
}

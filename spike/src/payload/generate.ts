import { mulberry32 } from './rng';
import type {
  Aircraft,
  CityLabel,
  EventPoint,
  LonLat,
  Payload,
  Rgba,
  Route,
} from '../engines/types';

export const POINT_COUNT = 30_000;
export const AIRCRAFT_COUNT = 2_000;
export const AIRCRAFT_DATELINE_COUNT = 200;
export const ARC_COUNT = 200;
export const ARC_DATELINE_COUNT = 30;
export const SPEED_DEG_PER_TICK = 0.5;

const POINT_COLORS: Rgba[] = [
  [255, 99, 71, 200],
  [255, 196, 0, 200],
  [64, 196, 255, 200],
  [144, 238, 144, 200],
];

/**
 * 센티널 12점 — 픽킹·마커 소실 검사 전용 고정 좌표 (DESIGN §3-2).
 * 0..3 날짜변경선 / 4..5 극지 / 6..11 pose P(center [139.7,35.6], z2) 기준 중앙·림 근처.
 */
export const SENTINELS: { id: string; position: LonLat }[] = [
  // s1 lat 10: DESIGN §3-2 문자는 "lat 0/±40"이나 s0[179.9,0]과 s1[-179.9,0]은
  // 0.4° 간격 — z3 검사 pose에서 8px 원끼리 겹쳐 top을 뺏겨 가짜 오차 7px 발생 (실측).
  // 날짜변경선 양쪽 + 상이 lat 의도를 보존하며 겹침만 해소 (편차는 RESULT.md에 기록).
  { id: 'sentinel-0', position: [179.9, 0] },
  { id: 'sentinel-1', position: [-179.9, 10] },
  { id: 'sentinel-2', position: [179.9, 40] },
  { id: 'sentinel-3', position: [-179.9, -40] },
  { id: 'sentinel-4', position: [100, 75] },
  { id: 'sentinel-5', position: [20, -75] },
  // 림 좌표 근거: z2 globe 수평선은 카메라 유한 거리 탓에 각거리 ~75°에서 잘림 (실측:
  // 원반 반경 315px = asin(315/326) ≈ 75°). DESIGN §4-3의 "~80°"는 수평선 밖이라
  // 물리적으로 렌더 불가 — 원반 안 림 근처(~67-71°)로 확정 (§3-2가 좌표 확정을 구현에 위임).
  { id: 'sentinel-6', position: [139.7, 35.6] }, // pose P 화면 중앙 (대조군)
  { id: 'sentinel-7', position: [70, 5] }, // pose P 기준 각거리 ~70.6° (림 근처)
  { id: 'sentinel-8', position: [-155, 5] }, // 림 근처 반대편 ~67.1°
  { id: 'sentinel-9', position: [120, 10] },
  { id: 'sentinel-10', position: [160, 50] },
  { id: 'sentinel-11', position: [100, 40] },
];

/** 두 좌표 간 대원 각거리 (deg) — 센티널 가시성 판정용 */
export function angularDistanceDeg(a: LonLat, b: LonLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lon1, lat1] = a.map(toRad) as [number, number];
  const [lon2, lat2] = b.map(toRad) as [number, number];
  const cosD =
    Math.sin(lat1) * Math.sin(lat2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (Math.acos(Math.min(1, Math.max(-1, cosD))) * 180) / Math.PI;
}

/**
 * 이벤트 점 30k — 구면 균등 분포, 정적 (틱 무관). 마지막 12개는 센티널.
 * 센티널은 배열 끝 = 가장 나중에 그려짐(top-most) — 일반 점에 가려져
 * pickObject가 다른 점을 반환하는 계측 오염을 막는다 (픽킹 검사 전제).
 */
export function generatePoints(seed: number): EventPoint[] {
  const rand = mulberry32(seed);
  const points: EventPoint[] = [];
  for (let i = 0; i < POINT_COUNT - SENTINELS.length; i++) {
    const u = rand();
    const v = rand();
    const lon = 360 * u - 180;
    const lat = (Math.asin(2 * v - 1) * 180) / Math.PI;
    points.push({
      id: `pt-${i}`,
      position: [lon, lat],
      radiusPx: 3 + rand() * 5,
      color: POINT_COLORS[Math.floor(rand() * POINT_COLORS.length)],
      isSentinel: false,
    });
  }
  for (const s of SENTINELS) {
    points.push({
      id: s.id,
      position: s.position,
      radiusPx: 8,
      color: [255, 255, 255, 255],
      isSentinel: true,
    });
  }
  return points;
}

interface AircraftBase {
  id: string;
  lon0: number;
  lat0: number;
  heading: number;
}

let aircraftBaseCache: { seed: number; bases: AircraftBase[] } | null = null;

/** 항공기 2k 초기 상태 — 200대는 날짜변경선 부근(lon 170~-170) 강제 배치 */
function aircraftBases(seed: number): AircraftBase[] {
  if (aircraftBaseCache && aircraftBaseCache.seed === seed) {
    return aircraftBaseCache.bases;
  }
  const rand = mulberry32(seed ^ 0xa1c);
  const bases: AircraftBase[] = [];
  for (let i = 0; i < AIRCRAFT_COUNT; i++) {
    const isDateline = i < AIRCRAFT_DATELINE_COUNT;
    const rawLon = isDateline ? 170 + rand() * 20 : 360 * rand() - 180;
    const lon0 = wrapLon(rawLon);
    const lat0 = (Math.asin(2 * rand() - 1) * 180) / Math.PI;
    bases.push({ id: `ac-${i}`, lon0, lat0, heading: rand() * 360 });
  }
  aircraftBaseCache = { seed, bases };
  return bases;
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * 틱 t의 항공기 상태 = f(seed, t) 순수 함수 — 매 호출 새 배열 (naive 교체 측정용).
 * ±180 경도 wrap 필수, 극지는 ±85 클램프.
 */
export function aircraftAtTick(seed: number, tick: number): Aircraft[] {
  return aircraftBases(seed).map((b) => {
    const dist = SPEED_DEG_PER_TICK * tick;
    const rad = (b.heading * Math.PI) / 180;
    const lat = Math.min(85, Math.max(-85, b.lat0 + Math.cos(rad) * dist));
    const latRad = (lat * Math.PI) / 180;
    const lon = wrapLon(
      b.lon0 + (Math.sin(rad) * dist) / Math.max(0.2, Math.cos(latRad)),
    );
    return { id: b.id, position: [lon, lat] as LonLat, heading: b.heading };
  });
}

/** 주요 도시 50 — 남반구 15개 이상 (텍스트 반전 검사용). ASCII만 (TextLayer 기본 charset). */
export const CITY_LABELS: CityLabel[] = (
  [
    // 북반구
    ['Tokyo', 139.69, 35.69],
    ['Seoul', 126.98, 37.57],
    ['Beijing', 116.41, 39.9],
    ['Shanghai', 121.47, 31.23],
    ['Hong Kong', 114.17, 22.32],
    ['Taipei', 121.56, 25.03],
    ['Bangkok', 100.5, 13.76],
    ['Hanoi', 105.85, 21.03],
    ['Mumbai', 72.88, 19.08],
    ['Delhi', 77.21, 28.61],
    ['Dubai', 55.27, 25.2],
    ['Tehran', 51.39, 35.69],
    ['Moscow', 37.62, 55.76],
    ['Istanbul', 28.98, 41.01],
    ['Cairo', 31.24, 30.04],
    ['Lagos', 3.39, 6.45],
    ['London', -0.13, 51.51],
    ['Paris', 2.35, 48.86],
    ['Berlin', 13.41, 52.52],
    ['Madrid', -3.7, 40.42],
    ['Rome', 12.5, 41.9],
    ['Stockholm', 18.07, 59.33],
    ['Reykjavik', -21.94, 64.15],
    ['New York', -74.01, 40.71],
    ['Chicago', -87.63, 41.88],
    ['Los Angeles', -118.24, 34.05],
    ['San Francisco', -122.42, 37.77],
    ['Toronto', -79.38, 43.65],
    ['Mexico City', -99.13, 19.43],
    ['Havana', -82.37, 23.11],
    ['Anchorage', -149.9, 61.22],
    ['Honolulu', -157.86, 21.31],
    // 남반구 (18)
    ['Sydney', 151.21, -33.87],
    ['Melbourne', 144.96, -37.81],
    ['Brisbane', 153.03, -27.47],
    ['Perth', 115.86, -31.95],
    ['Darwin', 130.84, -12.46],
    ['Auckland', 174.76, -36.85],
    ['Wellington', 174.78, -41.29],
    ['Suva', 178.44, -18.14],
    ['Port Moresby', 147.18, -9.44],
    ['Jakarta', 106.85, -6.21],
    ['Lima', -77.03, -12.05],
    ['Santiago', -70.65, -33.45],
    ['Buenos Aires', -58.38, -34.6],
    ['Sao Paulo', -46.63, -23.55],
    ['Rio de Janeiro', -43.17, -22.91],
    ['La Paz', -68.12, -16.5],
    ['Cape Town', 18.42, -33.92],
    ['Nairobi', 36.82, -1.29],
  ] as [string, number, number][]
).map(([text, lon, lat], i) => ({
  id: `label-${i}`,
  position: [lon, lat] as LonLat,
  text,
}));

/** 경로 200 — 도시쌍 랜덤, 30개는 날짜변경선 횡단 쌍 강제. 정적. */
export function generateArcs(seed: number): Route[] {
  const rand = mulberry32(seed ^ 0xa2c);
  const cities = CITY_LABELS;
  const east = cities.filter((c) => c.position[0] > 140);
  const west = cities.filter((c) => c.position[0] < -100);
  const arcs: Route[] = [];
  for (let i = 0; i < ARC_COUNT; i++) {
    let a: CityLabel;
    let b: CityLabel;
    if (i < ARC_DATELINE_COUNT) {
      a = east[Math.floor(rand() * east.length)];
      b = west[Math.floor(rand() * west.length)];
    } else {
      a = cities[Math.floor(rand() * cities.length)];
      do {
        b = cities[Math.floor(rand() * cities.length)];
      } while (b.id === a.id);
    }
    arcs.push({ id: `arc-${i}`, source: a.position, target: b.position });
  }
  return arcs;
}

/** 틱 t의 전체 페이로드. 점·경로·라벨은 참조 유지, 항공기만 새 배열 (DESIGN §3-3). */
export function createPayloadSource(seed: number): {
  atTick(t: number): Payload;
} {
  const points = generatePoints(seed);
  const arcs = generateArcs(seed);
  const labels = CITY_LABELS;
  return {
    atTick(t: number): Payload {
      return { points, aircraft: aircraftAtTick(seed, t), arcs, labels };
    },
  };
}

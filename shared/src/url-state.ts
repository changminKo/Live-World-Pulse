/** URL State 직렬화 (PLAN §8.5).
 *  /world?lat=35.6&lng=139.7&z=5&t=1755540000000&l=eq,wx,fl,nw&sel=usgs:abc123&play=1&rate=10&pin=...
 *  - `t` = UTC epoch ms 또는 센티넬 'live' (없으면 공유 링크가 과거로 고정됨)
 *  - 순수 함수만 — replaceState + 디바운스는 프론트 몫 (pushState 금지)
 *  - 계약: 캐노니컬 상태는 parse(serialize(s)) ≡ s 라운드트립 보장.
 *    기본값과 같은 필드는 생략 (짧은 공유 URL), 파싱 불능 값은 필드별 기본값 폴백. */
import type { LayerId } from './types';

export type LayerShortKey = 'eq' | 'wx' | 'fl' | 'nw';

/** 짧은 키 규약 — 배열 순서가 캐노니컬 레이어 순서 (직렬화·정규화 공용) */
const LAYER_ORDER: readonly { layer: LayerId; short: LayerShortKey }[] = [
  { layer: 'earthquake', short: 'eq' },
  { layer: 'weather', short: 'wx' },
  { layer: 'flight', short: 'fl' },
  { layer: 'news', short: 'nw' },
];

export const LAYER_TO_SHORT: Record<LayerId, LayerShortKey> = Object.fromEntries(
  LAYER_ORDER.map(({ layer, short }) => [layer, short]),
) as Record<LayerId, LayerShortKey>;

export const SHORT_TO_LAYER: Record<LayerShortKey, LayerId> = Object.fromEntries(
  LAYER_ORDER.map(({ layer, short }) => [short, layer]),
) as Record<LayerShortKey, LayerId>;

export interface AppState {
  lat: number;
  lng: number;
  z: number;
  /** UTC epoch ms | 'live' — LIVE 추적 모드 센티넬 */
  t: number | 'live';
  /** 켜진 레이어 — 항상 캐노니컬 순서(eq,wx,fl,nw)·중복 없음 */
  l: LayerId[];
  /** 선택 레코드 id (`${source}:${sourceId}`) */
  sel: string | null;
  play: boolean;
  /** 재생 배속 (play와 독립 보존 — 일시정지 후 재개 시 배속 유지) */
  rate: number;
  /** 케이스 스터디 퍼머링크 (PLAN §8.6 pin/{pinId}) */
  pin: string | null;
}

export const DEFAULT_APP_STATE: AppState = {
  lat: 20,
  lng: 0,
  z: 1.8,
  t: 'live',
  l: LAYER_ORDER.map(({ layer }) => layer),
  sel: null,
  play: false,
  rate: 1,
  pin: null,
};

/** 캐노니컬 순서 정렬 + 중복 제거 — 라운드트립 동일성의 전제 */
export function canonicalLayers(layers: readonly LayerId[]): LayerId[] {
  const enabled = new Set(layers);
  return LAYER_ORDER.filter(({ layer }) => enabled.has(layer)).map(({ layer }) => layer);
}

const sameLayers = (a: readonly LayerId[], b: readonly LayerId[]): boolean =>
  a.length === b.length && a.every((layer, i) => layer === b[i]);

export function serializeAppState(
  state: AppState,
  defaults: AppState = DEFAULT_APP_STATE,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.lat !== defaults.lat) params.set('lat', String(state.lat));
  if (state.lng !== defaults.lng) params.set('lng', String(state.lng));
  if (state.z !== defaults.z) params.set('z', String(state.z));
  if (state.t !== defaults.t) params.set('t', state.t === 'live' ? 'live' : String(state.t));
  const layers = canonicalLayers(state.l);
  if (!sameLayers(layers, defaults.l)) params.set('l', layers.map((k) => LAYER_TO_SHORT[k]).join(','));
  if (state.sel !== defaults.sel && state.sel !== null) params.set('sel', state.sel);
  if (state.play !== defaults.play) params.set('play', state.play ? '1' : '0');
  if (state.rate !== defaults.rate) params.set('rate', String(state.rate));
  if (state.pin !== defaults.pin && state.pin !== null) params.set('pin', state.pin);
  return params;
}

const finiteOr = (raw: string | null, fallback: number): number => {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

function parseT(raw: string | null, fallback: number | 'live'): number | 'live' {
  if (raw === null) return fallback;
  if (raw === 'live') return 'live';
  const n = Number(raw);
  // epoch ms — 음수/소수/비유한 거부 (직렬화가 만들 수 없는 값)
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function parseLayers(raw: string | null, fallback: readonly LayerId[]): LayerId[] {
  if (raw === null) return [...fallback];
  const shorts = new Set(raw.split(','));
  // 미지의 키는 무시 (前버전 URL 관용) — 'l='(빈 문자열) = 전 레이어 꺼짐
  return LAYER_ORDER.filter(({ short }) => shorts.has(short)).map(({ layer }) => layer);
}

export function parseAppState(
  input: string | URLSearchParams,
  defaults: AppState = DEFAULT_APP_STATE,
): AppState {
  const params = typeof input === 'string' ? new URLSearchParams(input) : input;
  return {
    lat: clamp(finiteOr(params.get('lat'), defaults.lat), -90, 90),
    lng: clamp(finiteOr(params.get('lng'), defaults.lng), -180, 180),
    z: clamp(finiteOr(params.get('z'), defaults.z), 0, 22),
    t: parseT(params.get('t'), defaults.t),
    l: parseLayers(params.get('l'), defaults.l),
    sel: params.get('sel') ?? defaults.sel,
    play: (() => {
      const v = params.get('play');
      if (v === '1') return true;
      if (v === '0') return false;
      return defaults.play; // 미지 값은 필드별 기본값 폴백 (계약)
    })(),
    rate: finiteOr(params.get('rate'), defaults.rate),
    pin: params.get('pin') ?? defaults.pin,
  };
}

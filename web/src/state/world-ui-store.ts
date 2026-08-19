import { create } from 'zustand';
import {
  canonicalLayers,
  DEFAULT_APP_STATE,
  LAYER_TO_SHORT,
  parseAppState,
  type LayerId,
} from '@lwp/shared';
import { writeUrlKeys } from './url-sync';

/** 월드 UI 상태 — 레이어 토글 + 선택 레코드. URL(l·sel)과 양방향:
 *  초기값은 URL에서 파싱, 변경은 replaceState 즉시 반영 (url-sync 확장·기존 보존 로직 유지). */

/** Phase 0 활성 레이어 — 기상·뉴스는 Phase 1 (UI disabled) */
export const ACTIVE_LAYERS: readonly LayerId[] = ['earthquake', 'flight'];

const sameAsDefault = (layers: readonly LayerId[]): boolean => {
  const defaults = DEFAULT_APP_STATE.l;
  return layers.length === defaults.length && layers.every((l, i) => l === defaults[i]);
};

const serializeLayers = (layers: LayerId[]): string | null =>
  sameAsDefault(layers) ? null : layers.map((l) => LAYER_TO_SHORT[l]).join(',');

interface WorldUiState {
  /** 켜진 레이어 — 항상 캐노니컬 순서 (shared url-state 계약) */
  enabled: LayerId[];
  /** 선택 레코드 id (`${source}:${sourceId}`) — URL sel과 동기 */
  selectedId: string | null;
  toggleLayer: (layer: LayerId) => void;
  select: (id: string | null) => void;
  /** URL → 스토어 재동기화 — popstate·라우트 재진입용 (리뷰 Low1). URL은 쓰지 않는다 (루프 방지) */
  syncFromUrl: () => void;
}

const initial = parseAppState(window.location.search);

export const useWorldUiStore = create<WorldUiState>()((set) => ({
  enabled: canonicalLayers(initial.l),
  selectedId: initial.sel,

  toggleLayer: (layer) =>
    set((s) => {
      const has = s.enabled.includes(layer);
      const next = canonicalLayers(
        has ? s.enabled.filter((l) => l !== layer) : [...s.enabled, layer],
      );
      writeUrlKeys({ l: serializeLayers(next) });
      return { enabled: next };
    }),

  select: (id) =>
    set(() => {
      writeUrlKeys({ sel: id });
      return { selectedId: id };
    }),

  syncFromUrl: () =>
    set(() => {
      const state = parseAppState(window.location.search);
      return { enabled: canonicalLayers(state.l), selectedId: state.sel };
    }),
}));

// 뒤로가기/앞으로가기 — URL이 바뀌었는데 모듈 초기 파스만 남는 어긋남 방지 (리뷰 Low1)
window.addEventListener('popstate', () => useWorldUiStore.getState().syncFromUrl());

export const isLayerEnabled = (enabled: readonly LayerId[], layer: LayerId): boolean =>
  enabled.includes(layer);

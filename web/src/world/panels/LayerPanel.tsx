import type { LayerId } from '@lwp/shared';
import { useLiveStore, type LayerStatus, type LiveLayerId } from '../../data/live-store';
import { useWorldUiStore } from '../../state/world-ui-store';

/** DESIGN §2.1 — shape가 1차 식별자, hue는 보조 (색상만으로 레이어 구분 금지) */
interface LayerRow {
  id: LayerId;
  label: string;
  glyph: string;
  colorVar: string;
}

/** Phase 1 — 4레이어 전부 활성 (기상·뉴스 토글 개방) */
const LAYER_ROWS: readonly LayerRow[] = [
  { id: 'earthquake', label: '지진', glyph: '●', colorVar: '--layer-quake' },
  { id: 'weather', label: '기상 경보', glyph: '▩', colorVar: '--layer-alert' },
  { id: 'flight', label: '항공기', glyph: '▲', colorVar: '--layer-flight' },
  { id: 'news', label: '뉴스', glyph: '■', colorVar: '--layer-news' },
];

const STATUS_COLOR: Record<LayerStatus, string> = {
  idle: 'var(--text-lo)',
  loading: 'var(--text-lo)',
  ready: 'var(--status-live)',
  stale: 'var(--status-stale)',
  error: 'var(--layer-alert)',
};

/** stale 배지 텍스트 — '데이터 지연 N분' 정직 표기 (수집 갭 숨기기 금지) */
function badgeText(status: LayerStatus, asOfMs: number | null, nowMs: number): string {
  if (status === 'stale' && asOfMs !== null) {
    const min = Math.max(1, Math.floor((nowMs - asOfMs) / 60_000));
    return `지연 ${min}분`;
  }
  return status;
}

interface StatusBadgeProps {
  layer: LiveLayerId;
  rowId: string;
}

function StatusBadge({ layer, rowId }: StatusBadgeProps) {
  const layerState = useLiveStore((s) => s[layer]);
  const nowMs = useLiveStore((s) => s.tickNowMs);
  const text = badgeText(layerState.status, layerState.asOfMs, nowMs);
  return (
    <span
      id={rowId}
      title={layerState.error ?? undefined}
      className="mono border border-[var(--border)] bg-[var(--bg-2)] px-[var(--sp-1)] text-[length:var(--text-xs)]"
      style={{ borderRadius: 'var(--radius)', color: STATUS_COLOR[layerState.status] }}
    >
      {text}
    </span>
  );
}

/** 레이어 패널 — 4레이어 실토글 (Phase 1).
 *  레이어별 상태 배지: 부분 실패가 정상 상태, 전체 스피너 금지 (PLAN §3). */
export default function LayerPanel() {
  const enabled = useWorldUiStore((s) => s.enabled);
  const toggleLayer = useWorldUiStore((s) => s.toggleLayer);

  return (
    <aside
      className="flex flex-col border-r border-[var(--border)] bg-[var(--bg-1)]"
      aria-label="레이어 패널"
    >
      <h2 className="m-0 border-b border-[var(--border)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.2em] text-[var(--text-lo)]">
        Layers
      </h2>
      <ul className="m-0 list-none p-0">
        {LAYER_ROWS.map((row) => (
          <li
            key={row.id}
            className="flex items-center gap-[var(--sp-2)] border-b border-[var(--border)] px-[var(--sp-3)] py-[var(--sp-2)]"
          >
            <input
              type="checkbox"
              id={`layer-${row.id}`}
              checked={enabled.includes(row.id)}
              onChange={() => toggleLayer(row.id)}
              aria-describedby={`layer-${row.id}-status`}
              className="accent-[var(--status-live)]"
            />
            <span
              aria-hidden="true"
              className="text-[length:var(--text-sm)]"
              style={{ color: `var(${row.colorVar})` }}
            >
              {row.glyph}
            </span>
            <label
              htmlFor={`layer-${row.id}`}
              className="flex-1 text-[length:var(--text-sm)] text-[var(--text-hi)]"
            >
              {row.label}
            </label>
            <StatusBadge layer={row.id} rowId={`layer-${row.id}-status`} />
          </li>
        ))}
      </ul>
      <p className="mt-auto px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-xs)] leading-relaxed text-[var(--text-lo)]">
        항공기는 6개 지역(서울·도쿄·런던·프랑크푸르트·뉴욕·LA)만 수집 — 빈 지역이 정상입니다.
        기상은 60분 사이클, 뉴스는 15분 슬롯 수집 — 갱신 지연이 정상입니다.
      </p>
    </aside>
  );
}

import type { LayerId } from '@lwp/shared';

/** DESIGN §2.1 — shape가 1차 식별자, hue는 보조 (색상만으로 레이어 구분 금지) */
interface LayerRow {
  id: LayerId;
  label: string;
  glyph: string;
  colorVar: string;
}

const LAYER_ROWS: readonly LayerRow[] = [
  { id: 'earthquake', label: '지진', glyph: '●', colorVar: '--layer-quake' },
  { id: 'weather', label: '기상 경보', glyph: '▩', colorVar: '--layer-alert' },
  { id: 'flight', label: '항공기', glyph: '▲', colorVar: '--layer-flight' },
  { id: 'news', label: '뉴스', glyph: '■', colorVar: '--layer-news' },
];

/** 레이어 패널 — 토글 자리만 (데이터 연결은 다음 태스크).
 *  레이어별 상태 배지: 부분 실패가 정상 상태, 전체 스피너 금지 (PLAN §3). */
export default function LayerPanel() {
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
              disabled
              aria-describedby={`layer-${row.id}-status`}
              className="accent-[var(--status-live)]"
            />
            <span aria-hidden="true" className="text-[length:var(--text-sm)]" style={{ color: `var(${row.colorVar})` }}>
              {row.glyph}
            </span>
            <label
              htmlFor={`layer-${row.id}`}
              className="flex-1 text-[length:var(--text-sm)] text-[var(--text-hi)]"
            >
              {row.label}
            </label>
            <span
              id={`layer-${row.id}-status`}
              className="mono border border-[var(--border)] bg-[var(--bg-2)] px-[var(--sp-1)] text-[length:var(--text-xs)] text-[var(--text-lo)]"
              style={{ borderRadius: 'var(--radius)' }}
            >
              idle
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-auto px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-xs)] leading-relaxed text-[var(--text-lo)]">
        데이터 레이어는 다음 단계에서 연결됩니다.
      </p>
    </aside>
  );
}

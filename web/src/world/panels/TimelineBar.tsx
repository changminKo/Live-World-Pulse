import { useViewportStore } from '../../state/viewport-store';

/** 타임라인 바 — 정적 스텁 (스크럽·수집 갭 밴드는 Phase 2).
 *  우측 좌표 readout은 디바운스 viewport 사본(전역 스토어) 소비 예시. */
export default function TimelineBar() {
  const snapshot = useViewportStore((s) => s.snapshot);

  return (
    <footer className="flex items-center gap-[var(--sp-4)] border-t border-[var(--border)] bg-[var(--bg-1)] px-[var(--sp-4)]">
      <span className="text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.2em] text-[var(--text-lo)]">
        Timeline
      </span>
      <input
        type="range"
        disabled
        aria-label="타임라인 스크럽 (준비 중)"
        className="h-[2px] flex-1 appearance-none bg-[var(--border)]"
      />
      <span className="mono text-[length:var(--text-xs)] text-[var(--text-lo)]">
        {snapshot
          ? `${snapshot.lat.toFixed(2)}°, ${snapshot.lng.toFixed(2)}° · z${snapshot.zoom.toFixed(2)}`
          : '—'}
      </span>
    </footer>
  );
}

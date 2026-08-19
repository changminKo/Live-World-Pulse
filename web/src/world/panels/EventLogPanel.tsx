/** 이벤트 로그 — 동일 데이터의 1급 DOM 뷰 (PLAN §10 접근성: WebGL 캔버스는 스크린리더에 불투명).
 *  지금은 빈 리스트 — 레이어 연결 태스크가 채움. */
export default function EventLogPanel() {
  return (
    <aside
      className="flex flex-col border-l border-[var(--border)] bg-[var(--bg-1)]"
      aria-label="이벤트 로그"
    >
      <h2 className="m-0 flex items-baseline justify-between border-b border-[var(--border)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.2em] text-[var(--text-lo)]">
        Event Log
        <span className="mono text-[var(--text-lo)]">0</span>
      </h2>
      <ol
        aria-live="polite"
        className="m-0 flex flex-1 list-none flex-col items-center justify-center gap-[var(--sp-2)] p-[var(--sp-4)]"
      >
        <li className="text-center text-[length:var(--text-sm)] text-[var(--text-lo)]">
          아직 수신된 이벤트가 없습니다.
          <br />
          <span className="text-[length:var(--text-xs)]">레이어 연결 대기 중</span>
        </li>
      </ol>
    </aside>
  );
}

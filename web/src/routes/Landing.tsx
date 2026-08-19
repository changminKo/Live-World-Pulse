import { Link } from 'react-router';

/** 랜딩 스텁 — 정적 텍스트 + CTA만. 지도 번들 로드 금지 (PLAN §10 랜딩/앱 분리). */
export default function Landing() {
  return (
    <main className="space-bg relative flex h-full flex-col items-center justify-center gap-6 overflow-hidden px-6 text-center">
      <p className="text-[length:var(--text-sm)] uppercase tracking-[0.3em] text-[var(--text-lo)]">
        Live Data Integration
      </p>
      <h1 className="m-0 text-4xl font-semibold tracking-tight text-[var(--text-hi)] sm:text-6xl">
        LIVE WORLD PULSE
      </h1>
      <p className="m-0 max-w-md text-[length:var(--text-md)] leading-relaxed text-[var(--text-lo)]">
        지진·기상·항공기·뉴스 — 전 세계 이벤트를 3D 지구본과 타임라인으로 탐색합니다.
      </p>
      <Link
        to="/world"
        className="mt-4 border border-[var(--border)] bg-[var(--bg-1)] px-6 py-3 text-[length:var(--text-md)] font-medium text-[var(--text-hi)] transition-colors duration-150 hover:border-[var(--status-live)] hover:text-[var(--status-live)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--status-live)]"
        style={{ borderRadius: 'var(--radius)' }}
      >
        지구본 열기 →
      </Link>
    </main>
  );
}

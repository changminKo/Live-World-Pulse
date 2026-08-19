import { useEffect, useState } from 'react';

const formatUtc = (epochMs: number): string =>
  `${new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

/** 데이터 파이프라인 상태 (CLAUDE.md 표기 계약)
 *  - live: 최신 가용 스냅샷 표시 중 (● LIVE)
 *  - stale: 6분(항공기 2주기) 무갱신 (◐ 지연)
 *  - standby: 데이터 레이어 미연결 — LIVE 허위 주장 금지 (○ STANDBY) */
export type PulseStatus = 'live' | 'stale' | 'standby';

const STATUS_BADGE: Record<PulseStatus, { text: string; color: string; title: string }> = {
  live: { text: '● LIVE', color: 'var(--status-live)', title: '최신 가용 스냅샷 표시 중' },
  stale: { text: '◐ 지연', color: 'var(--status-stale)', title: '6분 이상 무갱신 — 지연 상태' },
  standby: {
    text: '○ STANDBY',
    color: 'var(--text-lo)',
    title: '데이터 레이어 연결 전 — 표시할 스냅샷 없음',
  },
};

interface HeaderBarProps {
  /** 레이어 연결 태스크가 live/stale 판정을 내려 전달 — 그 전까진 standby */
  status?: PulseStatus;
}

/** 헤더 — 타이틀 + 상태 배지.
 *  "Realtime" 표기 금지 → "Live Data Integration" (CLAUDE.md 표기 규칙). */
export default function HeaderBar({ status = 'standby' }: HeaderBarProps) {
  const [utc, setUtc] = useState(() => formatUtc(Date.now()));
  const badge = STATUS_BADGE[status];

  useEffect(() => {
    const id = setInterval(() => setUtc(formatUtc(Date.now())), 1_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="flex items-center gap-[var(--sp-4)] border-b border-[var(--border)] bg-[var(--bg-1)] px-[var(--sp-4)]">
      <h1 className="m-0 text-[length:var(--text-md)] font-semibold tracking-[0.18em] text-[var(--text-hi)]">
        LIVE WORLD PULSE
      </h1>
      <span
        className="mono flex items-center gap-[var(--sp-1)] border border-[var(--border)] bg-[var(--bg-2)] px-[var(--sp-2)] py-[2px] text-[length:var(--text-xs)]"
        style={{ borderRadius: 'var(--radius)', color: badge.color }}
        title={badge.title}
      >
        {badge.text}
      </span>
      <span className="text-[length:var(--text-xs)] uppercase tracking-[0.2em] text-[var(--text-lo)]">
        Live Data Integration
      </span>
      <span className="mono ml-auto text-[length:var(--text-sm)] text-[var(--text-lo)]">{utc}</span>
    </header>
  );
}

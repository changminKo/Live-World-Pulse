import { useEffect, useMemo, useRef, useState } from 'react';
import type { EarthquakeRecord, SeverityRank } from '@lwp/shared';
import { useLiveStore, type AlertArrival } from '../../data/live-store';
import { useWorldUiStore } from '../../state/world-ui-store';

/** 이벤트 로그 — 동일 데이터의 1급 DOM 뷰 (PLAN §10 접근성: WebGL 캔버스는 스크린리더에 불투명).
 *  지진(전체 1시간 window) + 세션 중 유입된 신규 기상 경보 병합 — 경보 422건 백필을
 *  전부 싣지 않고 '신규 유입'만 로그 (지진과 구분되는 ▩ 글리프·적색).
 *  aria-live는 별도 스로틀 어나운서(5s 1회) — 리스트 자체에 걸면 폴마다 전체 재낭독. */

const MAX_ROWS = 50;
const ANNOUNCE_THROTTLE_MS = 5_000;

const RANK_COLOR_VAR: Record<SeverityRank, string> = {
  0: '--quake-r0',
  1: '--quake-r1',
  2: '--quake-r2',
  3: '--quake-r3',
  4: '--quake-r4',
};

const ALERT_RANK_COLOR_VAR: Record<SeverityRank, string> = {
  0: '--alert-r0',
  1: '--alert-r1',
  2: '--alert-r2',
  3: '--alert-r3',
  4: '--alert-r4',
};

/** 로그 행 유니언 — 정렬 키: 지진 = occurredAt, 경보 = 클라이언트 도착 시각
 *  (validFrom은 수시간 전일 수 있어 '유입' 표시가 리스트 깊숙이 묻힘) */
type LogRow =
  | { kind: 'quake'; sortMs: number; record: EarthquakeRecord }
  | { kind: 'alert'; sortMs: number; arrival: AlertArrival };

const timeUtc = (iso: string): string => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '--:--:--' : t.toISOString().slice(11, 19);
};

const magLabel = (r: EarthquakeRecord): string =>
  r.payload.magnitude === null ? 'M?' : `M${r.payload.magnitude.toFixed(1)}`;

/** 스로틀 aria-live 어나운서 — 최신 도착 지진 1건만, 5초에 1회 (polite) */
function useThrottledAnnouncement(latest: EarthquakeRecord | null): string {
  const [announced, setAnnounced] = useState('');
  const lastAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!latest) return;
    const text = `새 지진 ${magLabel(latest)} ${latest.payload.place ?? '위치 미상'}`;
    const since = Date.now() - lastAtRef.current;
    const apply = () => {
      lastAtRef.current = Date.now();
      setAnnounced(text);
    };
    if (since >= ANNOUNCE_THROTTLE_MS) {
      apply();
    } else {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(apply, ANNOUNCE_THROTTLE_MS - since);
    }
    return () => clearTimeout(timerRef.current);
  }, [latest]);

  return announced;
}

export default function EventLogPanel() {
  const quakes = useLiveStore((s) => s.earthquake.records);
  const arrivals = useLiveStore((s) => s.quakeArrivals);
  const alertArrivals = useLiveStore((s) => s.alertArrivals);
  const select = useWorldUiStore((s) => s.select);
  const selectedId = useWorldUiStore((s) => s.selectedId);

  // 시간 내림차순 병합 — 새 이벤트가 자연히 맨 위에 prepend되는 정렬
  const rows = useMemo<LogRow[]>(() => {
    const quakeRows: LogRow[] = quakes.map((record) => ({
      kind: 'quake',
      sortMs: Date.parse(record.occurredAt),
      record,
    }));
    const alertRows: LogRow[] = alertArrivals.map((arrival) => ({
      kind: 'alert',
      sortMs: arrival.arrivedAtMs,
      arrival,
    }));
    return [...quakeRows, ...alertRows].sort((a, b) => b.sortMs - a.sortMs).slice(0, MAX_ROWS);
  }, [quakes, alertArrivals]);
  const arrivedIds = useMemo(() => new Set(arrivals.map((a) => a.id)), [arrivals]);
  const latestArrival = useMemo(() => {
    const first = arrivals[0];
    return first ? (quakes.find((q) => q.id === first.id) ?? null) : null;
  }, [arrivals, quakes]);
  const announced = useThrottledAnnouncement(latestArrival);

  return (
    <aside
      className="flex min-h-0 flex-col border-l border-[var(--border)] bg-[var(--bg-1)]"
      aria-label="이벤트 로그"
    >
      <h2 className="m-0 flex items-baseline justify-between border-b border-[var(--border)] px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.2em] text-[var(--text-lo)]">
        Event Log
        <span className="mono text-[var(--text-lo)]">{rows.length}</span>
      </h2>
      {/* 스로틀 어나운서 — 시각적으로 숨김, 스크린리더 전용 */}
      <p aria-live="polite" className="sr-only">
        {announced}
      </p>
      <ol className="m-0 flex-1 list-none overflow-y-auto p-0">
        {rows.length === 0 && (
          <li className="p-[var(--sp-4)] text-center text-[length:var(--text-sm)] text-[var(--text-lo)]">
            최근 1시간 수신 이벤트 없음
          </li>
        )}
        {rows.map((row) => {
          const id = row.kind === 'quake' ? row.record.id : row.arrival.id;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => select(id === selectedId ? null : id)}
                aria-pressed={id === selectedId}
                className="flex w-full items-baseline gap-[var(--sp-2)] border-b border-[var(--border)] px-[var(--sp-3)] py-[var(--sp-1)] text-left hover:bg-[var(--bg-2)]"
                style={{ background: id === selectedId ? 'var(--bg-2)' : undefined }}
              >
                {row.kind === 'quake' ? (
                  <>
                    <span className="mono text-[length:var(--text-xs)] text-[var(--text-lo)]">
                      {timeUtc(row.record.occurredAt)}
                    </span>
                    <span
                      className="mono text-[length:var(--text-sm)] font-semibold"
                      style={{ color: `var(${RANK_COLOR_VAR[row.record.severity.rank]})` }}
                    >
                      {magLabel(row.record)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-sm)] text-[var(--text-hi)]">
                      {row.record.payload.place ?? '위치 미상'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="mono text-[length:var(--text-xs)] text-[var(--text-lo)]">
                      {timeUtc(row.arrival.validFrom)}
                    </span>
                    {/* 지진과 구분: ▩ 글리프 + 경보 rank 적색 계열 (shape+hue 이중) */}
                    <span
                      aria-label="기상 경보"
                      className="mono text-[length:var(--text-sm)] font-semibold"
                      style={{ color: `var(${ALERT_RANK_COLOR_VAR[row.arrival.rank]})` }}
                    >
                      ▩
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-sm)] text-[var(--text-hi)]">
                      {row.arrival.event ?? '경보 (종류 미상)'}
                    </span>
                  </>
                )}
                {arrivedIds.has(id) && (
                  <span
                    aria-label="새 이벤트"
                    className="text-[length:var(--text-xs)] text-[var(--status-live)]"
                  >
                    ●
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

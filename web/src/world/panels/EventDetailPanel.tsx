import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import type { EarthquakeRecord, FlightRecord } from '@lwp/shared';
import { useLiveStore } from '../../data/live-store';
import { useWorldUiStore } from '../../state/world-ui-store';

/** 클릭 픽킹 상세 패널 — 지진: M·깊이·장소·시각 / 항공기: callsign·고도·속도·기종.
 *  'delayed/diverted' 문구 금지 (CLAUDE.md 표기 규칙 — 계산 가능 지표만).
 *  키보드 계약 (PLAN §10, 리뷰 Med3): 열릴 때 패널로 포커스 이동, Tab 포커스 트랩,
 *  Esc 닫기, 닫히면 열기 전 포커스 요소로 복귀. */

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const utc = (iso: string): string => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '—' : `${t.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
};

interface FieldProps {
  label: string;
  value: string;
}

function Field({ label, value }: FieldProps) {
  return (
    <div className="flex items-baseline gap-[var(--sp-2)]">
      <dt className="w-14 shrink-0 text-[length:var(--text-xs)] uppercase tracking-wide text-[var(--text-lo)]">
        {label}
      </dt>
      <dd className="mono m-0 text-[length:var(--text-sm)] text-[var(--text-hi)]">{value}</dd>
    </div>
  );
}

function quakeFields(r: EarthquakeRecord): FieldProps[] {
  return [
    { label: '규모', value: r.payload.magnitude === null ? '미상' : `M${r.payload.magnitude.toFixed(1)} (${r.payload.magType ?? '?'})` },
    { label: '깊이', value: r.payload.depthKm === null ? '미상' : `${r.payload.depthKm.toFixed(1)} km` },
    { label: '장소', value: r.payload.place ?? '위치 미상' },
    { label: '시각', value: utc(r.occurredAt) },
  ];
}

function flightFields(r: FlightRecord): FieldProps[] {
  const alt =
    r.payload.altBaroFt === null ? '미상' : r.payload.altBaroFt === 'ground' ? '지상' : `${r.payload.altBaroFt.toLocaleString()} ft`;
  return [
    { label: '콜사인', value: r.payload.callsign ?? r.entityId },
    { label: '고도', value: alt },
    { label: '속도', value: r.payload.groundSpeedKt === null ? '미상' : `${Math.round(r.payload.groundSpeedKt)} kt` },
    { label: '기종', value: r.payload.aircraftType ?? '미상' },
    { label: '표본', value: utc(r.sampledAt) },
  ];
}

export default function EventDetailPanel() {
  const selectedId = useWorldUiStore((s) => s.selectedId);
  const select = useWorldUiStore((s) => s.select);
  const quakes = useLiveStore((s) => s.earthquake.records);
  const flights = useLiveStore((s) => s.flight.records);

  const record = useMemo(() => {
    if (selectedId === null) return null;
    return (
      quakes.find((r) => r.id === selectedId) ?? flights.find((r) => r.id === selectedId) ?? null
    );
  }, [selectedId, quakes, flights]);

  const panelRef = useRef<HTMLElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const isOpen = record !== null;

  // 열릴 때 패널로 포커스 이동 + 닫히면(언마운트 포함) 트리거 요소로 복귀 (PLAN §10)
  useEffect(() => {
    if (!isOpen) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [isOpen]);

  if (record === null) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      select(null); // 포커스 복귀는 위 effect cleanup이 수행
      return;
    }
    if (e.key !== 'Tab' || panelRef.current === null) return;
    // 포커스 트랩 — 패널 내 포커스 가능 요소 순환 (현재는 닫기 버튼 1개)
    const nodes = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (first === undefined || last === undefined) return;
    if (!e.shiftKey && (active === last || active === panelRef.current)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    }
  };

  const isQuake = record.layer === 'earthquake';
  const fields = isQuake
    ? quakeFields(record as EarthquakeRecord)
    : flightFields(record as FlightRecord);

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-label="선택 이벤트 상세"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="absolute bottom-[var(--sp-3)] left-[var(--sp-3)] w-64 border border-[var(--border)] bg-[var(--bg-1)] p-[var(--sp-3)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--text-lo)]"
      style={{ borderRadius: 'var(--radius)' }}
    >
      <header className="mb-[var(--sp-2)] flex items-center justify-between">
        <h3
          className="m-0 text-[length:var(--text-sm)] font-semibold"
          style={{ color: isQuake ? 'var(--layer-quake)' : 'var(--layer-flight)' }}
        >
          {isQuake ? '● 지진' : '▲ 항공기'}
        </h3>
        <button
          type="button"
          onClick={() => select(null)}
          aria-label="상세 패널 닫기"
          className="mono border-0 bg-transparent px-[var(--sp-1)] text-[length:var(--text-sm)] text-[var(--text-lo)] hover:text-[var(--text-hi)]"
        >
          ✕
        </button>
      </header>
      <dl className="m-0 flex flex-col gap-[var(--sp-1)]">
        {fields.map((f) => (
          <Field key={f.label} label={f.label} value={f.value} />
        ))}
      </dl>
      <p className="mb-0 mt-[var(--sp-2)] text-[length:var(--text-xs)] text-[var(--text-lo)]">
        id {record.id}
      </p>
    </section>
  );
}

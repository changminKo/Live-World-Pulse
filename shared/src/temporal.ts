/** PLAN §5 "시각 t의 세계 상태" 질의 계약 + §6 레이어별 temporalMode 선언.
 *  단일 timestamp 필터 금지 — kind별 슬라이스 함수만 사용한다.
 *  전부 순수 함수 — 입력 불변, epoch ms 연산, 표시 변환은 프론트 몫. */
import type { Interval, LayerId, Observation, Occurrence } from './types';

export type TemporalMode = 'instant' | 'interval' | 'sampled';

export type TemporalSpec =
  | { temporalMode: 'instant'; windowMs: number } // [T - window, T] 발생분
  | { temporalMode: 'interval' } // validFrom ≤ T < validTo 겹침
  | { temporalMode: 'sampled'; toleranceMs: number }; // entityId별 최신 1건 + stale 판정

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** 레이어별 T 해석 선언 (PLAN §6).
 *
 *  flight tolerance = 지역당 수집 주기 × 2 = 20분 (2026-08-19 CPU 사다리 재조정):
 *  Workers Free 하드 10ms/invocation에서 한 invocation = 1지역만 처리하도록 분할해
 *  6지역 × 시간당 6회 = 지역당 10분 주기가 됐다 (collector schedule.ts MINUTE_TASKS).
 *  `● LIVE`/`◐ 지연` 배지 임계(6분, CLAUDE.md)와는 별개 상수 — 배지는 통합
 *  latest.json 갱신 간격(매분 재조립)을 보고, tolerance는 개별 표본의 낡음을 본다.
 *
 *  news window = 2시간 (2026-08-19): GDELT는 15분 파일 단위 이산 이벤트라 window는
 *  "표시 범위"다. 30분은 수집이 한 슬롯만 밀려도 레이어가 전멸했다 (실측: 수집 지연
 *  2시간 중 window 30분 → 표시 0건). 15분 슬롯 × 8 = 2시간이면 지연에도 견딘다. */
export const TEMPORAL_SPEC: Record<LayerId, TemporalSpec> = {
  earthquake: { temporalMode: 'instant', windowMs: HOUR_MS },
  news: { temporalMode: 'instant', windowMs: 2 * HOUR_MS },
  weather: { temporalMode: 'interval' },
  flight: { temporalMode: 'sampled', toleranceMs: 20 * MINUTE_MS },
};

const epochOf = (iso: string): number => Date.parse(iso);

/** occurrence: occurredAt ∈ [T - window, T] (양끝 포함 — PLAN §5 표기 그대로) */
export function sliceOccurrence<P>(
  records: readonly Occurrence<P>[],
  tMs: number,
  windowMs: number,
): Occurrence<P>[] {
  return records.filter((r) => {
    const at = epochOf(r.occurredAt);
    return at >= tMs - windowMs && at <= tMs;
  });
}

/** interval: validFrom ≤ T < validTo. validTo null(미해제)은 validFrom ≤ T면 활성.
 *  status 필터링(cancelled 숨김 등)은 시간 계약이 아니라 표시 정책 — 호출자 몫. */
export function sliceInterval<P>(records: readonly Interval<P>[], tMs: number): Interval<P>[] {
  return records.filter((r) => {
    if (epochOf(r.validFrom) > tMs) return false;
    return r.validTo === null || tMs < epochOf(r.validTo);
  });
}

export interface ObservationSample<P> {
  record: Observation<P>;
  /** T - sampledAt > tolerance — 표본이 낡음 (수집 갭·커버리지 공백을 정직 표시) */
  stale: boolean;
}

/** observation: sampledAt ≤ T 중 entityId별 최신 1건 + stale 플래그.
 *  T 이후 표본은 존재하지 않는 것으로 취급 (미래 누설 금지 — Time Machine 재생 계약). */
export function sliceObservation<P>(
  records: readonly Observation<P>[],
  tMs: number,
  toleranceMs: number,
): ObservationSample<P>[] {
  const latestByEntity = new Map<string, { record: Observation<P>; at: number }>();
  for (const record of records) {
    const at = epochOf(record.sampledAt);
    if (at > tMs) continue;
    const prev = latestByEntity.get(record.entityId);
    if (!prev || at > prev.at) latestByEntity.set(record.entityId, { record, at });
  }
  return [...latestByEntity.values()].map(({ record, at }) => ({
    record,
    stale: tMs - at > toleranceMs,
  }));
}

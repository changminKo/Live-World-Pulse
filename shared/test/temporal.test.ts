/** kind별 시간 슬라이스 규칙 (PLAN §5 질의 계약) — 경계 포함/배제 정밀 검증 */
import { TEMPORAL_SPEC, sliceInterval, sliceObservation, sliceOccurrence } from '../src/temporal';
import { intervalOf, observationAt, occurrenceAt } from './helpers';

const T = Date.parse('2026-08-19T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('TEMPORAL_SPEC 선언 테이블', () => {
  it('레이어별 temporalMode가 PLAN §6과 일치한다', () => {
    expect(TEMPORAL_SPEC.earthquake).toEqual({ temporalMode: 'instant', windowMs: 3_600_000 });
    expect(TEMPORAL_SPEC.news).toEqual({ temporalMode: 'instant', windowMs: 1_800_000 });
    expect(TEMPORAL_SPEC.weather).toEqual({ temporalMode: 'interval' });
    expect(TEMPORAL_SPEC.flight).toEqual({ temporalMode: 'sampled', toleranceMs: 360_000 });
  });
});

describe('sliceOccurrence — [T - window, T] 양끝 포함', () => {
  const windowMs = 3_600_000;

  it('window 정확 경계: T-window 포함, T 포함, 1ms 밖은 배제', () => {
    const records = [
      occurrenceAt('exactLower', iso(T - windowMs)),
      occurrenceAt('inside', iso(T - 1)),
      occurrenceAt('exactUpper', iso(T)),
      occurrenceAt('beforeWindow', iso(T - windowMs - 1)),
      occurrenceAt('future', iso(T + 1)),
    ];
    const ids = sliceOccurrence(records, T, windowMs).map((r) => r.sourceId);
    expect(ids).toEqual(['exactLower', 'inside', 'exactUpper']);
  });

  it('빈 입력은 빈 결과', () => {
    expect(sliceOccurrence([], T, windowMs)).toEqual([]);
  });
});

describe('sliceInterval — validFrom ≤ T < validTo', () => {
  it('validFrom == T 포함, validTo == T 배제 (반개구간)', () => {
    const records = [
      intervalOf('startsNow', iso(T), iso(T + 1000)),
      intervalOf('endsNow', iso(T - 1000), iso(T)),
      intervalOf('covers', iso(T - 1000), iso(T + 1000)),
    ];
    const ids = sliceInterval(records, T).map((r) => r.sourceId);
    expect(ids).toEqual(['startsNow', 'covers']);
  });

  it('validTo null(미해제)은 validFrom ≤ T면 활성', () => {
    const records = [
      intervalOf('openActive', iso(T - 1), null),
      intervalOf('openFuture', iso(T + 1), null),
    ];
    expect(sliceInterval(records, T).map((r) => r.sourceId)).toEqual(['openActive']);
  });
});

describe('sliceObservation — entityId별 최신 1건 + stale', () => {
  const toleranceMs = 360_000;

  it('entityId별 sampledAt ≤ T 최신 1건만 남긴다 (T 이후 표본은 미래 누설 금지)', () => {
    const records = [
      observationAt('7c2ba6', iso(T - 600_000)),
      observationAt('7c2ba6', iso(T - 120_000)), // 같은 개체 더 최신 → 이것만
      observationAt('7c2ba6', iso(T + 60_000)), // 미래 — 무시
      observationAt('abc123', iso(T - 60_000)),
    ];
    const samples = sliceObservation(records, T, toleranceMs);
    const byEntity = new Map(samples.map((s) => [s.record.entityId, s]));
    expect(samples).toHaveLength(2);
    expect(byEntity.get('7c2ba6')!.record.sampledAt).toBe(iso(T - 120_000));
    expect(byEntity.get('7c2ba6')!.stale).toBe(false);
  });

  it('tolerance 정확 경계: 초과만 stale (== tolerance는 fresh)', () => {
    const records = [
      observationAt('atLimit', iso(T - toleranceMs)),
      observationAt('overLimit', iso(T - toleranceMs - 1)),
    ];
    const byEntity = new Map(
      sliceObservation(records, T, toleranceMs).map((s) => [s.record.entityId, s.stale]),
    );
    expect(byEntity.get('atLimit')).toBe(false);
    expect(byEntity.get('overLimit')).toBe(true);
  });

  it('미래 표본만 있는 개체는 결과에서 사라진다', () => {
    expect(sliceObservation([observationAt('x', iso(T + 1))], T, toleranceMs)).toEqual([]);
  });
});

import { create } from 'zustand';
import { TEMPORAL_SPEC, type EarthquakeRecord, type FlightRecord } from '@lwp/shared';
import type { FlightRegionSlice, FlightSnapshot } from './latest-source';

/** LIVE 데이터 스토어 — 링버퍼 성격의 폴링 스냅샷 (PLAN §8.4: Query에 스트림 밀어넣기 금지).
 *  레이어별 records + asOf + status. stale 판정은 shared TEMPORAL_SPEC tolerance
 *  (항공기 6분 = CLAUDE.md `◐ 지연` 강등 규칙과 동일 상수)를 전 레이어 공용으로 쓴다. */

export type LayerStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';
export type LiveLayerId = 'earthquake' | 'flight';

/** 강등 임계 — flight toleranceMs(6분)를 LIVE 배지 규칙(CLAUDE.md)의 단일 기준으로 공용 */
export const STALE_AFTER_MS =
  TEMPORAL_SPEC.flight.temporalMode === 'sampled' ? TEMPORAL_SPEC.flight.toleranceMs : 360_000;

export interface LiveLayerState<R> {
  records: R[];
  /** 데이터 시점 epoch ms — flight=지역 asOf 최댓값, quake=마지막 성공 폴 시각 */
  asOfMs: number | null;
  /** 마지막 성공 폴(200/304) epoch ms */
  lastSuccessAtMs: number | null;
  status: LayerStatus;
  error: string | null;
  /** 연속 폴 오류 횟수 — 성공(200/304) 시 0. stale 강등과 무관한 진단 카운터 (리뷰 Med1) */
  errorCount: number;
}

/** 이벤트 로그 prepend·등장 펄스용 — 클라이언트에 처음 도착한 지진 (id, 도착 시각) */
export interface QuakeArrival {
  id: string;
  arrivedAtMs: number;
}

const PULSE_LIFE_MS = 10 * 60_000; // 등장 펄스 유지 시간
const MAX_ARRIVALS = 100;

/** stale 판정은 시간 규칙만 (CLAUDE.md 6분=2주기 무갱신, 리뷰 Med1) —
 *  기준 시각: flight은 데이터 asOf(수집기 정지도 잡음), quake는 성공 폴 시각.
 *  폴 1회 오류는 강등 사유 아님 — error 메시지·errorCount만 기록. */
function statusOf<R>(layer: LiveLayerId, s: LiveLayerState<R>, nowMs: number): LayerStatus {
  if (s.lastSuccessAtMs === null) return s.status; // 성공 이력 없음 — idle/loading/error 유지
  const basis = layer === 'flight' ? s.asOfMs : s.lastSuccessAtMs;
  if (basis !== null && nowMs - basis > STALE_AFTER_MS) return 'stale';
  return 'ready';
}

const emptyLayer = <R>(): LiveLayerState<R> => ({
  records: [],
  asOfMs: null,
  lastSuccessAtMs: null,
  status: 'idle',
  error: null,
  errorCount: 0,
});

interface LiveState {
  earthquake: LiveLayerState<EarthquakeRecord>;
  flight: LiveLayerState<FlightRecord>;
  /** 지역 단위 참조 안정 슬라이스 — 변한 지역만 새 배열 (리뷰 Med4, 레이어 memo 키) */
  flightRegions: FlightRegionSlice[];
  quakeArrivals: QuakeArrival[];
  /** 상태 재평가 트리거 — 컨트롤러가 30s마다 갱신 (배지 '지연 N분' 재계산용) */
  tickNowMs: number;
  setLoading: (layer: LiveLayerId) => void;
  setQuakes: (records: EarthquakeRecord[]) => void;
  setFlights: (snapshot: FlightSnapshot) => void;
  /** 304 — 데이터 불변, 폴 성공만 기록 */
  setChecked: (layer: LiveLayerId) => void;
  setError: (layer: LiveLayerId, message: string) => void;
  recomputeStale: (nowMs: number) => void;
}

export const useLiveStore = create<LiveState>()((set) => ({
  earthquake: emptyLayer<EarthquakeRecord>(),
  flight: emptyLayer<FlightRecord>(),
  flightRegions: [],
  quakeArrivals: [],
  tickNowMs: Date.now(),

  setLoading: (layer) =>
    set((s) => ({
      [layer]: {
        ...s[layer],
        status: s[layer].lastSuccessAtMs === null ? 'loading' : s[layer].status,
      },
    })),

  setQuakes: (records) =>
    set((s) => {
      const now = Date.now();
      const next: LiveLayerState<EarthquakeRecord> = {
        records,
        asOfMs: now,
        lastSuccessAtMs: now,
        status: 'ready',
        error: null,
        errorCount: 0,
      };
      // 첫 로드는 백필이라 '신규 도착' 아님 — 이후 폴에서 못 보던 id만 펄스·로그 강조
      const known = new Set(s.earthquake.records.map((r) => r.id));
      const fresh =
        s.earthquake.lastSuccessAtMs === null
          ? []
          : records.filter((r) => !known.has(r.id)).map((r) => ({ id: r.id, arrivedAtMs: now }));
      return {
        earthquake: { ...next, status: statusOf('earthquake', next, now) },
        quakeArrivals: [...fresh, ...s.quakeArrivals]
          .filter((a) => now - a.arrivedAtMs < PULSE_LIFE_MS)
          .slice(0, MAX_ARRIVALS),
      };
    }),

  setFlights: (snapshot) =>
    set(() => {
      const now = Date.now();
      const next: LiveLayerState<FlightRecord> = {
        records: snapshot.records,
        asOfMs: snapshot.asOfMs,
        lastSuccessAtMs: now,
        status: 'ready',
        error: null,
        errorCount: 0,
      };
      return {
        flight: { ...next, status: statusOf('flight', next, now) },
        flightRegions: snapshot.regions,
      };
    }),

  setChecked: (layer) =>
    set((s) => {
      const now = Date.now();
      if (layer === 'earthquake') {
        const next = { ...s.earthquake, lastSuccessAtMs: now, error: null, errorCount: 0 };
        return { earthquake: { ...next, status: statusOf('earthquake', next, now) } };
      }
      const next = { ...s.flight, lastSuccessAtMs: now, error: null, errorCount: 0 };
      return { flight: { ...next, status: statusOf('flight', next, now) } };
    }),

  setError: (layer, message) =>
    set((s) => {
      // 성공 이력 없으면 error. 있으면 낡은 데이터 계속 표시 — stale 강등은
      // 시간 규칙(마지막 성공 asOf 기준 6분)만 따른다 (리뷰 Med1).
      const now = Date.now();
      if (layer === 'earthquake') {
        const next = { ...s.earthquake, error: message, errorCount: s.earthquake.errorCount + 1 };
        const status: LayerStatus =
          next.lastSuccessAtMs === null ? 'error' : statusOf('earthquake', next, now);
        return { earthquake: { ...next, status } };
      }
      const next = { ...s.flight, error: message, errorCount: s.flight.errorCount + 1 };
      const status: LayerStatus =
        next.lastSuccessAtMs === null ? 'error' : statusOf('flight', next, now);
      return { flight: { ...next, status } };
    }),

  recomputeStale: (nowMs) =>
    set((s) => ({
      tickNowMs: nowMs,
      earthquake: { ...s.earthquake, status: statusOf('earthquake', s.earthquake, nowMs) },
      flight: { ...s.flight, status: statusOf('flight', s.flight, nowMs) },
      quakeArrivals: s.quakeArrivals.filter((a) => nowMs - a.arrivedAtMs < PULSE_LIFE_MS),
    })),
}));

/** 헤더 배지 규칙 (태스크 계약): 하나라도 ready → live / 성공 이력 있고 전부 무갱신 → stale /
 *  성공 이력 없음 → standby */
export function derivePulseStatus(
  s: Pick<LiveState, 'earthquake' | 'flight'>,
): 'live' | 'stale' | 'standby' {
  const layers = [s.earthquake, s.flight];
  if (layers.some((l) => l.status === 'ready')) return 'live';
  if (layers.some((l) => l.lastSuccessAtMs !== null)) return 'stale';
  return 'standby';
}

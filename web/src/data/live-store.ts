import { create } from 'zustand';
import {
  TEMPORAL_SPEC,
  type EarthquakeRecord,
  type FlightRecord,
  type NewsRecord,
  type SeverityRank,
  type WeatherAlertRecord,
} from '@lwp/shared';
import type { FlightRegionSlice, FlightSnapshot, LayerSnapshot } from './latest-source';

/** LIVE 데이터 스토어 — 링버퍼 성격의 폴링 스냅샷 (PLAN §8.4: Query에 스트림 밀어넣기 금지).
 *  레이어별 records + asOf + status. stale 판정은 레이어별 수집 주기 × 2주기.
 *  2026-08-19 CPU 사다리로 수집 주기가 바뀌어 임계도 함께 갱신했다
 *  (collector schedule.ts MINUTE_TASKS가 단일 출처). */

export type LayerStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';
export type LiveLayerId = 'earthquake' | 'flight' | 'weather' | 'news';

/** `● LIVE` → `◐ 지연` 배지 임계 (CLAUDE.md 표기 규칙 6분). 통합 latest.json이 매 분
 *  재조립되므로 이 임계는 "수집기 자체가 살아 있는가"를 본다 — TEMPORAL_SPEC.flight
 *  tolerance(개별 표본의 낡음, 20분)와는 별개 상수다. 2026-08-19 전까지는 flight
 *  tolerance에서 파생했지만, 사다리로 tolerance가 20분이 되면서 분리했다. */
export const STALE_AFTER_MS = 6 * 60_000;

/** flight 표본 stale 임계 — 지역당 10분 주기 × 2주기 (shared TEMPORAL_SPEC.flight) */
const FLIGHT_STALE_MS =
  TEMPORAL_SPEC.flight.temporalMode === 'sampled' ? TEMPORAL_SPEC.flight.toleranceMs : 1_200_000;
/** weather는 60분 수집 사이클 — 2주기(120분) 무갱신 시 강등 (collector schedule.ts:
 *  페이지 1장/슬롯 × 10슬롯 = 사이클 60분. 2026-08-19 프로덕션 CPU 실측 결과) */
const WEATHER_STALE_MS = 120 * 60_000;
/** news는 15분 수집 슬롯 — 2주기(30분) 무갱신 시 강등 */
const NEWS_STALE_MS = 30 * 60_000;

export const LAYER_STALE_MS: Record<LiveLayerId, number> = {
  earthquake: STALE_AFTER_MS,
  flight: FLIGHT_STALE_MS,
  weather: WEATHER_STALE_MS,
  news: NEWS_STALE_MS,
};

export interface LiveLayerState<R> {
  records: R[];
  /** 데이터 시점 epoch ms — latest 레이어 asOf, quake=마지막 성공 폴 시각 */
  asOfMs: number | null;
  /** 마지막 성공 폴(200/304) epoch ms */
  lastSuccessAtMs: number | null;
  status: LayerStatus;
  error: string | null;
  /** 연속 폴 오류 횟수 — 성공(200/304) 시 0. stale 강등과 무관한 진단 카운터 (리뷰 Med1) */
  errorCount: number;
  /** 마지막 수신 문서가 이 레이어 계약을 위반했다 (재리뷰 Med6).
   *  304는 "데이터 불변"일 뿐 스키마가 고쳐졌다는 뜻이 아니므로, 이 플래그가 서 있는 동안
   *  setChecked는 error 상태를 ready로 세탁하지 못한다. 해제는 성공 ingest에서만. */
  schemaFailed: boolean;
}

/** 이벤트 로그 prepend·등장 펄스용 — 클라이언트에 처음 도착한 지진 (id, 도착 시각) */
export interface QuakeArrival {
  id: string;
  arrivedAtMs: number;
}

/** 이벤트 로그용 신규 경보 유입 — 레코드가 latest에서 사라져도 로그 행이 남도록
 *  표시 필드를 스냅샷으로 보존 (records 수명과 분리) */
export interface AlertArrival {
  id: string;
  arrivedAtMs: number;
  event: string | null;
  rank: SeverityRank;
  validFrom: string;
}

const PULSE_LIFE_MS = 10 * 60_000; // 등장 펄스 유지 시간
const MAX_ARRIVALS = 100;
const MAX_ALERT_ARRIVALS = 50; // 로그 표시용 — 세션 내 보존 (시간 만료 없음)

/** stale 판정 입력 — records 타입과 무관한 공통 메타만 (4레이어 유니언 호출 허용) */
type LayerMeta = Pick<LiveLayerState<unknown>, 'asOfMs' | 'lastSuccessAtMs' | 'status' | 'schemaFailed'>;

/** stale 판정은 시간 규칙만 (CLAUDE.md 2주기 무갱신, 리뷰 Med1) —
 *  기준 시각: quake는 성공 폴 시각(USGS 직접), 나머지는 데이터 asOf(수집기 정지도 잡음).
 *  폴 1회 오류는 강등 사유 아님 — error 메시지·errorCount만 기록. */
function statusOf(layer: LiveLayerId, s: LayerMeta, nowMs: number): LayerStatus {
  if (s.schemaFailed) return 'error'; // 계약 위반은 시간이 지나도 stale/ready가 되지 않는다 (Med6)
  if (s.lastSuccessAtMs === null) return s.status; // 성공 이력 없음 — idle/loading/error 유지
  const basis = layer === 'earthquake' ? s.lastSuccessAtMs : s.asOfMs;
  if (basis !== null && nowMs - basis > LAYER_STALE_MS[layer]) return 'stale';
  return 'ready';
}

const emptyLayer = <R>(): LiveLayerState<R> => ({
  records: [],
  asOfMs: null,
  lastSuccessAtMs: null,
  status: 'idle',
  error: null,
  errorCount: 0,
  schemaFailed: false,
});

interface LiveState {
  earthquake: LiveLayerState<EarthquakeRecord>;
  flight: LiveLayerState<FlightRecord>;
  weather: LiveLayerState<WeatherAlertRecord>;
  news: LiveLayerState<NewsRecord>;
  /** 지역 단위 참조 안정 슬라이스 — 변한 지역만 새 배열 (리뷰 Med4, 레이어 memo 키) */
  flightRegions: FlightRegionSlice[];
  quakeArrivals: QuakeArrival[];
  alertArrivals: AlertArrival[];
  /** 상태 재평가 트리거 — 컨트롤러가 30s마다 갱신 (배지 '지연 N분' 재계산용) */
  tickNowMs: number;
  setLoading: (layer: LiveLayerId) => void;
  setQuakes: (records: EarthquakeRecord[]) => void;
  setFlights: (snapshot: FlightSnapshot) => void;
  setWeather: (snapshot: LayerSnapshot<WeatherAlertRecord>) => void;
  setNews: (snapshot: LayerSnapshot<NewsRecord>) => void;
  /** 시간 경과 재슬라이스 — 폴 성공이 아니므로 lastSuccessAtMs·asOf를 건드리지 않는다 (Med5) */
  resliceWeather: (snapshot: LayerSnapshot<WeatherAlertRecord>) => void;
  resliceNews: (snapshot: LayerSnapshot<NewsRecord>) => void;
  /** 304 — 데이터 불변, 폴 성공만 기록 */
  setChecked: (layer: LiveLayerId) => void;
  setError: (layer: LiveLayerId, message: string) => void;
  /** 계약 위반(스키마 불일치) — 다음 304가 덮지 못하는 sticky 오류 (Med6) */
  setSchemaError: (layer: LiveLayerId, message: string) => void;
  recomputeStale: (nowMs: number) => void;
}

/** 동적 키 패치 — s[layer]는 4개 레이어 상태의 유니언이라 computed key 반환을
 *  zustand Partial로 넘길 때 캐스트가 필요 (레코드 타입은 레이어별로 다르지만
 *  여기서 만지는 필드는 공통 메타뿐이라 안전) */
type LayerPatch = Partial<Pick<LiveState, LiveLayerId>>;

export const useLiveStore = create<LiveState>()((set) => ({
  earthquake: emptyLayer<EarthquakeRecord>(),
  flight: emptyLayer<FlightRecord>(),
  weather: emptyLayer<WeatherAlertRecord>(),
  news: emptyLayer<NewsRecord>(),
  flightRegions: [],
  quakeArrivals: [],
  alertArrivals: [],
  tickNowMs: Date.now(),

  setLoading: (layer) =>
    set((s) => {
      const prev = s[layer];
      return {
        [layer]: {
          ...prev,
          status: prev.lastSuccessAtMs === null ? 'loading' : prev.status,
        },
      } as LayerPatch;
    }),

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
        schemaFailed: false, // 성공 수신 — 계약 위반 해제 (Med6)
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
        schemaFailed: false,
      };
      return {
        flight: { ...next, status: statusOf('flight', next, now) },
        flightRegions: snapshot.regions,
      };
    }),

  setWeather: (snapshot) =>
    set((s) => {
      const now = Date.now();
      const next: LiveLayerState<WeatherAlertRecord> = {
        records: snapshot.records,
        asOfMs: snapshot.asOfMs,
        lastSuccessAtMs: now,
        status: 'ready',
        error: null,
        errorCount: 0,
        schemaFailed: false,
      };
      // 첫 로드는 백필 — 이후 폴의 미지 id만 이벤트 로그 '신규 경보'로 기록
      const known = new Set(s.weather.records.map((r) => r.id));
      const fresh: AlertArrival[] =
        s.weather.lastSuccessAtMs === null
          ? []
          : snapshot.records
              .filter((r) => !known.has(r.id))
              .map((r) => ({
                id: r.id,
                arrivedAtMs: now,
                event: r.payload.event,
                rank: r.severity.rank,
                validFrom: r.validFrom,
              }));
      return {
        weather: { ...next, status: statusOf('weather', next, now) },
        alertArrivals: [...fresh, ...s.alertArrivals].slice(0, MAX_ALERT_ARRIVALS),
      };
    }),

  setNews: (snapshot) =>
    set(() => {
      const now = Date.now();
      const next: LiveLayerState<NewsRecord> = {
        records: snapshot.records,
        asOfMs: snapshot.asOfMs,
        lastSuccessAtMs: now,
        status: 'ready',
        error: null,
        errorCount: 0,
        schemaFailed: false,
      };
      return { news: { ...next, status: statusOf('news', next, now) } };
    }),

  resliceWeather: (snapshot) =>
    set((s) => {
      if (snapshot.records === s.weather.records) return {}; // 집합 불변 — 리렌더 없음
      return { weather: { ...s.weather, records: snapshot.records } };
    }),

  resliceNews: (snapshot) =>
    set((s) => {
      if (snapshot.records === s.news.records) return {};
      return { news: { ...s.news, records: snapshot.records } };
    }),

  setChecked: (layer) =>
    set((s) => {
      const now = Date.now();
      const prev = s[layer];
      // Med6: 계약 위반이 걸려 있으면 304로 성공 세탁하지 않는다 — 폴 성공 시각만 갱신하고
      // error 문구·error 상태를 유지한다 (다음 200 성공 ingest에서만 해제).
      if (prev.schemaFailed) {
        return { [layer]: { ...prev, lastSuccessAtMs: now, status: 'error' } } as LayerPatch;
      }
      const next = { ...prev, lastSuccessAtMs: now, error: null, errorCount: 0 };
      return { [layer]: { ...next, status: statusOf(layer, next, now) } } as LayerPatch;
    }),

  setSchemaError: (layer, message) =>
    set((s) => {
      const prev = s[layer];
      return {
        [layer]: {
          ...prev,
          error: message,
          errorCount: prev.errorCount + 1,
          schemaFailed: true,
          status: 'error',
        },
      } as LayerPatch;
    }),

  setError: (layer, message) =>
    set((s) => {
      // 성공 이력 없으면 error. 있으면 낡은 데이터 계속 표시 — stale 강등은
      // 시간 규칙(레이어별 tolerance)만 따른다 (리뷰 Med1).
      const now = Date.now();
      const next = { ...s[layer], error: message, errorCount: s[layer].errorCount + 1 };
      const status: LayerStatus =
        next.lastSuccessAtMs === null ? 'error' : statusOf(layer, next, now);
      return { [layer]: { ...next, status } } as LayerPatch;
    }),

  recomputeStale: (nowMs) =>
    set((s) => ({
      tickNowMs: nowMs,
      earthquake: { ...s.earthquake, status: statusOf('earthquake', s.earthquake, nowMs) },
      flight: { ...s.flight, status: statusOf('flight', s.flight, nowMs) },
      weather: { ...s.weather, status: statusOf('weather', s.weather, nowMs) },
      news: { ...s.news, status: statusOf('news', s.news, nowMs) },
      quakeArrivals: s.quakeArrivals.filter((a) => nowMs - a.arrivedAtMs < PULSE_LIFE_MS),
    })),
}));

/** 헤더 배지 규칙 (태스크 계약): 하나라도 ready → live / 성공 이력 있고 전부 무갱신 → stale /
 *  성공 이력 없음 → standby. 4레이어 기준 (레이어별 tolerance는 LAYER_STALE_MS). */
export function derivePulseStatus(
  s: Pick<LiveState, LiveLayerId>,
): 'live' | 'stale' | 'standby' {
  const layers = [s.earthquake, s.flight, s.weather, s.news];
  if (layers.some((l) => l.status === 'ready')) return 'live';
  if (layers.some((l) => l.lastSuccessAtMs !== null)) return 'stale';
  return 'standby';
}

import {
  TEMPORAL_SPEC,
  sliceInterval,
  sliceObservation,
  sliceOccurrence,
  type FlightRecord,
  type LatestDoc,
  type NewsRecord,
  type WeatherAlertRecord,
} from '@lwp/shared';

/** Worker 프록시 latest.json — LIVE 폴링 1req/폴 계약 (PLAN §8.6).
 *  항공기만 소비 (지진은 USGS 직접 — 더 신선).
 *
 *  참조 안정화 (리뷰 Med4): latest 200마다 전 지역을 새 배열로 평탄화하면 건강한 1분
 *  갱신마다 SimpleMeshLayer attribute가 전부 재생성된다. 지역별 asOf를 비교해
 *  **변한 지역의 배열만 교체**하고, 아무 지역도 안 변했으면 직전 스냅샷 객체를 그대로
 *  반환한다 (records·regions 참조 동일 → 레이어 memo 히트). 지역 단위 binary attribute
 *  경로(사전계산 Float32Array — PLAN §8.3)는 Phase 1 과제. */

export const LATEST_URL = 'https://lwp-collector.rhckdals123.workers.dev/api/latest';

/** 지역 단위 슬라이스 — dedupe 생존 레코드. 배열 참조는 지역 데이터가 변할 때만 교체 */
export interface FlightRegionSlice {
  key: string;
  asOfMs: number | null;
  records: FlightRecord[];
}

export interface FlightSnapshot {
  /** 전 지역 평탄화 (지역 순서 고정) — 상세 패널·검증 스크립트 소비 */
  records: FlightRecord[];
  /** 지역 asOf 최댓값 epoch ms — 커버리지 갭(지역별 10분 주기)에서 가장 신선한 시점 */
  asOfMs: number | null;
  /** 지역별 참조 안정 슬라이스 — deck 레이어 memo 키 */
  regions: FlightRegionSlice[];
}

const flightTolerance =
  TEMPORAL_SPEC.flight.temporalMode === 'sampled' ? TEMPORAL_SPEC.flight.toleranceMs : 1_200_000;

interface RegionRaw {
  asOfIso: string;
  asOfMs: number | null;
  records: FlightRecord[];
}

export type FlightIngest = (doc: unknown, nowMs: number) => FlightSnapshot | null;

/** 스냅샷 병합기 — 직전 폴의 지역별 원본·슬라이스를 기억한다 (컨트롤러 수명 스코프) */
export function createFlightSource(): FlightIngest {
  let prevRaw = new Map<string, RegionRaw>();
  let prevSlices = new Map<string, FlightRegionSlice>();
  let prevSnapshot: FlightSnapshot | null = null;

  return function ingest(doc: unknown, nowMs: number): FlightSnapshot | null {
    const layers = (doc as LatestDoc | null)?.layers;
    if (layers === undefined || layers === null || typeof layers !== 'object') return null;

    const regions = layers.flight?.regions;
    if (regions === undefined) {
      // 레이어 미수집 — 빈 세계 (직전 상태도 비운다)
      prevRaw = new Map();
      prevSlices = new Map();
      prevSnapshot = { records: [], asOfMs: null, regions: [] };
      return prevSnapshot;
    }

    // 1. 지역별 원본 수집 — asOf 동일하면 직전 파스 결과(객체 참조) 재사용
    const keys = Object.keys(regions).sort(); // 레이어 순서 결정론화
    const nextRaw = new Map<string, RegionRaw>();
    let changed = keys.length !== prevRaw.size;
    for (const key of keys) {
      const region = regions[key];
      if (!Array.isArray(region?.records)) return null; // 계약 위반 — 부분 성공으로 위장 금지
      const prev = prevRaw.get(key);
      if (prev !== undefined && prev.asOfIso === region.asOf) {
        nextRaw.set(key, prev); // 무변경 지역 — 기존 레코드 객체 유지
      } else {
        const at = Date.parse(region.asOf);
        nextRaw.set(key, {
          asOfIso: region.asOf,
          asOfMs: Number.isFinite(at) ? at : null,
          records: region.records,
        });
        changed = true;
      }
    }

    // 2. 아무 지역도 안 변함 — 직전 스냅샷 그대로 (폴 성공 기록은 스토어 몫)
    if (!changed && prevSnapshot !== null) return prevSnapshot;

    // 3. 전역 dedupe (entityId별 최신 1건 + 미래 표본 배제 — shared 계약 함수는 유지)
    const all: FlightRecord[] = [];
    for (const key of keys) all.push(...(nextRaw.get(key)?.records ?? []));
    const survived = new Set(sliceObservation(all, nowMs, flightTolerance).map((s) => s.record));

    // 4. 생존 레코드를 지역별로 분할 — 내용 동일 지역은 직전 슬라이스 배열 참조 재사용
    const nextSlices = new Map<string, FlightRegionSlice>();
    const sliceList: FlightRegionSlice[] = [];
    const flat: FlightRecord[] = [];
    let asOfMs: number | null = null;
    for (const key of keys) {
      const raw = nextRaw.get(key);
      if (raw === undefined) continue;
      if (raw.asOfMs !== null) asOfMs = asOfMs === null ? raw.asOfMs : Math.max(asOfMs, raw.asOfMs);
      const records = raw.records.filter((r) => survived.has(r));
      const prev = prevSlices.get(key);
      const reusable =
        prev !== undefined &&
        prev.asOfMs === raw.asOfMs &&
        prev.records.length === records.length &&
        records.every((r, i) => r === prev.records[i]);
      const slice: FlightRegionSlice = reusable ? prev : { key, asOfMs: raw.asOfMs, records };
      nextSlices.set(key, slice);
      sliceList.push(slice);
      flat.push(...slice.records);
    }

    prevRaw = nextRaw;
    prevSlices = nextSlices;
    prevSnapshot = { records: flat, asOfMs, regions: sliceList };
    return prevSnapshot;
  };
}

/* ── weather·news — latest.json 단일 asOf 레이어 소비 (Phase 1) ── */

/** 단일 asOf 레이어 스냅샷 — weather(Interval)·news(Occurrence) 공용 */
export interface LayerSnapshot<R> {
  records: R[];
  asOfMs: number | null;
}

export type LayerIngest<R> = (doc: unknown, nowMs: number) => LayerSnapshot<R> | null;

/** 단일 asOf 레이어 소스 — 폴 수신(ingest)과 **시간 경과 재평가(reslice)**를 분리한다.
 *  reslice가 필요한 이유 (재리뷰 Med5): weather는 interval, news는 window라 asOf가
 *  그대로여도 시계가 흐르면 표시 집합이 바뀐다(경보 만료·뉴스 window 이탈). asOf가
 *  같으면 재계산을 건너뛰던 이전 판은 만료를 다음 수집(기상 60분·뉴스 15분)까지 미뤘다. */
export interface LayerSource<R> {
  ingest: LayerIngest<R>;
  /** 마지막 수신 데이터로 시각 T만 바꿔 다시 슬라이스. 결과가 같으면 같은 참조를 반환한다
   *  (레이어 memo 히트 유지 — 틱마다 attribute 재계산을 만들지 않는다). 수신 이력이
   *  없으면 null. */
  reslice: (nowMs: number) => LayerSnapshot<R> | null;
}

const NEWS_WINDOW_MS =
  TEMPORAL_SPEC.news.temporalMode === 'instant' ? TEMPORAL_SPEC.news.windowMs : 7_200_000;

interface SimpleLayerRaw<R> {
  asOfIso: string;
  asOfMs: number | null;
  records: R[];
}

/** 참조 안정 단일 레이어 병합기 — asOf 동일하면 직전 스냅샷(배열 참조) 그대로 반환.
 *  weather(60분 사이클)·news(15분 슬롯)이라 60s 폴 대부분에서 무변경 — 레이어 memo 히트가 기본 경로.
 *  slice는 asOf가 바뀐 폴에서만 재계산 — 슬롯 사이 만료(interval validTo 경과 등)는
 *  다음 슬롯 도착까지 유지되지만 상태 배지 tolerance가 지연을 정직 표기한다. */
function createSimpleSource<R>(
  layerOf: (doc: LatestDoc) => { asOf: string; records: R[] } | undefined,
  slice: (records: R[], asOfMs: number | null, nowMs: number) => R[],
): LayerSource<R> {
  let prev: SimpleLayerRaw<R> | null = null;
  let prevSnapshot: LayerSnapshot<R> | null = null;

  /** 슬라이스 결과가 직전과 같은 집합이면 직전 배열 참조를 유지한다 — 틱마다 새 배열을
   *  만들면 asOf가 그대로인데도 deck attribute가 재계산된다 (PLAN §8.3 병목 ①). */
  const commit = (records: R[], asOfMs: number | null): LayerSnapshot<R> => {
    const before = prevSnapshot;
    const same =
      before !== null &&
      before.asOfMs === asOfMs &&
      before.records.length === records.length &&
      records.every((r, i) => r === before.records[i]);
    prevSnapshot = same && before !== null ? before : { records, asOfMs };
    return prevSnapshot;
  };

  return {
    ingest(doc: unknown, nowMs: number): LayerSnapshot<R> | null {
      const layers = (doc as LatestDoc | null)?.layers;
      if (layers === undefined || layers === null || typeof layers !== 'object') return null;

      const layer = layerOf(doc as LatestDoc);
      if (layer === undefined) {
        // 레이어 미수집 (partial 조립) — 빈 세계 (직전 상태도 비운다)
        prev = null;
        prevSnapshot = { records: [], asOfMs: null };
        return prevSnapshot;
      }
      if (!Array.isArray(layer.records)) return null; // 계약 위반 — 부분 성공으로 위장 금지

      // asOf 동일 = 원본 불변. 새로 파싱된 객체를 채택하지 않고 **직전 원본을 유지**한 채
      // 시각 T만 갱신해 다시 슬라이스한다 (Med5 재슬라이스 + 참조 안정성 동시 충족 —
      // 새 파스 객체를 채택하면 내용이 같아도 identity가 달라져 매 폴 attribute가 재계산된다).
      if (prev !== null && prev.asOfIso === layer.asOf) {
        return commit(slice(prev.records, prev.asOfMs, nowMs), prev.asOfMs);
      }

      const at = Date.parse(layer.asOf);
      const asOfMs = Number.isFinite(at) ? at : null;
      prev = { asOfIso: layer.asOf, asOfMs, records: layer.records };
      return commit(slice(layer.records, asOfMs, nowMs), asOfMs);
    },

    reslice(nowMs: number): LayerSnapshot<R> | null {
      if (prev === null) return null;
      return commit(slice(prev.records, prev.asOfMs, nowMs), prev.asOfMs);
    },
  };
}

/** weather = Interval — validFrom ≤ T < validTo 겹침 슬라이스 (TEMPORAL_SPEC.weather).
 *  cancelled 숨김은 시간 계약이 아니라 표시 정책 (shared temporal.ts 주석) — 여기서 적용. */
export function createWeatherSource(): LayerSource<WeatherAlertRecord> {
  return createSimpleSource(
    (doc) => doc.layers.weather,
    (records, _asOfMs, nowMs) =>
      sliceInterval(records, nowMs).filter((r) => r.status !== 'cancelled'),
  );
}

/** news = Occurrence — [T - 2시간, T] window (TEMPORAL_SPEC.news — 수집 지연 내성).
 *  주의: occurredAt은 15분 슬롯 '종료' 시각이라 클라이언트 시계보다 미래일 수 있음
 *  (실측: ingestedAt 09:26 < occurredAt 09:30) — T = max(now, asOf)로 최신 슬롯 소실 방지. */
export function createNewsSource(): LayerSource<NewsRecord> {
  return createSimpleSource(
    (doc) => doc.layers.news,
    (records, asOfMs, nowMs) =>
      sliceOccurrence(records, Math.max(nowMs, asOfMs ?? nowMs), NEWS_WINDOW_MS),
  );
}

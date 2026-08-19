import {
  TEMPORAL_SPEC,
  sliceObservation,
  type FlightRecord,
  type LatestDoc,
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
  /** 지역 asOf 최댓값 epoch ms — 커버리지 갭(지역별 3분 주기)에서 가장 신선한 시점 */
  asOfMs: number | null;
  /** 지역별 참조 안정 슬라이스 — deck 레이어 memo 키 */
  regions: FlightRegionSlice[];
}

const flightTolerance =
  TEMPORAL_SPEC.flight.temporalMode === 'sampled' ? TEMPORAL_SPEC.flight.toleranceMs : 360_000;

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

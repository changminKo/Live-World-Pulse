/** R2 파일 본문 스키마 — Collector가 쓰고 프론트(Worker 프록시 경유)가 읽는 계약.
 *  주의: JSON 필드 순서는 타입이 아니라 쓰는 쪽 객체 리터럴이 결정한다 —
 *  여기 타입 변경은 직렬화 결과를 바꾸지 않아야 한다 (§8.7 내용 해시·CAS 전제). */
import type { EarthquakeRecord, FlightRecord, Iso, LayerId, NewsRecord, WeatherAlertRecord, WorldRecord } from './types';

/** latest.json — 전 레이어 통합 최신 스냅샷 (PLAN §8.6 — LIVE 폴링 1req/폴의 근거).
 *  4레이어 전부 계약 확정 (Phase 0b) — weather/news 기록은 Phase 1 어댑터부터 채워짐
 *  (optional이라 기존 R2 바이트 불변, 하위 호환). */
export interface LatestDoc {
  updatedAt: Iso;
  /** 조립 시점에 누락된 파트 목록 (예: 'weather', 'flight:seoul') — 해당 필드는 생략됨.
   *  optional 추가만 (기존 필드 불변 계약) — 전 파트 존재 시 프로퍼티 자체가 없다. */
  partial?: string[];
  layers: {
    earthquake?: { asOf: Iso; records: EarthquakeRecord[] };
    flight?: { regions: Record<string, { asOf: Iso; records: FlightRecord[] }> };
    weather?: { asOf: Iso; records: WeatherAlertRecord[] };
    news?: { asOf: Iso; records: NewsRecord[] };
  };
}

/** norm/{layer}/dt=/slot=*.g*.json.gz 본문 (collector r2/norm.ts가 발행) */
export interface SlotFileBody<R extends WorldRecord = WorldRecord> {
  layer: LayerId;
  slot: number; // slot 시작 epoch 초 (NORM_SLOT_SEC 정렬)
  slotDurationSec: number;
  generation: number;
  writtenAt: Iso;
  records: R[];
}

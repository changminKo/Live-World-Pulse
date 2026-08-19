/** 수집 오케스트레이션 — 한 invocation = 작업 1개 (분 배정은 schedule.ts MINUTE_TASKS).
 *
 *  CPU 사다리 상태 (2026-08-19 — Free 플랜 하드 10ms/invocation):
 *  - rung ① invocation 분할: 지진 / 항공기 1지역 / weather 페이지 2개 / weather 커밋 /
 *    weather 트랙 / news fetch / news process 를 각각 다른 분에 (schedule.ts).
 *    latest 재조립만 매 분 공통 — byte concat으로 ~0.3ms (r2/latest.ts)
 *  - rung ①-b 2차 분할 (사후 리뷰 High1): 1작업/분으로도 tail이 weather-commit 26ms ·
 *    quake 13ms였다. weather는 **페이지 단위**로 더 쪼갰고(가져온 즉시 정규화 →
 *    커밋은 정규화된 청크만 읽음), quake는 norm 커밋 대상을 현재+직전 슬롯으로 좁혔다.
 *  - rung ② 강등: flight norm = raw-only (FLIGHT_NORM_DEGRADED).
 *    weather TC 트랙 강등은 **해제**됐다 — 전용 트랙 슬롯 + 캐시로 되살렸다
 *    (collectWeatherTracks / applyTcGeometry).
 *  - rung ③ 완화: adsb 반경 250→150nm, 지역당 주기 3분→10분, 지진 1분→20분,
 *    weather 15분→30분. GDACS 페이지 캡은 4→8로 **되돌렸다** (재리뷰 Med2 —
 *    캡이 실데이터를 잘랐고, CPU는 캡이 아니라 분할로 잡는다)
 *  - gzip은 zlib level 1 (gzip.ts 헤더 참조)
 *
 *  지오메트리 범위 (정직 표기 — 재리뷰 High2):
 *  GDACS getgeometry는 **TC(태풍)에만** 트랙·예보콘을 준다. 그래서 구현 범위도 TC 한정이다
 *  — TC는 트랙 LineString + 콘 Polygon(파생 레코드), 그 외 경보(홍수·산불 등)는 Point다.
 *  비TC 경보의 영역 폴리곤은 이벤트당 getgeometry 1콜(수백 콜)이라 $0·10ms 예산에서
 *  수집하지 않는다 — 백로그 (PLAN §4.2). "폴리곤 구현" 주장을 TC 콘으로 한정한다.
 *
 *  지역·단계 격리: 한 지역의 parse/R2/스키마 실패가 다음 지역과
 *  이미 모은 records의 norm 커밋을 중단시키지 않는다.
 *  성공-empty·부분 실패·전면 실패는 manifest/status 원장에 immutable 기록 (실제 빈 세계 vs 갭 구분). */
import { fetchBytes, fetchText, fetchTextWithRetry, sleep } from './http';
import { gunzipToText, gzipText } from './gzip';
import type { Region } from './schedule';
import { normalizeAdsb, pointUrl } from './sources/adsblol';
import { normalizeUsgs, USGS_ALL_HOUR_URL } from './sources/usgs';
import {
  GDACS_ALERT_LEVELS,
  GDACS_PAGE_CAP,
  GDACS_PAGE_SIZE,
  applyTcGeometry,
  buildTcGeometry,
  dedupeGdacs,
  gdacsGeometryUrl,
  gdacsListUrl,
  normalizeGdacsList,
  tcIdsOf,
} from './sources/gdacs';
import type { GdacsAlertLevel, TcIndex, TcTrackCache } from './sources/gdacs';
import {
  GDELT_LASTUPDATE_URL,
  buildNewsRecords,
  extractCsv,
  gdeltRawZipKey,
  parseLastUpdate,
  zipUncompressedSize,
} from './sources/gdelt';
import { mergeById, mergeByRevision, putIfAbsent, upsertNormSlot } from './r2/norm';
import { latestFlightRegionKey, latestLayerKey, putSnapshotIfNewer } from './r2/latest';
import {
  NORM_SLOT_SEC,
  OBSERVATION_BUCKET_SEC,
  TC_INDEX_KEY,
  WEATHER_CYCLE_SEC,
  rawKey,
  slotStartSec,
  statusKey,
  tcTrackKey,
  weatherChunkKey,
  weatherCycleStartMs,
  weatherProgressKey,
} from './slots';
import type { EarthquakeRecord, Env, FlightRecord, LayerId, WeatherAlertRecord } from './types';

const USGS_TIMEOUT_MS = 15_000;
const ADSB_TIMEOUT_MS = 20_000; // 소프트 스로틀로 지연 급증 시 스킵 (재시도 금지)
const USGS_RETRY_DELAY_MS = 2_000;
const ADSB_429_RETRY_DELAY_MS = 10_000; // per-IP 스로틀 실측: 10s 재시도 성공률 40% (2026-08-19 Workers 실측)
const ADSB_CALL_GAP_MS = 5_000; // adsb.lol 모든 콜 간 최소 5s (재시도 포함 — 실측 안전선)

export interface CollectSummary {
  ok: boolean;
  layer: string;
  detail: Record<string, unknown>;
}

export async function collectQuakes(env: Env, scheduledMs: number): Promise<CollectSummary> {
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);

  const res = await fetchTextWithRetry(USGS_ALL_HOUR_URL, USGS_TIMEOUT_MS, USGS_RETRY_DELAY_MS);
  if (!res.ok) {
    const detail = { reason: res.reason, status: res.status };
    await writeStatus(env, 'earthquake', normSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'earthquake', detail };
  }

  try {
    await env.DATA.put(rawKey('usgs', scheduledMs, 'all_hour'), await gzipText(res.text));

    const normalized = normalizeUsgs(JSON.parse(res.text), scheduledMs);
    if (!normalized.ok) {
      // HTTP 200 오류 JSON — latest 보존, 갭으로 기록
      const detail = { reason: 'schema' };
      await writeStatus(env, 'earthquake', normSlot, scheduledMs, 'failed', detail);
      return { ok: false, layer: 'earthquake', detail };
    }
    const { records, dropped } = normalized;

    // occurredAt 기준 900s(15분) norm 슬롯으로 분배 — 내용 불변 슬롯은 해시 판정으로 스킵 (g 유지)
    const bySlot = new Map<number, EarthquakeRecord[]>();
    for (const r of records) {
      const slot = slotStartSec(Date.parse(r.occurredAt), NORM_SLOT_SEC);
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), r]);
    }

    // 커밋 대상은 **현재 + 직전 슬롯만** (사후 리뷰 High1 — CPU).
    // all_hour는 1시간 창이라 예전에는 매 실행이 15분 슬롯 4~5개를 전부 upsert했다
    // (슬롯당 R2 왕복 6회 × 5 = 30회 → 프로덕션 13ms). 스케줄이 20분 주기이고 슬롯이
    // 15분이므로 [현재, 직전] 두 슬롯이면 모든 슬롯이 최소 한 번은 "현재"로,
    // 대부분 다시 "직전"으로 커밋돼 커버리지 손실이 없다.
    // 한계 (정직 표기): 30분보다 오래된 레코드의 사후 정정(revision 증가)은 반영되지
    // 않는다 — USGS 정정 대부분은 수분 내이고, 그 밖은 Phase 2 백필 대상이다.
    const commitSlots = new Set([normSlot, normSlot - NORM_SLOT_SEC]);
    let slotsWritten = 0;
    let slotsSkipped = 0;
    for (const [slot, slotRecords] of bySlot) {
      if (!commitSlots.has(slot)) {
        slotsSkipped += 1;
        continue;
      }
      const outcome = await upsertNormSlot(
        env.DATA,
        'earthquake',
        slot,
        NORM_SLOT_SEC,
        slotRecords,
        mergeByRevision,
        { dropped },
      );
      if (outcome.written) slotsWritten += 1;
    }

    const asOf = new Date(scheduledMs).toISOString();
    await putSnapshotIfNewer(env.DATA, latestLayerKey('earthquake'), asOf, records);

    if (records.length === 0) {
      await writeStatus(env, 'earthquake', normSlot, scheduledMs, 'empty', { dropped });
    }
    return {
      ok: true,
      layer: 'earthquake',
      detail: { records: records.length, dropped, slots: bySlot.size, slotsWritten, slotsSkipped },
    };
  } catch (error: unknown) {
    const detail = { reason: 'exception', error: String(error) };
    await writeStatus(env, 'earthquake', normSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'earthquake', detail };
  }
}

/** CPU 사다리 rung ② (PLAN §8.7 — 2026-08-19 발동, 리뷰 High1):
 *  flight norm 슬롯은 15분간 3,827~9,500 records(2.3~6MB)로 자라 매분
 *  gunzip+parse+merge+stringify+gzip 사이클이 단독 ~18-45ms — Free 하드 10ms
 *  예산에서 어떤 gzip/직렬화 최적화로도 수용 불가 (zlib lvl1 기준 실측).
 *  raw는 슬롯마다 적재 유지(원본 보존·7일 롤링), norm 히스토리는 이 기간 쌓이지 않아
 *  flight Time Machine 불가 — manifest/status 'degraded' + 슬롯 부재 = 갭 밴드로 정직 표시.
 *  재개 조건: Workers Paid(사용자 명시 승인 필수) 또는 슬롯 구조 재설계. */
const FLIGHT_NORM_DEGRADED = true;

/** 항공기 1지역 수집 — 한 invocation의 유일한 작업 (CPU 사다리 rung ①).
 *  기존 "분당 2지역 순차"는 지역당 ~13ms(로컬 실측)라 한 invocation에 둘을 넣는 순간
 *  하드 10ms를 3배 초과했다. 지역 배정은 schedule.ts MINUTE_TASKS가 결정한다. */
export async function collectFlightRegion(
  env: Env,
  scheduledMs: number,
  region: Region,
): Promise<CollectSummary> {
  // ID용 180s 버킷(§5 Observation 계약)과 norm 파일 슬라이스 900s(§8.6)는 별개 — 혼용 금지
  const bucketTs = slotStartSec(scheduledMs, OBSERVATION_BUCKET_SEC);
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  const asOf = new Date(scheduledMs).toISOString();

  let records: FlightRecord[] = [];
  let dropped = 0;
  let detail: Record<string, unknown>;
  let ok = false;

  try {
    // adsb.lol 429는 크레딧 소진이 아니라 per-IP 스로틀 (Workers 공유 IP 실측 2026-08-19)
    // — CLAUDE.md 429 룰의 명시적 예외: 10s 후 1회 재시도 (실측 회수율 40%).
    // timeout은 재시도 금지 유지, 그 외 재시도도 콜 간 최소 5s 준수.
    const res = await fetchText(pointUrl(region), ADSB_TIMEOUT_MS);
    const retried =
      !res.ok && res.reason !== 'timeout'
        ? await (async () => {
            await sleep(res.reason === 'rate_limited' ? ADSB_429_RETRY_DELAY_MS : ADSB_CALL_GAP_MS);
            return fetchText(pointUrl(region), ADSB_TIMEOUT_MS);
          })()
        : null;
    const final = retried ?? res;

    if (!final.ok) {
      detail = { region: region.id, reason: final.reason, status: final.status };
    } else {
      await env.DATA.put(rawKey('adsblol', scheduledMs, region.id), await gzipText(final.text));
      const normalized = normalizeAdsb(JSON.parse(final.text), region, bucketTs, scheduledMs);
      if (!normalized.ok) {
        // HTTP 200 오류 JSON — latest의 이 지역 스냅샷 보존
        detail = { region: region.id, reason: 'schema' };
      } else {
        records = normalized.records;
        dropped = normalized.dropped;
        await putSnapshotIfNewer(env.DATA, latestFlightRegionKey(region.id), asOf, records);
        ok = true;
        detail = { region: region.id, aircraft: records.length, dropped };
      }
    }
  } catch (error: unknown) {
    detail = { region: region.id, reason: 'exception', error: String(error) };
  }

  // norm 커밋 (강등 중에는 스킵 — 위 FLIGHT_NORM_DEGRADED)
  let slotOutcome: Record<string, unknown> = { skipped: true };
  let normCommitFailed = false;
  if (FLIGHT_NORM_DEGRADED) {
    slotOutcome = { degraded: 'raw-only' };
    // 강등 상태를 슬롯당 1회 원장에 기록 — 슬롯 첫 분에만 (중복 엔트리 방지)
    if (scheduledMs % (NORM_SLOT_SEC * 1000) < 60_000) {
      await writeStatus(env, 'flight', normSlot, scheduledMs, 'degraded', {
        reason: 'cpu_ladder_raw_only',
        records: records.length,
      });
    }
  } else if (records.length > 0) {
    try {
      const outcome = await upsertNormSlot(env.DATA, 'flight', normSlot, NORM_SLOT_SEC, records, mergeById, {
        dropped,
      });
      slotOutcome = { written: outcome.written, generation: outcome.generation, records: outcome.records };
    } catch (error: unknown) {
      // 재리뷰 H2 — norm 커밋 실패는 fetch가 성공해도 히스토리 갭:
      // status 원장에 failed(reason: norm_commit)로 남기고 레이어 결과도 ok:false.
      normCommitFailed = true;
      slotOutcome = { ok: false, reason: 'norm_commit', error: String(error) };
    }
  }

  if (!ok || normCommitFailed || records.length === 0) {
    await writeStatus(env, 'flight', normSlot, scheduledMs, !ok || normCommitFailed ? 'failed' : 'empty', {
      ...(normCommitFailed ? { reason: 'norm_commit' } : {}),
      ...detail,
      records: records.length,
      dropped,
    });
  }

  return {
    ok: ok && !normCommitFailed, // 데드맨 스위치 신호 — norm 커밋 실패도 비정상 (재리뷰 H2)
    layer: 'flight',
    detail: { slot: normSlot, bucketTs, ...detail, norm: slotOutcome },
  };
}

const GDACS_TIMEOUT_MS = 15_000;
const GDACS_RETRY_DELAY_MS = 2_000;
/** 페이지 슬롯당 처리 페이지 수 (사후 리뷰 High1 — 분할 단위가 곧 CPU 단위).
 *  **1로 확정 (2026-08-19 프로덕션 실측)**: 슬롯당 2페이지를 넣었더니 Green 2장에서
 *  cpuTime 13ms였다 (작은 Red+Orange 조합은 9ms). 페이지 1장의 [fetch → raw gzip PUT →
 *  JSON.parse → 정규화 → 청크 PUT]이 Workers에서 ~6.5ms이므로 1장이 하드 10ms의
 *  안전선이다 (로컬 bench/slot-cpu.ts 기준 ~1.3ms — 로컬:프로덕션 ≈ 1:5).
 *  대가는 사이클 길이: 8페이지 + 여유 2장을 담으려면 페이지 슬롯 10개가 필요해
 *  weather 사이클이 30분 → 60분이 됐다 (shared WEATHER_CYCLE_SEC 주석). */
const PAGES_PER_SLOT = 1;
/** 사이클 전체 페이지 예산 = PAGES_PER_SLOT × weather-page 슬롯 수(8, schedule.ts).
 *  예산을 다 쓰고도 pending인 레벨은 capped(cycle_budget)로 못박는다 — 그래야 커밋이
 *  "미완주"로 오해해 latest를 영구히 얼리지 않고, 잘림은 partial로 정직하게 남는다. */
const PAGES_PER_CYCLE = PAGES_PER_SLOT * 10;
/** 페이지 fetch 순서 — **작은 레벨 먼저** (Red 1p, Orange 1p, Green 6p 실측 2026-08-19).
 *  예산이 모자랄 때 잘리는 쪽이 항상 Green(가장 경미한 등급)이 되도록 하는 우선순위다.
 *  GDACS_ALERT_LEVELS(등급 오름차순)는 dedupe·표시 순서용이라 그대로 둔다. */
const PAGE_ORDER: readonly GdacsAlertLevel[] = ['Red', 'Orange', 'Green'];
/** 트랙 캐시 유효 창 — 이보다 낡으면 합성하지 않고 Point로 폴백하고 원장에 기록한다.
 *  트랙 슬롯이 시간당 2회 × TC_PER_SLOT건 회전이므로 활성 TC 5건이면 최장 ~2.5시간. */
const TC_CACHE_TTL_MS = 6 * 3600_000;
/** 트랙 슬롯 1회당 getgeometry 콜 수 — 응답이 ~300KB(실측 307KB)라 parse만 프로덕션
 *  ~4ms로 추정된다. 1건 고정 + 회전으로 슬롯 CPU를 예측 가능하게 유지한다. */
const TC_PER_SLOT = 1;

type GdacsLevelState = 'pending' | 'complete' | 'capped' | 'failed';

interface GdacsLevelProgress {
  /** 이 사이클에서 성공적으로 가져와 청크까지 남긴 페이지 수 (1..pages 연속) */
  pages: number;
  /** 누적 current 건수 — 종료 판정·관측용 */
  current: number;
  state: GdacsLevelState;
  reason?: string;
}

/** 사이클 진행 마커 (staging/weather/cycle={cycleStart}/progress.json).
 *  커밋 슬롯의 완주 게이트 — "fetch 3분 뒤면 끝났겠지" 같은 시간 간격 의존을 대체한다
 *  (재리뷰 Med1). 마커가 없거나 pending/failed 레벨이 남아 있으면 커밋은 아무것도
 *  건드리지 않고 다음 사이클로 넘긴다. */
interface WeatherCycleProgress {
  cycleStart: number;
  updatedAt: string;
  levels: Record<string, GdacsLevelProgress>;
}

function freshProgress(cycleStart: number, nowMs: number): WeatherCycleProgress {
  const levels: Record<string, GdacsLevelProgress> = {};
  for (const level of GDACS_ALERT_LEVELS) {
    levels[level] = { pages: 0, current: 0, state: 'pending' };
  }
  return { cycleStart, updatedAt: new Date(nowMs).toISOString(), levels };
}

/** 진행 마커 읽기 — 없거나 손상이면 null (커밋은 null을 "미완주"로 취급) */
async function readWeatherProgress(
  env: Env,
  cycleStart: number,
): Promise<WeatherCycleProgress | null> {
  const obj = await env.DATA.get(weatherProgressKey(cycleStart));
  if (!obj) return null;
  try {
    const parsed = (await obj.json()) as WeatherCycleProgress;
    if (parsed?.cycleStart !== cycleStart || typeof parsed.levels !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

interface GdacsPageOutcome {
  records: WeatherAlertRecord[];
  features: number;
  current: number;
}

/** 페이지 1개: fetch → raw 적재 → **즉시 정규화** → 청크 PUT.
 *  정규화를 여기서 하는 것이 이번 재설계의 핵심이다 — 커밋 슬롯이 원문 810KB를
 *  되읽어 한 번에 파싱하던 구조(프로덕션 26ms)를 페이지 단위로 나눈다.
 *  파싱 총량은 그대로 1회다 (fetch에서 세고 커밋에서 다시 파싱하던 중복도 제거). */
async function fetchGdacsPage(
  env: Env,
  scheduledMs: number,
  cycleStart: number,
  level: GdacsAlertLevel,
  page: number,
): Promise<{ ok: true; outcome: GdacsPageOutcome } | { ok: false; reason: string; status?: number }> {
  const res = await fetchTextWithRetry(gdacsListUrl(level, page), GDACS_TIMEOUT_MS, GDACS_RETRY_DELAY_MS);
  if (!res.ok) return { ok: false, reason: res.reason, status: res.status };

  await env.DATA.put(
    rawKey('gdacs', scheduledMs, `list_${level.toLowerCase()}_p${page}`),
    await gzipText(res.text),
  );

  const parsed = JSON.parse(res.text) as { features?: unknown };
  const features = Array.isArray(parsed.features) ? parsed.features : null;
  if (features === null) return { ok: false, reason: 'schema' };

  const normalized = normalizeGdacsList(parsed, scheduledMs);
  if (!normalized.ok) return { ok: false, reason: 'schema' };

  // current 카운트는 이미 파싱한 객체에서 센다 (텍스트 스캔 불필요 — 종료 판정 근거).
  let current = 0;
  for (const f of features as Array<{ properties?: { iscurrent?: unknown } }>) {
    const v = f?.properties?.iscurrent;
    if (v === 'true' || v === true) current += 1;
  }

  await env.DATA.put(weatherChunkKey(cycleStart, level, page), JSON.stringify(normalized.records));
  return { ok: true, outcome: { records: normalized.records, features: features.length, current } };
}

/** 페이지 종료 판정 — GDACS는 current를 앞쪽 페이지에 정렬해 돌려준다 (실측).
 *  ① feature < 100 → 마지막 페이지 ② current 0 → 이후는 전부 히스토리(커밋이 버린다)
 *  ③ 캡 도달 → capped (잘림을 숨기지 않는다: 원장 page_capped + 커밋 결과 ok:false) */
function nextLevelState(page: number, outcome: GdacsPageOutcome): GdacsLevelState {
  if (outcome.features < GDACS_PAGE_SIZE) return 'complete';
  if (outcome.current === 0) return 'complete';
  if (page >= GDACS_PAGE_CAP) return 'capped';
  return 'pending';
}

/** weather 페이지 슬롯 (schedule.ts weather-page — 사이클당 4개).
 *  진행 마커를 보고 아직 pending인 레벨의 다음 페이지를 PAGES_PER_SLOT개만 처리한다.
 *  전 레벨이 종료 상태면 아무 일도 하지 않는다 (사이클 여유 슬롯). */
export async function collectWeatherPages(env: Env, scheduledMs: number): Promise<CollectSummary> {
  const cycleStart = weatherCycleStartMs(scheduledMs);
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);

  try {
    const existing = await readWeatherProgress(env, cycleStart);
    const base = existing ?? freshProgress(cycleStart, scheduledMs);
    const levels: Record<string, GdacsLevelProgress> = { ...base.levels };
    const processed: Array<Record<string, unknown>> = [];
    let failures = 0;

    for (let n = 0; n < PAGES_PER_SLOT; n += 1) {
      const level = PAGE_ORDER.find((l) => levels[l]?.state === 'pending');
      if (level === undefined) break;
      const lp = levels[level] ?? { pages: 0, current: 0, state: 'pending' as GdacsLevelState };
      const page = lp.pages + 1;
      const result = await fetchGdacsPage(env, scheduledMs, cycleStart, level, page);
      if (!result.ok) {
        // 레벨 실패 = 그 레벨 체인 미완주. 커밋이 latest를 건드리지 않도록 failed로 못박는다
        // (이전 스냅샷 보존 — 부분 데이터로 덮어 활성 경보가 사라지던 회귀 방지).
        levels[level] = { ...lp, state: 'failed', reason: result.reason };
        processed.push({ level, page, ok: false, reason: result.reason, status: result.status });
        failures += 1;
        continue;
      }
      levels[level] = {
        pages: page,
        current: lp.current + result.outcome.current,
        state: nextLevelState(page, result.outcome),
      };
      processed.push({
        level,
        page,
        ok: true,
        records: result.outcome.records.length,
        current: result.outcome.current,
      });
    }

    // 사이클 예산 소진 — 남은 pending은 잘림으로 확정 (커밋이 영구 대기하지 않게)
    const totalPages = GDACS_ALERT_LEVELS.reduce((sum, l) => sum + (levels[l]?.pages ?? 0), 0);
    if (totalPages >= PAGES_PER_CYCLE) {
      for (const level of GDACS_ALERT_LEVELS) {
        const lp = levels[level];
        if (lp?.state === 'pending') levels[level] = { ...lp, state: 'capped', reason: 'cycle_budget' };
      }
    }

    const progress: WeatherCycleProgress = {
      cycleStart,
      updatedAt: new Date(scheduledMs).toISOString(),
      levels,
    };
    await env.DATA.put(weatherProgressKey(cycleStart), JSON.stringify(progress));

    if (failures > 0) {
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'partial', {
        phase: 'page',
        reason: 'page_fetch_failed',
        processed,
      });
    }
    return {
      ok: failures === 0,
      layer: 'weather',
      detail: { phase: 'page', cycleStart, processed, levels },
    };
  } catch (error: unknown) {
    const detail = { phase: 'page', reason: 'exception', error: String(error) };
    await writeStatus(env, 'weather', normSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'weather', detail };
  }
}

/** 커밋 슬롯이 읽어들인 청크 묶음 — 결손이 있으면 latest를 건드리지 않는다 */
interface ChunkRead {
  lists: WeatherAlertRecord[][];
  missing: string[];
  keys: string[];
}

async function readWeatherChunks(
  env: Env,
  cycleStart: number,
  levels: Record<string, GdacsLevelProgress>,
): Promise<ChunkRead> {
  const lists: WeatherAlertRecord[][] = [];
  const missing: string[] = [];
  const keys: string[] = [];
  for (const level of GDACS_ALERT_LEVELS) {
    const pages = levels[level]?.pages ?? 0;
    for (let page = 1; page <= pages; page += 1) {
      const key = weatherChunkKey(cycleStart, level, page);
      keys.push(key);
      const obj = await env.DATA.get(key);
      if (!obj) {
        missing.push(`${level}:p${page}`);
        continue;
      }
      lists.push((await obj.json()) as WeatherAlertRecord[]);
    }
  }
  return { lists, missing, keys };
}

/** 활성 TC에 트랙·콘 합성 — 캐시가 신선할 때만. 결손·낡음은 숨기지 않고 카운트로 보고. */
async function mergeTcGeometry(
  env: Env,
  records: readonly WeatherAlertRecord[],
  nowMs: number,
): Promise<{ records: WeatherAlertRecord[]; tracks: number; cones: number; stale: number; missing: number }> {
  const out: WeatherAlertRecord[] = [];
  const cones: WeatherAlertRecord[] = [];
  let tracks = 0;
  let stale = 0;
  let missing = 0;

  for (const record of records) {
    const isActiveTc = record.payload.gdacsEventType === 'TC' && record.status === 'active';
    const ids = isActiveTc ? tcIdsOf(record) : null;
    if (ids === null) {
      out.push(record);
      continue;
    }
    const obj = await env.DATA.get(tcTrackKey(ids.eventId, ids.episodeId));
    if (!obj) {
      missing += 1;
      out.push(record);
      continue;
    }
    let cache: TcTrackCache | null = null;
    try {
      cache = (await obj.json()) as TcTrackCache;
    } catch {
      cache = null;
    }
    const fetchedAtMs = cache ? Date.parse(cache.fetchedAt) : NaN;
    if (!cache || !Number.isFinite(fetchedAtMs) || nowMs - fetchedAtMs > TC_CACHE_TTL_MS) {
      stale += 1;
      out.push(record);
      continue;
    }
    const applied = applyTcGeometry(record, cache);
    if (applied.record.geometry.type === 'LineString') tracks += 1;
    out.push(applied.record);
    if (applied.cone) cones.push(applied.cone);
  }

  return { records: [...out, ...cones], tracks, cones: cones.length, stale, missing };
}

/** GDACS 커밋 슬롯 (schedule.ts weather-commit — 사이클당 1개, 페이지 슬롯 뒤).
 *  하는 일: 진행 마커 게이트 → 정규화된 청크 union·dedupe → TC 트랙·콘 합성 →
 *  norm 커밋 → latest 교체 → tc-index 발행 → 스테이징 삭제.
 *  **원문을 다시 파싱하지 않는다** (페이지 슬롯이 이미 정규화했다 — High1의 핵심).
 *
 *  게이트 규칙 (재리뷰 Med1 — 시간 간격 의존 제거):
 *  - 마커 없음 / pending·failed 레벨 있음 / 청크 결손 → **아무것도 쓰지 않고** partial 기록.
 *    다음 사이클이 처음부터 재시도한다 (인라인 재fetch 복구 경로 폐기 — 그 경로가
 *    fetch+커밋을 한 분에 겹쳐 CPU 초과를 만들던 원인이기도 했다).
 *  - capped 레벨 있음 → 데이터는 싣지만 결과는 ok:false + 원장 partial (재리뷰 Med2:
 *    잘림을 ok로 기록하지 않는다). */
export async function collectWeatherCommit(env: Env, scheduledMs: number): Promise<CollectSummary> {
  const cycleStart = weatherCycleStartMs(scheduledMs);
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  const asOf = new Date(scheduledMs).toISOString();

  try {
    const progress = await readWeatherProgress(env, cycleStart);
    if (progress === null) {
      const detail = { phase: 'commit', reason: 'no_progress', cycleStart };
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'partial', detail);
      return { ok: false, layer: 'weather', detail };
    }

    const unfinished = GDACS_ALERT_LEVELS.filter((l) => {
      const state = progress.levels[l]?.state;
      return state === undefined || state === 'pending' || state === 'failed';
    });
    if (unfinished.length > 0) {
      const detail = {
        phase: 'commit',
        reason: 'chain_incomplete',
        cycleStart,
        unfinished,
        levels: progress.levels,
      };
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'partial', detail);
      return { ok: false, layer: 'weather', detail };
    }

    const chunks = await readWeatherChunks(env, cycleStart, progress.levels);
    if (chunks.missing.length > 0) {
      const detail = { phase: 'commit', reason: 'chunk_missing', cycleStart, missing: chunks.missing };
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'partial', detail);
      return { ok: false, layer: 'weather', detail };
    }

    const deduped = dedupeGdacs(chunks.lists);
    const merged = await mergeTcGeometry(env, deduped, scheduledMs);
    const activeTcs = deduped.filter((r) => r.payload.gdacsEventType === 'TC' && r.status === 'active');

    const outcome = await upsertNormSlot(
      env.DATA,
      'weather',
      normSlot,
      NORM_SLOT_SEC,
      merged.records,
      mergeByRevision,
      { dropped: 0 },
    );
    await putSnapshotIfNewer(env.DATA, latestLayerKey('weather'), asOf, merged.records);

    // 트랙 슬롯이 회전 대상으로 읽는 작은 인덱스 (latest 200KB를 다시 파싱하지 않기 위해)
    const index: TcIndex = {
      updatedAt: asOf,
      tcs: activeTcs.flatMap((r) => {
        const ids = tcIdsOf(r);
        return ids ? [{ eventId: ids.eventId, episodeId: ids.episodeId, name: r.payload.event }] : [];
      }),
    };
    await env.DATA.put(TC_INDEX_KEY, JSON.stringify(index));

    // 스테이징 정리 — 실패해도 수집 결과를 뒤집지 않는다 (잔재는 daily scan이 청소)
    await Promise.all(
      [...chunks.keys, weatherProgressKey(cycleStart)].map((key) =>
        env.DATA.delete(key).catch(() => undefined),
      ),
    );

    const capped = GDACS_ALERT_LEVELS.filter((l) => progress.levels[l]?.state === 'capped');
    if (capped.length > 0) {
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'partial', {
        phase: 'commit',
        reason: 'page_capped',
        capped,
        records: merged.records.length,
      });
    }
    if (merged.stale > 0 || merged.missing > 0) {
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'degraded', {
        phase: 'commit',
        reason: 'tc_track_cache',
        stale: merged.stale,
        missing: merged.missing,
        activeTcs: activeTcs.length,
      });
    }
    if (merged.records.length === 0) {
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'empty', {
        phase: 'commit',
        pages: chunks.keys.length,
      });
    }

    return {
      ok: capped.length === 0,
      layer: 'weather',
      detail: {
        phase: 'commit',
        cycleStart,
        slot: normSlot,
        pages: chunks.keys.length,
        records: merged.records.length,
        activeTcs: activeTcs.length,
        tracks: merged.tracks,
        cones: merged.cones,
        trackCacheStale: merged.stale,
        trackCacheMissing: merged.missing,
        ...(capped.length > 0 ? { capped } : {}),
        norm: { written: outcome.written, generation: outcome.generation, records: outcome.records },
      },
    };
  } catch (error: unknown) {
    const detail = { phase: 'commit', reason: 'exception', error: String(error) };
    await writeStatus(env, 'weather', normSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'weather', detail };
  }
}

/** TC 트랙 슬롯 (schedule.ts weather-track — 시간당 2회, 커밋 뒤).
 *  커밋이 발행한 tc-index를 회전하며 TC_PER_SLOT건의 getgeometry를 가져와
 *  트랙 LineString + 예보콘 Polygon을 캐시한다 (커밋이 다음 사이클에 합성).
 *
 *  왜 별 슬롯인가 (재리뷰 High2 — 이전 강등 해제):
 *  getgeometry 응답은 실측 307KB이고 parse만으로 커밋 슬롯 예산을 먹었다. 커밋에서
 *  떼어내 1건씩 회전시키면 슬롯 CPU가 예측 가능해진다. 대가는 트랙 신선도 —
 *  활성 TC N건이면 갱신 주기가 30분 × N이다 (N=5면 2.5시간). TC 트랙은 3~6시간마다
 *  점이 하나 붙는 데이터라 수용 가능하고, 캐시가 TC_CACHE_TTL_MS를 넘기면
 *  합성하지 않고 Point로 폴백하며 원장에 degraded로 남는다. */
export async function collectWeatherTracks(env: Env, scheduledMs: number): Promise<CollectSummary> {
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);

  try {
    const obj = await env.DATA.get(TC_INDEX_KEY);
    if (!obj) {
      return { ok: true, layer: 'weather', detail: { phase: 'track', reason: 'no_index' } };
    }
    const index = (await obj.json()) as TcIndex;
    const tcs = Array.isArray(index?.tcs) ? index.tcs : [];
    if (tcs.length === 0) {
      return { ok: true, layer: 'weather', detail: { phase: 'track', tcs: 0 } };
    }

    // 회전: 트랙 슬롯은 30분마다 한 번 오므로 사이클 인덱스를 그대로 오프셋으로 쓴다
    const cycle = Math.floor(scheduledMs / (WEATHER_CYCLE_SEC * 1000));
    const fetched: Array<Record<string, unknown>> = [];
    let failures = 0;

    for (let n = 0; n < TC_PER_SLOT; n += 1) {
      const target = tcs[(cycle + n) % tcs.length];
      if (!target) break;
      const res = await fetchTextWithRetry(
        gdacsGeometryUrl('TC', target.eventId, target.episodeId),
        GDACS_TIMEOUT_MS,
        GDACS_RETRY_DELAY_MS,
      );
      if (!res.ok) {
        failures += 1;
        fetched.push({ eventId: target.eventId, ok: false, reason: res.reason, status: res.status });
        continue;
      }
      const geometry = buildTcGeometry(JSON.parse(res.text));
      const cache: TcTrackCache = {
        eventId: target.eventId,
        episodeId: target.episodeId,
        fetchedAt: new Date(scheduledMs).toISOString(),
        track: geometry.track,
        cone: geometry.cone,
        centroid: geometry.centroid,
      };
      await env.DATA.put(tcTrackKey(target.eventId, target.episodeId), JSON.stringify(cache));
      fetched.push({
        eventId: target.eventId,
        episodeId: target.episodeId,
        ok: true,
        trackPoints: geometry.track?.coordinates.length ?? 0,
        conePoints: geometry.cone?.coordinates[0]?.length ?? 0,
      });
    }

    if (failures > 0) {
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'partial', {
        phase: 'track',
        reason: 'geometry_fetch_failed',
        fetched,
      });
    }
    return { ok: failures === 0, layer: 'weather', detail: { phase: 'track', tcs: tcs.length, fetched } };
  } catch (error: unknown) {
    const detail = { phase: 'track', reason: 'exception', error: String(error) };
    await writeStatus(env, 'weather', normSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'weather', detail };
  }
}

const GDELT_TIMEOUT_MS = 15_000;
const GDELT_ZIP_TIMEOUT_MS = 30_000;
const GDELT_RETRY_DELAY_MS = 2_000;
/** news 파싱 팻파일 가드 — 해제 CSV가 이 크기를 넘으면 raw-only 강등 (unzip+스캔 CPU 폭주 방어.
 *  실측: 공식 masterfilelist 395,845개 중 최대 해제 22.6MB — 스캔만 ~20ms로 하드 한도 초과.
 *  2026-08-19 재조정 8MB → 2MB: 평시 export CSV는 447KB이고(실측) 전체 경로가 ~3ms다.
 *  2MB면 평시의 4배까지 허용하면서 하드 10ms 안에 남는다. */
const MAX_NEWS_CSV_BYTES = 2 * 1024 * 1024;

/** GDELT fetch 슬롯 (schedule.ts news-fetch) — lastupdate → export zip → raw PUT만.
 *  파싱·norm 커밋은 2분 뒤 news-process 슬롯이 raw zip을 되읽어 수행 (CPU 분할).
 *  멱등: 파일 타임스탬프 결정론 키 + putIfAbsent — 같은 파일 재적재 스킵. */
export async function collectNews(env: Env, scheduledMs: number): Promise<CollectSummary> {
  const fallbackSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);

  const last = await fetchTextWithRetry(GDELT_LASTUPDATE_URL, GDELT_TIMEOUT_MS, GDELT_RETRY_DELAY_MS);
  if (!last.ok) {
    const detail = { phase: 'fetch', step: 'lastupdate', reason: last.reason, status: last.status };
    await writeStatus(env, 'news', fallbackSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'news', detail };
  }
  const ref = parseLastUpdate(last.text);
  if (!ref) {
    const detail = { phase: 'fetch', step: 'lastupdate-parse', reason: 'schema' };
    await writeStatus(env, 'news', fallbackSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'news', detail };
  }

  // norm 슬롯·멱등 키는 스케줄 시각이 아니라 파일 타임스탬프 기준 (파일 단위 계약)
  const normSlot = slotStartSec(ref.fileMs, NORM_SLOT_SEC);

  try {
    const zip = await fetchBytes(ref.url, GDELT_ZIP_TIMEOUT_MS);
    if (!zip.ok) {
      const detail = { phase: 'fetch', step: 'download', reason: zip.reason, status: zip.status, file: ref.url };
      await writeStatus(env, 'news', normSlot, scheduledMs, 'failed', detail);
      return { ok: false, layer: 'news', detail };
    }

    // 원본 zip 그대로 적재 (이미 압축 — 재압축 없음). 결정론 키 + putIfAbsent = 중복 스킵
    const rawWritten = await putIfAbsent(env.DATA, gdeltRawZipKey(ref.fileMs), zip.bytes);

    return {
      ok: true,
      layer: 'news',
      detail: { phase: 'fetch', slot: normSlot, file: ref.url, bytes: zip.bytes.byteLength, rawWritten },
    };
  } catch (error: unknown) {
    const detail = { phase: 'fetch', reason: 'exception', error: String(error), file: ref.url };
    await writeStatus(env, 'news', normSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'news', detail };
  }
}

/** GDELT 처리 슬롯 (schedule.ts news-process) — raw zip 되읽기(없으면 재fetch 복구) → unzip → 셀 집계 →
 *  norm 커밋 + latest. 해제 크기 가드 초과 파일은 raw-only 강등 (원본은 이미 보존됨). */
export async function collectNewsProcess(env: Env, scheduledMs: number): Promise<CollectSummary> {
  const fallbackSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);

  const last = await fetchTextWithRetry(GDELT_LASTUPDATE_URL, GDELT_TIMEOUT_MS, GDELT_RETRY_DELAY_MS);
  if (!last.ok) {
    const detail = { phase: 'process', step: 'lastupdate', reason: last.reason, status: last.status };
    await writeStatus(env, 'news', fallbackSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'news', detail };
  }
  const ref = parseLastUpdate(last.text);
  if (!ref) {
    const detail = { phase: 'process', step: 'lastupdate-parse', reason: 'schema' };
    await writeStatus(env, 'news', fallbackSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'news', detail };
  }
  const normSlot = slotStartSec(ref.fileMs, NORM_SLOT_SEC);

  try {
    // fetch 단계가 적재한 raw zip 우선 — 없으면(그 분이 죽음) 업스트림 재fetch로 복구
    let zipBytes: Uint8Array | null = null;
    let recovered = false;
    const rawObj = await env.DATA.get(gdeltRawZipKey(ref.fileMs));
    if (rawObj) {
      zipBytes = new Uint8Array(await rawObj.arrayBuffer());
    } else {
      recovered = true;
      const zip = await fetchBytes(ref.url, GDELT_ZIP_TIMEOUT_MS);
      if (!zip.ok) {
        const detail = { phase: 'process', step: 'download', reason: zip.reason, status: zip.status, file: ref.url };
        await writeStatus(env, 'news', normSlot, scheduledMs, 'failed', detail);
        return { ok: false, layer: 'news', detail };
      }
      await putIfAbsent(env.DATA, gdeltRawZipKey(ref.fileMs), zip.bytes);
      zipBytes = new Uint8Array(zip.bytes);
    }

    // CPU 팻파일 가드 — 해제 전에 central directory 크기로 판정 (raw는 보존, 파싱만 강등)
    const uncompressed = zipUncompressedSize(zipBytes);
    if (uncompressed !== null && uncompressed > MAX_NEWS_CSV_BYTES) {
      const detail = { phase: 'process', reason: 'too_large', uncompressed, file: ref.url };
      await writeStatus(env, 'news', normSlot, scheduledMs, 'degraded', detail);
      return { ok: false, layer: 'news', detail };
    }

    const csv = extractCsv(zipBytes);
    if (csv === null) {
      // zip 구조 이상 — raw는 이미 적재됨 (사다리: 원본 보존, 파싱만 실패로 기록)
      const detail = { phase: 'process', step: 'unzip', reason: 'schema', file: ref.url };
      await writeStatus(env, 'news', normSlot, scheduledMs, 'failed', detail);
      return { ok: false, layer: 'news', detail };
    }

    // 원장·로그에 입력 규모를 남긴다 (High1 후속): 이 슬롯의 CPU는 **행 수에 비례**하므로
    // tail의 cpuTime을 파일 크기와 대조할 수 있어야 원인을 판정할 수 있다.
    const csvBytes = csv.length;
    const { records, dropped, rows } = buildNewsRecords(csv, ref.fileMs, scheduledMs);

    const outcome = await upsertNormSlot(env.DATA, 'news', normSlot, NORM_SLOT_SEC, records, mergeById, {
      dropped,
    });
    // asOf = 파일 시각 — 같은 파일 재처리는 단조 가드로 자연 스킵
    await putSnapshotIfNewer(env.DATA, latestLayerKey('news'), new Date(ref.fileMs).toISOString(), records);

    if (records.length === 0) {
      await writeStatus(env, 'news', normSlot, scheduledMs, 'empty', { phase: 'process', rows, dropped, file: ref.url });
    }
    return {
      ok: true,
      layer: 'news',
      detail: {
        phase: 'process',
        slot: normSlot,
        file: ref.url,
        rows,
        csvBytes,
        cells: records.length,
        dropped,
        recovered,
        norm: { written: outcome.written, generation: outcome.generation, records: outcome.records },
      },
    };
  } catch (error: unknown) {
    const detail = { phase: 'process', reason: 'exception', error: String(error), file: ref.url };
    await writeStatus(env, 'news', normSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'news', detail };
  }
}

type StatusOutcome = 'empty' | 'partial' | 'failed' | 'degraded';

/** 같은 scheduledMs의 기록 시도(cron 재전달·중복 실행)를 구분하는 attempt 상한 —
 *  실제로는 0~1이 정상, 상한 도달은 그 자체가 이상 신호라 로그만 남긴다 */
const MAX_STATUS_ATTEMPTS = 8;

/** immutable 상태 원장 — putIfAbsent + attempt 순번 키 (unconditional PUT 금지, 이전 리뷰 Med).
 *  같은 scheduledMs가 겹쳐도 기존 기록을 덮지 않고 a{n+1}로 비켜 쓴다.
 *  원장 기록 실패가 수집 결과를 뒤집으면 안 되므로 예외는 삼키고 로그만 남긴다. */
async function writeStatus(
  env: Env,
  layer: LayerId,
  slot: number,
  scheduledMs: number,
  outcome: StatusOutcome,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    const body = JSON.stringify({
      layer,
      slot,
      scheduledMs,
      outcome,
      writtenAt: new Date().toISOString(),
      detail,
    });
    for (let attempt = 0; attempt < MAX_STATUS_ATTEMPTS; attempt += 1) {
      if (await putIfAbsent(env.DATA, statusKey(layer, slot, scheduledMs, attempt), body)) return;
    }
    console.log(JSON.stringify({ statusWriteFailed: { layer, slot, reason: 'attempts_exhausted' } }));
  } catch (error: unknown) {
    console.log(JSON.stringify({ statusWriteFailed: { layer, slot, error: String(error) } }));
  }
}

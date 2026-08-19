/** 수집 오케스트레이션 — 한 invocation = 작업 1개 (분 배정은 schedule.ts MINUTE_TASKS).
 *
 *  CPU 사다리 발동 상태 (2026-08-19 — Free 플랜 하드 10ms/invocation, tail 100% exceededCpu):
 *  - rung ① invocation 분할 극대화: 지진 / 항공기 1지역 / weather fetch / weather commit /
 *    news fetch / news process 를 각각 다른 분에 (schedule.ts). latest 재조립만 매 분
 *    공통 — byte concat으로 ~0.3ms (r2/latest.ts)
 *  - rung ② 강등: flight norm = raw-only, weather TC 트랙 enrich 중단 (아래 각 플래그)
 *  - rung ③ 완화: adsb 반경 250→150nm, GDACS 레벨당 페이지 캡 10→2,
 *    지역당 주기 3분→10분, 지진 1분→10분, weather 15분→30분
 *  - gzip은 zlib level 1 (gzip.ts 헤더 참조)
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
  dedupeGdacs,
  gdacsListUrl,
  normalizeGdacsList,
  scanGdacsPage,
} from './sources/gdacs';
import type { GdacsAlertLevel } from './sources/gdacs';
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
import { NORM_SLOT_SEC, OBSERVATION_BUCKET_SEC, rawKey, slotStartSec, statusKey } from './slots';
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

    let slotsWritten = 0;
    for (const [slot, slotRecords] of bySlot) {
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
      detail: { records: records.length, dropped, slots: bySlot.size, slotsWritten },
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
/** CPU 사다리 rung ② 강등 (2026-08-19): TC 트랙 getgeometry 응답이 225~510KB —
 *  parse + ring centroid 계산만 태풍 1건당 ~3ms(실측 추정)라 커밋 슬롯 예산을 단독으로
 *  먹었다. 경보 자체(Point·등급·기간)는 그대로 살아 있고 트랙 LineString만 없다.
 *  status 원장에 degraded(reason: tc_track_disabled)로 기록 — 숨기지 않는다.
 *  재개 조건: Workers Paid(사용자 명시 승인) 또는 트랙 전용 슬롯 신설. */
const WEATHER_TC_TRACK_DEGRADED = true;
const GDELT_TIMEOUT_MS = 15_000;
const GDELT_ZIP_TIMEOUT_MS = 30_000;
const GDELT_RETRY_DELAY_MS = 2_000;
/** news 파싱 팻파일 가드 — 해제 CSV가 이 크기를 넘으면 raw-only 강등 (unzip+스캔 CPU 폭주 방어.
 *  실측: 공식 masterfilelist 395,845개 중 최대 해제 22.6MB — 스캔만 ~20ms로 하드 한도 초과.
 *  2026-08-19 재조정 8MB → 2MB: 평시 export CSV는 447KB이고(실측) 전체 경로가 ~3ms다.
 *  2MB면 평시의 4배까지 허용하면서 하드 10ms 안에 남는다. */
const MAX_NEWS_CSV_BYTES = 2 * 1024 * 1024;

interface GdacsRawFetch {
  perLevel: Record<string, unknown>;
  okLevels: number;
  cappedLevels: string[];
  pages: number;
}

/** GDACS fetch 단계 — 페이징 fetch + raw 적재 + 체인 완주 마커. **정규화하지 않는다.**
 *  이전 판은 여기서 normalizeGdacsList를 돌리고 커밋 슬롯이 raw를 되읽어 또 돌렸다
 *  (동일 작업 2회). 정규화는 커밋 슬롯에서 한 번만 — 페이징 종료 판정은 parse 없는
 *  scanGdacsPage로 대체한다 (CPU 사다리 rung ①).
 *  종료 조건 두 가지: ① 페이지의 feature가 100 미만(마지막 페이지)
 *  ② current가 0 (GDACS는 current를 앞쪽 페이지에 정렬 — 뒤는 히스토리라 커밋이 버린다).
 *  페이지 실패 시 그 레벨은 ok:false (이미 적재한 페이지는 유지 — 커밋의 union엔 무해). */
async function fetchGdacsRawPages(env: Env, scheduledMs: number): Promise<GdacsRawFetch> {
  const perLevel: Record<string, unknown> = {};
  let okLevels = 0;
  let totalPages = 0;
  const cappedLevels: string[] = [];

  for (const level of GDACS_ALERT_LEVELS) {
    let pages = 0;
    let current = 0;
    let levelOk = true;
    let capped = false;
    const completeKey = rawKey('gdacs', scheduledMs, `list_${level.toLowerCase()}_complete`);
    try {
      // Med2 — 재시도(같은 scheduledMs cron 재전달) 시작 시 기존 마커 선무효화:
      // 이전 시도의 complete 마커가 남은 채 이번 체인이 중간 실패하면, 페이지가
      // 신구 세대로 섞였는데 커밋이 complete로 오인해 latest를 덮는다.
      await env.DATA.delete(completeKey);
      for (let page = 1; page <= GDACS_PAGE_CAP; page += 1) {
        const res = await fetchTextWithRetry(gdacsListUrl(level, page), GDACS_TIMEOUT_MS, GDACS_RETRY_DELAY_MS);
        if (!res.ok) {
          levelOk = false;
          perLevel[level] = { ok: false, reason: res.reason, status: res.status, pages };
          break;
        }
        await env.DATA.put(
          rawKey('gdacs', scheduledMs, `list_${level.toLowerCase()}_p${page}`),
          await gzipText(res.text),
        );
        const scan = scanGdacsPage(res.text);
        pages += 1;
        current += scan.current;
        if (scan.features < GDACS_PAGE_SIZE) break; // 마지막 페이지
        if (scan.current === 0) break; // 이후 페이지는 전부 히스토리
        if (page === GDACS_PAGE_CAP) {
          capped = true; // 캡 도달인데 아직 current가 남았다 — 잘림 (숨기지 않는다)
          cappedLevels.push(level);
        }
      }
      // 재리뷰 High2: 체인 완주 마커 — 커밋 단계는 이 마커가 있는 레벨만 complete로
      // 인정한다. 중간 페이지 실패 슬롯은 raw 일부가 남아도 마커가 없어 latest 갱신에서
      // 제외 (이전 스냅샷 유지). 마커 PUT 실패는 catch로 떨어져 incomplete 취급.
      // Med2: body에 세대(scheduledMs)·페이지 수를 넣어 커밋이 실제 raw와 대조한다.
      if (levelOk) {
        await env.DATA.put(completeKey, await gzipText(JSON.stringify({ scheduledMs, pages })));
      }
    } catch (error: unknown) {
      levelOk = false;
      perLevel[level] = { ok: false, reason: 'exception', error: String(error), pages };
    }
    totalPages += pages;
    if (levelOk) {
      okLevels += 1;
      perLevel[level] = { ok: true, pages, current, ...(capped ? { capped } : {}) };
    }
  }

  return { perLevel, okLevels, cappedLevels, pages: totalPages };
}

/** GDACS fetch 슬롯 (schedule.ts weather-fetch) — raw 적재 전용.
 *  norm 커밋·latest 교체는 3분 뒤 weather-commit 슬롯이 raw를 되읽어 수행 (CPU 분할). */
export async function collectWeather(env: Env, scheduledMs: number): Promise<CollectSummary> {
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);

  try {
    const { perLevel, okLevels, cappedLevels, pages } = await fetchGdacsRawPages(env, scheduledMs);

    if (okLevels === 0) {
      const detail = { phase: 'fetch', reason: 'all_levels_failed', levels: perLevel };
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'failed', detail);
      return { ok: false, layer: 'weather', detail };
    }

    const partial = okLevels < GDACS_ALERT_LEVELS.length;
    if (partial || cappedLevels.length > 0) {
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'partial', {
        phase: 'fetch',
        ...(cappedLevels.length > 0 ? { reason: 'page_capped', capped: cappedLevels } : {}),
        levels: perLevel,
      });
    }
    return {
      ok: !partial,
      layer: 'weather',
      detail: {
        phase: 'fetch',
        slot: normSlot,
        levels: perLevel,
        pages,
        ...(cappedLevels.length > 0 ? { capped: cappedLevels } : {}),
      },
    };
  } catch (error: unknown) {
    const detail = { phase: 'fetch', reason: 'exception', error: String(error) };
    await writeStatus(env, 'weather', normSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'weather', detail };
  }
}

/** raw 키 basename의 epochMs 파싱 — `{epochMs}-list_{level}_p{n}.json.gz` */
const GDACS_RAW_LIST_RE = /\/(\d{13})-list_([a-z]+)_p(\d+)\.json\.gz$/;
/** 레벨 체인 완주 마커 — fetch 단계가 페이지 체인을 끝까지 성공했을 때만 남긴다 (재리뷰 High2) */
const GDACS_RAW_COMPLETE_RE = /\/(\d{13})-list_([a-z]+)_complete\.json\.gz$/;

interface GdacsSlotRaw {
  pageKeys: Array<{ key: string; epochMs: number; level: string; page: number }>;
  /** 체인 완주가 검증된 레벨(소문자) — latest 교체 게이트 */
  completeLevels: Set<string>;
}

/** 이 norm 슬롯에 적재된 GDACS raw 페이지 + 검증된 완주 레벨 발견.
 *  키가 scheduledMs 스탬프라 dt/hour prefix LIST로 찾고 슬롯 창으로 걸러낸다.
 *  재리뷰 High2: latest 갱신 게이트는 "raw 페이지가 있다"가 아니라 "체인 완주 마커"
 *  기준 — 중간 페이지 실패 슬롯의 부분 raw를 complete로 오인해 latest를 불완전
 *  데이터로 덮던 회귀의 수정. norm 커밋은 union이라 부분 raw도 그대로 싣는다.
 *  Med2: 마커는 존재만으로 complete가 아니다 — body의 세대(scheduledMs)·페이지 수가
 *  실제 raw 페이지(같은 세대, 1..pages 연속)와 일치할 때만 인정. */
async function discoverGdacsSlotRaw(env: Env, normSlot: number): Promise<GdacsSlotRaw> {
  const slotMsMin = normSlot * 1000;
  const slotMsMax = slotMsMin + NORM_SLOT_SEC * 1000;
  const dt = new Date(slotMsMin).toISOString().slice(0, 10);
  const hour = new Date(slotMsMin).toISOString().slice(11, 13);
  const prefix = `raw/gdacs/dt=${dt}/hour=${hour}/`;

  const pageKeys: GdacsSlotRaw['pageKeys'] = [];
  const markerKeys: Array<{ key: string; epochMs: number; level: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await env.DATA.list({ prefix, cursor });
    for (const obj of page.objects) {
      const m = GDACS_RAW_LIST_RE.exec(obj.key);
      if (m) {
        const epochMs = Number(m[1]);
        if (epochMs >= slotMsMin && epochMs < slotMsMax) {
          pageKeys.push({ key: obj.key, epochMs, level: m[2] ?? '', page: Number(m[3]) });
        }
        continue;
      }
      const c = GDACS_RAW_COMPLETE_RE.exec(obj.key);
      if (c) {
        const epochMs = Number(c[1]);
        if (epochMs >= slotMsMin && epochMs < slotMsMax) {
          markerKeys.push({ key: obj.key, epochMs, level: c[2] ?? '' });
        }
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const completeLevels = new Set<string>();
  for (const marker of markerKeys) {
    try {
      const obj = await env.DATA.get(marker.key);
      if (!obj) continue;
      const body = JSON.parse(await gunzipToText(await obj.arrayBuffer())) as {
        scheduledMs?: unknown;
        pages?: unknown;
      };
      const pages = typeof body.pages === 'number' ? body.pages : 0;
      if (typeof body.scheduledMs !== 'number' || body.scheduledMs !== marker.epochMs) continue;
      if (pages < 1) continue;
      const genPages = new Set(
        pageKeys.filter((p) => p.level === marker.level && p.epochMs === marker.epochMs).map((p) => p.page),
      );
      const chainIntact =
        genPages.size === pages && Array.from({ length: pages }, (_, i) => i + 1).every((n) => genPages.has(n));
      if (chainIntact) completeLevels.add(marker.level);
    } catch {
      // 마커 손상/gunzip 실패 — incomplete 취급 (보수적 방향)
    }
  }
  return { pageKeys, completeLevels };
}

/** GDACS norm 커밋 슬롯 (schedule.ts weather-commit, fetch 3분 뒤) — 이번 슬롯의 raw
 *  페이지를 되읽어 정규화·dedupe → norm 커밋 → latest 교체. 정규화는 파이프라인 전체에서
 *  여기 한 번만 돈다 (fetch 슬롯은 raw 적재 전용).
 *  TC 트랙 enrich는 rung ② 강등으로 비활성 (WEATHER_TC_TRACK_DEGRADED 참조).
 *  fetch 슬롯이 통째로 죽었으면 raw를 인라인 재fetch해 복구한다 — 그 분은 fetch+커밋을
 *  겹쳐 하므로 CPU 초과 위험이 있는 복구 전용 경로다 (정상 경로에선 발생하지 않는다). */
export async function collectWeatherCommit(env: Env, scheduledMs: number): Promise<CollectSummary> {
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  const asOf = new Date(scheduledMs).toISOString();

  try {
    const discovered = await discoverGdacsSlotRaw(env, normSlot);
    const pageKeys = discovered.pageKeys;
    const completeLevels = discovered.completeLevels;

    let recovered = false;
    if (pageKeys.length === 0) {
      // fetch 슬롯이 이 슬롯에 raw를 남기지 못함 — raw를 인라인으로 채운 뒤 되읽는다
      // (정규화 경로를 한 곳으로 유지 — 복구 경로만 fetch+커밋이 같은 분에 겹친다)
      recovered = true;
      const fetched = await fetchGdacsRawPages(env, scheduledMs);
      if (fetched.okLevels === 0) {
        const detail = { phase: 'commit', reason: 'no_raw_and_refetch_failed', levels: fetched.perLevel };
        await writeStatus(env, 'weather', normSlot, scheduledMs, 'failed', detail);
        return { ok: false, layer: 'weather', detail };
      }
      const rediscovered = await discoverGdacsSlotRaw(env, normSlot);
      pageKeys.push(...rediscovered.pageKeys);
      completeLevels.clear();
      for (const level of rediscovered.completeLevels) completeLevels.add(level);
      if (pageKeys.length === 0) {
        const detail = { phase: 'commit', reason: 'no_raw_after_refetch', levels: fetched.perLevel };
        await writeStatus(env, 'weather', normSlot, scheduledMs, 'failed', detail);
        return { ok: false, layer: 'weather', detail };
      }
    }

    const lists: WeatherAlertRecord[][] = [];
    for (const { key, epochMs } of pageKeys) {
      const obj = await env.DATA.get(key);
      if (!obj) continue;
      const parsed = JSON.parse(await gunzipToText(await obj.arrayBuffer()));
      // ingestedAt = 실제 fetch 시각 (raw 키 스탬프) — 유예 창 판정도 그 시점 기준
      const normalized = normalizeGdacsList(parsed, epochMs);
      if (normalized.ok) lists.push(normalized.records);
    }
    const patched = dedupeGdacs(lists);

    // rung ② 강등 — TC 트랙 enrich 없음. 활성 TC 수만 원장·로그에 남긴다.
    const activeTcs = patched.filter((r) => r.payload.gdacsEventType === 'TC' && r.status === 'active');
    if (WEATHER_TC_TRACK_DEGRADED && activeTcs.length > 0) {
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'degraded', {
        phase: 'commit',
        reason: 'tc_track_disabled',
        activeTcs: activeTcs.length,
      });
    }

    const outcome = await upsertNormSlot(env.DATA, 'weather', normSlot, NORM_SLOT_SEC, patched, mergeByRevision, {
      dropped: 0,
    });

    // latest 교체 — 전 레벨 체인 완주 마커가 있을 때만 (재리뷰 High2:
    // 부분 fetch 슬롯에서 실패 레벨 경보가 latest에서 사라지는 회귀 방지 —
    // 이전 스냅샷 유지. norm은 union이라 무해)
    const incompleteLevels = GDACS_ALERT_LEVELS.filter((l) => !completeLevels.has(l.toLowerCase()));
    if (incompleteLevels.length === 0) {
      await putSnapshotIfNewer(env.DATA, latestLayerKey('weather'), asOf, patched);
    } else {
      // incomplete 슬롯은 원장에 partial 기록 — latest 미갱신 사유의 정직 표시
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'partial', {
        phase: 'commit',
        reason: 'incomplete_levels',
        incomplete: incompleteLevels,
        pages: pageKeys.length,
      });
    }

    if (patched.length === 0 && incompleteLevels.length === 0) {
      await writeStatus(env, 'weather', normSlot, scheduledMs, 'empty', { phase: 'commit', pages: pageKeys.length });
    }
    return {
      ok: true,
      layer: 'weather',
      detail: {
        phase: 'commit',
        slot: normSlot,
        pages: pageKeys.length,
        recovered,
        records: patched.length,
        ...(incompleteLevels.length > 0 ? { incomplete: incompleteLevels, latestSkipped: true } : {}),
        activeTcs: activeTcs.length,
        ...(WEATHER_TC_TRACK_DEGRADED ? { tracks: 'degraded' } : {}),
        norm: { written: outcome.written, generation: outcome.generation, records: outcome.records },
      },
    };
  } catch (error: unknown) {
    const detail = { phase: 'commit', reason: 'exception', error: String(error) };
    await writeStatus(env, 'weather', normSlot, scheduledMs, 'failed', detail);
    return { ok: false, layer: 'weather', detail };
  }
}

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

/** 수집 오케스트레이션 — 지진(매분) + 항공기(m%3 지역 2개 순차).
 *  지역·단계 격리: 한 지역의 parse/R2/스키마 실패가 다음 지역과
 *  이미 모은 records의 norm 커밋을 중단시키지 않는다.
 *  성공-empty·부분 실패·전면 실패는 manifest/status 원장에 immutable 기록 (실제 빈 세계 vs 갭 구분). */
import { fetchText, fetchTextWithRetry, sleep } from './http';
import { gzipText } from './gzip';
import { regionsForMinute } from './schedule';
import { normalizeAdsb, pointUrl } from './sources/adsblol';
import { normalizeUsgs, USGS_ALL_HOUR_URL } from './sources/usgs';
import { mergeById, mergeByRevision, putIfAbsent, upsertNormSlot } from './r2/norm';
import { setEarthquakeLatest, setFlightRegionLatest, updateLatest } from './r2/latest';
import { NORM_SLOT_SEC, OBSERVATION_BUCKET_SEC, rawKey, slotStartSec, statusKey } from './slots';
import type { EarthquakeRecord, Env, FlightRecord, LayerId } from './types';

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
    await updateLatest(env.DATA, setEarthquakeLatest(records, asOf));

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

export async function collectFlights(env: Env, scheduledMs: number): Promise<CollectSummary> {
  const regions = regionsForMinute(scheduledMs);
  // ID용 180s 버킷(§5 Observation 계약)과 norm 파일 슬라이스 900s(§8.6)는 별개 — 혼용 금지
  const bucketTs = slotStartSec(scheduledMs, OBSERVATION_BUCKET_SEC);
  const normSlot = slotStartSec(scheduledMs, NORM_SLOT_SEC);
  const asOf = new Date(scheduledMs).toISOString();

  const perRegion: Record<string, unknown> = {};
  let okRegions = 0;
  let droppedTotal = 0;
  const allRecords: FlightRecord[] = [];

  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i];
    if (!region) continue;
    if (i > 0) await sleep(ADSB_CALL_GAP_MS);

    // 지역 격리 — 이 지역의 어떤 실패도 다음 지역·norm 커밋을 막지 않는다
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
        perRegion[region.id] = { ok: false, reason: final.reason, status: final.status };
        continue;
      }

      await env.DATA.put(rawKey('adsblol', scheduledMs, region.id), await gzipText(final.text));

      const normalized = normalizeAdsb(JSON.parse(final.text), region, bucketTs, scheduledMs);
      if (!normalized.ok) {
        // HTTP 200 오류 JSON — latest의 이 지역 스냅샷 보존
        perRegion[region.id] = { ok: false, reason: 'schema' };
        continue;
      }
      const { records, dropped } = normalized;
      droppedTotal += dropped;
      allRecords.push(...records);
      await updateLatest(env.DATA, setFlightRegionLatest(region.id, records, asOf));
      perRegion[region.id] = { ok: true, aircraft: records.length, dropped };
      okRegions += 1;
    } catch (error: unknown) {
      perRegion[region.id] = { ok: false, reason: 'exception', error: String(error) };
    }
  }

  // 성공 지역의 records는 실패 지역과 무관하게 커밋
  let slotOutcome: Record<string, unknown> = { skipped: true };
  let normCommitFailed = false;
  if (allRecords.length > 0) {
    try {
      const outcome = await upsertNormSlot(
        env.DATA,
        'flight',
        normSlot,
        NORM_SLOT_SEC,
        allRecords,
        mergeById,
        { dropped: droppedTotal },
      );
      slotOutcome = {
        written: outcome.written,
        generation: outcome.generation,
        records: outcome.records,
      };
    } catch (error: unknown) {
      // 재리뷰 H2 — norm 커밋 실패는 fetch가 다 성공해도 히스토리 갭:
      // status 원장에 failed(reason: norm_commit)로 남기고 레이어 결과도 ok:false.
      normCommitFailed = true;
      slotOutcome = { ok: false, reason: 'norm_commit', error: String(error) };
      perRegion.__norm = { ok: false, reason: 'norm_commit', error: String(error) };
    }
  }

  const partial = okRegions > 0 && okRegions < regions.length;
  const failed = okRegions === 0 || normCommitFailed;
  if (failed || partial || allRecords.length === 0) {
    await writeStatus(env, 'flight', normSlot, scheduledMs, failed ? 'failed' : partial ? 'partial' : 'empty', {
      ...(normCommitFailed ? { reason: 'norm_commit' } : {}),
      regions: perRegion,
      records: allRecords.length,
      dropped: droppedTotal,
    });
  }

  return {
    ok: okRegions > 0 && !normCommitFailed, // 데드맨 스위치 신호 — norm 커밋 실패도 비정상 (재리뷰 H2)
    layer: 'flight',
    detail: { slot: normSlot, bucketTs, partial, regions: perRegion, norm: slotOutcome },
  };
}

type StatusOutcome = 'empty' | 'partial' | 'failed';

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

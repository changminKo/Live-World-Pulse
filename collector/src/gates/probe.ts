/** Phase 0a 배포 후속 실측 게이트 (측정 전용 — 수집 아님, 아키텍처 변경 아님).
 *  ① /__gates/alt?src=adsbfi|airplaneslive|opensky — 대체 소스 Worker발 성공률
 *  ② /__gates/adsb-retry — adsb.lol 429 시 10s 뒤 동일 invocation 재시도 성공 여부
 *  ③ /__gates/flight1?region=… — 1지역 전체 경로(파싱+정규화+gzip+norm+latest RMW) CPU 분할 실측
 *  ④ /__gates/quake1 — 지진-only 경로 CPU 실측 (collectQuakes 프로덕션 경로 그대로) */
import { collectQuakes } from '../collect';
import { gzipText } from '../gzip';
import { sleep } from '../http';
import { setFlightRegionLatest, updateLatest } from '../r2/latest';
import { mergeById, upsertNormSlot } from '../r2/norm';
import { REGIONS } from '../schedule';
import { normalizeAdsb, pointUrl } from '../sources/adsblol';
import { NORM_SLOT_SEC, OBSERVATION_BUCKET_SEC, rawKey, slotStartSec } from '../slots';
import type { Env } from '../types';

const FETCH_TIMEOUT_MS = 20_000;
const RETRY_WAIT_MS = 10_000;

type AltSource = 'adsbfi' | 'airplaneslive' | 'opensky';

function altUrl(src: AltSource): string {
  switch (src) {
    case 'adsbfi':
      return 'https://opendata.adsb.fi/api/v2/lat/37.5/lon/127.0/dist/250';
    case 'airplaneslive':
      return 'https://api.airplanes.live/v2/point/37.5/127.0/250';
    case 'opensky':
      return 'https://opensky-network.org/api/states/all?lamin=35.5&lomin=124.5&lamax=39.5&lomax=129.5';
  }
}

function countAircraft(src: AltSource, body: unknown): number | null {
  const b = body as Record<string, unknown>;
  const arr =
    src === 'adsbfi' ? b?.aircraft : src === 'airplaneslive' ? b?.ac : b?.states;
  return Array.isArray(arr) ? arr.length : null;
}

/** ① 대체 소스 1회 호출 — 상태코드·기체 수 보고 */
export async function altSourceGate(srcParam: string | null): Promise<Response> {
  const src = srcParam as AltSource;
  if (src !== 'adsbfi' && src !== 'airplaneslive' && src !== 'opensky') {
    return json({ ok: false, step: 'param', hint: 'src=adsbfi|airplaneslive|opensky' }, 400);
  }
  try {
    const res = await fetch(altUrl(src), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = await res.text();
    let count: number | null = null;
    try {
      count = countAircraft(src, JSON.parse(text));
    } catch {
      // JSON 아님 — count null 유지, bodyHead로 판별
    }
    return json({
      ok: res.ok,
      src,
      status: res.status,
      aircraft: count,
      bodyBytes: text.length,
      bodyHead: res.ok ? undefined : text.slice(0, 200),
    });
  } catch (error: unknown) {
    return json({ ok: false, src, step: 'fetch', error: String(error) }, 502);
  }
}

/** ② adsb.lol 429 → 10s 대기 → 동일 invocation 내 1회 재시도 (per-IP 스로틀 성격 판별) */
export async function adsbRetryGate(regionId: string | null): Promise<Response> {
  const region = REGIONS.find((r) => r.id === (regionId ?? 'seoul')) ?? REGIONS[0];
  if (!region) return json({ ok: false, step: 'region' }, 400);

  const first = await fetch(pointUrl(region), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  await first.body?.cancel();
  if (first.status !== 429) {
    return json({ ok: first.ok, region: region.id, first: first.status, retried: false });
  }

  await sleep(RETRY_WAIT_MS);
  const second = await fetch(pointUrl(region), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  await second.body?.cancel();
  return json({
    ok: second.ok,
    region: region.id,
    first: 429,
    retried: true,
    second: second.status,
    waitMs: RETRY_WAIT_MS,
  });
}

/** ③ 1지역 전체 경로 — collect.ts 프로덕션 경로와 동일 단계 (fetch→raw put→정규화→norm upsert→latest RMW).
 *  결정론 키·merge 기반이라 프로덕션 수집과 멱등 공존. CPU는 tail cpuTime으로 읽는다. */
export async function flightOneRegionGate(env: Env, regionId: string | null): Promise<Response> {
  const region = REGIONS.find((r) => r.id === (regionId ?? 'seoul')) ?? REGIONS[0];
  if (!region) return json({ ok: false, step: 'region' }, 400);

  const nowMs = Date.now();
  const bucketTs = slotStartSec(nowMs, OBSERVATION_BUCKET_SEC); // ID용 180s (§5)
  const normSlot = slotStartSec(nowMs, NORM_SLOT_SEC); // 파일 슬라이스 900s (§8.6)

  const res = await fetch(pointUrl(region), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status !== 200) {
    await res.body?.cancel();
    return json({ ok: false, region: region.id, status: res.status, step: 'fetch' });
  }
  const text = await res.text();

  await env.DATA.put(rawKey('adsblol', nowMs, region.id), await gzipText(text));
  const normalized = normalizeAdsb(JSON.parse(text), region, bucketTs, nowMs);
  if (!normalized.ok) {
    return json({ ok: false, region: region.id, step: 'schema' }, 502);
  }
  const { records, dropped } = normalized;
  const asOf = new Date(nowMs).toISOString();
  await updateLatest(env.DATA, setFlightRegionLatest(region.id, records, asOf));

  let norm: Record<string, unknown> = { skipped: true };
  if (records.length > 0) {
    const outcome = await upsertNormSlot(env.DATA, 'flight', normSlot, NORM_SLOT_SEC, records, mergeById, {
      dropped,
    });
    norm = { written: outcome.written, generation: outcome.generation, records: outcome.records };
  }

  return json({ ok: true, region: region.id, aircraft: records.length, dropped, slot: normSlot, bucketTs, norm });
}

/** ④ 지진-only invocation — collectQuakes 프로덕션 경로. CPU는 tail cpuTime으로 읽는다. */
export async function quakeOnlyGate(env: Env): Promise<Response> {
  const summary = await collectQuakes(env, Date.now());
  return json(summary, summary.ok ? 200 : 502);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

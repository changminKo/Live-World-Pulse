/** Live World Pulse — Collector + 읽기 프록시 엔트리.
 *  cron "* * * * *" 1개: 지진 매분 + 항공기 m%3 지역 디스패치 (PLAN §8.7).
 *  UTC 03:07에 daily capacity scan (§8.6 fail-safe) — halt 플래그 존재 시 수집 전면 스킵.
 *  fetch: /__gates/*(GATE_TOKEN) + /api/* 읽기 프록시 (§8.6 공개 접근 경로 — proxy.ts). */
import { collectFlights, collectQuakes } from './collect';
import { handleApi } from './proxy';
import { adsbGate } from './gates/adsb';
import { gdeltGate } from './gates/gdelt';
import { adsbRetryGate, altSourceGate, flightOneRegionGate, quakeOnlyGate } from './gates/probe';
import { isHalted, isScanSlot, runDailyCapacityScan, runPollRelaxScan } from './r2/capacity';
import type { PollRelaxResult } from './r2/capacity';
import type { Env } from './types';

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const scheduledMs = controller.scheduledTime;
    const scheduledAt = new Date(scheduledMs).toISOString();

    let capacity: Record<string, unknown> | undefined;
    let pollRelax: PollRelaxResult | undefined;
    let scanFailed = false;
    if (isScanSlot(scheduledMs)) {
      try {
        const record = await runDailyCapacityScan(env.DATA, scheduledMs);
        capacity = { totalBytes: record.totalBytes, overLimit: record.overLimit };
      } catch (error: unknown) {
        // 스캔 실패가 수집을 막으면 안 되고(halt 오탐 금지), 성공으로 위장해도 안 된다 (재리뷰 Med2)
        scanFailed = true;
        capacity = { error: String(error) };
      }
      // §8.6 quota 방어 ① producer — 시크릿 없으면 skipped, 조회 실패는 플래그 불변 + 로그만
      // (Analytics 일시 장애로 데드맨 오탐을 내지 않는다 — 결과는 아래 구조화 로그로 관측)
      pollRelax = await runPollRelaxScan(env.DATA, env, scheduledMs);
    }

    // §8.6 fail-safe ②: halt 플래그 존재 = 수집 스킵 (자동 과금 차단이 수집보다 먼저)
    if (await isHalted(env.DATA)) {
      console.log(JSON.stringify({ scheduledAt, halted: true, capacity, pollRelax }));
      await pingHealthchecks(env, false); // halt는 비정상 상태 — 데드맨 알림 유지
      return;
    }

    const [quakes, flights] = await Promise.allSettled([
      collectQuakes(env, scheduledMs),
      collectFlights(env, scheduledMs),
    ]);

    const summary = {
      scheduledAt,
      capacity,
      pollRelax,
      earthquake: quakes.status === 'fulfilled' ? quakes.value : { ok: false, error: String(quakes.reason) },
      flight: flights.status === 'fulfilled' ? flights.value : { ok: false, error: String(flights.reason) },
    };
    // 관측용 구조화 로그 — wrangler tail / Workers Logs에서 invocation별 확인
    console.log(JSON.stringify(summary));

    const allOk =
      !scanFailed &&
      quakes.status === 'fulfilled' &&
      quakes.value.ok &&
      flights.status === 'fulfilled' &&
      flights.value.ok;
    await pingHealthchecks(env, allOk);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__gates/')) {
      // 실측 게이트는 쓰기·외부 API 증폭 경로 — GATE_TOKEN 뒤로 fail-closed
      // (시크릿 미설정이면 게이트 자체가 존재하지 않는 것처럼 404)
      const token = env.GATE_TOKEN;
      if (!token || request.headers.get('x-gate-token') !== token) {
        return new Response('not found', { status: 404 });
      }
      if (url.pathname === '/__gates/gdelt') return gdeltGate();
      if (url.pathname === '/__gates/adsb') return adsbGate(url.searchParams.get('region'));
      if (url.pathname === '/__gates/alt') return altSourceGate(url.searchParams.get('src'));
      if (url.pathname === '/__gates/adsb-retry') return adsbRetryGate(url.searchParams.get('region'));
      if (url.pathname === '/__gates/flight1') return flightOneRegionGate(env, url.searchParams.get('region'));
      if (url.pathname === '/__gates/quake1') return quakeOnlyGate(env);
      return new Response('not found', { status: 404 });
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    return new Response('lwp-collector (Phase 0a)', { status: 200 });
  },
};

/** HEALTHCHECKS_URL 시크릿 있으면 핑, 없으면 조용히 스킵 (PLAN §8.7 데드맨 스위치) */
async function pingHealthchecks(env: Env, ok: boolean): Promise<void> {
  const base = env.HEALTHCHECKS_URL;
  if (!base) return;
  const url = ok ? base : `${base.replace(/\/$/, '')}/fail`;
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5_000) });
  } catch {
    // 핑 실패는 수집 실패가 아니다 — 무시 (manifest 기반 감시가 1차)
  }
}

/** Live World Pulse — Collector + 읽기 프록시 엔트리.
 *  cron "* * * * *" 1개. **한 invocation = 작업 1개** (CPU 사다리 rung ① — Free 플랜
 *  하드 10ms/invocation). weather는 페이지 단위로 더 쪼개져 있다 (page ×4 → commit →
 *  track, 사이클 30분 — 사후 리뷰 High1). 분 → 작업 배정은 schedule.ts MINUTE_TASKS가 결정하고,
 *  latest.json 재조립만 매 분 공통으로 돈다 (byte concat ~0.3ms — r2/latest.ts).
 *  UTC 03:13에 daily capacity scan (§8.6 fail-safe) — 그 분은 수집 작업을 건너뛴다.
 *  halt 플래그 존재 시 수집 전면 스킵.
 *  fetch: /__gates/*(GATE_TOKEN) + /api/* 읽기 프록시 (§8.6 공개 접근 경로 — proxy.ts). */
import {
  collectFlightRegion,
  collectNews,
  collectNewsProcess,
  collectQuakes,
  collectWeatherCommit,
  collectWeatherPages,
  collectWeatherTracks,
} from './collect';
import { taskForMinute } from './schedule';
import type { MinuteTask } from './schedule';
import { assembleLatest } from './r2/latest';
import { handleApi } from './proxy';
import { adsbGate } from './gates/adsb';
import { gdeltGate } from './gates/gdelt';
import { adsbRetryGate, altSourceGate, flightOneRegionGate, quakeOnlyGate } from './gates/probe';
import { isHalted, isScanSlot, runDailyCapacityScan, runPollRelaxScan } from './r2/capacity';
import type { PollRelaxResult } from './r2/capacity';
import type { CollectSummary } from './collect';
import type { Env } from './types';

/** 분 테이블이 지정한 단 하나의 작업 실행. idle은 조립만 하는 분이다. */
async function runTask(env: Env, task: MinuteTask, scheduledMs: number): Promise<CollectSummary | null> {
  switch (task.kind) {
    case 'quake':
      return collectQuakes(env, scheduledMs);
    case 'flight':
      return collectFlightRegion(env, scheduledMs, task.region);
    case 'weather-page':
      return collectWeatherPages(env, scheduledMs);
    case 'weather-commit':
      return collectWeatherCommit(env, scheduledMs);
    case 'weather-track':
      return collectWeatherTracks(env, scheduledMs);
    case 'news-fetch':
      return collectNews(env, scheduledMs);
    case 'news-process':
      return collectNewsProcess(env, scheduledMs);
    case 'idle':
      return null;
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const scheduledMs = controller.scheduledTime;
    const scheduledAt = new Date(scheduledMs).toISOString();
    const task = taskForMinute(scheduledMs);
    const taskLabel = task.kind === 'flight' ? `flight:${task.region.id}` : task.kind;

    let capacity: Record<string, unknown> | undefined;
    let pollRelax: PollRelaxResult | undefined;
    let scanFailed = false;
    const scanSlot = isScanSlot(scheduledMs);
    if (scanSlot) {
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
      console.log(JSON.stringify({ scheduledAt, task: taskLabel, halted: true, capacity, pollRelax }));
      await pingHealthchecks(env, false); // halt는 비정상 상태 — 데드맨 알림 유지
      return;
    }

    // 스캔 분은 LIST 전수 순회로 CPU를 쓰므로 수집 작업을 겹치지 않는다 (사다리 rung ①).
    // 스캔 슬롯은 idle 분(schedule.ts)에 배정돼 있어 평상시 손실이 없다.
    const result = scanSlot ? null : await runTask(env, task, scheduledMs).catch((error: unknown) => ({
      ok: false,
      layer: task.kind,
      detail: { reason: 'exception', error: String(error) },
    }));

    // 작업 뒤 통합 latest.json 재조립 (재리뷰 High1 — 프록시 9 GET 되돌림).
    // 파트는 pre-serialized 바이트 그대로 concat — r2/latest.ts assembleLatest 주석 참조.
    // 조립 실패 = latest 정체 → 데드맨 신호에 포함 (아래 allOk).
    let latestAssembly: Record<string, unknown>;
    let latestOk = true;
    try {
      const assembled = await assembleLatest(env.DATA);
      latestAssembly = {
        written: assembled.written,
        partial: assembled.partial,
        ...(assembled.invalid.length > 0 ? { invalid: assembled.invalid } : {}),
        bytes: assembled.bytes,
      };
    } catch (error: unknown) {
      latestOk = false;
      latestAssembly = { ok: false, error: String(error) };
    }

    // 관측용 구조화 로그 — wrangler tail / Workers Logs에서 invocation별 확인.
    // task 라벨이 있으므로 tail의 cpuTime이 곧 그 작업의 CPU 실측치다.
    console.log(
      JSON.stringify({
        scheduledAt,
        task: taskLabel,
        ...(scanSlot ? { scanSlot: true } : {}),
        capacity,
        pollRelax,
        latest: latestAssembly,
        ...(result ? { result } : {}),
      }),
    );

    const allOk = !scanFailed && latestOk && (result === null || result.ok);
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

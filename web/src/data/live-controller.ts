import { normalizeUsgs, sliceOccurrence, TEMPORAL_SPEC, USGS_ALL_HOUR_URL } from '@lwp/shared';
import { startPollLoop, type PollOutcome } from './poll-loop';
import { useLiveStore } from './live-store';
import { createFlightSource, LATEST_URL } from './latest-source';

/** LIVE 파이프라인 컨트롤러 — 두 폴 루프(프록시 latest 60s·USGS 60s) + stale 재평가 틱.
 *  WorldPage 마운트 시 start, 언마운트 시 stop. React 밖 모듈 — 지도/스토어와 동일 수명. */

const POLL_INTERVAL_MS = 60_000;
const STALE_TICK_MS = 30_000;

const quakeWindowMs =
  TEMPORAL_SPEC.earthquake.temporalMode === 'instant'
    ? TEMPORAL_SPEC.earthquake.windowMs
    : 3_600_000;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : '알 수 없는 오류';
}

/** X-Poll-Interval 응답 헤더 (초) → ms — 200·304 공통 적용 (리뷰 Med2) */
function pollIntervalOf(res: Response): { pollIntervalMs: number } | Record<string, never> {
  const header = res.headers.get('X-Poll-Interval');
  const sec = header !== null ? Number(header) : NaN;
  return Number.isFinite(sec) && sec > 0 ? { pollIntervalMs: sec * 1_000 } : {};
}

/** 지역별 참조 안정 병합기 — 컨트롤러 수명 스코프 (리뷰 Med4) */
const ingestFlights = createFlightSource();

/** 프록시 latest.json 폴 — ETag/304 + X-Poll-Interval 존중 + 429 백오프 (poll-loop 계약) */
async function pollLatest(etag: string | null): Promise<PollOutcome> {
  const store = useLiveStore.getState();
  store.setLoading('flight');
  let res: Response;
  try {
    res = await fetch(LATEST_URL, {
      headers: etag !== null ? { 'If-None-Match': etag } : {},
    });
  } catch (e: unknown) {
    store.setError('flight', errorMessage(e));
    return { kind: 'error', reason: errorMessage(e) };
  }

  if (res.status === 304) {
    store.setChecked('flight');
    return { kind: 'notModified', ...pollIntervalOf(res) };
  }
  if (res.status === 429 || res.status >= 500) {
    // 429 재시도 금지 룰 + Error 1027 fail-closed — 지수 백오프 (CLAUDE.md·PLAN §8.6)
    store.setError('flight', `HTTP ${res.status}`);
    return { kind: 'backoff', reason: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    store.setError('flight', `HTTP ${res.status}`);
    return { kind: 'error', reason: `HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e: unknown) {
    store.setError('flight', 'latest.json 파싱 실패');
    return { kind: 'error', reason: errorMessage(e) };
  }
  const snapshot = ingestFlights(body, Date.now());
  if (snapshot === null) {
    store.setError('flight', 'latest.json 스키마 불일치');
    return { kind: 'error', reason: 'schema' };
  }
  store.setFlights(snapshot);
  return { kind: 'ok', etag: res.headers.get('ETag'), ...pollIntervalOf(res) };
}

/** USGS all_hour 직접 폴 — 브라우저 직접 fetch 유일 예외 (CLAUDE.md) */
async function pollUsgs(etag: string | null): Promise<PollOutcome> {
  const store = useLiveStore.getState();
  store.setLoading('earthquake');
  let res: Response;
  try {
    res = await fetch(USGS_ALL_HOUR_URL, {
      headers: etag !== null ? { 'If-None-Match': etag } : {},
    });
  } catch (e: unknown) {
    store.setError('earthquake', errorMessage(e));
    return { kind: 'error', reason: errorMessage(e) };
  }

  if (res.status === 304) {
    store.setChecked('earthquake');
    return { kind: 'notModified', ...pollIntervalOf(res) };
  }
  if (res.status === 429 || res.status >= 500) {
    store.setError('earthquake', `HTTP ${res.status}`);
    return { kind: 'backoff', reason: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    store.setError('earthquake', `HTTP ${res.status}`);
    return { kind: 'error', reason: `HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e: unknown) {
    store.setError('earthquake', 'USGS 피드 파싱 실패');
    return { kind: 'error', reason: errorMessage(e) };
  }
  const outcome = normalizeUsgs(body, Date.now());
  if (!outcome.ok) {
    store.setError('earthquake', 'USGS 스키마 불일치');
    return { kind: 'error', reason: 'schema' };
  }
  // 시각 T=now 슬라이스 — kind별 규칙 (occurrence=window 1h, 단일 timestamp 필터 금지)
  const records = sliceOccurrence(outcome.records, Date.now(), quakeWindowMs);
  store.setQuakes(records);
  return { kind: 'ok', etag: res.headers.get('ETag'), ...pollIntervalOf(res) };
}

/** 폴 루프 2개 + stale 틱 시작. 반환 함수로 전부 정지. */
export function startLiveController(): () => void {
  if (import.meta.env.DEV) {
    // dev 전용 진단 핸들 (기계 검증 스크립트용) — 프로덕션 번들 제외
    (window as unknown as Record<string, unknown>).__lwpLive = useLiveStore;
  }
  const stopLatest = startPollLoop({ intervalMs: POLL_INTERVAL_MS, poll: pollLatest });
  const stopUsgs = startPollLoop({ intervalMs: POLL_INTERVAL_MS, poll: pollUsgs });
  const tick = setInterval(() => useLiveStore.getState().recomputeStale(Date.now()), STALE_TICK_MS);
  return () => {
    stopLatest();
    stopUsgs();
    clearInterval(tick);
  };
}

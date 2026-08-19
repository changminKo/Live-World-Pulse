/** LIVE 폴링 루프 — TanStack Query 금지 하드 룰(CLAUDE.md)에 따른 전용 폴러.
 *  계약 (PLAN §8.6 클라이언트 측):
 *  - ETag If-None-Match 재검증 (304면 바디 스킵)
 *  - X-Poll-Interval 응답 헤더 존중 (quota 완화 지시 60s→180s)
 *  - 429/1027(플랫폼 오류) 시 지수 백오프 — 재시도 폭주 금지
 *  - visibilitychange hidden 시 폴링 정지 (PLAN §10 복원력) */

export type PollOutcome =
  | { kind: 'ok'; etag: string | null; pollIntervalMs?: number }
  | { kind: 'notModified'; pollIntervalMs?: number } // 304도 X-Poll-Interval 적용 (리뷰 Med2)
  | { kind: 'backoff'; reason: string } // 429/5xx — 지수 백오프 대상
  | { kind: 'error'; reason: string }; // 스키마/네트워크 — 역시 백오프 (연속 실패 폭주 방지, 리뷰 Med2)

export interface PollLoopOptions {
  /** 기본 폴링 주기 (X-Poll-Interval이 덮어씀) */
  intervalMs: number;
  /** 백오프 상한 (기본 15분) */
  maxBackoffMs?: number;
  /** 1회 폴 실행 — etag는 직전 성공 응답의 값 */
  poll: (etag: string | null) => Promise<PollOutcome>;
}

const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
/** 백오프 지터 ±30% — 다수 클라이언트 동기화 재시도(thundering herd) 분산 (리뷰 Med2) */
const BACKOFF_JITTER = 0.3;

/** setTimeout 체인 폴러. stop() 반환 — React effect cleanup에 그대로 사용. */
export function startPollLoop(options: PollLoopOptions): () => void {
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  let intervalMs = options.intervalMs;
  let backoffCount = 0;
  let etag: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let inFlight = false;

  const delayMs = (): number => {
    if (backoffCount === 0) return intervalMs;
    // 지터를 cap 이전에 적용 — cap 후 지터면 maxBackoffMs를 최대 1.3배 초과 (재리뷰 Low)
    const jittered = intervalMs * 2 ** backoffCount * (1 + (Math.random() * 2 - 1) * BACKOFF_JITTER);
    return Math.round(Math.min(jittered, maxBackoffMs));
  };

  const schedule = (): void => {
    if (stopped || document.hidden) return; // hidden — visibilitychange가 재개
    clearTimeout(timer);
    timer = setTimeout(run, delayMs());
  };

  const run = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const outcome = await options.poll(etag);
      if (outcome.kind === 'ok') {
        etag = outcome.etag;
        backoffCount = 0;
        if (outcome.pollIntervalMs !== undefined) intervalMs = outcome.pollIntervalMs;
      } else if (outcome.kind === 'notModified') {
        backoffCount = 0;
        if (outcome.pollIntervalMs !== undefined) intervalMs = outcome.pollIntervalMs;
      } else {
        // backoff(429/5xx)·error(네트워크/스키마) 모두 백오프 — 연속 실패 시 재시도 폭주 금지 (리뷰 Med2)
        backoffCount += 1;
      }
    } finally {
      inFlight = false;
      schedule();
    }
  };

  const onVisibility = (): void => {
    if (document.hidden) {
      clearTimeout(timer); // 정지 — 숨김 탭에서 예산 소모 금지
    } else {
      void run(); // 복귀 즉시 1회 + 체인 재개
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  void run(); // 즉시 1회

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

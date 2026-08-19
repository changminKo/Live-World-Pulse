/** trailing 디바운스 + maxWait — 마지막 호출 후 ms 경과 시 1회 발화하되,
 *  연속 호출(자동 회전 등)이 계속돼도 maxWaitMs마다 최소 1회는 발화한다
 *  (starvation 방지 — 재리뷰 Med: 회전 중 URL·viewport가 영원히 안 갱신되는 문제).
 *  flush()는 pending이 있으면 즉시 발화 — cleanup에서 마지막 상태 유실 방지. */
export function debounceTrailing(
  fn: () => void,
  ms: number,
  maxWaitMs?: number,
): { run: () => void; cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let firstCallAt: number | undefined;

  const fire = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = false;
    firstCallAt = undefined;
    fn();
  };

  return {
    run: () => {
      const now = Date.now();
      if (!pending) {
        pending = true;
        firstCallAt = now;
      }
      clearTimeout(timer);
      const sinceFirst = now - (firstCallAt ?? now);
      const wait =
        maxWaitMs !== undefined ? Math.min(ms, Math.max(0, maxWaitMs - sinceFirst)) : ms;
      timer = setTimeout(fire, wait);
    },
    cancel: () => {
      clearTimeout(timer);
      timer = undefined;
      pending = false;
      firstCallAt = undefined;
    },
    flush: () => {
      if (pending) fire();
    },
  };
}

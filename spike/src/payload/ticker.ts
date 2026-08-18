import type { Payload } from '../engines/types';

export const TICK_INTERVAL_MS = 5_000;
export const TICK_COUNT = 12;

export interface TickEvent {
  tick: number; // 1..12
  timestampMs: number; // performance.now() 기준
  payload: Payload;
}

/**
 * 5초 틱 × 12회 = 60초 시뮬레이터 (DESIGN §3-3).
 * 매 틱 항공기 새 배열 → setPayload — attribute 전체 재생성 최악 케이스를 일부러 유발.
 */
export function startTicker(
  payloadAtTick: (t: number) => Payload,
  onTick: (e: TickEvent) => void,
  onDone?: () => void,
): { stop(): void } {
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    onTick({
      tick,
      timestampMs: performance.now(),
      payload: payloadAtTick(tick),
    });
    if (tick >= TICK_COUNT) {
      clearInterval(timer);
      onDone?.();
    }
  }, TICK_INTERVAL_MS);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

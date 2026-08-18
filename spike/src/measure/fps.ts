/** rAF 프레임 시간 수집기 (DESIGN §4-1, §4-6) */

export interface FrameSample {
  t: number; // 프레임 시각 (performance.now)
  dt: number; // 직전 프레임과의 간격 ms
}

export interface FpsStats {
  minWindowFps: number; // 1초 슬라이딩 윈도 평균 FPS의 최소값
  medianFps: number;
  p95FrameMs: number;
  frameCount: number;
}

export const DROP_FRAME_MS = 33.4; // 60Hz 기준 2프레임 예산 초과 = 드롭 (DESIGN §4-6)

export class FpsMeter {
  private samples: FrameSample[] = [];
  private running = false;
  private rafId = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.samples.push({ t: now, dt: now - last });
      last = now;
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  now(): number {
    return performance.now();
  }

  samplesIn(t0: number, t1: number): FrameSample[] {
    return this.samples.filter((s) => s.t >= t0 && s.t <= t1);
  }

  /** 구간 [t0, t1] 통계. warmupMs만큼 앞부분 제외 (초기 컴파일/업로드 워밍업). */
  statsIn(t0: number, t1: number, warmupMs = 1_000): FpsStats {
    const frames = this.samplesIn(t0 + warmupMs, t1);
    if (frames.length < 2) {
      return { minWindowFps: 0, medianFps: 0, p95FrameMs: 0, frameCount: frames.length };
    }
    const dts = frames.map((f) => f.dt).sort((a, b) => a - b);
    const medianDt = dts[Math.floor(dts.length / 2)];
    const p95Dt = dts[Math.min(dts.length - 1, Math.floor(dts.length * 0.95))];

    // 1초 슬라이딩 윈도(프레임 단위 스텝) 평균 FPS 최소값
    let minWindowFps = Infinity;
    let lo = 0;
    for (let hi = 0; hi < frames.length; hi++) {
      while (frames[hi].t - frames[lo].t > 1_000) lo++;
      const span = frames[hi].t - frames[lo].t;
      if (span >= 800) {
        const fps = ((hi - lo) / span) * 1_000;
        minWindowFps = Math.min(minWindowFps, fps);
      }
    }
    if (!isFinite(minWindowFps)) minWindowFps = 1_000 / medianDt;

    return {
      minWindowFps: round1(minWindowFps),
      medianFps: round1(1_000 / medianDt),
      p95FrameMs: round1(p95Dt),
      frameCount: frames.length,
    };
  }

  /** 틱 직후 1초 윈도의 드롭 프레임(>33.4ms) 개수 (DESIGN §4-6) */
  dropsAfter(tickTimestampMs: number, windowMs = 1_000): number {
    return this.samplesIn(tickTimestampMs, tickTimestampMs + windowMs).filter(
      (s) => s.dt > DROP_FRAME_MS,
    ).length;
  }

  currentFps(): number {
    const now = performance.now();
    const recent = this.samplesIn(now - 1_000, now);
    return recent.length > 1 ? round1(recent.length) : 0;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

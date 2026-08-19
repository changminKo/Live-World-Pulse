/** 외부 fetch 규율 (PLAN §8.7): 슬롯 내 재시도 1회, 429는 재시도 금지,
 *  타임아웃(소프트 스로틀 신호)도 재시도 없이 스킵. */

export type FetchOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; status?: number; reason: 'http' | 'rate_limited' | 'timeout' | 'network' };

export async function fetchText(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<FetchOutcome> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) return { ok: false, status: 429, reason: 'rate_limited' };
    if (!res.ok) return { ok: false, status: res.status, reason: 'http' };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'network' };
  }
}

/** 재시도 1회 — 단 429(rate_limited)와 timeout(스로틀 신호)은 즉시 포기 */
export async function fetchTextWithRetry(
  url: string,
  timeoutMs: number,
  retryDelayMs: number,
  headers?: Record<string, string>,
): Promise<FetchOutcome> {
  const first = await fetchText(url, timeoutMs, headers);
  if (first.ok || first.reason === 'rate_limited' || first.reason === 'timeout') return first;
  await sleep(retryDelayMs);
  return await fetchText(url, timeoutMs, headers);
}

export type FetchBytesOutcome =
  | { ok: true; status: number; bytes: ArrayBuffer }
  | { ok: false; status?: number; reason: 'http' | 'rate_limited' | 'timeout' | 'network' };

/** 바이너리 응답용 (GDELT zip) — 규율은 fetchText와 동일 */
export async function fetchBytes(url: string, timeoutMs: number): Promise<FetchBytesOutcome> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) return { ok: false, status: 429, reason: 'rate_limited' };
    if (!res.ok) return { ok: false, status: res.status, reason: 'http' };
    return { ok: true, status: res.status, bytes: await res.arrayBuffer() };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'network' };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

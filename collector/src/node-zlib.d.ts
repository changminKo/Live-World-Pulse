/** nodejs_compat node:zlib 최소 타입 — @types/node 전체를 끌어오면 workers-types 전역과
 *  충돌(setTimeout 등)하므로 사용하는 표면만 선언한다. Buffer는 Uint8Array 서브타입. */
declare module 'node:zlib' {
  export function gzipSync(
    data: Uint8Array | string,
    options?: { level?: number },
  ): Uint8Array;
  export function gunzipSync(data: Uint8Array): Uint8Array;
  export function inflateRawSync(
    data: Uint8Array,
    options?: { finishFlush?: number },
  ): Uint8Array;
  export const constants: { Z_SYNC_FLUSH: number };
}

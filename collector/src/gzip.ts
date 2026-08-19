/** gzip 유틸 — node:zlib 동기 API (Workers nodejs_compat / Node 공통).
 *  CPU 사다리 실측 (2026-08-19, §8.7): CompressionStream은 스트림 오버헤드로 ~10ms/MB,
 *  zlib gzipSync level 1은 ~1.5ms/MB (6배) — Free 플랜 하드 10ms 예산에서 gzip이
 *  지배 비용이라 level 1 고정 (크기 +20~30%는 R2 여유로 수용, capacity scan이 가드). */
import { gunzipSync, gzipSync } from 'node:zlib';

const GZIP_LEVEL = 1;

export async function gzipText(text: string): Promise<ArrayBuffer> {
  const out = gzipSync(new TextEncoder().encode(text), { level: GZIP_LEVEL });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function gunzipToText(data: ArrayBuffer): Promise<string> {
  return new TextDecoder().decode(gunzipSync(new Uint8Array(data)));
}

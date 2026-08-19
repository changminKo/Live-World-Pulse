/** latest 스냅샷 — 레이어/지역별 분리 저장 (CPU 사다리, 2026-08-19 exceededCpu 대응).
 *
 *  기존 latest.json 단일 객체는 1.39MB까지 자라 read-modify-write가 분당 3회
 *  (지진 1 + 항공기 지역 2) — parse+stringify만 ~12ms로 Free 플랜 하드 CPU 한도
 *  (10ms/invocation)를 단독 초과했다. 분리 후 각 writer는 자기 파트만 stringify
 *  (지진 ~6KB, 지역 최대 ~480KB) — 타 레이어 파싱 비용 0.
 *
 *  공개 계약 불변: 프론트는 /api/latest만 읽고, Collector가 매 invocation 말미에
 *  파트를 **바이트 concat만으로**(JSON.parse/stringify·TextDecoder 금지 — 1.39MB CPU
 *  사고 재발 방지) 통합 latest.json으로 재조립한다 (assembleLatest). 프록시는 통합본 1 GET
 *  + R2 etag만 — 폴링당 파트 9 GET(월 ~2,050만 Class B, 무료 1,000만 초과)이었던
 *  재리뷰 High1의 되돌림. 파트 9 GET은 이제 Collector 분당 1회(월 ~39만)뿐.
 *
 *  단조 가드: 파트 customMetadata.asOf 를 head()로 비교 — 본문 parse 없이
 *  늦게 끝난 과거 invocation의 되돌림을 막는다. 같은 레이어의 동시 writer는
 *  cron 단일 실행 구조상 희귀(중첩 실행)하고, 최악도 다음 분에 수렴하므로 CAS 불요.
 *  통합본은 무가드 PUT — 어떤 순서로 겹쳐도 각 파트가 이미 단조라 다음 분에 수렴. */
import { LATEST_KEY } from '../slots';
import { REGIONS } from '../schedule';
import type { Iso, LayerId } from '../types';

/** 스키마는 shared r2-contract로 승격 (프론트 LIVE 폴링과 공유) — 기존 임포트 경로 유지용 재수출 */
export type { LatestDoc } from '@lwp/shared';

/** 분리 파트 키 prefix — proxy.ts 조립과 공유 (레거시 latest.json은 fallback 전용) */
export const LATEST_V2_PREFIX = 'latest/v2/';

export function latestLayerKey(layer: Exclude<LayerId, 'flight'>): string {
  return `${LATEST_V2_PREFIX}${layer}.json`;
}

export function latestFlightRegionKey(regionId: string): string {
  return `${LATEST_V2_PREFIX}flight/${regionId}.json`;
}

/** 파트 본문 — LatestDoc.layers.{earthquake|weather|news} / flight.regions[id]와 동일 shape.
 *  프록시가 본문을 parse 없이 그대로 조립하므로 이 리터럴 순서가 곧 응답 바이트. */
export interface SnapshotPart<R> {
  asOf: Iso;
  records: R[];
}

/** asOf 단조 가드 후 파트 교체. 기존이 더 새거나 같으면 skip (false 반환).
 *  head는 본문을 읽지 않는다 — 가드 비용은 메타데이터 1회. */
export async function putSnapshotIfNewer<R>(
  bucket: R2Bucket,
  key: string,
  asOf: Iso,
  records: R[],
): Promise<boolean> {
  const existing = await bucket.head(key);
  const existingAsOf = existing?.customMetadata?.asOf;
  if (existingAsOf !== undefined && existingAsOf >= asOf) return false;
  const part: SnapshotPart<R> = { asOf, records };
  await bucket.put(key, JSON.stringify(part), { customMetadata: { asOf } });
  return true;
}

/** 조립 파트 목록 — chunk 이름이 곧 LatestDoc.partial 항목명 (순서 = 응답 필드 순서) */
const LATEST_PARTS: ReadonlyArray<{ chunk: string; key: string }> = [
  { chunk: 'earthquake', key: latestLayerKey('earthquake') },
  { chunk: 'weather', key: latestLayerKey('weather') },
  { chunk: 'news', key: latestLayerKey('news') },
  ...REGIONS.map((r) => ({ chunk: `flight:${r.id}`, key: latestFlightRegionKey(r.id) })),
];

export interface AssembleLatestResult {
  written: boolean;
  /** 누락 파트 chunk 목록 — 전부 있으면 빈 배열 */
  partial: string[];
  /** 검증 실패(손상) 파트 chunk 목록 — 1개라도 있으면 PUT 스킵(이전 통합본 보존) */
  invalid: string[];
  bytes: number;
}

const BRACE_OPEN = 0x7b; // '{'
const BRACE_CLOSE = 0x7d; // '}'

/** 파트 본문 경량 유효성 — 파트는 putSnapshotIfNewer가 직접 stringify한 객체 JSON이므로
 *  구조 parse 없이 첫 '{' + 끝 '}' + 길이>2만 본다 (통합본 1.39MB parse CPU 사고의 교훈:
 *  검증도 parse 금지). 잘린 업로드·비JSON 오염을 걸러 통합본 전체 오염을 막는 최소선.
 *  바이트로 판정 — 조립이 문자열을 만들지 않으므로 디코드도 하지 않는다. */
function isValidPartBytes(body: Uint8Array): boolean {
  return body.length > 2 && body[0] === BRACE_OPEN && body[body.length - 1] === BRACE_CLOSE;
}

/** 파트 → 통합 latest.json 재조립 (매 invocation 말미 — index.scheduled).
 *  CPU 계약: 파트 본문은 R2가 준 바이트 그대로 복사, 골격(구분자·필드명)만 인코딩 —
 *  JSON.parse/stringify는 물론 파트 본문의 TextDecoder도 금지 (1.39MB parse ~12ms
 *  사고 재발 방지 + 1.9MB text()+concat ~2.3ms 실측을 매 분 물지 않기 위해).
 *  updatedAt = 최신 파트 uploaded (기존 프록시 조립 의미론 유지).
 *  누락 파트는 필드 생략 + partial 메타 (Med1) — 파트 전무(콜드 스타트)면 PUT 스킵.
 *  손상 파트(경량 검증 실패)는 invalid로 보고하고 PUT 자체를 스킵 — concat 조립이라
 *  깨진 파트 하나가 통합본 전체를 비JSON으로 만들기 때문 (이전 통합본 보존). */
export async function assembleLatest(bucket: R2Bucket): Promise<AssembleLatestResult> {
  const parts = await Promise.all(LATEST_PARTS.map(({ key }) => bucket.get(key)));

  interface Piece {
    chunk: string;
    body: Uint8Array;
  }
  const layerPieces: Piece[] = [];
  const regionPieces: Piece[] = [];
  const partial: string[] = [];
  const invalid: string[] = [];
  let updatedAtMs = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const meta = LATEST_PARTS[i];
    if (!meta) continue;
    if (!part) {
      partial.push(meta.chunk);
      continue;
    }
    // 바이트로 받는다 — text()의 TextDecoder + 문자열 concat + put의 재인코딩이
    // 1.9MB 규모에서 ~2.3ms였고(로컬 실측 2026-08-19), 매 invocation 비용이라
    // 하드 10ms 예산에서 무시할 수 없었다. 바이트 복사는 memcpy 한 번이다.
    const body = new Uint8Array(await part.arrayBuffer());
    if (!isValidPartBytes(body)) {
      invalid.push(meta.chunk);
      continue;
    }
    const uploadedMs = part.uploaded ? new Date(part.uploaded).getTime() : 0;
    if (uploadedMs > updatedAtMs) updatedAtMs = uploadedMs;
    (meta.chunk.startsWith('flight:') ? regionPieces : layerPieces).push({ chunk: meta.chunk, body });
  }

  // 손상 파트 발견 → PUT 스킵 (이전 통합본 보존) — 손상 레이어만 빠진 통합본을 쓰면
  // 프론트에서 그 레이어가 유령처럼 사라진다. 다음 분의 정상 파트 교체로 자연 복구.
  if (invalid.length > 0) return { written: false, partial, invalid, bytes: 0 };
  if (layerPieces.length === 0 && regionPieces.length === 0) {
    return { written: false, partial, invalid, bytes: 0 }; // 콜드 스타트 — 조립할 것이 없다
  }

  // 골격(작은 문자열)만 인코딩하고, 파트 본문은 바이트 그대로 이어붙인다.
  // 필드 순서·구분자는 기존 문자열 조립판과 1바이트도 동일 (프록시·프론트 계약 불변).
  const enc = new TextEncoder();
  const segments: Uint8Array[] = [];
  const push = (s: string): void => {
    segments.push(enc.encode(s));
  };

  const partialField = partial.length > 0 ? `"partial":${JSON.stringify(partial)},` : '';
  push(`{"updatedAt":${JSON.stringify(new Date(updatedAtMs).toISOString())},${partialField}"layers":{`);
  let first = true;
  for (const piece of layerPieces) {
    push(`${first ? '' : ','}${JSON.stringify(piece.chunk)}:`);
    segments.push(piece.body);
    first = false;
  }
  if (regionPieces.length > 0) {
    push(`${first ? '' : ','}"flight":{"regions":{`);
    let firstRegion = true;
    for (const piece of regionPieces) {
      push(`${firstRegion ? '' : ','}${JSON.stringify(piece.chunk.slice('flight:'.length))}:`);
      segments.push(piece.body);
      firstRegion = false;
    }
    push('}}');
  }
  push('}}');

  let bytes = 0;
  for (const s of segments) bytes += s.byteLength;
  const doc = new Uint8Array(bytes);
  let offset = 0;
  for (const s of segments) {
    doc.set(s, offset);
    offset += s.byteLength;
  }

  await bucket.put(LATEST_KEY, doc, { httpMetadata: { contentType: 'application/json' } });
  return { written: true, partial, invalid, bytes };
}

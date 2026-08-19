/** norm 슬라이스 쓰기 — generation versioned key (PLAN §8.7 멱등성 계약).
 *  순서 고정: 새 g 파일 발행 → manifest immutable 엔트리 → 포인터 CAS.
 *  내용 불변(해시 동일)이면 아무것도 쓰지 않는다 (g 유지).
 *
 *  불변식 "고아 = 무해" (재리뷰 3 — delete 경로 폐기):
 *  - 포인터가 유일한 진실. 포인터가 참조하지 않는 body/manifest는 어떤 경로에도
 *    영향 없다 — 어떤 writer도 이미 존재하는 g를 재사용하지 않고(putIfAbsent 충돌
 *    시 g+1 전진), 아무도 delete하지 않으므로 poison·유실 interleaving이 설계상
 *    존재하지 않는다. 고아는 norm 90일 lifecycle이 자연 청소.
 *  - 예외적 재사용은 단 하나: 이번 호출에서 "내가" 방금 발행한 (g, hash)를 다음
 *    CAS 시도에 다시 쓰는 것. hash 동일 + g 단조 가드로만 허용 — 타 레이어/슬롯
 *    쓰기가 일으키는 일상적 shard CAS 충돌마다 고아가 쌓이는 것을 막는다.
 *  - 재시도 소진 시 throw → 호출자가 status 원장에 failed(norm_commit) 기록,
 *    다음 invocation이 같은 슬롯을 자연 재시도 (고아가 남아 있어도 무해). */
import { gunzipToText, gzipText } from '../gzip';
import { contentHash } from '../hash';
import { sleep } from '../http';
import { manifestEntryKey, manifestSlotPrefix, normKey, normPointerKey, normSlotPrefix, dtOf } from '../slots';
import type { SlotFileBody as SharedSlotFileBody } from '@lwp/shared';
import type { LayerId, NormRecord } from '../types';

export interface SlotPointer {
  g: number;
  hash: string;
}

/** 포인터 shard 본문 — 읽기 프록시(proxy.ts /api/manifest·norm resolve)와 공유 */
export interface PointerShard {
  layers: Record<string, Record<string, SlotPointer>>;
}

export type MergeFn = (existing: readonly NormRecord[], incoming: readonly NormRecord[]) => NormRecord[];

/** 항공기: id(=hex:bucketTs) 기준 유니온, 신규 우선 — 같은 norm 슬롯에 지역별 invocation이 누적 */
export const mergeById: MergeFn = (existing, incoming) => {
  const byId = new Map<string, NormRecord>();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** 지진: revision 큰 쪽 우선 (USGS 사후 정정 반영, 구버전 되돌림 방지) */
export const mergeByRevision: MergeFn = (existing, incoming) => {
  const byId = new Map<string, NormRecord>();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) {
    const prev = byId.get(r.id);
    if (!prev || r.revision >= prev.revision) byId.set(r.id, r);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

export interface NormSlotOutcome {
  layer: LayerId;
  slot: number;
  written: boolean;
  generation: number;
  records: number;
}

/** 파일 스키마는 shared r2-contract로 승격 — 0a 부분집합으로 좁혀 사용.
 *  주의: JSON 필드 순서는 아래 객체 리터럴이 결정 (§8.7 내용 해시 전제 — 순서 변경 금지). */
type SlotFileBody = SharedSlotFileBody<NormRecord>;

interface ManifestEntryBody {
  layer: LayerId;
  slot: number;
  generation: number;
  writtenAt: string;
  hash: string;
  counts: { records: number; incoming: number; dropped: number };
}

async function readPointerShard(
  bucket: R2Bucket,
  key: string,
): Promise<{ shard: PointerShard; etag: string | null }> {
  const obj = await bucket.get(key);
  if (!obj) return { shard: { layers: {} }, etag: null };
  const parsed = (await obj.json()) as PointerShard;
  return { shard: { layers: parsed.layers ?? {} }, etag: obj.etag };
}

async function readSlotRecords(bucket: R2Bucket, key: string): Promise<NormRecord[]> {
  const obj = await bucket.get(key);
  if (!obj) return [];
  const text = await gunzipToText(await obj.arrayBuffer());
  const parsed = JSON.parse(text) as SlotFileBody;
  return Array.isArray(parsed.records) ? parsed.records : [];
}

const MAX_COMMIT_ATTEMPTS = 5;
/** 호출 1회당 generation 전진 상한 — 고아를 건너뛰는 putIfAbsent probe 총량 */
const MAX_GENERATION_PROBES = 8;

/** 고아 무더기 위로 점프: 존재하는 body/manifest의 최대 g를 LIST로 찾는다.
 *  probe 첫 충돌 시 1회만 호출 (평상시 LIST 비용 0) — 소진 소진 반복으로 슬롯이
 *  영구 실패하는 liveness 문제(재리뷰 4 Med) 방지. */
async function maxExistingGeneration(bucket: R2Bucket, layer: LayerId, slot: number): Promise<number> {
  let maxG = -1;
  for (const prefix of [normSlotPrefix(layer, slot), manifestSlotPrefix(layer, slot)]) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor });
      for (const obj of page.objects) {
        const m = /\.g(\d+)\./.exec(obj.key.slice(prefix.length - 2));
        const g = m ? Number(m[1]) : NaN;
        if (Number.isFinite(g) && g > maxG) maxG = g;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return maxG;
}
const CAS_BACKOFF_MIN_MS = 100;
const CAS_BACKOFF_MAX_MS = 500;

/** 정상 동시 갱신이 같은 리듬으로 계속 충돌해 attempts를 소진하지 않도록 지터 백오프 */
function casBackoffMs(): number {
  return CAS_BACKOFF_MIN_MS + Math.floor(Math.random() * (CAS_BACKOFF_MAX_MS - CAS_BACKOFF_MIN_MS));
}

export async function upsertNormSlot(
  bucket: R2Bucket,
  layer: LayerId,
  slot: number,
  slotDurationSec: number,
  incoming: readonly NormRecord[],
  merge: MergeFn,
  meta: { dropped: number },
): Promise<NormSlotOutcome> {
  const pointerKey = normPointerKey(dtOf(slot));
  const slotKey = String(slot);

  // 이번 호출에서 이미 충돌 확인·발행한 g는 다시 밟지 않는다 (단조 전진)
  let probeFloor = 0;
  let probesUsed = 0;
  // 이번 호출에서 내가 발행 완료한 (g, hash) — CAS 재시도 시 재사용 후보
  let prepared: { g: number; hash: string } | null = null;

  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(casBackoffMs());
    const { shard, etag } = await readPointerShard(bucket, pointerKey);
    const current = shard.layers[layer]?.[slotKey];

    const existingRecords = current
      ? await readSlotRecords(bucket, normKey(layer, slot, current.g))
      : [];
    const merged = merge(existingRecords, incoming);
    const hash = await contentHash(merged);

    if (current && current.hash === hash) {
      return { layer, slot, written: false, generation: current.g, records: merged.length };
    }

    // ①② body + manifest 발행. 이미 존재하는 g는 — 고아든 경쟁자든 구분 없이 —
    //    재사용도 삭제도 하지 않고 g+1로 전진 (헤더의 "고아 = 무해" 불변식).
    //    예외: 내가 방금 발행한 prepared는 hash 동일 + g 단조(포인터보다 앞)일 때만
    //    재사용 — 타 레이어/슬롯發 shard CAS 충돌마다 고아가 쌓이는 것 방지.
    //    g 단조 가드가 없으면 경쟁 커밋 뒤 포인터 g를 되돌릴 수 있어 필수.
    let generation: number;
    if (prepared && prepared.hash === hash && prepared.g > (current?.g ?? -1)) {
      generation = prepared.g;
    } else {
      prepared = null;
      probeFloor = Math.max(probeFloor, current ? current.g + 1 : 0);
      const writtenAt = new Date().toISOString();
      let issued = -1;
      let jumped = false;
      while (probesUsed < MAX_GENERATION_PROBES) {
        const g = probeFloor;
        probeFloor += 1;
        probesUsed += 1;
        const body: SlotFileBody = { layer, slot, slotDurationSec, generation: g, writtenAt, records: merged };
        if (!(await putIfAbsent(bucket, normKey(layer, slot, g), await gzipText(JSON.stringify(body))))) {
          // 선점된 g — 첫 충돌이면 고아 무더기 전체를 LIST 1회로 건너뛴다 (liveness)
          if (!jumped) {
            jumped = true;
            probeFloor = Math.max(probeFloor, (await maxExistingGeneration(bucket, layer, slot)) + 1);
          }
          continue;
        }
        const entry: ManifestEntryBody = {
          layer,
          slot,
          generation: g,
          writtenAt,
          hash,
          counts: { records: merged.length, incoming: incoming.length, dropped: meta.dropped },
        };
        if (!(await putIfAbsent(bucket, manifestEntryKey(layer, slot, g), JSON.stringify(entry)))) {
          continue; // 원장만 남은 고아와 충돌 — 방금 쓴 body도 버려두고 전진
        }
        issued = g;
        break;
      }
      if (issued < 0) {
        // probe 소진 — 재시도해도 같은 고아들과 충돌하므로 즉시 실패 (호출자가 status 기록)
        throw new Error(`norm generation probes exhausted (${MAX_GENERATION_PROBES}): ${pointerKey} ${layer}/${slotKey}`);
      }
      generation = issued;
      prepared = { g: generation, hash };
    }

    // ③ 포인터 CAS — 신규 shard도 create-if-absent (최초 실행·UTC 새 날짜 경합 방지)
    const nextShard: PointerShard = {
      layers: {
        ...shard.layers,
        [layer]: { ...(shard.layers[layer] ?? {}), [slotKey]: { g: generation, hash } },
      },
    };
    const putOk = await casPut(bucket, pointerKey, JSON.stringify(nextShard), etag);
    if (putOk) return { layer, slot, written: true, generation, records: merged.length };

    // CAS 충돌 — 경쟁자가 같은 내용을 이미 커밋했으면 성공 수렴 (g가 달라도 hash가
    // 판정: 포인터가 가리키는 g의 body는 커밋자가 발행 완료한 것이므로 유실 없음).
    // 다른 내용이면 내 body/manifest는 그대로 버려두고(무해 고아) 재병합 재시도.
    const { shard: afterShard } = await readPointerShard(bucket, pointerKey);
    const committed = afterShard.layers[layer]?.[slotKey];
    if (committed && committed.hash === hash) {
      return { layer, slot, written: true, generation: committed.g, records: merged.length };
    }
  }
  // 호출자(collect.ts)가 status 원장에 failed(norm_commit) 기록 — 고아는 무해하므로
  // 다음 invocation의 같은 슬롯 재시도가 항상 성립한다.
  throw new Error(`norm slot commit failed after ${MAX_COMMIT_ATTEMPTS} attempts: ${pointerKey} ${layer}/${slotKey}`);
}

/** create-if-absent 조건부 PUT (If-None-Match: *) — 이미 존재하면 false */
export async function putIfAbsent(
  bucket: R2Bucket,
  key: string,
  body: string | ArrayBuffer,
): Promise<boolean> {
  const result = await bucket.put(key, body, { onlyIf: { etagDoesNotMatch: '*' } });
  return result !== null;
}

/** ETag 조건부 PUT. etag null(신규)이면 create-if-absent — 생성 경합도 CAS로 취급 */
export async function casPut(
  bucket: R2Bucket,
  key: string,
  body: string,
  etag: string | null,
): Promise<boolean> {
  if (etag === null) return await putIfAbsent(bucket, key, body);
  const result = await bucket.put(key, body, { onlyIf: { etagMatches: etag } });
  return result !== null;
}

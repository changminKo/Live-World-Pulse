/** latest.json — 전 레이어 통합 최신 스냅샷.
 *  read-modify-write + ETag 조건부 PUT(CAS): 이번 invocation이 갱신한 레이어/지역만 교체,
 *  나머지 레이어는 기존 내용 보존 (PLAN §8.6 — stateless invocation의 유일한 보존 경로).
 *  신규 객체도 create-if-absent 조건부 PUT — 최초 실행 병렬 last-write-wins 방지. */
import { LATEST_KEY } from '../slots';
import type { LatestDoc } from '@lwp/shared';
import type { EarthquakeRecord, FlightRecord, Iso } from '../types';

/** 스키마는 shared r2-contract로 승격 (프론트 LIVE 폴링과 공유) — 기존 임포트 경로 유지용 재수출 */
export type { LatestDoc } from '@lwp/shared';

const EMPTY: LatestDoc = { updatedAt: new Date(0).toISOString(), layers: {} };
const MAX_CAS_ATTEMPTS = 4;

export async function updateLatest(
  bucket: R2Bucket,
  apply: (doc: LatestDoc) => LatestDoc,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const obj = await bucket.get(LATEST_KEY);
    const doc = obj ? ((await obj.json()) as LatestDoc) : EMPTY;
    const applied = apply(doc);
    // 단조 갱신 스킵 (setter가 기존 doc을 그대로 반환) — 쓰기 자체를 생략
    if (applied === doc && obj) return;
    const body = JSON.stringify({ ...applied, updatedAt: new Date().toISOString() });

    if (!obj) {
      // create-if-absent: 최초 실행에 병렬 quake/flight가 서로를 지우지 못하게 조건부 생성
      const created = await bucket.put(LATEST_KEY, body, {
        onlyIf: { etagDoesNotMatch: '*' },
      });
      if (created !== null) return;
      continue; // 경쟁자가 먼저 생성 — 재읽기 후 병합 재시도
    }
    const result = await bucket.put(LATEST_KEY, body, { onlyIf: { etagMatches: obj.etag } });
    if (result !== null) return;
    // CAS 충돌 — 재읽기 후 재시도
  }
  throw new Error(`latest.json CAS failed after ${MAX_CAS_ATTEMPTS} attempts`);
}

/** 단조 갱신: 기존 asOf가 더 새거나 같으면 doc을 그대로 반환 (늦게 끝난 과거 invocation의 되돌림 방지) */
export function setEarthquakeLatest(records: EarthquakeRecord[], asOf: Iso) {
  return (doc: LatestDoc): LatestDoc => {
    const existing = doc.layers.earthquake;
    if (existing && existing.asOf >= asOf) return doc;
    return { ...doc, layers: { ...doc.layers, earthquake: { asOf, records } } };
  };
}

export function setFlightRegionLatest(regionId: string, records: FlightRecord[], asOf: Iso) {
  return (doc: LatestDoc): LatestDoc => {
    const existing = doc.layers.flight?.regions[regionId];
    if (existing && existing.asOf >= asOf) return doc;
    return {
      ...doc,
      layers: {
        ...doc.layers,
        flight: {
          regions: { ...(doc.layers.flight?.regions ?? {}), [regionId]: { asOf, records } },
        },
      },
    };
  };
}

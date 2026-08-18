import type { NormRecord } from './types';

/** 슬롯 내용 해시 — generation 판정용 (§8.7 '내용 불변 시 g0 유지').
 *  ingestedAt은 재실행마다 달라지므로 제외. id 정렬로 순서 무관 결정론 확보. */
export async function contentHash(records: readonly NormRecord[]): Promise<string> {
  const canonical = records
    .map((r) => ({ ...r, ingestedAt: '' }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

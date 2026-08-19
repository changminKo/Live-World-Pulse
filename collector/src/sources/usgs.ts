/** shared 승격 (수정 태스크 Med5) — 정규화 구현은 @lwp/shared/normalize-usgs.
 *  web LIVE 폴러와 동일 함수 공유 (PLAN §8.4 동일 정규화 계약). 기존 import 경로 유지용 re-export. */
export { USGS_ALL_HOUR_URL, normalizeUsgs, quakeSeverity } from '@lwp/shared';
export type { NormalizeOutcome } from '@lwp/shared';

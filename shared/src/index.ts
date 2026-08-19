/** @lwp/shared — 프론트(web/)와 collector가 공유하는 계약 (PLAN §5·§6·§8.5·§8.6).
 *  의존성 0 순수 타입+함수. npm workspace 아님 — 소비자가 tsconfig paths로 상대 참조. */
export * from './types';
export * from './temporal';
export * from './r2-keys';
export * from './r2-contract';
export * from './url-state';

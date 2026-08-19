import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** 프론트 단위 테스트 (재리뷰 Low3 — 지금까지 web에 test 스크립트가 없었다).
 *  대상은 CLAUDE.md 테스트 규칙의 "최우선": 시간 슬라이스·참조 안정성·상태 전이·기하 계산.
 *  WebGL 픽셀 회귀는 여전히 금지 — 렌더 검증은 scripts/verify-layers.mjs(DOM·스토어·URL 단정). */
export default defineConfig({
  resolve: {
    alias: {
      '@lwp/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

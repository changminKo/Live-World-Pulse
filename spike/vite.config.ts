import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      // 프로덕션 hatch 구현(web/src/world/deck/hatch.ts)을 그대로 계측하기 위한 별칭
      '@lwp/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // ../web · ../shared 소스를 그대로 import한다 (계측 대상 = 프로덕션 코드)
    fs: { allow: ['..'] },
  },
});

/** Phase 0 기계 검증 — 지구본 렌더·JS 에러 0·스크린샷 2장·FPS 임계·URL 계약 회귀.
 *  실 API 아님(타일 서버는 정적 CDN) — E2E 모킹 룰은 이벤트 데이터 fixture에 적용.
 *  종료 코드 반영 단정: console/page 에러 0, 랜딩 지도 번들 누수 0, fps ≥ 30,
 *  카메라 이동 후 URL 비카메라 필드(t/l/sel/play/rate/pin) 보존. */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const BASE = process.env.LWP_BASE ?? 'http://localhost:5199';
const OUT_DIR = fileURLToPath(new URL('../../docs/phase0/shots/', import.meta.url));
const MIN_FPS = 30;
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  // headless GPU 경로 (macOS Metal) — 소프트웨어 GL 대비 실사용에 근접한 프레임
  args: ['--enable-gpu', '--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

// ── 1. 랜딩: 지도 번들 로드 금지 검증 (PLAN §10 랜딩/앱 분리) ──
const landingRequests = [];
const trackLanding = (r) => landingRequests.push(r.url());
page.on('request', trackLanding);
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
page.off('request', trackLanding);
const mapBundleLeak = landingRequests.filter((u) => /WorldPage|maplibre|deck/i.test(u));

// ── 2. /world 전체 지구본 (z1.5 동아시아 초기 카메라) ──
await page.goto(`${BASE}/world`, { waitUntil: 'networkidle' });
await page.waitForSelector('.maplibregl-canvas', { timeout: 20_000 });
await page.waitForTimeout(6_000); // 타일 페인트 안정화
await page.screenshot({ path: `${OUT_DIR}globe-full-z1.5.png` });

// ── 3. FPS 실측 — rAF 3초 (자동 회전 동작 중), 임계 ≥ 30 ──
const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = (now) => {
        frames += 1;
        if (now - start >= 3_000) resolve(Math.round((frames / (now - start)) * 1000));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
);

// ── 4. z4 줌 — URL 파라미터 복원 경로로 진입 (parseAppState 검증 겸용) ──
await page.goto(`${BASE}/world?lat=35.9&lng=127.5&z=4`, { waitUntil: 'networkidle' });
await page.waitForSelector('.maplibregl-canvas', { timeout: 20_000 });
await page.waitForTimeout(6_000);
await page.screenshot({ path: `${OUT_DIR}globe-zoom-z4.png` });

// ── 5. URL 계약 회귀 — 카메라 이동은 lat/lng/z만 교체, t/l/sel/play/rate/pin 보존.
// reduced-motion으로 자동 회전을 멈춰 이동 종료 시점을 결정론화하고,
// dev 진단 핸들(__lwpMap)로 1회 jumpTo → 디바운스(viewport 250ms·URL 300ms) 후 1회 replaceState. ──
const FULL_QUERY = 'lat=35.9&lng=127.5&z=4&t=1755540000000&l=eq&sel=usgs%3Aabc&play=1&rate=10&pin=case-1';
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto(`${BASE}/world?${FULL_QUERY}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.maplibregl-canvas', { timeout: 20_000 });
await page.waitForTimeout(1_000); // 초기화 안정
const urlBeforeMove = await page.evaluate(() => window.location.search);
await page.evaluate(() => window.__lwpMap.jumpTo({ center: [100, 25], zoom: 3 }));
await page.waitForTimeout(1_500); // 디바운스 여유
const urlAfterMove = await page.evaluate(() => window.location.search);

const urlViolations = [];
const after = new URLSearchParams(urlAfterMove);
if (after.get('lat') !== '25' || after.get('lng') !== '100' || after.get('z') !== '3') {
  urlViolations.push(`camera not updated after move: ${urlAfterMove}`);
}
const MUST_PRESERVE = [
  ['t', '1755540000000'],
  ['l', 'eq'],
  ['sel', 'usgs:abc'],
  ['play', '1'],
  ['rate', '10'],
  ['pin', 'case-1'],
];
for (const [key, expected] of MUST_PRESERVE) {
  if (after.get(key) !== expected) {
    urlViolations.push(`${key} lost/changed: expected=${expected} actual=${after.get(key)}`);
  }
}

const fpsBelowThreshold = fps < MIN_FPS;
const report = {
  fps,
  minFps: MIN_FPS,
  fpsBelowThreshold,
  urlBeforeMove,
  urlAfterMove,
  urlViolations,
  mapBundleLeak,
  errors,
  outDir: OUT_DIR,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await browser.close();
process.exit(
  errors.length > 0 || mapBundleLeak.length > 0 || urlViolations.length > 0 || fpsBelowThreshold
    ? 1
    : 0,
);

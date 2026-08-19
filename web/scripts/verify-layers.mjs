/** Phase 1 레이어 기계 검증 — 실 API(프록시 latest + USGS)로 4레이어 마커 렌더·픽킹·토글·FPS.
 *  종료 코드 단정: console/page 에러 0, 지진·항공기·기상·뉴스 레코드 수신, 클릭 픽킹 → sel
 *  URL 반영, 토글 off → URL l 갱신, fps ≥ 50 (PLAN §10 데스크톱 목표), 스크린샷 갱신 +
 *  TC 트랙 낮은 고도각(pitch) 육안 확인용 1장 (스파이크 이관 7 — globe 위 Path 지표 관통).
 *  주의: WebGL 픽셀 회귀 아님 (CLAUDE.md 테스트 규칙) — DOM/스토어/URL 단정만. */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const BASE = process.env.LWP_BASE ?? 'http://localhost:5199';
const OUT_DIR = fileURLToPath(new URL('../../docs/phase0/shots/', import.meta.url));
const MIN_FPS = 50; // PLAN §10 데스크톱 목표 (리뷰 Low2 — 30은 회귀 게이트로 약함)
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  args: ['--enable-gpu', '--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

const failures = [];

// ── 1. /world z1.5 — 데이터 도착 대기 후 마커 수 실측 ──
await page.goto(`${BASE}/world`, { waitUntil: 'networkidle' });
await page.waitForSelector('.maplibregl-canvas', { timeout: 20_000 });
await page.waitForFunction(
  () => {
    const s = window.__lwpLive?.getState();
    return s && s.earthquake.lastSuccessAtMs !== null && s.flight.lastSuccessAtMs !== null;
  },
  { timeout: 30_000 },
);
const counts = await page.evaluate(() => {
  const s = window.__lwpLive.getState();
  return {
    quakes: s.earthquake.records.length,
    flights: s.flight.records.length,
    weather: s.weather.records.length,
    news: s.news.records.length,
    quakeStatus: s.earthquake.status,
    flightStatus: s.flight.status,
    weatherStatus: s.weather.status,
    newsStatus: s.news.status,
    flightAsOf: s.flight.asOfMs,
  };
});
if (counts.quakes === 0) failures.push('quake records = 0 (USGS all_hour 정상 시 드묾 — 재확인)');
if (counts.flights === 0) failures.push('flight records = 0 (6지역 전부 빈 것은 비정상)');
// weather/news는 Collector 수집 주기(15분)라 0일 수 있으나, latest에 있으면 스토어에도 있어야 함
if (counts.weather === 0) failures.push('weather records = 0 (GDACS 경보는 상시 수백 건 — latest 확인 필요)');
if (counts.news === 0) failures.push('news records = 0 (GDELT 15분 슬롯 — latest 확인 필요)');

// 헤더 LIVE 배지 — 하나라도 ready면 ● LIVE
const badgeText = await page.locator('header span[title]').first().textContent();

await page.waitForTimeout(5_000); // 타일 페인트 안정화
await page.screenshot({ path: `${OUT_DIR}globe-full-z1.5.png` });

// ── 2. FPS 실측 (마커 렌더 + 자동 회전 상태) ──
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

// ── 3. 일본 확대 z4 스크린샷 (도쿄 지역 항공기 커버리지) ──
await page.emulateMedia({ reducedMotion: 'reduce' }); // 회전 정지 — 결정론화
await page.goto(`${BASE}/world?lat=36&lng=138&z=4`, { waitUntil: 'networkidle' });
await page.waitForSelector('.maplibregl-canvas', { timeout: 20_000 });
await page.waitForFunction(
  () => window.__lwpLive?.getState().flight.records.length > 0,
  { timeout: 30_000 },
);
await page.waitForTimeout(5_000);
await page.screenshot({ path: `${OUT_DIR}globe-zoom-z4.png` });

// ── 4. 클릭 픽킹 — 화면 안 항공기 1대를 투영해 클릭 → sel 스토어+URL 반영 ──
const target = await page.evaluate(() => {
  const map = window.__lwpMap;
  const flights = window.__lwpLive.getState().flight.records;
  const canvas = map.getCanvas().getBoundingClientRect();
  for (const f of flights) {
    const p = map.project(f.centroid);
    if (p.x > 40 && p.x < canvas.width - 40 && p.y > 40 && p.y < canvas.height - 40) {
      return { id: f.id, x: canvas.left + p.x, y: canvas.top + p.y };
    }
  }
  return null;
});
let picking = { attempted: false, pickedId: null, urlSel: null, ok: false };
if (target) {
  picking.attempted = true;
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(400);
  picking.urlSel = await page.evaluate(
    () => new URLSearchParams(window.location.search).get('sel'),
  );
  picking.pickedId = picking.urlSel;
  // 정확 중심 클릭 — 클릭한 대상 id와 일치해야 함 (비-null만 검사하면 인접 오선택을 놓침 — 재리뷰 Low)
  picking.ok = picking.urlSel === target.id;
  if (!picking.ok) failures.push(`클릭 픽킹 불일치: target=${target.id} sel=${picking.urlSel}`);
  // 상세 패널 렌더 확인
  const panelVisible = await page.locator('section[aria-label="선택 이벤트 상세"]').isVisible();
  if (!panelVisible) failures.push('상세 패널 미표시');
  // 빈 곳 클릭 → 선택 해제
  await page.mouse.click(target.x + 200, target.y - 200);
  await page.waitForTimeout(400);
} else {
  failures.push('z4 화면 안 항공기 투영 실패 — 픽킹 미검증');
}

// ── 5. 토글 off/on — URL l 갱신 + 기존 파라미터 보존 ──
await page.click('#layer-flight');
await page.waitForTimeout(300);
const lAfterOff = await page.evaluate(
  () => new URLSearchParams(window.location.search).get('l'),
);
if (lAfterOff !== 'eq,wx,nw') failures.push(`토글 off 후 l=${lAfterOff} (기대 eq,wx,nw)`);
const camPreserved = await page.evaluate(() => {
  const p = new URLSearchParams(window.location.search);
  return p.get('lat') !== null && p.get('z') !== null;
});
if (!camPreserved) failures.push('토글 시 카메라 파라미터 유실');
await page.click('#layer-flight');
await page.waitForTimeout(300);
const lAfterOn = await page.evaluate(
  () => new URLSearchParams(window.location.search).get('l'),
);
if (lAfterOn !== null) failures.push(`토글 복원 후 l=${lAfterOn} (기대: 기본값이라 생략)`);

const fpsBelowThreshold = fps < MIN_FPS;
if (fpsBelowThreshold) failures.push(`fps ${fps} < ${MIN_FPS}`);

const report = {
  counts,
  headerBadge: badgeText?.trim(),
  fps,
  minFps: MIN_FPS,
  picking,
  toggle: { lAfterOff, lAfterOn, camPreserved },
  errors,
  failures,
  outDir: OUT_DIR,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await browser.close();
process.exit(errors.length > 0 || failures.length > 0 ? 1 : 0);

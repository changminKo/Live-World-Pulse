/** 지구 표면 vs 우주 배경 대비 검증 — DESIGN §2.3 계약 (ΔL ≥ 22, Rec.709 luma 0-255).
 *
 *  측정법 (계약 명문): 실행 스크린샷 픽셀에서 표면(해양·야간면 대용 반구) 4점 이상 /
 *  우주 배경 4점 이상을 샘플해 각각 중앙값 luma를 낸다. 별(1px 점묘)·마커(3~6px)
 *  오염은 점당 3×3 중앙값 + 클래스당 9점 중앙값으로 걸러낸다.
 *  WCAG 대비 공식을 쓰지 않는 이유는 DESIGN §2.3 참조 (flare 항이 근흑 영역 지배).
 *
 *  스크린샷 4장 → docs/phase1/shots/contrast/ (z1.5 기본 / z4 확대 / pitch60 / 해양 반구).
 *  종료 코드 단정: 해양·육지 각각 ΔL ≥ 22, 육지 > 해양, console/page 에러 0. */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const BASE = process.env.LWP_BASE ?? 'http://localhost:5199';
const OUT_DIR = fileURLToPath(new URL('../../docs/phase1/shots/contrast/', import.meta.url));
const MIN_DELTA_L = 22; // DESIGN §2.3 계약
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.emulateMedia({ reducedMotion: 'reduce' }); // 자동 회전 정지 — 샘플 결정론화

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

const failures = [];

/** 스크린샷 PNG를 페이지 안 2D 캔버스로 디코드해 지정 점들의 3×3 중앙값 luma를 잰다 */
async function sampleLuma(buf, points) {
  return page.evaluate(
    async ({ b64, pts }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      // 스크린샷은 devicePixelRatio 배율 — CSS 좌표를 픽셀 좌표로 환산
      const scale = img.width / 1440;
      const median = (arr) => {
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      return pts.map(([x, y]) => {
        const lumas = [];
        const rgbs = [];
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            const d = ctx.getImageData(
              Math.round((x + dx) * scale),
              Math.round((y + dy) * scale),
              1,
              1,
            ).data;
            lumas.push(0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]);
            rgbs.push([d[0], d[1], d[2]]);
          }
        }
        const m = median(lumas);
        return { x, y, luma: m, rgb: rgbs[lumas.indexOf(m)] };
      });
    },
    { b64: buf.toString('base64'), pts: points },
  );
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** z1.5 정면 뷰 기준 샘플 좌표 (1440×900).
 *  지구본 캔버스 열 = x≈216..1152 (좌 LAYERS·우 EVENT LOG 패널 제외 — 패널은 bg-1이라
 *  우주 배경이 아니다), 원반 중심 ≈(683,445), 반경 ≈200px.
 *  표면점 = 원반 중앙부, 우주점 = 캔버스 안·대기광(림 주변 ~40px) 밖. */
const SURFACE_POINTS = [
  [683, 445], [620, 400], [750, 500], [683, 330], [683, 560],
  [600, 510], [770, 380], [640, 445], [730, 445],
];
const SPACE_POINTS = [
  [300, 120], [1060, 120], [300, 760], [1060, 760],
  [260, 445], [1100, 445], [683, 90], [450, 750], [920, 110],
];

async function shoot(url, file, waitMs = 6000) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.maplibregl-canvas', { timeout: 20_000 });
  await page.waitForTimeout(waitMs); // 타일·오버라이드 페인트 안정화
  const buf = await page.screenshot({ path: `${OUT_DIR}${file}` });
  return buf;
}

// ── 1. 해양 반구 (태평양 중심 — '야간면' 대용: 현 렌더러에 주야 셰이딩 없음) ──
const oceanShot = await shoot('/world?lng=-150&lat=5&z=1.5', 'globe-ocean-hemisphere-z1.5.png');
const oceanSurface = await sampleLuma(oceanShot, SURFACE_POINTS);
const oceanSpace = await sampleLuma(oceanShot, SPACE_POINTS);

// ── 2. 육지 반구 z1.5 기본 (아프리카 중심) ──
const landShot = await shoot('/world?lng=20&lat=8&z=1.5', 'globe-land-z1.5.png');
const landSurface = await sampleLuma(landShot, SURFACE_POINTS);
const landSpace = await sampleLuma(landShot, SPACE_POINTS);

// ── 3. z4 확대 (일본 — 마커 밀집 지역: 그라티큘·마커 가독성 육안 판정용) ──
await shoot('/world?lng=138&lat=36&z=4', 'globe-zoom-z4.png');

// ── 4. 저각도 pitch 60 (그라티큘 지표 밀착 + 수평선 확인) ──
await page.evaluate(() => window.__lwpMap.jumpTo({ center: [138, 30], zoom: 3, pitch: 60 }));
await page.waitForTimeout(2_500);
await page.screenshot({ path: `${OUT_DIR}globe-pitch60.png` });

// ── 단정 ──
const oceanLuma = median(oceanSurface.map((p) => p.luma));
const landLuma = median(landSurface.map((p) => p.luma));
const spaceLuma = median([...oceanSpace, ...landSpace].map((p) => p.luma));
const oceanDelta = oceanLuma - spaceLuma;
const landDelta = landLuma - spaceLuma;

if (oceanDelta < MIN_DELTA_L) failures.push(`해양 ΔL ${oceanDelta.toFixed(1)} < ${MIN_DELTA_L}`);
if (landDelta < MIN_DELTA_L) failures.push(`육지 ΔL ${landDelta.toFixed(1)} < ${MIN_DELTA_L}`);
if (landLuma <= oceanLuma) {
  failures.push(`육지(${landLuma.toFixed(1)}) ≤ 해양(${oceanLuma.toFixed(1)}) — 상대 단차 위반`);
}
if (oceanSurface.length < 4 || landSurface.length < 4 || oceanSpace.length + landSpace.length < 4) {
  failures.push('샘플 수 부족 (계약: 표면·배경 각 4점 이상)');
}
if (errors.length > 0) failures.push(...errors);

const report = {
  contract: `ΔL ≥ ${MIN_DELTA_L} (Rec.709 luma 0-255, DESIGN §2.3)`,
  spaceLuma: Number(spaceLuma.toFixed(1)),
  ocean: { luma: Number(oceanLuma.toFixed(1)), deltaL: Number(oceanDelta.toFixed(1)) },
  land: { luma: Number(landLuma.toFixed(1)), deltaL: Number(landDelta.toFixed(1)) },
  samples: {
    oceanSurface: oceanSurface.map((p) => ({ ...p, luma: Number(p.luma.toFixed(1)) })),
    landSurface: landSurface.map((p) => ({ ...p, luma: Number(p.luma.toFixed(1)) })),
    space: [...oceanSpace, ...landSpace].map((p) => ({ ...p, luma: Number(p.luma.toFixed(1)) })),
  },
  failures,
  outDir: OUT_DIR,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await browser.close();
process.exit(failures.length > 0 ? 1 : 0);

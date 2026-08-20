/** TC 트랙 후보 비교 계측 (스파이크 이관 7 재검증 — 후보 판정표 근거 생성).
 *
 *  후보 × pose 마다:
 *    1) flat 스타일(배경색만)로 지구 디스크 마스크를 먼저 찍고(hide=1),
 *    2) 같은 pose에서 후보 선(순수 마젠타)을 찍어,
 *    3) **디스크 밖 마젠타 픽셀 수 = 지구 실루엣 밖으로 뜬 픽셀**을 센다 (객관 지표).
 *    4) basemap 스타일로 육안 판정용 스크린샷도 남긴다.
 *  WebGL 픽셀 회귀가 아니다 — 색이 아니라 "밖으로 샜는가"만 세는 기하 단정.
 *
 *  선(line)만이 아니라 **콘 채움(fill)·빗금(hatch)** 도 deck ↔ maplibre 네이티브로 각각
 *  계측한다 (사후 리뷰 Med2 — 이전 판정표는 선만 재고 "line/fill 0px"을 주장했다).
 *  콘은 SAUDEL-26(lon 132…153)이라 트랙 pose에서는 화면 밖이다 → 콘 전용 pose(c*)를 쓴다.
 *  콘을 화면 중앙에 두면 pitch 오차가 거의 안 보인다 → 수평선 쪽에 놓는 pose(chorizon·cedge)가
 *  선 후보의 lowpitch와 같은 조건이고, 판정은 그 pose로 한다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';

const BASE = process.env.TC_BASE ?? 'http://localhost:5173';
const OUT = fileURLToPath(new URL('../../docs/phase1/shots/candidates/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const CANDS = ['path', 'gc', 'subdiv', 'billboard', 'cull', 'cull2', 'maplibre'];
const POSES = ['globe', 'zoom', 'lowpitch', 'back'];
/** 콘 계측용 pose (콘 중심) × 엔진 × 계측 대상 */
const CONE_POSES = ['cglobe', 'czoom', 'clowpitch', 'chorizon', 'cedge', 'cback'];
const ENGINES = ['deck', 'native'];
const AREA_MEASURES = ['fill', 'hatch'];
const VIEWPORT = { width: 1280, height: 800 };

const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: VIEWPORT });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

async function shot(url, file) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__tc?.ready === true, { timeout: 20_000 });
  await page.waitForTimeout(2_500); // 타일/렌더 안정화
  const buf = await page.screenshot({ path: file ? `${OUT}${file}` : undefined });
  return buf;
}

function decode(buf) {
  return PNG.sync.read(buf);
}

/** 디스크 마스크: 배경(#000 근처)이 아닌 픽셀 = 지구 */
function discMask(png) {
  const mask = new Uint8Array(png.width * png.height);
  for (let i = 0; i < mask.length; i += 1) {
    const r = png.data[i * 4];
    const g = png.data[i * 4 + 1];
    const b = png.data[i * 4 + 2];
    mask[i] = r + g + b > 24 ? 1 : 0;
  }
  return mask;
}

/** 마젠타(선) 픽셀 — r 높고 g 낮고 b 높음 */
function isLine(png, i) {
  const r = png.data[i * 4];
  const g = png.data[i * 4 + 1];
  const b = png.data[i * 4 + 2];
  return r > 150 && b > 150 && g < 90;
}

const results = [];
for (const pose of POSES) {
  const maskPng = decode(await shot(`${BASE}/tc.html?style=flat&pose=${pose}&hide=1`, `mask-${pose}.png`));
  const mask = discMask(maskPng);
  const discPx = mask.reduce((a, b) => a + b, 0);
  for (const cand of CANDS) {
    const flat = decode(
      await shot(`${BASE}/tc.html?style=flat&pose=${pose}&cand=${cand}`, `flat-${cand}-${pose}.png`),
    );
    let linePx = 0;
    let outsidePx = 0;
    for (let i = 0; i < mask.length; i += 1) {
      if (!isLine(flat, i)) continue;
      linePx += 1;
      if (mask[i] === 0) outsidePx += 1;
    }
    await shot(`${BASE}/tc.html?style=basemap&pose=${pose}&cand=${cand}&poly=plain`, `map-${cand}-${pose}.png`);
    const pts = await page.evaluate(() => window.__tc.trackPts);
    results.push({ pose, cand, discPx, linePx, outsidePx, outsidePct: +(100 * outsidePx / Math.max(1, linePx)).toFixed(2), trackPts: pts });
    process.stdout.write(`${pose}/${cand}: line=${linePx} outside=${outsidePx} (${(100 * outsidePx / Math.max(1, linePx)).toFixed(2)}%)\n`);
  }
}

// 콘 채움·빗금 — deck vs maplibre 네이티브 (선과 같은 "지구 밖 픽셀" 지표)
const areaResults = [];
for (const pose of CONE_POSES) {
  const maskPng = decode(await shot(`${BASE}/tc.html?style=flat&pose=${pose}&hide=1`, `mask-${pose}.png`));
  const mask = discMask(maskPng);
  const discPx = mask.reduce((a, b) => a + b, 0);
  for (const engine of ENGINES) {
    for (const measure of AREA_MEASURES) {
      const png = decode(
        await shot(
          `${BASE}/tc.html?style=flat&pose=${pose}&cand=none&poly=plain&engine=${engine}&measure=${measure}`,
          `flat-${measure}-${engine}-${pose}.png`,
        ),
      );
      let px = 0;
      let outsidePx = 0;
      for (let i = 0; i < mask.length; i += 1) {
        if (!isLine(png, i)) continue;
        px += 1;
        if (mask[i] === 0) outsidePx += 1;
      }
      const hatchSegs = await page.evaluate(() => window.__tc.hatchSegs);
      areaResults.push({ pose, engine, measure, poly: 'plain', discPx, px, outsidePx, outsidePct: +(100 * outsidePx / Math.max(1, px)).toFixed(2), hatchSegs });
      process.stdout.write(`${pose}/${engine}/${measure}: px=${px} outside=${outsidePx} (${(100 * outsidePx / Math.max(1, px)).toFixed(2)}%)\n`);
    }
    // 육안 대조 — 같은 pose에서 콘 전체(채움+외곽+빗금)를 엔진별로
    await shot(
      `${BASE}/tc.html?style=basemap&pose=${pose}&cand=none&poly=plain&engine=${engine}`,
      `map-cone-${engine}-${pose}.png`,
    );
  }
}

// 콘 링 세분화(0.5° 대권)가 필요한지 — 네이티브 채택안에서 plain vs subdiv 픽셀 비교
for (const pose of ['chorizon', 'cedge']) {
  const maskPng = decode(await shot(`${BASE}/tc.html?style=flat&pose=${pose}&hide=1`));
  const mask = discMask(maskPng);
  const discPx = mask.reduce((a, b) => a + b, 0);
  for (const measure of AREA_MEASURES) {
    const png = decode(
      await shot(
        `${BASE}/tc.html?style=flat&pose=${pose}&cand=none&poly=subdiv&engine=native&measure=${measure}`,
        `flat-${measure}-native-subdiv-${pose}.png`,
      ),
    );
    let px = 0;
    let outsidePx = 0;
    for (let i = 0; i < mask.length; i += 1) {
      if (!isLine(png, i)) continue;
      px += 1;
      if (mask[i] === 0) outsidePx += 1;
    }
    areaResults.push({ pose, engine: 'native', measure, poly: 'subdiv', discPx, px, outsidePx, outsidePct: +(100 * outsidePx / Math.max(1, px)).toFixed(2) });
    process.stdout.write(`${pose}/native+subdiv/${measure}: px=${px} outside=${outsidePx}\n`);
  }
}

// 폴리곤(콘) 후보 — plain vs subdiv 육안 대조
for (const poly of ['plain', 'subdiv']) {
  await shot(`${BASE}/tc.html?style=basemap&pose=clowpitch&cand=none&poly=${poly}`, `cone-${poly}-lowpitch.png`);
  await shot(`${BASE}/tc.html?style=basemap&pose=czoom&cand=none&poly=${poly}`, `cone-${poly}-zoom.png`);
}

const report = { viewport: VIEWPORT, results, areaResults, errors, outDir: OUT };
writeFileSync(`${OUT}report.json`, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await browser.close();
process.exit(errors.length > 0 ? 1 : 0);

/** Phase 1 레이어 기계 검증 — 실 API(프록시 latest + USGS)로 4레이어 마커 렌더·픽킹·토글·FPS.
 *  종료 코드 단정: console/page 에러 0, 지진·항공기·기상·뉴스 레코드 수신,
 *  **4레이어 각각의 클릭 픽킹** → sel URL 반영 (재리뷰 Low2 — 이전엔 flight만 눌렀다),
 *  TC 트랙/콘 렌더·픽킹 (모킹 fixture 주입 — 활성 TC가 없는 시각에도 결정론적으로 검증),
 *  토글 off → URL l 갱신, fps ≥ 50 (PLAN §10 데스크톱 목표), 스크린샷 갱신 +
 *  TC 트랙 낮은 고도각(pitch) 스크린샷 (스파이크 이관 7 — globe 위 Path billboard 확인).
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

// ── 4. 레이어별 클릭 픽킹 (재리뷰 Low2 — 이전엔 flight만, 그것도 z4 화면에 항공기가
//        없으면 미검증으로 실패했다) ──
// 방식: 레코드 좌표로 카메라를 옮긴 뒤, **deck이 실제로 픽킹 버퍼에 그린 객체**를
//   pickObjects로 찾아 그 픽셀을 클릭하고 URL sel이 그 객체 id와 같은지 본다.
//   레코드 좌표를 직접 클릭하지 않는 이유 (2026-08-19 실측): GDACS는 같은 좌표에 여러
//   경보가 겹치므로 앞 마커가 뒤 마커를 가린다 — "내가 고른 레코드"를 클릭해도 위에 있는
//   다른 레코드가 선택되는 게 정상이다. 그래서 단정은 "그려진 객체를 그 자리에서 누르면
//   그 id가 선택된다"로 세운다 (렌더·픽킹·URL 배선 전 구간 + 인접 오선택까지 잡는다).
// 주의 1: 자동 회전 중이면 project()와 click 사이에 지구가 돌아 빗나간다 — 위에서
//   emulateMedia({reducedMotion:'reduce'})로 회전을 정지시킨 상태다.
// 주의 2: 마커 sizeScale이 미터라 apparent 크기가 줌 무관 상수(~1.5~6px)다. 저줌에서
//   마커가 겹쳐 픽킹 대상이 뒤섞이므로 z8에서 검증한다.
const PICK_ZOOM = 8;

async function pickLayer(layer) {
  const target = await page.evaluate(
    async ({ key, zoom }) => {
      const records = window.__lwpLive.getState()[key].records;
      if (records.length === 0) return { reason: 'no-records' };
      const rec = [...records].sort((a, b) => b.severity.rank - a.severity.rank)[0];
      window.__lwpMap.jumpTo({ center: rec.centroid, zoom, pitch: 0 });
      await new Promise((r) => setTimeout(r, 1_400));

      const deck = window.__lwpDeck._deck;
      const canvas = window.__lwpMap.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const ids = deck.props.layers.map((l) => l.id);
      const wanted = window.__lwpDeckIds[key](ids);
      if (wanted.length === 0) return { reason: `no-deck-layer (있는 것: ${ids.join(',')})` };

      // 화면 안 레코드들의 투영 좌표 주변을 훑어 **deck이 그 픽셀에서 실제로 반환하는**
      // 객체를 찾는다. 주의 (2026-08-19 실측 2건):
      //  ① pickObject의 info.pixel은 "질의한 좌표"이지 객체가 그려진 좌표가 아니다 —
      //     radius를 키워 찾은 객체의 위치로 착각하면 빈 픽셀을 클릭하게 된다.
      //  ② 기상 Point 마커는 속이 빈 테두리라 정중앙이 구멍이다 — 오프셋 탐색 필요.
      const OFFS = [
        [0, 0],
        [3, 0],
        [-3, 0],
        [0, 3],
        [0, -3],
        [2, 2],
        [-2, -2],
      ];
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      for (const cand of records.slice(0, 300)) {
        const pr = window.__lwpMap.project(cand.centroid);
        if (pr.x < 24 || pr.x > w - 24 || pr.y < 24 || pr.y > h - 24) continue;
        for (const [dx, dy] of OFFS) {
          const info = deck.pickObject({ x: pr.x + dx, y: pr.y + dy, radius: 2, layerIds: wanted });
          if (info?.object?.id) {
            return {
              id: info.object.id,
              deckLayer: info.layer.id,
              x: rect.left + pr.x + dx,
              y: rect.top + pr.y + dy,
            };
          }
        }
      }
      return { reason: 'no-rendered-object', deckLayers: wanted };
    },
    { key: layer, zoom: PICK_ZOOM },
  );

  if (target.reason) {
    failures.push(`${layer} 픽킹 미검증: ${target.reason}`);
    return { layer, ok: false, reason: target.reason };
  }

  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(400);
  const sel = await page.evaluate(() => new URLSearchParams(window.location.search).get('sel'));
  const ok = sel === target.id;
  if (!ok) {
    // 실패 진단: 그 좌표에 무엇이 올라와 있고, deck은 여전히 그 객체를 찾는가
    const diag = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const canvas = window.__lwpMap.getCanvas();
        const rect = canvas.getBoundingClientRect();
        const info = window.__lwpDeck.pickObject({ x: x - rect.left, y: y - rect.top, radius: 6 });
        return {
          topEl: el ? `${el.tagName}.${el.className}` : null,
          overlayPick: info?.object?.id ?? null,
          overlayLayer: info?.layer?.id ?? null,
          rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
        };
      },
      { x: target.x, y: target.y },
    );
    failures.push(`${layer} 픽킹 불일치: target=${target.id} sel=${sel} diag=${JSON.stringify(diag)}`);
    return { layer, ok, sel, target: target.id, deckLayer: target.deckLayer, diag };
  }
  return { layer, ok, sel, target: target.id, deckLayer: target.deckLayer };
}

await page.evaluate(() => {
  // 레이어 → deck 레이어 id 매칭을 페이지 안으로 (evaluate 안에서 쓰기 위해)
  window.__lwpDeckIds = {
    earthquake: (ids) => ids.filter((id) => id === 'quakes'),
    flight: (ids) => ids.filter((id) => id.startsWith('flights-')),
    weather: (ids) => ids.filter((id) => id.startsWith('alert-') && id !== 'alert-hatch'),
    news: (ids) => ids.filter((id) => id === 'news'),
  };
});

const layerPicks = [];
for (const layer of ['flight', 'weather', 'news', 'earthquake']) {
  layerPicks.push(await pickLayer(layer));
}

// 상세 패널 렌더 + 빈 곳 클릭 → 선택 해제 (마지막 픽이 성공했을 때만 의미 있다)
let panelVisible = null;
let clearedSel = null;
if (layerPicks[layerPicks.length - 1]?.ok) {
  panelVisible = await page.locator('section[aria-label="선택 이벤트 상세"]').isVisible();
  if (!panelVisible) failures.push('상세 패널 미표시');
  await page.mouse.click(720 + 220, 450 - 220); // 마커에서 떨어진 지도 영역
  await page.waitForTimeout(400);
  clearedSel = await page.evaluate(() => new URLSearchParams(window.location.search).get('sel'));
  if (clearedSel !== null) failures.push(`빈 곳 클릭 후 선택 해제 실패: sel=${clearedSel}`);
}

// ── 4c. TC 트랙·콘 렌더 + 픽킹 (모킹 fixture — 활성 TC 유무와 무관하게 결정론) ──
// 실 GDACS는 활성 TC가 0건일 수 있으므로 스토어에 합성 레코드를 주입해 렌더 경로를 단정한다
// (CLAUDE.md: E2E는 모킹 fixture만. WebGL 픽셀 비교가 아니라 레이어 존재 + 픽킹 단정).
const track = await page.evaluate(() => {
  const store = window.__lwpLive;
  const base = {
    source: 'gdacs',
    layer: 'weather',
    revision: Date.now(),
    observedAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    h3r3: '',
    severity: { rank: 4, label: 'TC Red' },
    kind: 'interval',
    validFrom: new Date(Date.now() - 3_600_000).toISOString(),
    validTo: null,
    status: 'active',
  };
  const coords = [
    [140.9, 21.3],
    [138.4, 22.6],
    [135.8, 23.3],
    [133.0, 24.4],
    [130.1, 25.0],
  ];
  const cone = [[[136, 20], [141, 20], [141, 26], [136, 26], [136, 20]]];
  store.getState().setWeather({
    asOfMs: Date.now(),
    records: [
      {
        ...base,
        id: 'gdacs:999999:1',
        sourceId: '999999:1',
        geometry: { type: 'LineString', coordinates: coords },
        centroid: [135.8, 23.3],
        payload: {
          type: 'weatherAlert',
          event: 'Tropical Cyclone VERIFY-26',
          headline: null,
          areaDesc: null,
          capSeverity: null,
          gdacsAlertLevel: 'Red',
          gdacsEventType: 'TC',
          url: null,
          gdacsGeometryKind: 'track',
        },
      },
      {
        ...base,
        id: 'gdacs:999999:1:cone',
        sourceId: '999999:1:cone',
        geometry: { type: 'Polygon', coordinates: cone },
        centroid: [138.5, 23.0],
        payload: {
          type: 'weatherAlert',
          event: 'Tropical Cyclone VERIFY-26',
          headline: null,
          areaDesc: null,
          capSeverity: null,
          gdacsAlertLevel: 'Red',
          gdacsEventType: 'TC',
          url: null,
          gdacsGeometryKind: 'cone',
        },
      },
    ],
  });
  return { midpoint: coords[2], conePoint: [137.0, 25.5] };
});

await page.evaluate(() => window.__lwpMap.jumpTo({ center: [136, 23], zoom: 4.5, pitch: 0 }));
await page.waitForTimeout(1_500);

const deckLayers = await page.evaluate(() =>
  (window.__lwpDeck?._deck?.props?.layers ?? []).map((l) => l.id),
);
for (const id of ['alert-tracks', 'alert-areas', 'alert-hatch']) {
  if (!deckLayers.includes(id)) failures.push(`deck 레이어 누락: ${id} (있는 것: ${deckLayers.join(',')})`);
}

/** 트랙 선 위 한 점을 눌러 PathLayer 픽킹까지 확인 */
const trackPick = await (async () => {
  const at = await page.evaluate((lonLat) => {
    const rect = window.__lwpMap.getCanvas().getBoundingClientRect();
    const p = window.__lwpMap.project(lonLat);
    return { x: rect.left + p.x, y: rect.top + p.y };
  }, track.midpoint);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(400);
  const sel = await page.evaluate(() => new URLSearchParams(window.location.search).get('sel'));
  if (sel !== 'gdacs:999999:1') failures.push(`TC 트랙 픽킹 실패: sel=${sel}`);
  return sel;
})();

// 낮은 고도각 — globe 위 Path가 지구 실루엣 밖으로 뜨는지 육안 확인 (스파이크 이관 7)
await page.evaluate(() => window.__lwpMap.jumpTo({ center: [136, 23], zoom: 3.4, pitch: 60 }));
await page.waitForTimeout(1_500);
await page.screenshot({ path: `${OUT_DIR}tc-track-low-pitch.png` });
await page.evaluate(() => window.__lwpMap.jumpTo({ pitch: 0, zoom: 4, center: [138, 36] }));
await page.waitForTimeout(800);
await page.mouse.click(60, 60); // 선택 해제 (토글 섹션의 URL 단정 오염 방지)
await page.waitForTimeout(300);

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
  layerPicks,
  panel: { panelVisible, clearedSel },
  deckLayers,
  trackPick,
  toggle: { lAfterOff, lAfterOn, camPreserved },
  errors,
  failures,
  outDir: OUT_DIR,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await browser.close();
process.exit(errors.length > 0 || failures.length > 0 ? 1 : 0);

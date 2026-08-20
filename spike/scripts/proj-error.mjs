/** deck(overlaid) 투영 ↔ maplibre 투영 오차 — 트랙 정점을 deck ScatterplotLayer로 찍고
 *  map.project() 위치에서 나선 스캔 픽킹으로 실제 deck 위치를 찾아 픽셀 오차를 잰다.
 *  (spike RESULT 기준3 방법론 재사용 — pickObject는 radius 내 top 1개만 주므로 나선 스캔) */
import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--enable-gpu', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const out = {};
for (const pose of ['globe', 'zoom', 'lowpitch']) {
  await p.goto(`http://localhost:5173/tc.html?style=flat&pose=${pose}&cand=probe`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__tc?.ready === true, { timeout: 20000 });
  await p.waitForTimeout(2000);
  out[pose] = await p.evaluate(() => {
    const { map, overlay, vertices } = window.__tc;
    const res = [];
    for (const v of vertices) {
      const s = map.project(v);
      if (s.x < 0 || s.y < 0 || s.x > 1280 || s.y > 800) continue;
      let found = null;
      for (let r = 0; r <= 60 && !found; r += 1) {
        const n = r === 0 ? 1 : Math.max(8, Math.round(2 * Math.PI * r));
        for (let i = 0; i < n; i += 1) {
          const a = (2 * Math.PI * i) / n;
          const x = Math.round(s.x + r * Math.cos(a));
          const y = Math.round(s.y + r * Math.sin(a));
          const info = overlay.pickObject({ x, y, radius: 0 });
          if (info?.object && info.object.lon === v[0] && info.object.lat === v[1]) { found = r; break; }
        }
      }
      res.push({ v, screen: [Math.round(s.x), Math.round(s.y)], errPx: found });
    }
    const hits = res.filter((r) => r.errPx !== null);
    return {
      checked: res.length,
      hits: hits.length,
      misses: res.length - hits.length,
      maxErrPx: hits.reduce((m, r) => Math.max(m, r.errPx), 0),
      worst: res.slice().sort((a, c) => (c.errPx ?? 999) - (a.errPx ?? 999)).slice(0, 4),
    };
  });
  console.log(pose, JSON.stringify(out[pose]));
}
await b.close();

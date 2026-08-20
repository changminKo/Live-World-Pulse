import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--enable-gpu', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e.message)));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
for (const cand of ['arc']) {
  await p.goto(`http://localhost:5173/tc.html?style=flat&pose=globe&cand=${cand}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__tc?.ready === true, { timeout: 20000 });
  await p.waitForTimeout(2500);
  const info = await p.evaluate(() => {
    const deck = window.__tc.overlay._deck;
    const l = deck?.props?.layers?.find(x => x.id === 'tc-line');
    return { layerIds: (deck?.props?.layers ?? []).map(x => x.id), dataLen: l?.props?.data?.length ?? null };
  });
  const buf = await p.screenshot({ path: `/tmp/gc-${cand}.png` });
  console.log(cand, JSON.stringify(info), 'errs', errs.length);
}
await b.close();

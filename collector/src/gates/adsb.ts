/** adsb.lol 429 진단 게이트 (Phase 0a 배포 검증 — 측정 전용, 수집 아님).
 *  Workers egress에서 429가 왜 오는지 응답 헤더·바디로 확인한다. */
import { pointUrl } from '../sources/adsblol';
import { REGIONS } from '../schedule';

export async function adsbGate(regionId: string | null): Promise<Response> {
  const region = REGIONS.find((r) => r.id === (regionId ?? 'seoul')) ?? REGIONS[0];
  if (!region) return json({ ok: false, step: 'region' }, 400);

  const res = await fetch(pointUrl(region), { signal: AbortSignal.timeout(20_000) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = await res.text();

  return json({
    ok: res.ok,
    region: region.id,
    status: res.status,
    headers,
    bodyHead: body.slice(0, 300),
    bodyBytes: body.length,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

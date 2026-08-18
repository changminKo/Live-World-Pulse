/** GDELT 파싱 CPU 게이트 (PLAN §9 Phase 0a 착수 게이트 ②).
 *  수집 구현이 아니다 — 15분 export 파일 1개를 내려받아 파싱 CPU만 실측하는 측정 전용 경로.
 *  CPU 수치는 Workers observability(invocation CPU time)로 읽는다. */
import { unzipSync } from 'fflate';
import { validateLonLat } from '../coords';

const LASTUPDATE_URL = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';

// GDELT v2 export 61컬럼 중 ActionGeo_Lat/Long (0-based)
const COL_ACTIONGEO_LAT = 56;
const COL_ACTIONGEO_LON = 57;

export async function gdeltGate(): Promise<Response> {
  const last = await fetch(LASTUPDATE_URL, { signal: AbortSignal.timeout(15_000) });
  if (!last.ok) return json({ ok: false, step: 'lastupdate', status: last.status }, 502);

  const firstLine = (await last.text()).split('\n')[0] ?? '';
  const url = firstLine.trim().split(' ').pop();
  if (!url || !url.endsWith('.export.CSV.zip')) {
    return json({ ok: false, step: 'lastupdate-parse', line: firstLine }, 502);
  }

  const zipRes = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!zipRes.ok) return json({ ok: false, step: 'download', status: zipRes.status }, 502);
  const zipBytes = new Uint8Array(await zipRes.arrayBuffer());

  // ── 여기서부터가 측정 대상 CPU 경로 (unzip + TSV 파싱 + 좌표 검증) ──
  const files = unzipSync(zipBytes);
  const csvName = Object.keys(files)[0];
  const csvBytes = csvName ? files[csvName] : undefined;
  if (!csvName || !csvBytes) return json({ ok: false, step: 'unzip' }, 502);

  const text = new TextDecoder().decode(csvBytes);
  const lines = text.split('\n');
  let parsed = 0;
  let dropped = 0;
  for (const line of lines) {
    if (line === '') continue;
    const cols = line.split('\t');
    const lat = Number(cols[COL_ACTIONGEO_LAT]);
    const lon = Number(cols[COL_ACTIONGEO_LON]);
    if (validateLonLat(lon, lat)) parsed += 1;
    else dropped += 1;
  }

  return json({
    ok: true,
    file: url,
    zipBytes: zipBytes.byteLength,
    csvBytes: csvBytes.byteLength,
    lines: lines.length,
    parsedCoords: parsed,
    droppedCoords: dropped,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** GDELT raw 파일 어댑터 (PLAN §4.4 — 좌표는 15분 export raw 파일이 유일 경로).
 *  lastupdate.txt → 최신 {ts}.export.CSV.zip → fflate unzip → 필요한 컬럼만 표적 추출
 *  (§8.7 CPU 사다리: 61컬럼 전체 split 대신 탭 워커 — 실측 522KB/1.3k행 규모라 여유,
 *  그래도 raw PUT을 파싱보다 먼저 해 CPU 킬 시에도 원본은 보존).
 *  MVP 표현 계약: 0.5° 그리드 셀 집계 → Occurrence<NewsPayload>
 *  (h3 res-3 대신 좌표 그리드 — h3 라이브러리 번들·CPU 부담으로 대체 허용 조항 적용.
 *  h3r3 필드는 기존 레이어와 동일하게 '' 스텁 유지).
 *  멱등: 파일 타임스탬프 기반 슬롯 키 — sourceId = `${fileSec}:${lonIdx}:${latIdx}`,
 *  같은 파일 재처리는 동일 레코드 → norm 내용 해시로 자연 수렴. */
import { unzipSync } from 'fflate';
import { inflateRawSync } from 'node:zlib';
import { validateLonLat } from '../coords';
import { dtOf, hourOf } from '../slots';
import type { NormalizeOutcome } from './usgs';
import type { NewsPayload, NewsRecord, SeverityRank } from '../types';

export const GDELT_LASTUPDATE_URL = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';

/** 0.5° 그리드 (PLAN §4.4 대체 허용 — 결정 사유는 파일 헤더) */
export const NEWS_GRID_DEG = 0.5;

// GDELT v2 export 61컬럼 중 사용 컬럼 (0-based, Event Codebook V2.0 + 실측 검증 2026-08-19)
const COL_NUM_MENTIONS = 31; // NumMentions — 셀 대표 URL 선택(가장 많이 언급된 이벤트의 기사)에만 사용
const COL_NUM_ARTICLES = 33; // NumArticles — articleCount 집계의 근원 (아래 정의 참조)
const COL_ACTIONGEO_FULLNAME = 52;
const COL_ACTIONGEO_LAT = 56;
const COL_ACTIONGEO_LON = 57;
const COL_SOURCEURL = 60;
const LAST_NEEDED_COL = COL_SOURCEURL;

export interface GdeltFileRef {
  url: string;
  /** 파일명 타임스탬프 (UTC epoch ms) — 멱등 키·occurredAt·norm 슬롯의 근원 */
  fileMs: number;
}

/** lastupdate.txt 1행: `{size} {md5} {url(…{YYYYMMDDHHMMSS}.export.CSV.zip)}` */
export function parseLastUpdate(text: string): GdeltFileRef | null {
  const firstLine = text.split('\n')[0] ?? '';
  const url = firstLine.trim().split(/\s+/).pop();
  if (!url || !url.endsWith('.export.CSV.zip')) return null;
  const m = /(\d{14})\.export\.CSV\.zip$/.exec(url);
  if (!m || !m[1]) return null;
  const t = m[1];
  const fileMs = Date.UTC(
    Number(t.slice(0, 4)),
    Number(t.slice(4, 6)) - 1,
    Number(t.slice(6, 8)),
    Number(t.slice(8, 10)),
    Number(t.slice(10, 12)),
    Number(t.slice(12, 14)),
  );
  return Number.isFinite(fileMs) ? { url, fileMs } : null;
}

/** raw/{source}/dt=/hour=/ 경로 계약(§8.6)을 따르되 원본이 zip이라 확장자만 정직하게 유지.
 *  키가 파일 타임스탬프로 결정론 — putIfAbsent로 중복 적재 스킵 */
export function gdeltRawZipKey(fileMs: number): string {
  return `raw/gdelt/dt=${dtOf(Math.floor(fileMs / 1000))}/hour=${hourOf(fileMs)}/${fileMs}-export.CSV.zip`;
}

interface ZipEntry {
  method: number;
  compStart: number;
  compSize: number;
  uncompSize: number;
}

/** 첫 엔트리 메타 — central directory 기준 (data descriptor 파일도 사이즈 확정).
 *  GDELT export zip은 단일 엔트리·zip64 아님 (최대 2.8MB 실측). 구조 이상이면 null */
function firstZipEntry(zipBytes: Uint8Array): ZipEntry | null {
  if (zipBytes.length < 22) return null;
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  // EOCD(0x06054b50) 역방향 스캔 — 코멘트 최대 64KB 허용
  let eocd = -1;
  const scanFloor = Math.max(0, zipBytes.length - 22 - 65_535);
  for (let i = zipBytes.length - 22; i >= scanFloor; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const cd = view.getUint32(eocd + 16, true);
  if (cd + 46 > zipBytes.length || view.getUint32(cd, true) !== 0x02014b50) return null;
  const method = view.getUint16(cd + 10, true);
  const compSize = view.getUint32(cd + 20, true);
  const uncompSize = view.getUint32(cd + 24, true);
  const localOff = view.getUint32(cd + 42, true);
  if (localOff + 30 > zipBytes.length || view.getUint32(localOff, true) !== 0x04034b50) return null;
  const nameLen = view.getUint16(localOff + 26, true);
  const extraLen = view.getUint16(localOff + 28, true);
  const compStart = localOff + 30 + nameLen + extraLen;
  if (compStart + compSize > zipBytes.length) return null;
  return { method, compStart, compSize, uncompSize };
}

/** 첫 엔트리 해제 크기 (bytes) — 해제 전 CPU 팻파일 가드용. 구조 이상이면 null */
export function zipUncompressedSize(zipBytes: Uint8Array): number | null {
  return firstZipEntry(zipBytes)?.uncompSize ?? null;
}

/** zip → 첫 엔트리 CSV 텍스트. zip 구조 이상이면 null.
 *  CPU 사다리: zlib inflateRawSync(네이티브)가 기본 경로 — fflate JS inflate는
 *  대형 파일에서 수십 ms라 구조 파싱 실패 시 폴백으로만 유지. */
export function extractCsv(zipBytes: Uint8Array): string | null {
  const entry = firstZipEntry(zipBytes);
  if (entry) {
    try {
      const comp = zipBytes.subarray(entry.compStart, entry.compStart + entry.compSize);
      const bytes = entry.method === 0 ? comp : entry.method === 8 ? inflateRawSync(comp) : null;
      if (bytes) return new TextDecoder().decode(bytes);
    } catch {
      // 네이티브 경로 실패 — 아래 fflate 폴백
    }
  }
  try {
    const files = unzipSync(zipBytes);
    const name = Object.keys(files)[0];
    const bytes = name ? files[name] : undefined;
    if (!bytes) return null;
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** 탭 워커 — 전체 split 없이 지정 컬럼만 추출. 컬럼 부족 시 null.
 *  CPU 사다리 (2026-08-19): 문자 단위 charCodeAt 루프는 447KB CSV에서 4.2ms였다.
 *  탭 경계 탐색을 네이티브 indexOf로 바꾸고, 컬럼 → 출력 슬롯 판정을 `wanted.indexOf`
 *  선형 탐색에서 **룩업 테이블**로 바꿨다 (사후 리뷰 High1 후속 — 61컬럼 × 6원소 선형
 *  탐색이 행마다 366회였다. 실측 2,200행 1.77ms → 1.44ms).
 *  `out`은 호출자가 즉시 소비한다는 전제로 재사용 배열을 받을 수 있다 (행당 배열 할당 제거). */
export function pickColumns(
  line: string,
  wanted: readonly number[],
  out: string[] = new Array<string>(wanted.length).fill(''),
  slotOf?: Int8Array,
): string[] | null {
  const table = slotOf ?? columnSlotTable(wanted);
  let col = 0;
  let start = 0;
  let found = 0;
  const len = line.length;
  const maxCol = table.length - 1;
  while (start <= len) {
    let end = line.indexOf('\t', start);
    if (end < 0) end = len;
    const w = col <= maxCol ? table[col] ?? -1 : -1;
    if (w >= 0) {
      out[w] = line.slice(start, end);
      found += 1;
      if (found === wanted.length) break;
    }
    if (end === len) break;
    col += 1;
    start = end + 1;
    if (col > LAST_NEEDED_COL) break;
  }
  return found === wanted.length ? out : null;
}

/** 컬럼 인덱스 → 출력 슬롯 (없으면 -1). 행마다 다시 만들지 않는다. */
function columnSlotTable(wanted: readonly number[]): Int8Array {
  const table = new Int8Array(LAST_NEEDED_COL + 1).fill(-1);
  wanted.forEach((col, slot) => {
    if (col <= LAST_NEEDED_COL) table[col] = slot;
  });
  return table;
}

/** 앞뒤 공백이 있을 때만 trim — 평시 GDELT 컬럼은 공백이 없어 문자열 할당을 피한다 */
function trimIfNeeded(value: string): string {
  if (value === '') return '';
  const first = value.charCodeAt(0);
  const last = value.charCodeAt(value.length - 1);
  return first <= 32 || last <= 32 ? value.trim() : value;
}

const WANTED_COLS = [
  COL_NUM_MENTIONS,
  COL_NUM_ARTICLES,
  COL_ACTIONGEO_FULLNAME,
  COL_ACTIONGEO_LAT,
  COL_ACTIONGEO_LON,
  COL_SOURCEURL,
] as const;
const WANTED_SLOT_TABLE = columnSlotTable(WANTED_COLS);

/** 0.5° 셀 키를 **정수 하나**로 (사후 리뷰 High1 후속 — 행마다 `${lonIdx}:${latIdx}`
 *  템플릿 문자열을 만들면 2,200행에서 문자열 할당이 그만큼 생긴다).
 *  lonIdx ∈ [-360, 359], latIdx ∈ [-180, 179] 이므로 오프셋 후 1,024로 인터리브하면 충돌이 없다. */
const CELL_KEY_STRIDE = 1_024;
const cellKeyOf = (lonIdx: number, latIdx: number): number =>
  (lonIdx + 360) * CELL_KEY_STRIDE + (latIdx + 180);

interface CellAgg {
  lonIdx: number;
  latIdx: number;
  /** 셀 내 NumArticles(컬럼 33) 합 — NewsPayload.articleCount의 근원 (아래 정의) */
  articleSum: number;
  /** 셀 대표 지명·기사 = NumMentions 최대 행의 값 (사후 리뷰 High1 후속 — 아래 주석) */
  placeName: string | null;
  sampleUrl: string | null;
  sampleMentions: number;
}

function newsSeverityRank(count: number): SeverityRank {
  return count >= 50 ? 3 : count >= 10 ? 2 : 1;
}

/** export CSV → 0.5° 셀 집계 Occurrence<NewsPayload>.
 *
 *  articleCount 정의 (리뷰 Med 확정): 셀 내 이벤트 행들의 NumArticles(컬럼 33) 합 —
 *  "이 셀을 다룬 기사 수" (shared NewsPayload 코어 의미 '기사 수'와 일치).
 *  이벤트 행 수(rows)도 NumMentions(31)도 아니다 — 실측(2026-08-19) 한 셀에서
 *  rows=73 / sum NumArticles=221 / unique SOURCEURL=9로 전부 다른 지표.
 *  NumMentions는 셀 대표(sampleUrl·placeName) 선택에만 쓴다 — 가장 많이 언급된 이벤트의
 *  기사와 지명이다 (2026-08-19 CPU 사다리: 지명 최빈값 집계를 대표 행 채택으로 좁혔다).
 *
 *  주의: GDELT 빈 좌표는 빈 문자열 — Number('')===0이라 그대로 두면 적도 유령 좌표가
 *  된다. 빈 문자열은 파싱 전에 드롭. */
export function buildNewsRecords(
  csvText: string,
  fileMs: number,
  ingestedAtMs: number,
): NormalizeOutcome<NewsRecord> & { ok: true; rows: number } {
  const occurredAt = new Date(fileMs).toISOString();
  const ingestedAt = new Date(ingestedAtMs).toISOString();
  const fileSec = Math.floor(fileMs / 1000);

  const cells = new Map<number, CellAgg>();
  let rows = 0;
  let dropped = 0;

  // 행마다 재사용 — pickColumns가 즉시 소비되므로 안전 (참조를 보관하지 않는다)
  const colBuf = new Array<string>(WANTED_COLS.length).fill('');
  let lineStart = 0;
  while (lineStart < csvText.length) {
    let lineEnd = csvText.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = csvText.length;
    const line = csvText.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    if (line === '' || line === '\r') continue;
    rows += 1;

    const cols = pickColumns(line, WANTED_COLS, colBuf, WANTED_SLOT_TABLE);
    if (!cols) {
      dropped += 1;
      continue;
    }
    const [mentionsStr, articlesStr, fullName, latStr, lonStr, sourceUrl] = cols;
    if (latStr === '' || lonStr === '') {
      dropped += 1;
      continue;
    }
    const lonLat = validateLonLat(Number(lonStr), Number(latStr));
    if (!lonLat) {
      dropped += 1;
      continue;
    }
    const [lon, lat] = lonLat;
    // lon=±180은 같은 자오선 — +180을 -180으로 wrap해 단일 -179.75 셀로 정규화 (리뷰 Low1).
    // lat=90(극점)은 wrap 상대가 없으므로 마지막 89.75 셀로 클램프.
    const lonIdx = Math.floor((lon === 180 ? -180 : lon) / NEWS_GRID_DEG);
    const latIdx = Math.min(Math.floor(lat / NEWS_GRID_DEG), 90 / NEWS_GRID_DEG - 1);
    const key = cellKeyOf(lonIdx, latIdx);

    let cell = cells.get(key);
    if (!cell) {
      cell = { lonIdx, latIdx, articleSum: 0, placeName: null, sampleUrl: null, sampleMentions: -1 };
      cells.set(key, cell);
    }
    const articles = articlesStr === '' ? 0 : Number(articlesStr);
    cell.articleSum += Number.isFinite(articles) && articles > 0 ? articles : 0;
    // 대표 지명·기사 = NumMentions 최대 행 (사후 리뷰 High1 후속 — CPU):
    // 이전에는 셀별 Map으로 지명 최빈값을 셌다. 행마다 Map get+set 2회가 붙어
    // 2,200행에서 ~1.5ms였고, 결과는 "가장 많이 언급된 이벤트의 지명"과 실측상
    // 거의 같았다 (셀 안의 행들은 같은 도시를 가리키는 게 대부분 — 애초에 0.5° 셀이다).
    // 그래서 최빈값 대신 **대표 행의 값**으로 정의를 좁혔다. 동률은 먼저 온 행이 이긴다
    // (파일 행 순서는 GDELT가 결정론적으로 주므로 내용 해시도 안정).
    const mentions = mentionsStr === '' ? 0 : Number(mentionsStr);
    if (mentions > cell.sampleMentions && Number.isFinite(mentions)) {
      cell.sampleMentions = mentions;
      const url = trimIfNeeded(sourceUrl ?? '');
      if (url !== '') cell.sampleUrl = url;
      const place = trimIfNeeded(fullName ?? '');
      if (place !== '') cell.placeName = place;
    }
  }

  const records: NewsRecord[] = [];
  for (const cell of cells.values()) {
    const centerLon = (cell.lonIdx + 0.5) * NEWS_GRID_DEG;
    const centerLat = (cell.latIdx + 0.5) * NEWS_GRID_DEG;
    const payload: NewsPayload = {
      type: 'news',
      placeName: cell.placeName,
      articleCount: cell.articleSum,
      sampleUrl: cell.sampleUrl,
    };
    const sourceId = `${fileSec}:${cell.lonIdx}:${cell.latIdx}`;
    records.push({
      id: `gdelt:${sourceId}`,
      source: 'gdelt',
      sourceId,
      layer: 'news',
      revision: 0,
      observedAt: occurredAt,
      ingestedAt,
      geometry: { type: 'Point', coordinates: [centerLon, centerLat] },
      centroid: [centerLon, centerLat],
      h3r3: '',
      severity: {
        rank: newsSeverityRank(cell.articleSum),
        raw: cell.articleSum,
        unit: 'count',
        label: `${cell.articleSum} articles`,
      },
      kind: 'occurrence',
      occurredAt,
      payload,
    });
  }
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { ok: true, records, dropped, rows };
}

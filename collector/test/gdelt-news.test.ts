import { describe, expect, test } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  GDELT_LASTUPDATE_URL,
  NEWS_GRID_DEG,
  buildNewsRecords,
  extractCsv,
  gdeltRawZipKey,
  parseLastUpdate,
  pickColumns,
  zipUncompressedSize,
} from '../src/sources/gdelt';

const FILE_MS = Date.UTC(2026, 7, 19, 6, 15, 0);
const NOW = Date.UTC(2026, 7, 19, 6, 24, 0);

/** GDELT v2 export 61컬럼 TSV 행 — 사용 컬럼만 채우고 나머지 빈칸 */
function makeLine(over: {
  mentions?: string;
  articles?: string;
  place?: string;
  lat?: string;
  lon?: string;
  url?: string;
}): string {
  const cols = new Array<string>(61).fill('');
  cols[0] = '1234567890';
  cols[26] = '061'; // EventCode — 추출 대상 아님 (payload 계약에 자리 없음)
  cols[31] = over.mentions ?? '10';
  cols[33] = over.articles ?? '1'; // NumArticles — articleCount 집계 근원 (기본 1 = 행당 기사 1)
  cols[52] = over.place ?? 'Tokyo, Tokyo, Japan';
  cols[56] = over.lat ?? '35.6895';
  cols[57] = over.lon ?? '139.692';
  cols[60] = over.url ?? 'https://example.com/a';
  return cols.join('\t');
}

describe('parseLastUpdate — lastupdate.txt 1행 파싱', () => {
  test('실측 3행 형식에서 export.CSV.zip URL + 파일 타임스탬프 추출', () => {
    const text = [
      '76796 cd0cdff482bafd16128af7932a6a6ce7 http://data.gdeltproject.org/gdeltv2/20260819061500.export.CSV.zip',
      '81910 af31b47d6e44de3258a6c95124f45fd5 http://data.gdeltproject.org/gdeltv2/20260819061500.mentions.CSV.zip',
      '3607010 b94c8552445475cf940443011170b2b0 http://data.gdeltproject.org/gdeltv2/20260819061500.gkg.csv.zip',
    ].join('\n');

    const ref = parseLastUpdate(text);

    expect(ref).not.toBeNull();
    expect(ref!.url).toBe('http://data.gdeltproject.org/gdeltv2/20260819061500.export.CSV.zip');
    expect(ref!.fileMs).toBe(FILE_MS);
  });

  test('형식 불일치는 null', () => {
    expect(parseLastUpdate('')).toBeNull();
    expect(parseLastUpdate('garbage')).toBeNull();
    expect(parseLastUpdate('1 2 http://x/20260819061500.gkg.csv.zip')).toBeNull();
  });

  test('lastupdate URL은 상수 계약', () => {
    expect(GDELT_LASTUPDATE_URL).toBe('http://data.gdeltproject.org/gdeltv2/lastupdate.txt');
  });
});

describe('gdeltRawZipKey — 파일 타임스탬프 결정론 raw 키 (§8.6 raw 경로 계약)', () => {
  test('dt/hour 파티션 + zip 확장자 정직 유지', () => {
    expect(gdeltRawZipKey(FILE_MS)).toBe(
      `raw/gdelt/dt=2026-08-19/hour=06/${FILE_MS}-export.CSV.zip`,
    );
  });
});

describe('pickColumns — 탭 워커 표적 추출 (CPU 사다리)', () => {
  test('지정 컬럼만 추출 — split 없이', () => {
    expect(pickColumns('a\tb\tc\td', [1, 3])).toEqual(['b', 'd']);
    expect(pickColumns('a\tb\tc\td', [0])).toEqual(['a']);
  });

  test('컬럼 부족 시 null', () => {
    expect(pickColumns('a\tb', [5])).toBeNull();
  });
});

describe('buildNewsRecords — 0.5° 셀 집계 Occurrence<NewsPayload>', () => {
  test('같은 셀 집계: articleCount=NumArticles(33) 합·placeName 최빈값·sampleUrl은 NumMentions 최대 기사', () => {
    // Arrange: Tokyo 셀 3행 (articles 2+3+1=6, place 2:1, mentions 최대는 두 번째) + Seoul 셀 1행
    const csv = [
      makeLine({ place: 'Tokyo, Tokyo, Japan', mentions: '10', articles: '2', url: 'https://example.com/a' }),
      makeLine({ place: 'Tokyo, Tokyo, Japan', mentions: '40', articles: '3', url: 'https://example.com/b' }),
      makeLine({ place: 'Chiba, Chiba, Japan', mentions: '5', articles: '1', url: 'https://example.com/c' }),
      makeLine({ place: 'Seoul, Seoul, South Korea', lat: '37.56', lon: '126.99', mentions: '3', url: 'https://example.com/d' }),
    ].join('\n');

    // Act
    const { records, dropped, rows } = buildNewsRecords(csv, FILE_MS, NOW);

    // Assert — articleCount는 행 수(3)도 NumMentions(55)도 아닌 NumArticles 합 6 (리뷰 Med 확정)
    expect(rows).toBe(4);
    expect(dropped).toBe(0);
    expect(records).toHaveLength(2);
    const tokyo = records.find((r) => r.payload.placeName === 'Tokyo, Tokyo, Japan');
    expect(tokyo).toBeDefined();
    expect(tokyo!.payload.articleCount).toBe(6);
    expect(tokyo!.payload.sampleUrl).toBe('https://example.com/b');
    expect(tokyo!.severity).toEqual({ rank: 1, raw: 6, unit: 'count', label: '6 articles' });
    expect(tokyo!.kind).toBe('occurrence');
    expect(tokyo!.occurredAt).toBe('2026-08-19T06:15:00.000Z');
    expect(tokyo!.observedAt).toBe('2026-08-19T06:15:00.000Z');
    expect(tokyo!.layer).toBe('news');
    expect(tokyo!.source).toBe('gdelt');
    // 셀 중심 좌표 (0.5° 그리드): 139.692 → idx 279 → 139.75 / 35.6895 → idx 71 → 35.75
    expect(tokyo!.centroid).toEqual([139.75, 35.75]);
    // 멱등 키 = 파일초:lonIdx:latIdx
    expect(tokyo!.sourceId).toBe(`${FILE_MS / 1000}:279:71`);
    expect(tokyo!.id).toBe(`gdelt:${FILE_MS / 1000}:279:71`);
  });

  test('빈 좌표 문자열은 드롭 — Number("")===0 적도 유령 좌표 방지', () => {
    const csv = [
      makeLine({ lat: '', lon: '' }),
      makeLine({ lat: '', lon: '139.692' }),
      makeLine({}),
    ].join('\n');

    const { records, dropped } = buildNewsRecords(csv, FILE_MS, NOW);

    expect(dropped).toBe(2);
    expect(records).toHaveLength(1);
  });

  test('범위 밖·(0,0) 좌표 드롭 + 경계: lat=90 클램프, lon=180은 -180으로 wrap (같은 자오선)', () => {
    const csv = [
      makeLine({ lat: '999', lon: '10' }),
      makeLine({ lat: '0', lon: '0' }),
      makeLine({ lat: '90', lon: '180', place: 'Edge' }),
    ].join('\n');

    const { records, dropped } = buildNewsRecords(csv, FILE_MS, NOW);

    expect(dropped).toBe(2);
    expect(records).toHaveLength(1);
    // lon=180 → wrap → -179.75 셀 (lon=-180과 동일), lat=90 → 극점 클램프 89.75
    expect(records[0]!.centroid).toEqual([-179.75, 89.75]);
  });

  test('lon=±180 wrap 정규화 통일 — +180과 -180은 같은 셀로 집계 (리뷰 Low1)', () => {
    const csv = [
      makeLine({ lat: '10.1', lon: '180', articles: '2' }),
      makeLine({ lat: '10.1', lon: '-180', articles: '3' }),
      makeLine({ lat: '10.1', lon: '179.9', articles: '1' }), // 인접하지만 다른 셀 (179.75)
    ].join('\n');

    const { records } = buildNewsRecords(csv, FILE_MS, NOW);

    expect(records).toHaveLength(2);
    const wrapped = records.find((r) => r.centroid[0] === -179.75);
    const east = records.find((r) => r.centroid[0] === 179.75);
    expect(wrapped!.payload.articleCount).toBe(5); // +180과 -180 합산
    expect(east!.payload.articleCount).toBe(1);
  });

  test('severity rank 사다리: 1(<10) / 2(≥10) / 3(≥50)', () => {
    const many = (n: number, lat: string, lon: string) =>
      Array.from({ length: n }, () => makeLine({ lat, lon }));
    const csv = [...many(9, '10.1', '10.1'), ...many(10, '20.1', '20.1'), ...many(50, '30.1', '30.1')].join('\n');

    const { records } = buildNewsRecords(csv, FILE_MS, NOW);

    const ranks = new Map(records.map((r) => [r.payload.articleCount, r.severity.rank]));
    expect(ranks.get(9)).toBe(1);
    expect(ranks.get(10)).toBe(2);
    expect(ranks.get(50)).toBe(3);
  });

  test('placeName 최빈값 동률은 사전순 최소 — 결정론(내용 해시 안정)', () => {
    const csv = [
      makeLine({ place: 'Zeta' }),
      makeLine({ place: 'Alpha' }),
    ].join('\n');

    const { records } = buildNewsRecords(csv, FILE_MS, NOW);

    expect(records[0]!.payload.placeName).toBe('Alpha');
  });

  test('records는 id 정렬 — 같은 파일 재처리 시 동일 직렬화', () => {
    const csv = [
      makeLine({ lat: '35.6', lon: '139.7' }),
      makeLine({ lat: '-33.9', lon: '18.4' }),
      makeLine({ lat: '51.5', lon: '-0.1' }),
    ].join('\n');

    const a = buildNewsRecords(csv, FILE_MS, NOW);
    const b = buildNewsRecords(csv, FILE_MS, NOW);

    expect(a.records.map((r) => r.id)).toEqual([...a.records.map((r) => r.id)].sort());
    expect(JSON.stringify(a.records)).toBe(JSON.stringify(b.records));
  });
});

describe('extractCsv — zip 해제 (zlib inflateRawSync 네이티브 + fflate 폴백)', () => {
  test('zip 첫 엔트리 텍스트 추출 (deflate)', () => {
    const csv = makeLine({});
    const zipped = zipSync({ '20260819061500.export.CSV': strToU8(csv) });

    expect(extractCsv(zipped)).toBe(csv);
  });

  test('무압축(stored) 엔트리도 추출', () => {
    const csv = makeLine({});
    const zipped = zipSync({ 'f.CSV': strToU8(csv) }, { level: 0 });

    expect(extractCsv(zipped)).toBe(csv);
  });

  test('zip 아님 → null (raw-only 강등 신호)', () => {
    expect(extractCsv(strToU8('not a zip'))).toBeNull();
  });
});

describe('zipUncompressedSize — 해제 전 팻파일 가드 (CPU 사다리)', () => {
  test('central directory의 해제 크기 반환 — 실제 해제 없이', () => {
    const csv = [makeLine({}), makeLine({}), makeLine({})].join('\n');
    const zipped = zipSync({ 'f.CSV': strToU8(csv) });

    expect(zipUncompressedSize(zipped)).toBe(strToU8(csv).byteLength);
  });

  test('zip 아님 → null', () => {
    expect(zipUncompressedSize(strToU8('nope'))).toBeNull();
  });
});

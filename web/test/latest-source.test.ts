/** latest.json 소비 계약 — 시간 슬라이스(Med5 재슬라이스)와 참조 안정성(레이어 memo 키). */
import { describe, expect, test } from 'vitest';
import { createNewsSource, createWeatherSource } from '../src/data/latest-source';
import type { LatestDoc, NewsRecord, WeatherAlertRecord } from '@lwp/shared';

const ASOF = '2026-08-19T12:11:00.000Z';
const T0 = Date.parse(ASOF);

function alert(id: string, over: Partial<WeatherAlertRecord> = {}): WeatherAlertRecord {
  return {
    id,
    source: 'gdacs',
    sourceId: id,
    layer: 'weather',
    revision: T0,
    observedAt: ASOF,
    ingestedAt: ASOF,
    geometry: { type: 'Point', coordinates: [10, 20] },
    centroid: [10, 20],
    h3r3: '',
    severity: { rank: 1 },
    kind: 'interval',
    validFrom: '2026-08-19T00:00:00.000Z',
    validTo: null,
    status: 'active',
    payload: {
      type: 'weatherAlert',
      event: 'Flood',
      headline: null,
      areaDesc: null,
      capSeverity: null,
      gdacsAlertLevel: 'Green',
      gdacsEventType: 'FL',
      url: null,
    },
    ...over,
  };
}

function news(id: string, occurredAt: string): NewsRecord {
  return {
    id,
    source: 'gdelt',
    sourceId: id,
    layer: 'news',
    revision: Date.parse(occurredAt),
    observedAt: occurredAt,
    ingestedAt: occurredAt,
    geometry: { type: 'Point', coordinates: [139.7, 35.6] },
    centroid: [139.7, 35.6],
    h3r3: '',
    severity: { rank: 1 },
    kind: 'occurrence',
    occurredAt,
    payload: { type: 'news', placeName: 'Tokyo', articleCount: 3, sampleUrl: null },
  };
}

function doc(layers: LatestDoc['layers']): LatestDoc {
  return { updatedAt: ASOF, layers };
}

describe('createWeatherSource — interval 슬라이스', () => {
  test('만료된 경보는 처음부터 제외, 활성만 통과', () => {
    const src = createWeatherSource();
    const snapshot = src.ingest(
      doc({ weather: { asOf: ASOF, records: [alert('a'), alert('b', { validTo: '2026-08-19T12:00:00.000Z' })] } }),
      T0,
    );
    expect(snapshot?.records.map((r) => r.id)).toEqual(['a']);
  });

  test('cancelled는 표시 정책상 숨긴다 (시간 계약과 별개)', () => {
    const src = createWeatherSource();
    const snapshot = src.ingest(
      doc({ weather: { asOf: ASOF, records: [alert('a'), alert('c', { status: 'cancelled' })] } }),
      T0,
    );
    expect(snapshot?.records.map((r) => r.id)).toEqual(['a']);
  });

  test('Med5: asOf가 그대로여도 시간이 지나면 만료가 반영된다 (reslice)', () => {
    const src = createWeatherSource();
    const expiring = alert('x', { validTo: '2026-08-19T12:30:00.000Z' });
    const first = src.ingest(doc({ weather: { asOf: ASOF, records: [alert('a'), expiring] } }), T0);
    expect(first?.records.map((r) => r.id)).toEqual(['a', 'x']);

    // 다음 수집 슬롯(30분)까지 기다리지 않고 틱에서 만료 (이전 판은 여기서 x가 남았다)
    const later = src.reslice(Date.parse('2026-08-19T12:31:00.000Z'));
    expect(later?.records.map((r) => r.id)).toEqual(['a']);
    // asOf는 폴 시점 그대로 — 재슬라이스는 수집 성공을 위장하지 않는다
    expect(later?.asOfMs).toBe(T0);
  });

  test('집합이 그대로면 같은 스냅샷 참조를 돌려준다 (deck attribute 재계산 방지)', () => {
    const src = createWeatherSource();
    const first = src.ingest(doc({ weather: { asOf: ASOF, records: [alert('a')] } }), T0);
    expect(src.reslice(T0 + 30_000)).toBe(first);
    expect(src.ingest(doc({ weather: { asOf: ASOF, records: [alert('a')] } }), T0 + 60_000)).toBe(first);
  });

  test('수신 이력이 없으면 reslice는 null (빈 상태를 성공으로 위장하지 않는다)', () => {
    expect(createWeatherSource().reslice(T0)).toBeNull();
  });

  test('records가 배열이 아니면 계약 위반 → null (부분 성공 위장 금지)', () => {
    const src = createWeatherSource();
    const broken = { updatedAt: ASOF, layers: { weather: { asOf: ASOF, records: 'nope' } } };
    expect(src.ingest(broken, T0)).toBeNull();
  });

  test('레이어 자체가 없으면(partial 조립) 빈 세계', () => {
    const snapshot = createWeatherSource().ingest(doc({}), T0);
    expect(snapshot).toEqual({ records: [], asOfMs: null });
  });
});

describe('createNewsSource — occurrence window', () => {
  test('window(2시간) 밖 기사 셀은 제외', () => {
    const src = createNewsSource();
    const snapshot = src.ingest(
      doc({
        news: {
          asOf: ASOF,
          records: [news('fresh', '2026-08-19T12:00:00.000Z'), news('old', '2026-08-19T09:00:00.000Z')],
        },
      }),
      T0,
    );
    expect(snapshot?.records.map((r) => r.id)).toEqual(['fresh']);
  });

  test('T = max(now, asOf) — 슬롯 종료 시각이 클라이언트 시계보다 미래여도 최신 슬롯이 살아남는다', () => {
    const src = createNewsSource();
    const future = news('slot', '2026-08-19T12:15:00.000Z'); // asOf보다 4분 뒤
    const snapshot = src.ingest(doc({ news: { asOf: '2026-08-19T12:15:00.000Z', records: [future] } }), T0);
    expect(snapshot?.records.map((r) => r.id)).toEqual(['slot']);
  });

  test('Med5: 시간이 지나면 window를 벗어난 셀이 재슬라이스에서 빠진다', () => {
    const src = createNewsSource();
    const rec = news('a', '2026-08-19T12:00:00.000Z');
    expect(src.ingest(doc({ news: { asOf: ASOF, records: [rec] } }), T0)?.records).toHaveLength(1);
    // 2시간 window — occurredAt + 2h 이후엔 빠진다
    expect(src.reslice(Date.parse('2026-08-19T14:01:00.000Z'))?.records).toHaveLength(0);
  });
});

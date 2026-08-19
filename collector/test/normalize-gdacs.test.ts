import { describe, expect, test } from 'vitest';
import {
  RECENT_EXPIRED_WINDOW_MS,
  buildTcTrack,
  dedupeGdacs,
  gdacsGeometryUrl,
  gdacsListUrl,
  gdacsUtcIso,
  normalizeGdacsList,
} from '../src/sources/gdacs';
import type { WeatherAlertRecord } from '../src/types';

const NOW = Date.UTC(2026, 7, 19, 12, 2, 0);

/** 실측 응답 형태 (2026-08-19 geteventlist/SEARCH) 기반 최소 fixture */
function feature(over: Record<string, unknown> = {}, coords: unknown = [139.7, 35.6]) {
  return {
    properties: {
      eventtype: 'TC',
      eventid: 1001297,
      episodeid: 55,
      name: 'Tropical Cyclone DOLPHIN-26',
      alertlevel: 'Orange',
      fromdate: '2026-07-27T00:00:00',
      todate: '2026-08-19T10:00:00',
      datemodified: '2026-08-19T05:52:41',
      iscurrent: 'true',
      country: 'Japan',
      severitydata: { severity: 268.5168, severitytext: 'Hurricane/Typhoon > 74 mph' },
      url: { report: 'https://www.gdacs.org/report.aspx?eventid=1001297&episodeid=55' },
      ...over,
    },
    geometry: { type: 'Point', coordinates: coords },
  };
}

describe('gdacsUtcIso — zone 미표기 UTC 보정', () => {
  test('zone 없는 시각에 Z를 붙여 UTC로 해석', () => {
    expect(gdacsUtcIso('2026-08-19T05:22:24')).toBe('2026-08-19T05:22:24.000Z');
  });

  test('밀리초 표기·기존 zone은 그대로 소화', () => {
    expect(gdacsUtcIso('2026-02-11T15:18:59.037')).toBe('2026-02-11T15:18:59.037Z');
    expect(gdacsUtcIso('2026-08-19T05:22:24Z')).toBe('2026-08-19T05:22:24.000Z');
  });

  test('빈 값·파싱 불능은 null', () => {
    expect(gdacsUtcIso('')).toBeNull();
    expect(gdacsUtcIso('not-a-date')).toBeNull();
    expect(gdacsUtcIso(undefined)).toBeNull();
  });
});

describe('normalizeGdacsList — Interval<WeatherAlertPayload> 정규화', () => {
  test('확정 코어 필드 매핑 — 멱등 키 gdacs:{eventId}:{episodeId}', () => {
    // Arrange
    const resp = { features: [feature()] };

    // Act
    const out = normalizeGdacsList(resp, NOW);

    // Assert
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [r] = out.records;
    expect(r).toBeDefined();
    expect(r!.id).toBe('gdacs:1001297:55');
    expect(r!.sourceId).toBe('1001297:55');
    expect(r!.source).toBe('gdacs');
    expect(r!.layer).toBe('weather');
    expect(r!.kind).toBe('interval');
    expect(r!.validFrom).toBe('2026-07-27T00:00:00.000Z');
    // GDACS todate는 관측 종료 시각 — 미해제(iscurrent) 경보는 validTo=null (미해제 계약)
    expect(r!.validTo).toBeNull();
    expect(r!.status).toBe('active');
    expect(r!.revision).toBe(Date.parse('2026-08-19T05:52:41Z'));
    expect(r!.observedAt).toBe('2026-08-19T05:52:41.000Z');
    expect(r!.centroid).toEqual([139.7, 35.6]);
    expect(r!.severity).toEqual({ rank: 2, raw: 268.5168, label: 'TC Orange' });
    expect(r!.payload).toEqual({
      type: 'weatherAlert',
      event: 'Tropical Cyclone DOLPHIN-26',
      headline: 'Hurricane/Typhoon > 74 mph',
      areaDesc: 'Japan',
      capSeverity: null,
      gdacsAlertLevel: 'Orange',
      gdacsEventType: 'TC',
      url: 'https://www.gdacs.org/report.aspx?eventid=1001297&episodeid=55',
      observedUntil: '2026-08-19T10:00:00.000Z', // 원본 todate 보존
    });
  });

  test('alertlevel → rank 매핑: Green=1 / Orange=2 / Red=4', () => {
    const resp = {
      features: [
        feature({ eventid: 1, alertlevel: 'Green' }),
        feature({ eventid: 2, alertlevel: 'Orange' }),
        feature({ eventid: 3, alertlevel: 'Red' }),
      ],
    };
    const out = normalizeGdacsList(resp, NOW);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.records.map((r) => r.severity.rank)).toEqual([1, 2, 4]);
  });

  test('iscurrent=false + 최근 48h 내 종료 → expired로 유지', () => {
    const recentEnd = new Date(NOW - RECENT_EXPIRED_WINDOW_MS / 2).toISOString().slice(0, 19);
    const out = normalizeGdacsList(
      { features: [feature({ iscurrent: 'false', todate: recentEnd })] },
      NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.status).toBe('expired');
  });

  test('유예 창 밖 히스토리 잔재는 스킵 — dropped에도 세지 않는다', () => {
    // GDACS 레벨별 콜은 2025년 이벤트까지 항상 되돌려준다 (실측) — 무한 재적재 방지
    const out = normalizeGdacsList(
      { features: [feature({ iscurrent: 'false', todate: '2025-11-13T12:00:00' })] },
      NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.records).toHaveLength(0);
    expect(out.dropped).toBe(0);
  });

  test('좌표 불량·필수 필드 결손은 dropped', () => {
    const out = normalizeGdacsList(
      {
        features: [
          feature({}, [999, 35.6]), // 범위 밖 lon
          feature({ eventid: null }), // 멱등 키 불가
          feature({ eventid: 2, alertlevel: 'Purple' }), // 미지 등급
        ],
      },
      NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.records).toHaveLength(0);
    expect(out.dropped).toBe(3);
  });

  test('HTTP 200 오류 JSON(features 배열 없음)은 schema 실패', () => {
    expect(normalizeGdacsList({ error: 'oops' }, NOW)).toEqual({ ok: false, reason: 'schema' });
  });
});

describe('dedupeGdacs — 레벨별 3콜 union', () => {
  test('같은 (eventid, episodeid)는 revision 큰 쪽 유지 + id 정렬', () => {
    const mk = (eventid: number, datemodified: string): WeatherAlertRecord => {
      const out = normalizeGdacsList({ features: [feature({ eventid, datemodified })] }, NOW);
      if (!out.ok) throw new Error('fixture normalize failed');
      return out.records[0]!;
    };
    const older = mk(1001297, '2026-08-19T05:00:00');
    const newer = mk(1001297, '2026-08-19T06:00:00');
    const other = mk(500, '2026-08-19T05:30:00');

    const merged = dedupeGdacs([[older, other], [newer]]);

    expect(merged.map((r) => r.id)).toEqual(['gdacs:1001297:55', 'gdacs:500:55']);
    expect(merged[0]!.revision).toBe(Date.parse('2026-08-19T06:00:00Z'));
  });
});

describe('buildTcTrack — 트랙포인트 Polygon → centroid → LineString (실측 주의 2)', () => {
  /** 소형 사각 ring (닫힘 중복점 포함) — centroid = 중심 */
  function trackPoint(index: number, lon: number, lat: number) {
    const d = 0.1;
    return {
      properties: { Class: `Point_Polygon_Point_${index}` },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [lon - d, lat - d],
            [lon + d, lat - d],
            [lon + d, lat + d],
            [lon - d, lat + d],
            [lon - d, lat - d],
          ],
        ],
      },
    };
  }

  test('index 순 정렬 LineString + Point_Centroid 채택 — Poly_*·Line_*은 무시', () => {
    const resp = {
      features: [
        trackPoint(2, 140.0, 30.0),
        trackPoint(0, 138.0, 26.0),
        trackPoint(1, 139.0, 28.0),
        { properties: { Class: 'Point_Centroid' }, geometry: { type: 'Point', coordinates: [140.0, 30.0] } },
        { properties: { Class: 'Poly_Red' }, geometry: { type: 'Polygon', coordinates: [[[0, 1], [1, 1], [1, 0], [0, 1]]] } },
        { properties: { Class: 'Line_Line_0' }, geometry: { type: 'LineString', coordinates: [[138, 26], [139, 28]] } },
      ],
    };

    const { track, centroid } = buildTcTrack(resp);

    expect(centroid).toEqual([140.0, 30.0]);
    expect(track?.type).toBe('LineString');
    expect(track?.coordinates.map(([lon, lat]) => [Math.round(lon * 10) / 10, Math.round(lat * 10) / 10])).toEqual([
      [138.0, 26.0],
      [139.0, 28.0],
      [140.0, 30.0],
    ]);
  });

  test('트랙포인트 2개 미만이면 track=null (Point 유지 신호)', () => {
    const { track, centroid } = buildTcTrack({ features: [trackPoint(0, 138, 26)] });
    expect(track).toBeNull();
    expect(centroid).toBeNull();
  });

  test('features 배열 없음 → 둘 다 null', () => {
    expect(buildTcTrack({ error: 'oops' })).toEqual({ track: null, centroid: null });
  });
});

describe('GDACS URL 계약', () => {
  test('레벨별 리스트 URL — 통합 지정(;) 대신 레벨별 콜 + pagenumber/pagesize 페이징 (High2)', () => {
    expect(gdacsListUrl('Green', 1)).toBe(
      'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Green&pagenumber=1&pagesize=100',
    );
    expect(gdacsListUrl('Orange')).toBe(
      'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Orange&pagenumber=1&pagesize=100',
    );
    expect(gdacsListUrl('Red', 3)).toBe(
      'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Red&pagenumber=3&pagesize=100',
    );
  });

  test('getgeometry URL — eventtype·eventid·episodeid', () => {
    expect(gdacsGeometryUrl('TC', 1001297, 55)).toBe(
      'https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=1001297&episodeid=55',
    );
  });
});

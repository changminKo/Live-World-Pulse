import { describe, expect, test } from 'vitest';
import {
  RECENT_EXPIRED_WINDOW_MS,
  applyTcGeometry,
  buildTcGeometry,
  tcIdsOf,
  buildTcTrack,
  dedupeGdacs,
  gdacsGeometryUrl,
  gdacsListUrl,
  gdacsUtcIso,
  normalizeGdacsList,
} from '../src/sources/gdacs';
import type { TcTrackCache } from '../src/sources/gdacs';
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

  test('같은 응답의 Poly_Cones를 예보콘 Polygon으로 함께 뽑는다 (추가 콜 0 — 재리뷰 High2)', () => {
    const cone = {
      properties: { Class: 'Poly_Cones' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[139, 20], [141, 20], [141, 22], [139, 22], [139, 20]]],
      },
    };
    const { track, cone: parsed } = buildTcGeometry({
      features: [trackPoint(0, 138, 26), trackPoint(1, 139, 28), cone],
    });

    expect(track?.coordinates).toHaveLength(2);
    expect(parsed?.type).toBe('Polygon');
    expect(parsed?.coordinates[0]).toHaveLength(5);
  });

  test('콘 ring의 유효 좌표가 3점 미만이면 cone=null (렌더 불가 폴리곤 금지)', () => {
    const { cone } = buildTcGeometry({
      features: [
        {
          properties: { Class: 'Poly_Cones' },
          geometry: { type: 'Polygon', coordinates: [[[139, 20], [0, 0], ['x', 3]]] },
        },
      ],
    });
    expect(cone).toBeNull();
  });
});

describe('ringCentroid — ±180을 걸친 트랙포인트 ring (사후 리뷰 High)', () => {
  /** 실제 GDACS 트랙포인트는 중심점이 아니라 **소형 Polygon ring**으로 온다.
   *  날짜변경선 위 TC라면 그 ring의 정점 경도가 179.x와 −179.x로 섞인다 —
   *  산술평균은 여기서 약 0°(아프리카 앞바다)로 튀고, 그 오차는 소비 측 언랩으로
   *  복구되지 않는다(점 자체가 이미 틀린 자리). 구면 평균이라야 ±180 근처로 남는다. */
  function straddlingRing(index: number, lat: number) {
    return {
      properties: { Class: `Point_Polygon_Point_${index}` },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [179.5, lat - 0.1],
            [-179.5, lat - 0.1],
            [-179.5, lat + 0.1],
            [179.5, lat + 0.1],
            [179.5, lat - 0.1],
          ],
        ],
      },
    };
  }

  test('경도 179.5·−179.5 혼재 ring → 중심은 ±180 근처 (0도로 튀지 않는다)', () => {
    const { track } = buildTcTrack({
      features: [straddlingRing(0, 20), straddlingRing(1, 22)],
    });

    expect(track?.coordinates).toHaveLength(2);
    expect(track!.coordinates.map(([, lat]) => lat)).toEqual([
      expect.closeTo(20, 6),
      expect.closeTo(22, 6),
    ]);
    for (const [lon] of track!.coordinates) {
      expect(Math.abs(Math.abs(lon) - 180)).toBeLessThan(0.01); // 180 또는 −180
    }
  });

  test('실 트랙 형태: 날짜변경선 양쪽 트랙포인트가 반구를 가로지르지 않는다', () => {
    const { track } = buildTcTrack({
      features: [
        trackPointRing(0, 176, 15),
        straddlingRing(1, 17),
        trackPointRing(2, -176, 19),
      ],
    });

    const lons = track!.coordinates.map(([lon]) => lon);
    // 인접 점의 경도 차(언랩 후)가 반구를 넘으면 안 된다 — 산술평균 버그면 176→0→−176
    const unwrapped = lons.map((lon, i) => {
      let out = lon;
      const prev = i === 0 ? lon : lons[i - 1]!;
      while (out - prev > 180) out -= 360;
      while (out - prev < -180) out += 360;
      return out;
    });
    for (let i = 1; i < unwrapped.length; i += 1) {
      expect(Math.abs(unwrapped[i]! - unwrapped[i - 1]!)).toBeLessThan(10);
    }
  });

  test('극지 ±85 이상 트랙포인트도 좌표 유효 범위를 지킨다', () => {
    const { track } = buildTcTrack({
      features: [trackPointRing(0, 30, 87), trackPointRing(1, 150, -88)],
    });
    expect(track?.coordinates).toEqual([
      [expect.closeTo(30, 6), expect.closeTo(87, 6)],
      [expect.closeTo(150, 6), expect.closeTo(-88, 6)],
    ]);
  });
});

/** 일반(날짜변경선 밖) 트랙포인트 ring — 위 describe 전용 헬퍼 */
function trackPointRing(index: number, lon: number, lat: number) {
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

describe('applyTcGeometry — 트랙 캐시 합성 + 콘 파생 레코드', () => {
  function record(): WeatherAlertRecord {
    const [rec] = (normalizeGdacsList({ features: [feature()] }, NOW) as { records: WeatherAlertRecord[] }).records;
    return rec!;
  }

  const cache: TcTrackCache = {
    eventId: 1001297,
    episodeId: 55,
    fetchedAt: '2026-08-19T12:00:00.000Z',
    track: { type: 'LineString', coordinates: [[138, 26], [139, 28], [140, 30]] },
    cone: { type: 'Polygon', coordinates: [[[139, 20], [141, 20], [141, 22], [139, 22], [139, 20]]] },
    centroid: [140, 30],
  };

  test('본체 지오메트리는 트랙 LineString, centroid는 캐시의 Point_Centroid로 교체', () => {
    const src = record();
    const { record: applied } = applyTcGeometry(src, cache);

    expect(applied.geometry).toEqual(cache.track);
    expect(applied.centroid).toEqual([140, 30]);
    expect(applied.payload.gdacsGeometryKind).toBe('track');
    expect(src.geometry.type).toBe('Point'); // 입력 불변
  });

  test('콘 파생 레코드는 `:cone` sourceId + 같은 시간·등급 (슬라이스 결과가 갈리면 안 된다)', () => {
    const src = record();
    const { cone } = applyTcGeometry(src, cache);

    expect(cone?.id).toBe('gdacs:1001297:55:cone');
    expect(cone?.sourceId).toBe('1001297:55:cone');
    expect(cone?.geometry).toEqual(cache.cone);
    expect(cone?.payload.gdacsGeometryKind).toBe('cone');
    expect(cone?.validFrom).toBe(src.validFrom);
    expect(cone?.validTo).toBe(src.validTo);
    expect(cone?.status).toBe(src.status);
    expect(cone?.severity).toEqual(src.severity);
  });

  test('tcIdsOf는 파생(:cone) 레코드를 대상으로 잡지 않는다 (무한 파생 금지)', () => {
    const { cone } = applyTcGeometry(record(), cache);
    expect(tcIdsOf(cone!)).toBeNull();
    expect(tcIdsOf(record())).toEqual({ eventId: 1001297, episodeId: 55 });
  });

  test('track만 있고 cone이 없으면 파생 레코드 없음', () => {
    const { record: applied, cone } = applyTcGeometry(record(), { ...cache, cone: null });
    expect(applied.geometry.type).toBe('LineString');
    expect(cone).toBeNull();
  });

  test('track이 null이면 Point 유지 (centroid만 보정)', () => {
    const { record: applied } = applyTcGeometry(record(), { ...cache, track: null });
    expect(applied.geometry.type).toBe('Point');
    expect(applied.payload.gdacsGeometryKind).toBeUndefined();
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

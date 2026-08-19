/** [lon, lat] 순서 컴파일 타임 확인 — @ts-expect-error 줄은 tsc --noEmit이 검증한다
 *  (기대한 오류가 사라지면 typecheck이 실패 → 계약 위반을 빌드가 잡는다). */
import type { Geometry, Position, WorldRecord } from '../src/types';

describe('Position [lon, lat] 계약', () => {
  it('라벨드 튜플: lon이 0번, lat이 1번, alt는 선택 number', () => {
    const tokyo: Position = [139.7, 35.6];
    const withAlt: Position = [139.7, 35.6, 10_000];

    // @ts-expect-error — 요소 1개는 Position이 아니다
    const tooShort: Position = [139.7];
    // @ts-expect-error — alt는 number만
    const badAlt: Position = [139.7, 35.6, 'FL350'];

    void tooShort;
    void badAlt;
    const lon: number = tokyo[0];
    const lat: number = tokyo[1];
    expect(lon).toBe(139.7); // GeoJSON 순서: 경도 먼저
    expect(lat).toBe(35.6);
    expect(withAlt[2]).toBe(10_000);
  });

  it('Geometry 변형별 좌표 차원이 타입으로 강제된다', () => {
    const point: Geometry = { type: 'Point', coordinates: [139.7, 35.6] };
    const track: Geometry = {
      type: 'LineString',
      coordinates: [
        [139.7, 35.6],
        [140.1, 36.0],
      ],
    };
    // @ts-expect-error — LineString 좌표는 Position[] (Position 단일 금지)
    const badLine: Geometry = { type: 'LineString', coordinates: [139.7, 35.6] };

    void badLine;
    expect(point.type).toBe('Point');
    expect(track.coordinates).toHaveLength(2);
  });

  it('WorldRecord kind + payload discriminant로 4레이어 전부 narrowing 가능', () => {
    const describeRecord = (r: WorldRecord): string => {
      switch (r.kind) {
        case 'interval':
          return `${r.payload.event ?? 'alert'} until ${r.validTo ?? 'open'}`;
        case 'observation':
          return r.payload.callsign ?? r.entityId; // kind narrowing으로 Observation 필드 접근
        case 'occurrence':
          return r.payload.type === 'earthquake'
            ? `M${r.payload.magnitude ?? '?'} @ ${r.occurredAt}`
            : `${r.payload.placeName ?? '?'} · ${r.payload.articleCount}`;
      }
    };
    expect(typeof describeRecord).toBe('function');
  });
});

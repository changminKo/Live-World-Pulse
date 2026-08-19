/** URL 직렬화 라운드트립 (PLAN §8.5 — 필수 단위 테스트) */
import {
  DEFAULT_APP_STATE,
  canonicalLayers,
  parseAppState,
  serializeAppState,
  type AppState,
} from '../src/url-state';

const roundTrip = (state: AppState): AppState => parseAppState(serializeAppState(state));

describe('serializeAppState / parseAppState 라운드트립', () => {
  it('전 필드 비기본값 라운드트립', () => {
    const state: AppState = {
      lat: 35.6,
      lng: 139.7,
      z: 5,
      t: 1755540000000,
      l: ['earthquake', 'flight'],
      sel: 'usgs:abc123',
      play: true,
      rate: 10,
      pin: 'jebi-2026',
    };
    expect(roundTrip(state)).toEqual(state);
  });

  it('기본 상태는 빈 쿼리로 직렬화되고, 빈 쿼리는 기본 상태로 파싱된다', () => {
    expect(serializeAppState(DEFAULT_APP_STATE).toString()).toBe('');
    expect(parseAppState('')).toEqual(DEFAULT_APP_STATE);
  });

  it("'live' 센티넬 라운드트립 (t 없는 공유 링크가 과거로 고정되는 것 방지)", () => {
    const state: AppState = { ...DEFAULT_APP_STATE, t: 'live', z: 5 };
    const params = serializeAppState(state);
    expect(params.get('t')).toBeNull(); // 기본값이라 생략
    expect(roundTrip(state).t).toBe('live');

    const explicit = parseAppState('t=live&z=5');
    expect(explicit.t).toBe('live');
  });

  it('부분 상태: 명시된 필드만 반영, 나머지는 기본값', () => {
    const parsed = parseAppState('lat=35.6&t=1755540000000');
    expect(parsed).toEqual({
      ...DEFAULT_APP_STATE,
      lat: 35.6,
      t: 1755540000000,
    });
  });

  it('레이어 짧은 키 eq,wx,fl,nw ↔ LayerId 매핑', () => {
    const params = serializeAppState({ ...DEFAULT_APP_STATE, l: ['earthquake', 'news'] });
    expect(params.get('l')).toBe('eq,nw');
    expect(parseAppState('l=eq,wx,fl,nw').l).toEqual(['earthquake', 'weather', 'flight', 'news']);
  });

  it('레이어 전부 꺼짐([])도 라운드트립 (l= 빈 값 ≠ l 부재)', () => {
    const state: AppState = { ...DEFAULT_APP_STATE, l: [] };
    expect(serializeAppState(state).get('l')).toBe('');
    expect(roundTrip(state).l).toEqual([]);
  });

  it('뒤섞인 레이어 순서는 캐노니컬 순서로 정규화된 뒤 라운드트립', () => {
    const shuffled: AppState = { ...DEFAULT_APP_STATE, l: ['news', 'earthquake'] };
    expect(roundTrip(shuffled).l).toEqual(['earthquake', 'news']);
    expect(canonicalLayers(['news', 'earthquake', 'news'])).toEqual(['earthquake', 'news']);
  });
});

describe('parseAppState 방어 (시스템 경계 입력 검증)', () => {
  it('파싱 불능 값은 필드별 기본값 폴백', () => {
    const parsed = parseAppState('lat=abc&z=&t=-5&rate=Infinity&play=maybe');
    expect(parsed.lat).toBe(DEFAULT_APP_STATE.lat);
    expect(parsed.z).toBe(DEFAULT_APP_STATE.z);
    expect(parsed.t).toBe(DEFAULT_APP_STATE.t);
    expect(parsed.rate).toBe(DEFAULT_APP_STATE.rate);
    expect(parsed.play).toBe(false); // 미지 값 'maybe' → 기본값 폴백 (기본 false)
  });

  it('범위 밖 좌표/줌은 클램프', () => {
    const parsed = parseAppState('lat=99&lng=-999&z=30');
    expect(parsed.lat).toBe(90);
    expect(parsed.lng).toBe(-180);
    expect(parsed.z).toBe(22);
  });

  it('미지의 레이어 키는 무시 (前버전 URL 관용)', () => {
    expect(parseAppState('l=eq,volcano,fl').l).toEqual(['earthquake', 'flight']);
  });

  it('t는 정수 epoch ms만 수용 (소수·음수 거부)', () => {
    expect(parseAppState('t=1755540000000.5').t).toBe(DEFAULT_APP_STATE.t);
    expect(parseAppState('t=1755540000000').t).toBe(1755540000000);
  });
});

describe('play 미지 값 폴백 (재리뷰 Low)', () => {
  it("play=maybe는 '거짓 강제'가 아니라 defaults.play로 폴백한다", () => {
    const defaults = { ...DEFAULT_APP_STATE, play: true };
    expect(parseAppState('play=maybe', defaults).play).toBe(true);
    expect(parseAppState('play=0', defaults).play).toBe(false);
    expect(parseAppState('play=1', { ...DEFAULT_APP_STATE, play: false }).play).toBe(true);
  });
});

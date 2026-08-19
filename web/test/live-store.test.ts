/** LIVE 스토어 상태 전이 — stale 시간 규칙, 304 처리, 계약 위반 sticky(Med6). */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LAYER_STALE_MS, useLiveStore, derivePulseStatus } from '../src/data/live-store';
import type { NewsRecord, WeatherAlertRecord } from '@lwp/shared';

const NOW = Date.UTC(2026, 7, 19, 12, 30, 0);

function resetStore(): void {
  useLiveStore.setState(useLiveStore.getInitialState(), true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetStore();
});

const emptyWeather = { records: [] as WeatherAlertRecord[], asOfMs: NOW };
const emptyNews = { records: [] as NewsRecord[], asOfMs: NOW };

describe('setChecked (304)', () => {
  test('데이터 불변 — 폴 성공 시각만 갱신되고 ready 유지', () => {
    const s = useLiveStore.getState();
    s.setWeather(emptyWeather);
    s.setChecked('weather');

    const after = useLiveStore.getState().weather;
    expect(after.status).toBe('ready');
    expect(after.lastSuccessAtMs).toBe(NOW);
    expect(after.error).toBeNull();
  });

  test('Med6: 스키마 실패 뒤의 304는 error를 ready로 세탁하지 못한다', () => {
    const s = useLiveStore.getState();
    s.setWeather(emptyWeather); // 성공 이력 만들기
    s.setSchemaError('weather', 'latest.json 스키마 불일치');
    expect(useLiveStore.getState().weather.status).toBe('error');

    useLiveStore.getState().setChecked('weather');

    const after = useLiveStore.getState().weather;
    expect(after.status).toBe('error'); // 여전히 오류
    expect(after.error).toBe('latest.json 스키마 불일치');
    expect(after.schemaFailed).toBe(true);
    expect(after.lastSuccessAtMs).toBe(NOW); // 폴 자체는 성공했으므로 시각은 갱신
  });

  test('Med6: 시간이 지나도 stale/ready로 넘어가지 않는다 (recomputeStale)', () => {
    const s = useLiveStore.getState();
    s.setWeather(emptyWeather);
    s.setSchemaError('weather', 'x');

    useLiveStore.getState().recomputeStale(NOW + LAYER_STALE_MS.weather + 60_000);

    expect(useLiveStore.getState().weather.status).toBe('error');
  });

  test('Med6: 다음 성공 수신에서만 해제된다', () => {
    const s = useLiveStore.getState();
    s.setWeather(emptyWeather);
    s.setSchemaError('weather', 'x');

    useLiveStore.getState().setWeather({ records: [], asOfMs: NOW + 1000 });

    const after = useLiveStore.getState().weather;
    expect(after.schemaFailed).toBe(false);
    expect(after.status).toBe('ready');
    expect(after.error).toBeNull();
  });

  test('일시 폴 오류(HTTP 5xx)는 sticky가 아니다 — 낡은 데이터 계속 표시', () => {
    const s = useLiveStore.getState();
    s.setWeather(emptyWeather);
    s.setError('weather', 'HTTP 503');
    expect(useLiveStore.getState().weather.status).toBe('ready'); // 시간 규칙만 강등한다
    expect(useLiveStore.getState().weather.errorCount).toBe(1);

    useLiveStore.getState().setChecked('weather');
    expect(useLiveStore.getState().weather.error).toBeNull();
  });
});

describe('reslice (Med5)', () => {
  test('records만 교체 — asOf·lastSuccessAtMs는 그대로 (수집 성공 위장 금지)', () => {
    const s = useLiveStore.getState();
    s.setWeather({ records: [], asOfMs: NOW - 600_000 });
    const before = useLiveStore.getState().weather;

    useLiveStore.getState().resliceWeather({ records: [], asOfMs: NOW - 600_000 });

    const after = useLiveStore.getState().weather;
    expect(after.asOfMs).toBe(before.asOfMs);
    expect(after.lastSuccessAtMs).toBe(before.lastSuccessAtMs);
  });

  test('같은 배열 참조면 상태를 바꾸지 않는다 (리렌더 없음)', () => {
    const records: WeatherAlertRecord[] = [];
    useLiveStore.getState().setWeather({ records, asOfMs: NOW });
    const before = useLiveStore.getState().weather;

    useLiveStore.getState().resliceWeather({ records, asOfMs: NOW });

    expect(useLiveStore.getState().weather).toBe(before);
  });

  test('news도 같은 계약', () => {
    useLiveStore.getState().setNews(emptyNews);
    const before = useLiveStore.getState().news;
    useLiveStore.getState().resliceNews({ records: [], asOfMs: NOW });
    expect(useLiveStore.getState().news.lastSuccessAtMs).toBe(before.lastSuccessAtMs);
  });
});

describe('derivePulseStatus', () => {
  test('성공 이력 없음 → standby', () => {
    expect(derivePulseStatus(useLiveStore.getState())).toBe('standby');
  });

  test('하나라도 ready → live', () => {
    useLiveStore.getState().setNews(emptyNews);
    expect(derivePulseStatus(useLiveStore.getState())).toBe('live');
  });

  test('전부 무갱신 → stale', () => {
    useLiveStore.getState().setNews(emptyNews);
    useLiveStore.getState().recomputeStale(NOW + LAYER_STALE_MS.news + 60_000);
    expect(derivePulseStatus(useLiveStore.getState())).toBe('stale');
  });
});

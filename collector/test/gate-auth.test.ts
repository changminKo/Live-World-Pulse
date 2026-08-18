import { describe, expect, test } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { FakeR2, asBucket } from './fake-r2';

function env(overrides: Partial<Env> = {}): Env {
  return { DATA: asBucket(new FakeR2()), ...overrides };
}

describe('/__gates 인증 (H5 — fail-closed)', () => {
  test('GATE_TOKEN 미설정 → 모든 게이트 404 (fail-closed)', async () => {
    for (const path of ['/__gates/quake1', '/__gates/flight1', '/__gates/adsb', '/__gates/gdelt']) {
      const res = await worker.fetch(new Request(`https://collector.test${path}`), env());
      expect(res.status, path).toBe(404);
    }
  });

  test('토큰 불일치·헤더 누락 → 404', async () => {
    const withToken = env({ GATE_TOKEN: 'sekret' });
    const noHeader = await worker.fetch(new Request('https://collector.test/__gates/quake1'), withToken);
    expect(noHeader.status).toBe(404);
    const wrongHeader = await worker.fetch(
      new Request('https://collector.test/__gates/quake1', { headers: { 'x-gate-token': 'nope' } }),
      withToken,
    );
    expect(wrongHeader.status).toBe(404);
  });

  test('올바른 토큰 + 미정의 게이트 경로 → 404 (루트 fallthrough 금지)', async () => {
    const res = await worker.fetch(
      new Request('https://collector.test/__gates/unknown', { headers: { 'x-gate-token': 'sekret' } }),
      env({ GATE_TOKEN: 'sekret' }),
    );
    expect(res.status).toBe(404);
  });

  test('루트는 여전히 200 (헬스 확인용)', async () => {
    const res = await worker.fetch(new Request('https://collector.test/'), env());
    expect(res.status).toBe(200);
  });
});

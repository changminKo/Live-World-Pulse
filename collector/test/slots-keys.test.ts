import { describe, expect, test } from 'vitest';
import {
  NORM_SLOT_SEC,
  OBSERVATION_BUCKET_SEC,
  dtOf,
  hourOf,
  manifestEntryKey,
  normKey,
  normPointerKey,
  rawKey,
  slotStartSec,
  statusKey,
  capacityKey,
} from '../src/slots';

describe('slot 계산 (PLAN §5 Observation ID 계약 + §8.6 norm 슬라이스)', () => {
  test('Observation ID 버킷 = floor(epochSec/180)*180 — ID 전용', () => {
    // 2026-08-19T00:02:59Z → 00:00:00 버킷
    const t = Date.UTC(2026, 7, 19, 0, 2, 59);
    expect(slotStartSec(t, OBSERVATION_BUCKET_SEC)).toBe(Date.UTC(2026, 7, 19, 0, 0, 0) / 1000);
    // 00:03:00 → 새 버킷
    expect(slotStartSec(t + 1000, OBSERVATION_BUCKET_SEC)).toBe(Date.UTC(2026, 7, 19, 0, 3, 0) / 1000);
  });

  test('norm 파일 슬라이스 = 900s(15분) — 전 레이어 공통 (§8.6 계약)', () => {
    expect(NORM_SLOT_SEC).toBe(900);
    const t = Date.UTC(2026, 7, 19, 12, 14, 59);
    expect(slotStartSec(t, NORM_SLOT_SEC)).toBe(Date.UTC(2026, 7, 19, 12, 0, 0) / 1000);
    expect(slotStartSec(t + 1000, NORM_SLOT_SEC)).toBe(Date.UTC(2026, 7, 19, 12, 15, 0) / 1000);
  });

  test('ID 버킷(180s)과 norm 슬라이스(900s)는 별개 상수 — 혼용 회귀 방지', () => {
    expect(OBSERVATION_BUCKET_SEC).toBe(180);
    expect(NORM_SLOT_SEC).not.toBe(OBSERVATION_BUCKET_SEC);
  });

  test('dt·hour는 UTC 기준 (로컬 타임존 오염 금지)', () => {
    const t = Date.UTC(2026, 7, 18, 23, 59, 59);
    expect(dtOf(Math.floor(t / 1000))).toBe('2026-08-18');
    expect(hourOf(t)).toBe('23');
    expect(dtOf(Math.floor(t / 1000) + 1)).toBe('2026-08-19'); // 날짜 경계
  });
});

describe('R2 키 규약 (PLAN §8.6 표 그대로)', () => {
  const slot = Date.UTC(2026, 7, 19, 0, 15, 0) / 1000;

  test('norm 키 — versioned generation', () => {
    expect(normKey('flight', slot, 0)).toBe(`norm/flight/dt=2026-08-19/slot=${slot}.g0.json.gz`);
    expect(normKey('earthquake', slot, 2)).toBe(
      `norm/earthquake/dt=2026-08-19/slot=${slot}.g2.json.gz`,
    );
  });

  test('raw 키 — dt/hour 파티션 + gzip', () => {
    const t = Date.UTC(2026, 7, 19, 7, 15, 0);
    expect(rawKey('adsblol', t, 'seoul')).toBe(
      `raw/adsblol/dt=2026-08-19/hour=07/${t}-seoul.json.gz`,
    );
    expect(rawKey('usgs', t, 'all_hour')).toBe(
      `raw/usgs/dt=2026-08-19/hour=07/${t}-all_hour.json.gz`,
    );
  });

  test('manifest immutable 엔트리 + 일 단위 포인터 shard + status·capacity 원장', () => {
    expect(manifestEntryKey('flight', slot, 1)).toBe(
      `manifest/flight/dt=2026-08-19/slot=${slot}.g1.json`,
    );
    expect(normPointerKey('2026-08-19')).toBe('manifest/pointers/norm/dt=2026-08-19.json');
    const scheduledMs = Date.UTC(2026, 7, 19, 0, 16, 0);
    expect(statusKey('flight', slot, scheduledMs, 0)).toBe(
      `manifest/status/flight/dt=2026-08-19/slot=${slot}.${scheduledMs}.a0.json`,
    );
    // attempt 순번이 키를 분리 — 같은 scheduledMs 중복 기록도 immutable
    expect(statusKey('flight', slot, scheduledMs, 1)).not.toBe(statusKey('flight', slot, scheduledMs, 0));
    expect(capacityKey('2026-08-19')).toBe('manifest/capacity/dt=2026-08-19.json');
  });
});

describe('60/180s → 900s 전환 경계 키 (재리뷰 Med1 — cutoff 계약)', () => {
  test('15분 정각이 아닌 legacy 슬롯은 어떤 900s 슬롯 키와도 충돌하지 않는다', () => {
    // legacy 60s(지진)·180s(항공기) 슬롯 값 중 900의 배수가 아닌 것 = 키 자체가 다르다
    const legacy60 = Date.UTC(2026, 7, 18, 18, 52, 0) / 1000; // 실측 마지막 legacy 지진 슬롯
    const legacy180 = Date.UTC(2026, 7, 18, 18, 57, 0) / 1000; // 실측 마지막 legacy 항공기 슬롯
    expect(legacy60 % 900).not.toBe(0);
    expect(legacy180 % 900).not.toBe(0);
    const slots900 = [
      Date.UTC(2026, 7, 18, 18, 45, 0) / 1000,
      Date.UTC(2026, 7, 18, 19, 0, 0) / 1000,
    ];
    for (const s of slots900) {
      expect(normKey('earthquake', legacy60, 0)).not.toBe(normKey('earthquake', s, 0));
      expect(normKey('flight', legacy180, 0)).not.toBe(normKey('flight', s, 0));
    }
  });

  test('15분 정각 legacy 슬롯은 900s 슬롯과 키 공간을 공유한다 — generation이 판정 (덮어쓰기 아님)', () => {
    // 900의 배수는 60·180의 배수이기도 함 — 이 경우 slot= 값이 같아 같은 키 공간.
    // upsertNormSlot은 기존 g를 읽어 merge 후 g+1을 발행하므로 legacy 파일을 덮지 않고,
    // 각 파일의 slotDurationSec 필드가 최종 판정 기준 (capacity.ts cutoff 계약 참조).
    const aligned = Date.UTC(2026, 7, 18, 18, 0, 0) / 1000; // 실측: legacy 180s 슬롯이면서 900 배수
    expect(aligned % 900).toBe(0);
    expect(aligned % 180).toBe(0);
    expect(aligned % 60).toBe(0);
    expect(normKey('flight', aligned, 0)).toBe(`norm/flight/dt=2026-08-18/slot=${aligned}.g0.json.gz`);
    expect(normKey('flight', aligned, 1)).toBe(`norm/flight/dt=2026-08-18/slot=${aligned}.g1.json.gz`);
    expect(normKey('flight', aligned, 0)).not.toBe(normKey('flight', aligned, 1));
  });
});

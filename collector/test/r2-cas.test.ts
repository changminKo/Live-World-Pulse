import { describe, expect, test, vi } from 'vitest';
import { LATEST_KEY, normPointerKey, normKey, dtOf } from '../src/slots';
import { setEarthquakeLatest, setFlightRegionLatest, updateLatest } from '../src/r2/latest';
import type { LatestDoc } from '../src/r2/latest';
import { contentHash } from '../src/hash';
import { gzipText } from '../src/gzip';
import { mergeById, upsertNormSlot } from '../src/r2/norm';
import type { EarthquakeRecord, FlightRecord } from '../src/types';
import { FakeR2, asBucket } from './fake-r2';

function quake(id: string, occurredAt: string): EarthquakeRecord {
  return {
    id: `usgs:${id}`,
    source: 'usgs',
    sourceId: id,
    layer: 'earthquake',
    revision: 1,
    observedAt: occurredAt,
    ingestedAt: occurredAt,
    geometry: { type: 'Point', coordinates: [142.3, 38.1] },
    centroid: [142.3, 38.1],
    h3r3: '',
    severity: { rank: 2, raw: 4.2, label: 'M4.2' },
    kind: 'occurrence',
    occurredAt,
    payload: {
      type: 'earthquake',
      magnitude: 4.2,
      magType: 'mb',
      depthKm: 10,
      place: 'test',
      tsunami: false,
      status: 'automatic',
      url: null,
    },
  };
}

function flight(hex: string, bucketTs: number, sampledAt: string): FlightRecord {
  return {
    id: `adsblol:${hex}:${bucketTs}`,
    source: 'adsblol',
    sourceId: `${hex}:${bucketTs}`,
    layer: 'flight',
    revision: 0,
    observedAt: sampledAt,
    ingestedAt: sampledAt,
    geometry: { type: 'Point', coordinates: [126.95, 37.44] },
    centroid: [126.95, 37.44],
    h3r3: '',
    severity: { rank: 0 },
    kind: 'observation',
    entityId: hex,
    sampledAt,
    payload: {
      type: 'flight',
      regionId: 'seoul',
      callsign: null,
      altBaroFt: 35000,
      groundSpeedKt: 400,
      trackDeg: 90,
      aircraftType: null,
      registration: null,
      category: null,
      seenPosSec: 1,
    },
  };
}

describe('latest.json CAS (H2 — initial-create race + 단조 갱신)', () => {
  test('최초 실행 경합: 병렬 invocation이 서로의 갱신을 지우지 않는다', async () => {
    // Arrange — 우리 put 직전에 경쟁자가 latest를 먼저 생성하는 race 재현
    const fake = new FakeR2();
    let raced = false;
    fake.hooks.beforePut = (key) => {
      if (key === LATEST_KEY && !raced) {
        raced = true;
        const competitor: LatestDoc = {
          updatedAt: '2026-08-19T00:00:00.000Z',
          layers: {
            flight: {
              regions: { tokyo: { asOf: '2026-08-19T00:00:00.000Z', records: [] } },
            },
          },
        };
        fake.seed(LATEST_KEY, JSON.stringify(competitor));
      }
    };

    // Act
    await updateLatest(asBucket(fake), setEarthquakeLatest([quake('q1', '2026-08-19T00:00:30.000Z')], '2026-08-19T00:01:00.000Z'));

    // Assert — create-if-absent 실패 → 재읽기 병합: 두 레이어 모두 생존
    const doc = fake.jsonOf<LatestDoc>(LATEST_KEY)!;
    expect(doc.layers.flight?.regions.tokyo).toBeDefined();
    expect(doc.layers.earthquake?.records).toHaveLength(1);
  });

  test('단조 갱신: 늦게 끝난 과거 invocation이 최신 스냅샷을 되돌리지 못한다', async () => {
    const fake = new FakeR2();
    const bucket = asBucket(fake);
    const newer = flight('aaa111', 900, '2026-08-19T00:15:00.000Z');
    const older = flight('bbb222', 720, '2026-08-19T00:12:00.000Z');

    await updateLatest(bucket, setFlightRegionLatest('seoul', [newer], '2026-08-19T00:15:05.000Z'));
    const putsAfterNewer = fake.putCount;

    // 과거 asOf로 덮어쓰기 시도 — 쓰기 자체가 스킵되어야 한다
    await updateLatest(bucket, setFlightRegionLatest('seoul', [older], '2026-08-19T00:12:05.000Z'));
    expect(fake.putCount).toBe(putsAfterNewer);

    const doc = fake.jsonOf<LatestDoc>(LATEST_KEY)!;
    expect(doc.layers.flight?.regions.seoul?.asOf).toBe('2026-08-19T00:15:05.000Z');
    expect(doc.layers.flight?.regions.seoul?.records[0]?.entityId).toBe('aaa111');

    // earthquake도 동일 규칙
    await updateLatest(bucket, setEarthquakeLatest([quake('q1', '2026-08-19T00:10:00.000Z')], '2026-08-19T00:14:00.000Z'));
    await updateLatest(bucket, setEarthquakeLatest([], '2026-08-19T00:13:00.000Z'));
    const doc2 = fake.jsonOf<LatestDoc>(LATEST_KEY)!;
    expect(doc2.layers.earthquake?.asOf).toBe('2026-08-19T00:14:00.000Z');
    expect(doc2.layers.earthquake?.records).toHaveLength(1);
  });
});

describe('norm 포인터 CAS (H2 — 신규 shard create-if-absent)', () => {
  test('UTC 새 날짜 경합: 병렬 quake/flight가 포인터 shard를 서로 지우지 않는다', async () => {
    const fake = new FakeR2();
    const slot = Date.UTC(2026, 7, 19, 0, 0, 0) / 1000;
    const pointerKey = normPointerKey(dtOf(slot));

    let raced = false;
    fake.hooks.beforePut = (key) => {
      if (key === pointerKey && !raced) {
        raced = true;
        // 경쟁자(quake invocation)가 같은 날짜 shard를 먼저 생성
        fake.seed(
          pointerKey,
          JSON.stringify({ layers: { earthquake: { [String(slot)]: { g: 0, hash: 'qhash' } } } }),
        );
      }
    };

    const outcome = await upsertNormSlot(
      asBucket(fake),
      'flight',
      slot,
      900,
      [flight('aaa111', slot, '2026-08-19T00:01:00.000Z')],
      mergeById,
      { dropped: 0 },
    );

    // Assert — 재시도 후 두 레이어 엔트리가 모두 있는 shard로 수렴
    expect(outcome.written).toBe(true);
    const shard = fake.jsonOf<{ layers: Record<string, Record<string, { g: number; hash: string }>> }>(pointerKey)!;
    expect(shard.layers.earthquake?.[String(slot)]).toEqual({ g: 0, hash: 'qhash' });
    expect(shard.layers.flight?.[String(slot)]?.g).toBe(0);
    // 본체·포인터 hash 일치 (immutable 계약)
    expect(fake.store.has(normKey('flight', slot, 0))).toBe(true);
    // 타 레이어發 shard 충돌 재시도는 내가 발행한 g0을 재사용 — 고아를 만들지 않는다
    expect(fake.keysWithPrefix('norm/flight/')).toHaveLength(1);
    expect(fake.keysWithPrefix('manifest/flight/')).toHaveLength(1);
  });
});

/** fake timer 하에서 promise 완료까지 시간 전진 — CAS 지터 백오프(100~500ms) 소화 */
async function advanceUntilSettled<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = promise.finally(() => {
    settled = true;
  });
  wrapped.catch(() => {}); // 루프 중 unhandled rejection 경고 방지 — 최종 await가 판정
  while (!settled) {
    await vi.advanceTimersByTimeAsync(100);
  }
  return wrapped;
}

describe('고아 = 무해 불변식 (재리뷰 3 — delete 경로 폐기, generation 전진만)', () => {
  test('CAS 소진 시 고아 body/manifest는 남지만 후속 실행(다른 hash)을 poison하지 않는다', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeR2();
      const slot = Date.UTC(2026, 7, 19, 0, 0, 0) / 1000;
      const pointerKey = normPointerKey(dtOf(slot));

      // 경쟁자가 포인터 PUT 직전마다 shard를 다른 내용으로 갱신 — 모든 CAS 시도 실패
      let churn = 0;
      fake.hooks.beforePut = (key) => {
        if (key === pointerKey) {
          churn += 1;
          fake.seed(
            pointerKey,
            JSON.stringify({ layers: { earthquake: { '60': { g: churn, hash: `h${churn}` } } } }),
          );
        }
      };

      await expect(
        advanceUntilSettled(
          upsertNormSlot(
            asBucket(fake),
            'flight',
            slot,
            900,
            [flight('aaa111', slot, '2026-08-19T00:01:00.000Z')],
            mergeById,
            { dropped: 0 },
          ),
        ),
      ).rejects.toThrow(/commit failed after 5 attempts/);

      // delete는 없다 — 자기 발행분(g0)을 CAS 재시도에 재사용했으므로 고아는 정확히 1쌍
      expect(fake.keysWithPrefix('norm/flight/')).toEqual([normKey('flight', slot, 0)]);
      expect(fake.keysWithPrefix('manifest/flight/')).toHaveLength(1);

      // 다음 invocation(다른 내용): 고아 g0은 putIfAbsent 충돌로 건너뛰고 g1에 정상 커밋
      fake.hooks = {};
      const outcome = await advanceUntilSettled(
        upsertNormSlot(
          asBucket(fake),
          'flight',
          slot,
          900,
          [flight('bbb222', slot, '2026-08-19T00:02:00.000Z')],
          mergeById,
          { dropped: 0 },
        ),
      );
      expect(outcome.written).toBe(true);
      expect(outcome.generation).toBe(1);
      expect(fake.store.has(normKey('flight', slot, 1))).toBe(true);
      // 고아 g0은 그대로 — 아무도 지우지 않고, 포인터만이 진실
      expect(fake.store.has(normKey('flight', slot, 0))).toBe(true);
      const shard = fake.jsonOf<{ layers: Record<string, Record<string, { g: number }>> }>(pointerKey)!;
      expect(shard.layers.flight?.[String(slot)]?.g).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('경쟁자가 같은 내용을 먼저 커밋해도(재리뷰 3 H1 interleaving) 양쪽 모두 손실 없음', async () => {
    // delete가 없으므로 "재확인~삭제 사이 경쟁 커밋" 윈도 자체가 존재하지 않는다 —
    // 검증할 것은 hash 수렴과 양쪽 객체의 생존뿐.
    const fake = new FakeR2();
    const slot = Date.UTC(2026, 7, 19, 0, 0, 0) / 1000;
    const pointerKey = normPointerKey(dtOf(slot));
    const record = flight('aaa111', slot, '2026-08-19T00:01:00.000Z');
    const hash = await contentHash(mergeById([], [record]));

    // 내 포인터 CAS 직전, 경쟁자가 동일 hash를 자기 generation(g7)으로 커밋
    let raced = false;
    fake.hooks.beforePut = (key) => {
      if (key === pointerKey && !raced) {
        raced = true;
        fake.seed(pointerKey, JSON.stringify({ layers: { flight: { [String(slot)]: { g: 7, hash } } } }));
      }
    };

    const outcome = await upsertNormSlot(
      asBucket(fake),
      'flight',
      slot,
      900,
      [record],
      mergeById,
      { dropped: 0 },
    );

    // 성공 수렴 — 포인터(경쟁자 커밋)가 진실, g는 경쟁자 것
    expect(outcome.written).toBe(true);
    expect(outcome.generation).toBe(7);
    // 내가 발행한 g0 body/manifest는 삭제되지 않고 그대로 (고아 = 무해)
    expect(fake.store.has(normKey('flight', slot, 0))).toBe(true);
    expect(fake.keysWithPrefix('manifest/flight/')).toHaveLength(1);
    // 경쟁자의 포인터 커밋도 훼손 없음
    const shard = fake.jsonOf<{ layers: Record<string, Record<string, { g: number; hash: string }>> }>(pointerKey)!;
    expect(shard.layers.flight?.[String(slot)]).toEqual({ g: 7, hash });

    // 동일 내용 재실행은 포인터 hash 판정으로 무쓰기 수렴 (멱등)
    const again = await upsertNormSlot(asBucket(fake), 'flight', slot, 900, [record], mergeById, { dropped: 0 });
    expect(again.written).toBe(false);
    expect(again.generation).toBe(7);
  });
});

describe('고아 무더기 liveness (재리뷰 4 Med — LIST 점프)', () => {
  test('고아 g0..g9가 쌓여 있어도 probe 소진 없이 그 위(g10)로 커밋한다', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeR2();
      const slot = Date.UTC(2026, 7, 19, 3, 0, 0) / 1000;
      // 포인터 없음 + 고아 body 10개 (이전 CAS 소진 반복이 남긴 상황 재현)
      for (let g = 0; g < 10; g += 1) {
        await fake.put(
          normKey('flight', slot, g),
          await gzipText(JSON.stringify({ layer: 'flight', slot, slotDurationSec: 900, generation: g, writtenAt: 'x', records: [] })),
        );
      }
      const p = upsertNormSlot(
        asBucket(fake),
        'flight',
        slot,
        900,
        [flight('aa1122', slot, '2026-08-19T03:00:30.000Z')],
        mergeById,
        { dropped: 0 },
      );
      await vi.runAllTimersAsync();
      const outcome = await p;
      expect(outcome.written).toBe(true);
      expect(outcome.generation).toBe(10); // LIST 점프로 고아 무더기 위에 착지
      const shard = JSON.parse(await (await fake.get(normPointerKey(dtOf(slot))))!.text());
      expect(shard.layers.flight[String(slot)].g).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});

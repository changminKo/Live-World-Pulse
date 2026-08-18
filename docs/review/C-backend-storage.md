# 검토 C — 백엔드 / 데이터 파이프라인 / 저장 / 비용

대상: `PLAN.md` (Live World Pulse). 코드 없음 → 계획 자체 검토. 리뷰 전용, 파일 미수정.

---

## 0. 한 줄 판정

계획서의 **프론트엔드 파트는 견고하고, 백엔드 파트는 "후보 나열"에 머물러 있다.** 치명적인 것 3개: (a) `WorldEvent` 단일 타입이 4개 레이어 중 3개를 담지 못한다, (b) 항공기 스냅샷 용량 추정이 없어 무료 티어가 **6시간**만에 터진다, (c) Collector Phase 순서가 뒤집혀 있어 **Phase 2에 보여줄 과거가 존재하지 않는다** — 이건 실제로 성립한다.

---

# 1. 데이터 모델 판정 (§16 `WorldEvent`)

## 1-1. Event vs Snapshot vs Track — **반드시 분리해야 한다**

계획서 `WorldEvent`는 네 레이어를 하나의 `timestamp` + `location` 쌍으로 뭉갠다. 각 레이어의 시간 의미론이 실제로 다르다:

| 레이어 | 시간 의미 | 조회 규칙 (시각 `t`의 세계 상태) | `WorldEvent`로 되는가 |
|---|---|---|---|
| 지진 | 발생 시점 1회, 불변 | `t-window <= occurredAt <= t` | ✅ 된다 |
| 뉴스 | 발행 시점 1회 | `t-window <= publishedAt <= t` | ✅ 된다 |
| 기상경보 | **구간** `validFrom~validTo` | `validFrom <= t < validTo` | ❌ 안 된다 |
| 항공기 | **연속 존재 개체의 표본** | `entityId별 t 이전 최근 1건` | ❌ 안 된다 |

**항공기를 `timestamp` 필터로 뽑으면 결과가 빈다.** 90초 주기로 수집하는데 사용자가 `t = 17:32:10`을 요청하면 그 timestamp를 가진 행이 없다. `entityId(icao24)`별 `GROUP BY` + `DISTINCT ON` 최근값 조회가 필요하고, 이건 `WorldEvent[]`를 `WHERE timestamp BETWEEN`으로 긁는 것과 완전히 다른 쿼리다. [확인됨: 논리적 귀결 — OpenSky state vector 는 t 시점 표본이지 이벤트가 아님 https://openskynetwork.github.io/opensky-api/rest.html]

→ **판정: `kind: 'occurrence' | 'interval' | 'observation'` 3분기 필수.** `Track`은 저장 타입이 아니라 `Observation[]`을 `entityId`로 접은 **파생 뷰**로 두는 게 맞다 (§9 Time Replay의 태풍 경로/항공기 궤적이 여기서 나온다).

## 1-2. 지오메트리 — **GeoJSON Geometry 채택 필요**

`{latitude, longitude}` 한 쌍으로 표현 불가능한 것들이 이미 MVP 안에 있다:

- 태풍 경로 = `LineString` (§9에 그림으로 이미 그려놨다)
- 기상 경보 구역 = `Polygon`/`MultiPolygon` — NWS 경보는 CAP 기반 구역 지오메트리를 갖는다. 이걸 중심점 하나로 접으면 "경보 지역"이 아니라 "경보 점"이 되어 §4 Weather의 "Alert region" 요구를 못 지킨다
- 항로 우회 (§10 "14 diverted") = `LineString`

→ **판정: `geometry: GeoJSON.Geometry` + 렌더/클러스터링용 `centroid: [lon, lat]` 캐시 컬럼 병행.** centroid를 따로 두는 이유는 deck.gl 마커/H3 셀 집계가 점 하나면 충분한데 매번 폴리곤 중심을 계산하면 비싸기 때문. [추정: deck.gl 렌더 특성 기반]

주의: **좌표 순서.** GeoJSON은 `[lon, lat]`, 계획서 §20 예시는 `35.6762, 139.6503`(lat, lon). 이건 실무에서 가장 흔한 버그 소스다. 타입 레벨에서 `[lon: number, lat: number]` 라벨드 튜플로 못 박아야 한다.

## 1-3. 지속 구간 — **`timestamp` 하나로 불충분**

기상 경보는 `sent`(발표) / `effective`(발효) / `onset`(시작) / `expires`(만료) / `ends`(종료)를 각각 가진다. 계획서의 단일 `timestamp`는 이 중 뭐로 매핑해도 §8 타임라인이 틀린다: `sent`로 두면 발표 이후 6시간짜리 경보가 타임라인에서 1분만 존재하고, `expires`로 두면 미래에만 나타난다.

→ **판정: `validFrom` / `validTo: Iso | null` + `status: 'active'|'updated'|'cancelled'|'expired'` 필수.** `validTo: null` = 아직 해제 안 됨.

## 1-4. severity 단일 숫자 정규화 — **물리량으로는 불가, UI 순위로는 가능**

"규모 7.1 vs 태풍 경보 vs 뉴스 42건"을 하나의 실수로 비교 가능하게 만드는 건 **물리적으로 의미가 없다.** 로그 스케일 에너지량과 카테고리형 경보 등급과 카운트를 같은 축에 두는 건 자의적이다.

하지만 목적은 비교가 아니라 **시각 인코딩(마커 크기/색)** 이므로, 표준이 이미 있다: **CAP(Common Alerting Protocol)** 의 `Minor / Moderate / Severe / Extreme`. NWS 경보가 이 값을 원본에서 그대로 준다. [확인됨: https://www.weather.gov/documentation/services-web-api]

→ **판정: `severity`를 객체로 쪼갠다.**
- `rank: 0..4` — 레이어별 매핑 테이블로 산출, **UI 인코딩 전용**
- `raw: number` + `unit` — 원본값 보존 (Mww 7.1은 7.1로 남아야 상세 패널에 쓸 수 있다)

레이어별 rank 매핑 예 (문서화 필요): 지진 `M<4→1, 4-5.5→2, 5.5-7→3, ≥7→4`; 뉴스 `mentionCount` 백분위 기반; 기상 CAP 직결.

## 1-5. 누락된 필드 — **양시간(bitemporal)이 없으면 Time Machine이 거짓말을 한다**

계획서 모델에 `source`, `sourceId`, `ingestedAt`, `revision`이 없다. 이건 단순 편의 문제가 아니다:

- **USGS는 지진 규모를 사후 정정한다.** 초기 M6.8이 몇 시간 뒤 M7.1로 바뀐다. `revision` 없이 UPSERT하면 "1시간 전의 세계"를 재생할 때 그 시점에 아무도 몰랐던 M7.1이 표시된다 — Time Machine 제품으로서 틀린 출력이다.
- **NWS 경보는 update/cancel 메시지로 갱신된다.**
- `sourceId` 없이는 멱등 재수집이 불가능하다 (§3 파이프라인 판정 참조).

→ **판정: `observedAt`(원본 관측 시각) / `ingestedAt`(우리가 알게 된 시각) 분리 + `revision` 필수.** "그때 우리가 알던 세계"를 재생하려면 `WHERE ingestedAt <= t`, "실제로 일어난 세계"면 생략 — 이건 제품 결정이지만 **필드가 없으면 선택지 자체가 없다.**

## 1-6. `metadata: Record<string, unknown>` — 타입 안전성 포기

정규화 계층을 만드는 목적(§16 "공통 Event 포맷으로 변환")이 `unknown` 백에서 무산된다. 프론트에서 `metadata.magnitude as number` 캐스팅이 퍼지면 정규화를 안 한 것과 같다.

→ **판정: discriminated union payload.**

## 1-7. 개선 타입 제안

```ts
// ============ 공통 ============
type Iso = string;                       // ISO-8601, 항상 UTC
type LayerId = 'earthquake' | 'weather' | 'flight' | 'news';

/** GeoJSON 좌표는 [lon, lat]. 라벨드 튜플로 순서 실수를 컴파일 타임에 잡는다. */
type Position = [lon: number, lat: number, alt?: number];
type Geometry =
  | { type: 'Point';        coordinates: Position }
  | { type: 'LineString';   coordinates: Position[] }
  | { type: 'Polygon';      coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

/** CAP 등급 차용. 레이어 간 '물리적 비교'가 아니라 '시각 인코딩 순위'다. */
type SeverityRank = 0 | 1 | 2 | 3 | 4;   // unknown|minor|moderate|severe|extreme
interface Severity {
  rank: SeverityRank;
  raw?: number;
  unit?: 'Mww' | 'mps' | 'hPa' | 'count';
  label?: string;                        // 'M7.1', 'Typhoon Warning', '42 reports'
}

/** 모든 레코드 공통: 출처 / 멱등키 / 양시간 / 지오메트리 */
interface RecordBase {
  id: string;                            // `${source}:${sourceId}` — 내부 PK
  source: 'usgs' | 'nws' | 'opensky' | 'adsblol' | 'gdelt' | 'gdacs';
  sourceId: string;                      // 원본 고유 ID → UPSERT 멱등 키
  layer: LayerId;
  revision: number;                      // 원본 정정 시 증가 (USGS 규모 정정 등)
  observedAt: Iso;                       // 원본이 관측/발표한 시각
  ingestedAt: Iso;                       // 우리가 알게 된 시각 (bitemporal replay용)
  geometry: Geometry;
  centroid: [lon: number, lat: number];  // 렌더/클러스터링용 캐시
  h3r3: string;                          // H3 res-3 셀 ID — LOD 집계 조인 키 (§22)
  severity: Severity;
}

// ============ 3가지 시간 의미론 ============

/** (1) Occurrence — 한 시점에 발생하고 끝난 사건. 지진, 뉴스. */
interface Occurrence<P> extends RecordBase {
  kind: 'occurrence';
  occurredAt: Iso;
  payload: P;
}

/** (2) Interval — 지속 구간을 갖는 상태. 기상 경보, 태풍 경보구역. */
interface Interval<P> extends RecordBase {
  kind: 'interval';
  validFrom: Iso;
  validTo: Iso | null;                   // null = 미해제
  status: 'active' | 'updated' | 'cancelled' | 'expired';
  payload: P;
}

/** (3) Observation — 계속 존재하는 개체의 시각 t 표본. 항공기, 태풍 중심. */
interface Observation<P> extends RecordBase {
  kind: 'observation';
  entityId: string;                      // icao24 / 태풍 국제번호 — 표본 묶음 키
  sampledAt: Iso;
  payload: P;
}

/** Track 은 저장 타입이 아니다. Observation[] 을 entityId 로 접은 파생 뷰. */
interface Track<P> {
  entityId: string;
  layer: LayerId;
  from: Iso;
  to: Iso;
  path: Extract<Geometry, { type: 'LineString' }>;
  samples: Observation<P>[];
}

// ============ 레이어별 payload ============
interface EarthquakePayload {
  magnitude: number; magType: string; depthKm: number;
  place: string; tsunami: boolean; felt: number | null;
}
interface WeatherAlertPayload {
  event: string;                         // 'Typhoon Warning'
  capSeverity: 'Minor'|'Moderate'|'Severe'|'Extreme'|'Unknown';
  capUrgency: 'Immediate'|'Expected'|'Future'|'Past'|'Unknown';
  headline: string; areaDesc: string;
}
interface FlightStatePayload {
  callsign: string | null;
  altitudeM: number | null; velocityMs: number | null;
  headingDeg: number | null; verticalRateMs: number | null;
  onGround: boolean; originCountry: string | null;
}
interface NewsPayload {
  title: string; url: string; domain: string;
  language: string; toneScore: number | null; mentionCount: number;
}

export type WorldRecord =
  | Occurrence<EarthquakePayload>
  | Occurrence<NewsPayload>
  | Interval<WeatherAlertPayload>
  | Observation<FlightStatePayload>;

// ============ 타임머신 질의 계약 ============
/** 시각 t 의 '세계 상태' = 3가지 kind 를 서로 다른 규칙으로 뽑아 합친 것.
 *  단일 timestamp 필터로는 절대 만들 수 없다는 게 이 타입의 요점. */
interface WorldStateQuery {
  at: Iso;
  bbox?: [w: number, s: number, e: number, n: number];
  layers: LayerId[];
  occurrenceWindowSec: number;    // occurrence: [at-window, at]
  observationToleranceSec: number;// observation: entityId별 at 이전 최근 1건,
                                  //   이 값 초과 시 stale 플래그
  asKnownAt?: Iso;                // 지정 시 ingestedAt <= asKnownAt (그때 알던 세계)
}
```

---

# 2. 저장 / 용량 / 비용 (§19, §20)

## 2-1. 계산 가정 (명시)

- **A1** 전 세계 동시 추적 ADS-B 항공기 **평균 10,000대** (피크 ~20,000). [추정]
- **A2** Postgres 항공기 스냅샷 1행 크기:
  - heap: 행 헤더 23B + 정렬 패딩 ≈ 24B, 컬럼 데이터(icao24 7 + callsign 9 + lat/lon float8 16 + alt/vel/track/vrate float4 16 + bool 1 + timestamptz 8) ≈ 57B, 아이템 포인터 4B → **≈ 95B**
  - 인덱스 2개: `(sampled_at, entity_id)` btree ≈ 45B/엔트리, geo(GiST) ≈ 55B/엔트리
  - → **총 ≈ 200 B/row** [추정: 계산식 위 명시]
- **A3** Parquet + zstd 컬럼 압축 후 **≈ 15 B/record** (icao24 딕셔너리 인코딩, lat/lon 델타, 정렬 저장) [추정]
- **A4** 폴링 상한은 OpenSky 무료 크레딧이 결정 → **90초** (아래 2-2 참조)

## 2-2. 폴링 주기는 우리가 정하는 게 아니다 — OpenSky 크레딧이 정한다 [확인됨]

OpenSky 크레딧 비용: `> 400 sq° 또는 global = 4 크레딧`. 일일 할당 `익명 400 / 등록 4,000 / 피더(가동률 30%+) 8,000`. 엔드포인트 카테고리별 별도 버킷. [확인됨: https://openskynetwork.github.io/opensky-api/rest.html]

```
등록 사용자: 4,000 credits/day ÷ 4 credits/global call = 1,000 calls/day
             86,400 s ÷ 1,000 = 86.4 초/call  → 실질 90초 주기
익명:        400 ÷ 4 = 100 calls/day → 14.4 분 주기 (사용 불가)
피더:        8,000 ÷ 4 = 2,000 calls/day → 43.2 초 주기
```

→ **§6의 `● LIVE` 표시는 OpenSky 무료 티어에서 "90초 전 스냅샷"을 뜻한다.** 인증 사용자도 과거 조회는 **1시간까지만** 가능. [확인됨: 동일 URL]

**대안 (권고):** `adsb.lol` — API 키 불필요, 무료, ODbL, 히스토리 덤프도 무료 제공. `airplanes.live` — 무료, **1 req/sec** 제한 → 초 단위 폴링 가능. [확인됨: https://github.com/adsblol/api , https://airplanes.live/api-guide/] 단 커뮤니티 피더 기반이라 커버리지가 OpenSky보다 지역 편중(특히 해양·아프리카)이 있을 수 있다. [추정]

## 2-3. 용량 추정표 (90초 주기 기준)

| 주기 | rows/day | Postgres/day | Postgres/월 | R2 Parquet/월 |
|---|---|---|---|---|
| 30 s | 28.8 M | 5.76 GB | 173 GB | 13 GB |
| 60 s | 14.4 M | 2.88 GB | 86 GB | 6.5 GB |
| **90 s (OpenSky 무료 상한)** | **9.6 M** | **1.92 GB** | **57.6 GB** | **4.3 GB** |
| 5 min | 2.88 M | 0.58 GB | 17 GB | 1.3 GB |

계산: `86400/주기 × 10,000대 × 200 B`. Parquet 열은 `× 15 B`.

## 2-4. 무료/저가 호스팅이 언제 터지는가 [확인됨 — 요금 출처 아래]

| 호스팅 | 무료 한도 | 90초 주기에서 소진 시점 |
|---|---|---|
| **Supabase Free** | DB **500 MB**, egress 5 GB/월, 1주 미사용 시 프로젝트 일시정지 | **≈ 6.2 시간** |
| **Neon Free** | **0.5 GB/project**, 100 CU-h, 전송 5 GB/월 | **≈ 6.4 시간** |
| **Supabase Pro $25** | DB 8 GB 포함, 초과 **$0.125/GB-월**, egress 250 GB | **4.3 일**에 8 GB 도달 |
| **Neon Launch** | 종량, 스토리지 **$0.35/GB-월** | 즉시 과금 |
| **Fly.io 볼륨** | 무료 없음, **$0.15/GB-월**, shared-cpu-1x 256MB **$2.02/월** | 즉시 과금 (직접 Postgres 운영) |
| **Railway Hobby $5** | $5 크레딧 포함, 볼륨 $0.15/GB-월, 메모리 $10/GB-월, vCPU $20/월, egress $0.05/GB | 크레딧 소진 후 종량 |
| **Cloudflare R2** | **10 GB-월 무료**, Class A 100만, **egress 무료** | 2.3 개월 |
| **Upstash Redis Free** | 256 MB, **50만 command/월**, 10 GB 전송 | 요청당 캐시 패턴이면 빠르게 소진 |

출처: [확인됨: https://supabase.com/pricing] [확인됨: https://neon.com/docs/introduction/plans] [확인됨: https://fly.io/docs/about/pricing/] [확인됨: https://railway.com/pricing] [확인됨: Cloudflare R2 / Upstash 무료 티어 — 웹검색 다수 일치]

**전량 보존 시 Postgres 비용 곡선 (90초, Supabase Pro):**
```
1개월 누적  57.6 GB → (57.6-8) × $0.125 + $25 =  $31.2/월
6개월 누적 346   GB → (346-8)  × $0.125 + $25 =  $67.3/월
12개월 누적 691  GB → (691-8)  × $0.125 + $25 = $110.4/월   ← 매달 커진다
```
Neon Launch($0.35/GB-월)면 12개월차 **$242/월**. **"월 수만원" 가정을 항공기 레이어 하나가 혼자 깬다.**

**같은 데이터를 R2 Parquet으로:**
```
12개월 누적 4.3 GB/월 × 12 = 51.6 GB → (51.6-10) × $0.015 = $0.62/월
```
→ **약 180배 차이.** 이게 이 리포트에서 비용상 가장 큰 결론이다.

## 2-5. 다른 레이어 용량 (참고 — 항공기가 100배 지배적)

| 레이어 | 일 볼륨 | 월 용량 | 근거 |
|---|---|---|---|
| 지진 (M2.5+) | ~40–50건 | ~1 MB | USGS 피드, 1분 갱신 [확인됨: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php] |
| 지진 (전체) | ~300–500건 | ~5 MB | 동일 |
| 기상 경보 | ~1–3천건, **폴리곤 5–50 KB/건** | **~1.2 GB** | [추정: NWS CAP 폴리곤 크기] |
| 뉴스 (GDELT) | ~5–10만 지오태그 | **~1 GB** | 15분 갱신 [확인됨: https://blog.gdeltproject.org/gdelt-geo-2-0-api-debuts/] |

→ **기상 폴리곤이 의외의 2위.** `ST_Simplify(geom, 0.01)`로 저장 시 5–10배 절감 가능하고, 3D 지구본 렌더 정밀도에서는 손실이 안 보인다. [추정]

## 2-6. 보존 정책 / 다운샘플링 — **계획서에 전무. 필수다.**

3계층 권고:

**HOT (Postgres, 정액 안에 영구히 고정)**
- 항공기 raw 스냅샷 **48시간만**. 근거: §8 타임라인 최대 범위가 `-24 hours`. 48h면 경계 여유까지 충분.
- 48h @90s = `960 × 2 × 10,000 × 200 B` = **3.84 GB** → **Supabase Pro 8 GB 안에 영구 고정, $25/월 정액에서 안 움직인다.**
- 지진/뉴스/경보는 전량 유지 (연 ~25 GB → Pro 초과분 $2/월 수준, 필요시 90일 롤오프)
- 구현: `pg_partman` 시간 파티션 + `DROP PARTITION` (DELETE 금지 — 진공 부하가 크다)

**WARM (Postgres 집계, 90–365일)**
- `H3 res-3 셀 × 15분 버킷`으로 항공기 카운트/평균고도/평균속도 집계
- H3 res-3 전지구 41,162셀 중 항공기 점유 실측 ~2,000셀 → `192 buckets/day × 2,000 = 384k rows/day × 100 B = 38 MB/day = 1.15 GB/월` [추정]
- 이게 §22 LOD("Zoom 1: Flight Cluster 400")를 **서버에서 미리 계산해 주는** 테이블이다 — 프론트 Web Worker에서 매 프레임 1만 점을 클러스터링하는 것보다 압도적으로 빠르고 싸다.
- 궤적을 남기고 싶은 항공기만 선별 보존 (예: 고도 변화율 임계 초과 = 우회/회항 후보)

**COLD (Cloudflare R2, 무제한)**
- 전량 raw를 `flights/dt=2026-08-18/hour=17.parquet` 파티션으로. egress 무료라 백엔드가 필요할 때만 읽는다.
- Douglas-Peucker 시간 데시메이션(순항 직선 구간 제거)으로 추가 5–10배 절감 가능 [추정]

## 2-7. Geo index — **PostGIS로 결정. H3는 병행하되 역할이 다르다. Geohash는 탈락.**

계획서 §20의 쿼리 패턴 `반경 300km + 시간 범위 결합`을 실측 기준으로 판정:

| 후보 | 반경 300 km 정확도 | 시간 결합 | 판정 |
|---|---|---|---|
| **PostGIS** `geography` + GiST | ✅ 측지 정확, `ST_DWithin(geog, pt, 300000)` 한 줄 | ✅ 파티션 + BRIN(time)과 조합 | **채택** |
| **H3** | ⚠️ 셀 근사 — `gridDisk` 반경이 정확히 300km가 아님, 경계 오차 발생 | ➖ | **집계/LOD 전용 병행** |
| **Geohash** | ❌ 극지 왜곡 심함, 접두사 경계 문제(인접 셀이 접두사를 공유 안 함) | ➖ | **탈락** |

**결정적 관찰:** 이 워크로드에서 지배적 필터는 **공간이 아니라 시간**이다 (`최근 N분`이 항상 붙는다). 따라서:
```sql
-- 시간 파티션이 1차 프루닝, GiST가 2차
CREATE TABLE flight_obs (...) PARTITION BY RANGE (sampled_at);
CREATE INDEX ON flight_obs USING BRIN (sampled_at);      -- append-only에 최적, 인덱스 크기 극소
CREATE INDEX ON flight_obs USING GIST (geog);
-- 조회
SELECT DISTINCT ON (entity_id) *
FROM flight_obs
WHERE sampled_at BETWEEN $t - interval '3 min' AND $t
  AND ST_DWithin(geog, ST_MakePoint($lon,$lat)::geography, 300000)
ORDER BY entity_id, sampled_at DESC;
```
BRIN을 쓰면 시계열 인덱스 오버헤드가 A2의 45 B/row에서 **거의 0**으로 떨어진다 → 위 용량 추정이 25% 개선된다. [추정: BRIN 특성]

H3는 `h3r3` 컬럼으로 들고 있다가 **집계 GROUP BY 키**로만 쓴다. 두 개 다 쓰는 게 중복이 아니라 역할 분담이다.

## 2-8. Timescale — **이 호스팅 조합에서는 쓸 수 없다** [확인됨, 중요]

계획서 §19가 "PostgreSQL 또는 Timescale 계열 검토"라고 했는데, 무료/저가 호스팅에서 Timescale의 핵심 기능이 실제로 막혀 있다:

- **Supabase:** `timescaledb`는 **Postgres 17에서 제거(deprecated)**. PG15는 EOL(~2026년 5월)까지만 유지, 업그레이드 전 DROP 필요. 대체로 `pg_partman` + 네이티브 파티셔닝 안내. [확인됨: https://supabase.com/changelog/35851-forthcoming-postgres-17-release-notes]
- **Neon:** 설치는 되지만 **Apache-2 에디션만** — 네이티브 압축, continuous aggregates 증분 갱신, 티어드 스토리지 등 **TSL 기능이 전부 비활성.** 즉 우리가 원하던 두 기능(압축, 연속 집계)이 정확히 빠져 있다. [확인됨: https://neon.com/docs/extensions/timescaledb]

→ **판정: Timescale은 선택지에서 제외.** 네이티브 시간 파티셔닝 + `pg_partman` + BRIN으로 간다. 압축이 정말 필요하면 그건 Postgres가 아니라 **R2 Parquet의 역할**이다.

## 2-9. Redis — **Phase 0/1에서 불필요**

§19가 "Redis 또는 memory cache"라고 병기했는데, "current state"의 실제 크기가 **항공기 1만대 스냅샷 ≈ 1.5 MB**다. 상주 Collector 프로세스가 이미 하나 떠 있으므로 **그 프로세스의 in-memory Map으로 끝난다.** Redis를 넣으면 배포 단위 +1, 장애 지점 +1, 무료 티어 한도(Upstash 50만 command/월) 관리 부담 +1이 생기는데 얻는 게 없다.

→ **판정: Phase 0–1 인메모리. Redis는 "API 인스턴스가 2개 이상이 될 때" 도입.** 그 시점이 안 올 가능성이 높다(포트폴리오).

## 2-10. Egress — 계획서에 완전 누락, 실제로 먼저 터질 수 있다

```
항공기 1만대 응답: JSON 150 B/대 = 1.5 MB → gzip ≈ 400 KB
Supabase Free egress 5 GB/월 ÷ 400 KB = 12,500 응답
방문자 1명이 5분 체류 × 30초 폴링 = 10응답
→ 월 방문자 1,250명이면 무료 egress 소진
```
**DB 용량보다 egress가 먼저 터질 수도 있다.** 대응: (a) viewport bbox 필터링 필수, (b) 응답을 JSON이 아니라 **Float32Array 바이너리**(36 B/대 → 360 KB → gzip 250 KB), (c) **Cloudflare 무료 CDN + `Cache-Control: s-maxage=30`** 를 API 앞단에 — R2와 마찬가지로 egress 무료.

---

# 3. 파이프라인 판정 (§17, §18)

## 3-1. Collector 실행 방식 — **상주 프로세스 1개. serverless/cron은 전부 탈락.** [확인됨]

| 방식 | 실제 제약 | 판정 |
|---|---|---|
| **Vercel Cron (Hobby)** | **1일 1회**만 허용. 더 잦은 표현식은 배포 자체가 실패. 실행 시각도 지정 시간대(hour) 내 임의. | ❌ 완전 탈락 [확인됨: https://vercel.com/docs/cron-jobs/usage-and-pricing] |
| **GitHub Actions cron** | 최소 5분, 피크 시 **10–30분 지연** 상시, 공개 저장소는 **60일 무활동 시 자동 비활성화** | ❌ 탈락 (히스토리에 구멍) [확인됨: https://github.blog/changelog/2019-11-01-github-actions-scheduled-jobs-maximum-frequency-is-changing/] |
| **Cloudflare Cron Triggers** | 1분 주기 가능, 무료 | △ 90초 주기엔 부적합(1분 or 2분), 상태 없는 실행이라 dedupe 로직이 매번 DB 왕복 |
| **상주 프로세스 (Fly.io / Railway)** | Fly shared-cpu-1x 256 MB = **$2.02/월**. 소스별 독립 `setInterval` 스케줄러 | ✅ **채택** |

소스별 실제 갱신 주기와 맞춘 스케줄:
```
USGS 지진      60 s   (피드 1분 갱신)   [확인됨: USGS geojson.php]
항공기         90 s   (OpenSky 크레딧)  또는 5 s (adsb.lol/airplanes.live 사용 시)
NWS 경보       60 s   (rate limit 비공개, "generous", 초과 시 5초 후 재시도)
GDELT 뉴스    900 s   (15분 갱신 — 더 자주 호출해도 새 데이터 없음)
Open-Meteo     -      (온디맨드; 무료 10,000 call/day, 5,000/h, 600/min)
```
[확인됨: https://open-meteo.com/en/pricing] [확인됨: https://www.weather.gov/documentation/services-web-api]

**중요:** GDELT는 일반적으로 **IP당 5초에 1요청** 수준의 rate limit이 걸린다 [추정: GDELT 공지 기반]. `User-Agent` 헤더는 NWS에서 **필수**이고 연락처 포함이 권장된다 [확인됨].

## 3-2. 장애 / 재시도 / 멱등성 — **계획서 전무. 이 제품에서는 치명적.** [확인됨: PLAN.md 전문에 해당 언급 0회]

일반 서비스면 Collector 다운은 "잠깐 데이터 늦음"이다. **이 제품은 과거를 파는 제품이라 다운 = 그 시간대가 영구 손실**이다. 나중에 못 메운다(OpenSky는 1시간까지만 소급).

필요한 것:

**(a) 멱등 키 — 소스별 자연키로 UPSERT**
```
지진      → UNIQUE(source, sourceId)          USGS id는 안정적, 정정 시 revision++
뉴스      → UNIQUE(source, sha256(url))       GDELT는 같은 기사를 반복 반환
기상경보  → UNIQUE(source, sourceId, sent)    update/cancel이 같은 id로 온다
항공기    → PK(entity_id, bucket_ts)          bucket_ts = floor(ts / 90s) — 
                                              폴링이 밀려도 같은 슬롯에 덮어써 중복 방지
```
전부 `INSERT ... ON CONFLICT DO UPDATE WHERE excluded.revision > t.revision`.

**(b) 수집 원장 (`collector_runs`)**
```
(source, window_start, window_end, status, record_count, error, attempt)
```
재기동 시 이 테이블의 갭을 스캔 → 소스가 소급 가능하면 백필, 불가하면 **`gap` 레코드로 명시 기록.**

**(c) 갭을 UI에 노출** — 이게 핵심이다. 타임라인에 데이터 없는 구간을 조용히 비우면 사용자는 "그 시각엔 항공기가 없었다"로 읽는다. **거짓 세계 상태다.** 타임라인 스크러버에 회색 갭 밴드로 표시해야 한다. 포트폴리오 관점에서도 이걸 구현했다는 게 오히려 강한 신호다.

**(d) 데드맨 스위치** — Collector가 죽으면 아무도 모른다. 매 수집 성공 시 `healthchecks.io`(무료) 핑 → 3주기 미수신 시 이메일/텔레그램. 비용 $0, 코드 3줄.

**(e) 재시도** — 지수 백오프 + 지터, 최대 3회. OpenSky 429는 크레딧 소진 의미이므로 **재시도하면 안 되고 다음 슬롯까지 대기**해야 한다 (재시도하면 다음 날 크레딧까지 태운다).

## 3-3. WebSocket — **MVP에 불필요. SSE로 대체 권고.**

소스 자체의 갱신 주기: 지진 60초 / 항공기 90초 / 뉴스 900초 / 경보 분 단위. **초 단위로 바뀌는 소스가 하나도 없다.**

WebSocket을 넣으면 생기는 비용: 상태 있는 연결 유지 → 서버 스케일 제약, 재연결/하트비트/백프레셔 로직, 다중 인스턴스 시 팬아웃(pub/sub 필요 → Redis 강제 도입), 정적/엣지 호스팅 불가. 얻는 것: 90초마다 오는 데이터를 90초마다 받는 것 — **폴링과 동일.**

계획서 §13에 이미 **TanStack Query**가 있다. `refetchInterval`을 소스 주기에 맞추면 끝난다.

→ **판정:**
- Phase 0–1: **폴링** (TanStack Query `refetchInterval`, CDN 30초 캐시와 정렬)
- Phase 2+: "LIVE" 체감이 필요하면 **SSE** (`text/event-stream`) — 단방향이면 충분하고, HTTP 그대로라 CDN/프록시 친화적이며 재연결이 브라우저 기본 제공
- **WebSocket은 넣지 않는다.**

다만 §32가 "Realtime Architecture"를 포트폴리오 포인트로 걸고 있다 → 이건 엔지니어링 판단과 포트폴리오 서사가 충돌하는 지점이다. **SSE로도 "실시간 아키텍처"는 충분히 주장 가능하고, "왜 WebSocket을 안 썼는지 소스 갱신 주기로 논증한 README"가 오히려 시니어 신호다.** 그렇게 쓰는 걸 권고한다.

## 3-4. API 키 프록시 / 캐시 계층 — **계획서에 명시 없음** [확인됨: PLAN.md 전문 검색]

§16이 "외부 API 데이터를 직접 UI에서 사용하지 않는다"고 하지만 이건 **데이터 포맷 이야기지 네트워크 경로 이야기가 아니다.** §13 프론트 스택만 보면 클라이언트가 직접 fetch하는 구조로 읽힌다.

명시해야 할 것:
- **모든 외부 호출은 백엔드에서만.** 프론트는 자기 백엔드만 호출.
- 실무 이유 3가지: (1) OpenSky Basic 인증 자격증명 노출 방지, (2) **CORS** — NWS/OpenSky는 브라우저 직접 호출이 막히거나 불안정, (3) **rate limit 공유** — 클라이언트 직접 호출이면 방문자 수만큼 소스를 때려 크레딧이 즉사한다 (OpenSky 4,000 크레딧 = 방문자 1,000명이 각 1회 조회하면 끝).
- 캐시: 백엔드 인메모리 (TTL = 소스 주기) → HTTP `Cache-Control: s-maxage` → Cloudflare CDN. 3단.

---

# 4. Phase 순서 검증 — **문제 성립. 단, 레이어 1개에 한정.**

## 4-1. 레이어별 "과거를 나중에 백필할 수 있는가" 실사

| 레이어 | 소급 가능? | 근거 |
|---|---|---|
| **지진** | ✅ 완전 가능 | USGS가 past hour/day/7day/30day 피드 + FDSN `query` API로 수십 년치 제공 [확인됨: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php] |
| **뉴스** | ✅ 가능 | GDELT는 15분 단위 아카이브 파일 + BigQuery 공개 데이터셋 보유. GEO API도 최대 7일 소급 [확인됨: https://blog.gdeltproject.org/gdelt-geo-2-0-api-debuts/] |
| **기상** | △ 부분 가능 | Open-Meteo는 `past_days`(최대 92일) 및 아카이브 API 제공. **경보(alert)는 과거 조회가 제한적** [확인됨: Open-Meteo 문서 / 추정: NWS alerts 아카이브 범위] |
| **항공기** | ❌ **불가능** | OpenSky 인증 사용자도 **과거 1시간까지만**. 그 이상은 연구자용 Impala/Trino 접근 필요 [확인됨: https://openskynetwork.github.io/opensky-api/rest.html] |

## 4-2. 판정: **순서 문제는 실재한다 — 항공기 때문에.**

계획서 §35의 완성 기준 데모가 정확히 이 구멍을 밟는다:
```
3. 태풍 이벤트 선택 → 관련 항공편 및 뉴스 표시
4. Timeline을 2시간 전으로 이동 → 당시 세계 상태 복원
5. Play 클릭 → 시간에 따라 사건 변화 재생
```
→ **간판 데모 3개가 전부 "2시간 전 항공기 위치"를 요구한다.** OpenSky로는 1시간까지만 소급되므로, Phase 2에 착수하는 시점에 Collector가 이미 돌고 있지 않았다면 **보여줄 과거가 없다.** 지진/뉴스는 그 자리에서 백필하면 되므로 문제없다.

**단, 탈출구가 하나 있다:** `adsb.lol`이 **무료 히스토리 덤프**를 공개한다 [확인됨: https://github.com/adsblol/api]. 이걸 쓰면 자체 수집 없이도 과거 항공기 데이터를 얻을 수 있다. 다만 (a) 덤프 포맷/보존 기간/커버리지를 먼저 검증해야 하고, (b) 대용량 다운로드+파싱 파이프라인을 따로 만들어야 하며, (c) ODbL 라이선스 귀속 표기 의무가 붙는다.

## 4-3. 권고 순서

```
Phase 0a  ─ "Day 1, 지구본 코드 한 줄 쓰기 전에"      ★ 신설
   • Collector 최소본 배포 (Fly.io shared-cpu-1x, $2/월)
     - 항공기 90초 스냅샷 → Postgres(48h hot) + R2 Parquet(cold)
     - 지진 60초 (덤이다, 코드 20줄)
   • UI 없음. 대시보드 없음. healthchecks.io 핑만.
   • 규모: ~150줄. 반나절.
   → 이 시점부터 시계가 돌기 시작한다. Phase 2 도달 시점에 
     자동으로 수 주치 히스토리가 쌓여 있다.

Phase 0   ─ Globe 프로토타입 (계획서 그대로)
Phase 1   ─ MVP. 기상/뉴스 Collector 추가.
            지진·뉴스는 여기서 과거 백필 (소급 가능하므로 서두를 이유 없음)
Phase 2   ─ Time Machine. 이미 히스토리 존재. 
            "쌓기"가 아니라 "읽기"만 구현하면 된다.
```

**Phase 0a의 진짜 가치:** Phase 2에 가서야 데이터 모델의 결함(§1)이 드러나면 스키마 마이그레이션 + 재수집이 필요한데, 재수집이 **불가능하다**(항공기는 소급 안 됨). Phase 0a에서 raw 응답을 R2에 원본 그대로도 함께 던져두면(`raw/opensky/dt=.../hour=.parquet`) 스키마를 바꿔도 재파싱이 가능하다. **원본 raw 보존은 필수다.** 압축 후 용량 부담도 거의 없다.

---

# 5. 계획서에서 **틀린 전제**

**T1. "Realtime" (§6 `● LIVE`, §32 Realtime Architecture) — 실시간 소스가 하나도 없다.**
최선 해상도가 항공기 90초, 지진 60초, 뉴스 900초다. `● LIVE`는 "최신 가용 스냅샷"의 의미로만 정직하다. [확인됨: 각 소스 문서]

**T2. 기상 레이어의 지리 커버리지 — 간판 데모(일본 큐슈 태풍)에 쓸 무료 경보 소스가 없다.** ★ 가장 큰 제품 리스크
- NWS API = **미국 전용** [확인됨: weather.gov]
- MeteoAlarm = 유럽 전용
- NHC JSON = 대서양/동태평양 전용, 큐슈 미포함
- JMA = 공개 JSON API 부재 (3시간, 접근 시 1시간 갱신이지만 기계 판독 API가 아님)
- Open-Meteo = 예보만, **경보 없음** [확인됨: open-meteo.com]
→ §7 Event Detail 예시(`Japan / Typhoon Warning`)와 §35 데모 시나리오가 현재 무료 소스 조합으로 **구현 불가능**하다.
→ **대안: GDACS** (UN/EC 운영, 전지구 재난 경보, 열대저기압 트랙 포함, 무료 GeoRSS/GeoJSON). 다음 액션으로 GDACS 엔드포인트 스펙 검증을 권고한다. [추정: GDACS 공개 API 존재 확인, 상세 스펙 미검증]

**T3. §19 "PostgreSQL 또는 Timescale" — Timescale은 이 호스팅에서 쓸 수 없다.** (2-8 참조) [확인됨]

**T4. §19 "Redis 또는 memory cache" — Redis는 MVP에서 순손실.** current state가 1.5 MB다. (2-9 참조)

**T5. §32 "수만~수십만 개 이벤트" — 실시간 동시 데이터는 1–2만 개다.**
전지구 동시 ADS-B가 1–2만대. 여기에 지진 수십, 경보 수백, 뉴스 수천을 더해도 2–3만이다. "수십만"에 도달하려면 **과거 궤적을 동시에 그려야** 하는데, 이건 데이터 볼륨이 아니라 렌더링 선택이다. 서사를 "동시 2만 마커 + 24시간 궤적 재생"으로 정정하는 게 정직하고, 실제로도 더 어려운 문제다. [추정: A1]

**T6. §11 상관관계 규칙 `distance < 300km AND Δt < 60min` — 항공기에 적용하면 무의미하다.**
일본 상공 300km 원 안에는 상시 수백 대가 있다. 이 규칙은 "근처에 있었다"만 말하고 §10의 `27 delayed / 14 diverted`를 **논리적으로 도출할 수 없다.** 지연/우회는 근접이 아니라 **기준선 대비 편차**다 — 출발/도착 공항과 통상 항로를 알아야 한다. OpenSky `/flights/all`(estDepartureAirport/estArrivalAirport)로 가능하지만 **별도 크레딧 버킷**을 소모하고 데이터가 사후 확정된다. 
→ **판정: MVP에서 "diverted" 문구는 쓰지 말 것.** 대신 실제로 계산 가능한 것 — 셀 내 항공기 밀도의 시간 변화, 평균 고도/항로각 분산 증가 — 로 바꾸면 정직하고 시각적으로도 강하다. (예: `Aviation: traffic density -38% vs 24h baseline`)

**T7. §8 타임라인이 레이어별 시간 해상도 차이를 무시한다.**
`-10 min` 눈금에서 뉴스는 15분 갱신이라 아무것도 안 바뀌고, 지진은 그 10분간 사건이 0건일 확률이 높다. 레이어별 네이티브 해상도를 UI에 노출하지 않으면 "타임라인이 고장난 것처럼" 보인다.

**T8. §22 LOD를 프론트에서 계산한다는 암묵 전제.**
§21이 Web Worker에서 clustering을 하겠다고 했는데, 1만 점을 매 시각 이동마다 워커에서 클러스터링하면 스크러빙이 끊긴다. **서버에서 H3 집계 테이블로 미리 만들어 주는 게 맞다** (2-6 WARM 참조).

---

# 6. **추가 권고** (계획서에 없는 백엔드 관심사)

| # | 항목 | 권고 | 우선순위 |
|---|---|---|---|
| A1 | **인증** | 공개 읽기 전용 → 사용자 인증 불필요. 단 Collector 트리거/관리 엔드포인트는 shared secret 헤더로 보호 | P1 |
| A2 | **자체 API rate limiting** | 공개 포트폴리오는 스크래핑 대상. IP당 토큰 버킷 (Cloudflare 무료 룰 또는 앱 레벨). **없으면 남의 스크래퍼가 내 egress 요금을 태운다** | **P0** |
| A3 | **캐시 무효화** | 시간 기반 TTL만 사용 (소스 주기 = TTL). 과거 데이터는 불변이므로 `Cache-Control: public, max-age=31536000, immutable`. `LIVE`만 `s-maxage=30` | P1 |
| A4 | **모니터링/알림** | healthchecks.io 데드맨 스위치(무료) + 수집 갭 카운터. **Collector 침묵 = 영구 데이터 손실**이므로 이 프로젝트에서 최고 가치 항목 | **P0** |
| A5 | **마이그레이션** | Drizzle Kit 또는 Atlas. 파티션 테이블은 ORM 자동 생성이 잘 깨지므로 raw SQL 마이그레이션 병행 | P1 |
| A6 | **백업** | Supabase Free는 백업 없음, Pro도 7일 PITR. **R2 Parquet 콜드 레이어가 사실상 백업 역할**을 겸한다 — 이게 R2를 쓰는 두 번째 이유 | P1 |
| A7 | **CI/CD** | GitHub Actions: 타입체크/린트/빌드 + Fly deploy. cron 용도로는 쓰지 말 것(3-1) | P2 |
| A8 | **배포 타겟** | 프론트 Vercel/Cloudflare Pages(무료) + Collector·API Fly.io($2–5) + DB Supabase(무료→Pro) + 콜드 R2(무료). **총 $0 → $27/월** | P0 |
| A9 | **시크릿 관리** | `fly secrets` / Vercel env. `.env`를 절대 커밋하지 말 것 — 공개 저장소다 | **P0** |
| A10 | **비용 알람** | Supabase/Neon 사용량 알림 + Fly 예산 알림. 무료 티어 서비스는 알람이 기본 비활성인 경우가 많다 | P1 |
| A11 | **소스 ToS / 라이선스** | OpenSky = **비상업 용도 제한**, adsb.lol = **ODbL(귀속 표기 의무)**, GDELT/USGS/NWS = 공공. README에 출처 명시 필수. 포트폴리오라 상업성은 없지만 표기는 해야 한다 | **P0** |
| A12 | **시간/타임존** | 전 계층 UTC 강제. DB `timestamptz`, 앱 `Date` 대신 명시적 ISO 문자열. 표시 시점에만 로컬 변환 | P0 |
| A13 | **CORS** | 자체 API에 오리진 화이트리스트 | P1 |
| A14 | **egress 예산** | 2-10 참조. bbox 필터 + 바이너리 응답 + CDN | **P0** |
| A15 | **좌표 검증** | 소스가 가끔 `lat=0, lon=0`(널섬) 또는 `NaN`을 준다. 정규화 계층에서 드롭 + 카운터 기록 | P1 |
| A16 | **원본 raw 보존** | 4-3 참조. R2에 원본 응답 그대로도 적재 → 스키마 변경 시 재파싱 가능 | **P0** |

---

# 7. **수정 권고** (계획서 반영안)

| 대상 | 현재 | 수정안 |
|---|---|---|
| **§16** | 단일 `WorldEvent` | `Occurrence | Interval | Observation` 3분기 + GeoJSON geometry + `Severity` 객체 + `source/sourceId/revision/ingestedAt` (1-7 코드 블록) |
| **§17** | `... → (WebSocket) → Frontend` | `... → HTTP polling (CDN 30s) → Frontend`. WebSocket 제거, SSE는 Phase 2 선택 |
| **§18** | `Realtime Gateway` 포함 | `Realtime Gateway` 삭제. 대신 **`Collector Health / Gap Ledger`** 추가 |
| **§19** | Redis + PostgreSQL/Timescale | **Phase 0–1: Postgres 단일** (인메모리 캐시) + **R2 Parquet 콜드**. Timescale 삭제(2-8). Redis는 "API 인스턴스 2개+ 시점"으로 연기 |
| **§19** | 보존 정책 없음 | **HOT 48h / WARM H3r3×15min 90–365일 / COLD R2 무제한** 3계층 명시 (2-6) |
| **§20** | `PostGIS / H3 / Geohash` 후보 나열 | **PostGIS geography+GiST 채택**, H3는 집계 키로 병행, **Geohash 탈락** (2-7) |
| **§25 앞** | — | **`Phase 0a — Collector First`** 신설 (4-3) |
| **§11** | `distance<300km AND Δt<60min` 단일 규칙 | 레이어별 규칙 분리. 항공기는 근접이 아니라 **기준선 대비 편차** |
| **§10** | `27 delayed / 14 diverted` | MVP에서는 계산 불가. `traffic density -38% vs baseline` 형태로 교체 (T6) |
| **§4 Weather** | Typhoon 경보 (일본 데모) | 소스 미확보. **GDACS 검증을 선행 과제로 등록.** 미확보 시 데모 무대를 미국(NWS 커버)으로 변경하거나 태풍을 "트랙"으로만 표현 |
| **§32** | "수만~수십만 개 이벤트" | "동시 2만 마커 + 24시간 궤적 재생" |
| **§32** | "Realtime Architecture" | "**Rate-limit-aware ingestion & gap-honest history**" — 실제로 한 일이고 더 어려운 문제다 |

---

## 최종 요약 (실행 3줄)

1. **오늘 당장:** Collector 최소본(항공기 90초 + 지진)을 Fly.io에 배포한다. UI보다 먼저다. 안 그러면 Phase 2에 보여줄 과거가 없다.
2. **모델:** `WorldEvent` 단일 타입을 버리고 `Occurrence/Interval/Observation` + GeoJSON + bitemporal로 간다. Phase 0a raw를 R2에 원본 보존해 두면 나중에 바꿔도 재파싱된다.
3. **저장:** Postgres는 48시간 핫 데이터만(3.84 GB, Supabase Pro 정액 안에 영구 고정), 전체 히스토리는 R2 Parquet(연 $1 미만). Timescale·Redis·WebSocket 셋 다 지금은 빼라.

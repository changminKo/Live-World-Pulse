# Live World Pulse 작업 계획서 v2

> v1 대비 변경 요지: 4개 렌즈(데이터 소스 / 프론트 아키텍처 / 백엔드·비용 / 스코프) 검토 결과 반영.
> 실측·공식 문서로 확인된 제약을 전제에 반영했다. [검증 필요] 3건(GDACS·adsb.lol·타일 소스)은 2026-08-18 조사 단계 실측으로 전부 확정 반영 완료.
> 검토 리포트 원문: `docs/review/` (2026-08-18 기준 조사).

---

## 1. 프로젝트 개요

**Live World Pulse**는 전 세계에서 발생하는 주요 실시간 이벤트를 하나의 인터랙티브 지구본 위에서 탐색할 수 있는 데이터 시각화 서비스다.

지진, 기상, 항공기, 뉴스 데이터를 **시간(Time) + 위치(Location)** 기준으로 통합한다. 사용자는 현재 상태만 보는 것이 아니라 타임라인을 이동하면서 과거 특정 시점의 세계 상태를 확인하고, 특정 지역에서 여러 이벤트가 어떻게 연결되는지 탐색할 수 있다.

### 핵심 컨셉

> **DevTools for Earth**

웹 애플리케이션을 DevTools로 관찰하듯, 지구에서 발생하는 사건을 관찰하고 과거 상태까지 추적한다.

DevTools 은유를 완성하는 3요소:
1. **타임라인 스크러빙** — 시간 이동·재생
2. **이벤트 inspect** — 개별 이벤트 상세
3. **이벤트 로그 패널** — Network 탭처럼 흐르는 이벤트 리스트 (v2 신규 — 접근성 대체 뷰 + SEO 겸용)

### 포지셔닝 (정직한 서술)

- ~~"Realtime"~~ → **"Live Data Integration"**. 소스 최선 해상도가 항공기 90초 / 지진 60초 / 뉴스 15분이므로 초 단위 실시간을 주장하지 않는다. `● LIVE` 표시는 "최신 가용 스냅샷"을 뜻하며, 3분 이상 갱신이 없으면 `◐ 지연`으로 강등한다.
- ~~"수만~수십만 이벤트"~~ → **"동시 ~2만 마커 + 24시간 궤적 재생"**. 실측 동시 데이터는 항공기 ~1만 + 지진 수백 + 뉴스 수천. 십만 급은 궤적 히스토리 렌더로 달성하며, 주장 시 측정 환경·fps를 병기한다.

---

## 2. 프로젝트 목표

사용자가 지구본을 탐색하면서 다음 질문에 답할 수 있는 서비스를 만든다.

- 지금 세계에서 무슨 일이 일어나고 있는가?
- 특정 지역에서는 지금 어떤 사건들이 발생하고 있는가?
- 1시간 전과 지금은 무엇이 달라졌는가?
- 서로 다른 사건들이 같은 시간과 장소에서 어떤 관계를 가지는가?

**1인 사이드 프로젝트(주 10~15h)로 3~4개월 안에 "완성된 제품"으로 보이는 경계선까지 도달하는 것**을 1차 목표로 한다. 그 이후는 확장이지 완성 조건이 아니다.

---

## 3. 핵심 UX

```text
서비스 진입 → 3D Globe → 현재 세계 이벤트 표시
→ 특정 지역/이벤트 선택 → Event Detail → 관련 이벤트 확인
→ Timeline 이동 → 과거 세계 상태 재생
```

메인 화면:

```text
┌──────────────────────────────────────────────────────────────┐
│ LIVE WORLD PULSE                           ● LIVE / ◐ 지연   │
├───────────────┬──────────────────────────────┬───────────────┤
│ LAYERS        │                              │ EVENT LOG     │
│ ☑ Earthquake  │                              │ 18:32 M4.1 …  │
│ ☑ Weather     │          3D EARTH            │ 18:31 ✈ +214  │
│ ☑ Flights     │                              │ 18:30 ⚠ CAP … │
│ ☑ News        │                              │ (스크롤 리스트)│
├───────────────┴──────────────────────────────┴───────────────┤
│  17:00 ────── 17:30 ────── 18:00 ────── ● LIVE   ▶ PLAY     │
│  ▒▒▒░░░░░░░░░░░░░░░ (수집 갭 = 회색 밴드로 정직하게 표시)      │
└──────────────────────────────────────────────────────────────┘
```

- 레이어 항목마다 상태 배지: `idle | loading | ready | stale | error` ("Flights · 데이터 지연 2분"). 부분 실패가 정상 상태다 — 전체 화면 스피너 금지, 지구본 먼저 그리고 레이어 개별 채움.
- 모바일: 레이어 패널 → 바텀시트, 타임라인 → 하단 고정 슬라이더, 상세 → 전체화면 시트.

---

## 4. MVP 데이터 레이어 (소스 확정)

난이도 표기: 지진 1 ≪ 뉴스 4 < 날씨 5 < 항공기 7 (균등하지 않다).

### 4.1 Earthquake — 난이도 1

| 항목 | 내용 |
|---|---|
| 소스 | USGS GeoJSON feed (1분 갱신) + FDSN event query (과거 수십 년, 20,000건/쿼리) |
| 키/비용 | 불필요 / $0. CORS `*` — 유일하게 브라우저 직접 fetch 가능 |
| 과거 조회 | ✅ 완전 (백필 자유) |
| 주의 | **USGS는 규모를 사후 정정한다** (M6.8 → M7.1). `revision` 필드 필수 |

시각화: Marker Size = Magnitude, Marker Pulse = Recent Event (reduced-motion 시 정적 링).

### 4.2 Weather — 난이도 5 (3소스 합성)

단일 무료 소스는 존재하지 않는다. 역할 분담:

| 역할 | 소스 | 비고 |
|---|---|---|
| 수치 (기온·강수·풍속) | Open-Meteo | 무키, 10,000 call/day, past_days 92일 |
| 경보 (전 지구) | WMO Alert Hub CAP 레지스트리 + NWS(미국 상세) | NWS는 `User-Agent` 필수. CAP `Minor/Moderate/Severe/Extreme` 등급을 severity rank로 직결 |
| 태풍·재난 트랙 | **GDACS** (UN/EC, 다재해 GeoJSON) | ✅ 실측 확정 (2026-08-18): 무인증, 6개 엔드포인트 전부 200. TC 트랙 = getgeometry의 LineString (forecast:true/false 구분, 6h 간격 트랙포인트 + 불확실성 콘 + 풍역 폴리곤). 서태평양 태풍 커버 확인 (JEBI-18 일본 등). 에피소드 단위 시점 스냅샷 = Time Machine 요건 충족. Green/Orange/Red → severity rank 매핑 |

- **서태평양(일본) 태풍 경보 무료 API는 없다** (NHC는 대서양/동태평양만, JMA는 기계판독 API 부재). 태풍 데모는 GDACS 트랙 기반으로 구성한다 — 실측으로 성립 확인됨.
- GDACS 구현 주의 2건 (실측): SEARCH 기본이 Orange/Red만 반환 → `alertlevel=Green;Orange;Red` 명시 필요. 트랙포인트가 Point가 아닌 소형 Polygon → centroid 추출 필요. 응답 크기: 트랙 225~288KB, MAP 전종류 1.1MB → lazy fetch.
- 수치 오버레이(래스터)는 범위 축소: 경보 + 트랙 우선, 전 지구 래스터는 후순위.

### 4.3 Aviation — 난이도 7 (⚠ 결정 필요)

**전 지구 + 실시간 + 과거 + 공개 게시를 동시에 만족하는 무료 소스는 존재하지 않는다.**

| 소스 | 제약 (실측/ToS) |
|---|---|
| OpenSky | 등록 계정 4,000크레딧/day ÷ 4(전 지구) = **90초 주기 상한**. 과거 조회 인증해도 **-1시간까지만**. ToS: live product 통합은 서면 합의 필요 + 재배포 금지 + hyperscaler IP 차단 가능 |
| adsb.lol | 무키, ODbL(재배포 허용, 귀속 표기 의무), 히스토리 덤프 무료. 단 전역 엔드포인트 없음 — 250nm 타일 기반 |
| adsb.fi / airplanes.live | 실측 HTTP 403 (Cloudflare 차단) — 사용 불가 |

**채택: adsb.lol 지역 한정 방식 — ✅ 실측 확정 (2026-08-18).**

- API: `/v2/point/{lat}/{lon}/{radius}` (radius 최대 250nm), ADSBExchange v2 호환, 무인증. 필드 충분 (hex/lat/lon/alt_baro/gs/track/flight/category).
- **순환 스윕 확정: 6개 지역** — 서울·도쿄·런던·프랑크푸르트·뉴욕·LA. 지역당 90s 주기, 콜 간 5s 간격 순차 (사이클 40~80s). 대역폭 사이클당 gzip ~300~400KB.
- rate limit: 429 없음, 대신 **소프트 스로틀** (연속 호출 시 1.3s → 10s+ 지연 급증). 버스트 금지, 지연 급증 시 사이클 스킵.
- **동아시아 커버리지 공백 실재** (유럽 대비 ~1/8, 피더 밀도 문제. 해양은 구조적으로 0) — UI에서 지역별 커버리지 차이를 정직하게 표기할 것.
- 히스토리 덤프: 연도별 repo에 수년 보존, 일일 GitHub Release ~3.9GB tar (항공기당 gzip trace JSON). **조건부 백필용** — 지역별 추출 불가라 전 지구 백필엔 과체중. 실시간 API 저장분이 주 소스, 덤프는 갭 메우기·과거 이벤트 온디맨드.
- ODbL 귀속 문구 (UI 크레딧 + 문서 라이선스 페이지): "Flight data from ADSB.lol, made available under the Open Database License (ODbL) v1.0". 파생 DB(WARM 집계) 공개 시 share-alike 유의.
- OpenSky는 서면 합의를 받으면 승격 옵션 (유지).

표현 정보: 위치 / 방향 / 고도 / 속도. **"delayed / diverted" 문구는 MVP에서 금지** — 우회는 근접이 아니라 기준선 대비 편차라 룰로 도출 불가. 대신 계산 가능한 지표 사용: `traffic density -38% vs 24h baseline`.

### 4.4 News — 난이도 4

- **GDELT 15분 raw 파일 (events/GKG, ActionGeo_Lat/Long) 파이프라인.** DOC 2.0 API 응답에는 좌표가 없고(실측), GEO 2.0 API는 현재 404(실측)이므로 raw 파일이 유일한 좌표 경로다. 직접 NER은 불필요.
- DOC API는 보조(검색·기사 목록)로만. rate limit 실측 IP당 ~5초 1회.
- NewsAPI는 배제 (100 req/day + 24h 지연 + production 사용 금지).
- MVP 표현: **도시/지역별 뉴스 카운트 집계** (`Tokyo · 14 News Events`). 기사 단위 마커는 후순위.

### 4.5 Phase 3+ 확장 레이어 후보 (전부 실측 200 확인)

GDACS(다재해) / NASA EONET(산불·화산·폭풍) / NASA FIRMS(위성 산불, 무료 키) / NOAA tsunami.gov CAP / OpenAQ(대기질) / AISstream.io(선박). Blitzortung(번개)은 상업 이용 금지 → 비채택.

---

## 5. 데이터 모델 (v1 § 16 전면 교체)

단일 `WorldEvent`는 4레이어 중 3개를 못 담는다. 시간 의미론 3분기 + GeoJSON geometry + bitemporal로 확정한다.

```ts
type Iso = string;                       // ISO-8601, 항상 UTC
type LayerId = 'earthquake' | 'weather' | 'flight' | 'news';

/** GeoJSON 좌표는 [lon, lat]. 라벨드 튜플로 순서 실수를 컴파일 타임에 잡는다. */
type Position = [lon: number, lat: number, alt?: number];
type Geometry =
  | { type: 'Point';        coordinates: Position }
  | { type: 'LineString';   coordinates: Position[] }     // 태풍 트랙, 항적
  | { type: 'Polygon';      coordinates: Position[][] }   // 경보 구역
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

/** 레이어 간 '물리량 비교'가 아니라 '시각 인코딩 순위'. CAP 등급 차용. */
type SeverityRank = 0 | 1 | 2 | 3 | 4;   // unknown|minor|moderate|severe|extreme
interface Severity {
  rank: SeverityRank;
  raw?: number;                          // 원본값 보존 (M7.1의 7.1)
  unit?: 'Mww' | 'mps' | 'hPa' | 'count';
  label?: string;                        // 'M7.1', 'Typhoon Warning', '42 reports'
}

/** 공통: 출처 / 멱등키 / 양시간 / 지오메트리 */
interface RecordBase {
  id: string;                            // `${source}:${sourceId}`
  source: 'usgs' | 'nws' | 'wmo' | 'gdacs' | 'adsblol' | 'gdelt';
  sourceId: string;                      // 원본 고유 ID → UPSERT 멱등 키
  layer: LayerId;
  revision: number;                      // 원본 정정 시 증가 (USGS 규모 정정)
  observedAt: Iso;                       // 원본이 관측/발표한 시각
  ingestedAt: Iso;                       // 우리가 알게 된 시각 (bitemporal replay)
  geometry: Geometry;
  centroid: [lon: number, lat: number];  // 렌더/클러스터링 캐시
  h3r3: string;                          // H3 res-3 셀 — LOD 집계 조인 키
  severity: Severity;
}

/** (1) Occurrence — 한 시점에 발생하고 끝난 사건. 지진, 뉴스. */
interface Occurrence<P> extends RecordBase {
  kind: 'occurrence';
  occurredAt: Iso;
  payload: P;
}

/** (2) Interval — 지속 구간을 갖는 상태. 기상 경보. */
interface Interval<P> extends RecordBase {
  kind: 'interval';
  validFrom: Iso;
  validTo: Iso | null;                   // null = 미해제
  status: 'active' | 'updated' | 'cancelled' | 'expired';
  payload: P;
}

/** (3) Observation — 연속 존재 개체의 시각 t 표본. 항공기, 태풍 중심.
 *  ID 계약 (반복 표본이라 공통 규칙과 다름): sourceId = `${entityId}:${bucketTs}`
 *  (bucketTs = floor(epochSeconds / 90) × 90 — 폴링 밀림 중복 방지 버킷).
 *  따라서 id = `adsblol:7c2ba6:1755540000` 꼴. DB UNIQUE(entity_id, bucket_ts). */
interface Observation<P> extends RecordBase {
  kind: 'observation';
  entityId: string;                      // icao24 / 태풍 국제번호
  sampledAt: Iso;
  payload: P;
}

/** Track은 저장 타입이 아니라 Observation[]을 entityId로 접은 파생 뷰. */

export type WorldRecord =
  | Occurrence<EarthquakePayload>
  | Occurrence<NewsPayload>
  | Interval<WeatherAlertPayload>
  | Observation<FlightStatePayload>;
```

레이어별 payload는 discriminated union으로 타입 안전하게 정의한다 (`metadata: Record<string, unknown>` 백 금지).

### 시각 t의 "세계 상태" 질의 계약

단일 timestamp 필터로는 만들 수 없다. kind별 규칙:

| kind | `currentTime = T`의 해석 |
|---|---|
| occurrence | `[T - window, T]` 발생분 (window는 레이어별: 지진 1h, 뉴스 30min 등) |
| interval | `validFrom ≤ T < validTo` 겹침 판정 |
| observation | `entityId`별 T 이전 최근 1건 (`DISTINCT ON`), tolerance 초과 시 stale 플래그 |

옵션 `asKnownAt` (`ingestedAt ≤ t`)으로 "그때 우리가 알던 세계" vs "실제로 일어난 세계"를 구분할 수 있다.

**bitemporal 지원 범위 (계약 — 과대 약속 금지):** DB는 UPSERT로 **최신 상태 + revision 카운터만** 보존한다. 따라서 `asKnownAt`이 DB에서 보장하는 것은 "그 시각까지 수집된 레코드 존재 여부"(`ingestedAt` 필터)까지이며, **정정 전 옛 값 복원은 불가**하다 (예: M6.8→M7.1 정정 후 DB엔 7.1만 남음). 정정 전 값까지 포함한 완전 재생이 필요하면 R2 raw 원본(불변 적재)을 재파싱하는 오프라인 경로를 쓴다 — 그래서 R2 원본 보존이 필수다. revision 이력 테이블(append-only)은 Phase 2에서 필요가 실증되면 추가한다. **ingestedAt은 최초 인지 시각으로 고정** — UPSERT 갱신 시 덮어쓰지 않는다(ON CONFLICT 절에서 제외). 정정 도착은 revision 증가로만 표현한다. 이 규칙이 있어야 asKnownAt의 '존재 여부' 보장이 성립한다.

---

## 6. Timeline 시스템

전역 `currentTime`은 하나(UTC epoch ms)지만, **각 레이어가 T를 해석하는 방식은 위 kind 규칙으로 선언한다.** 레이어 정의에 `temporalMode: 'instant' | 'interval' | 'sampled'` + `window`를 명시하고 시간 슬라이스 함수를 레이어별로 분리한다.

범위는 Phase로 나눈다:

- **Phase 1 Timeline**: LIVE + 세션 내 버퍼 (브라우저 메모리 링버퍼, 최근 30~60분) + UI 골격
- **Phase 2 Timeline**: 서버 히스토리 기반 -24h Seek / Playback / Replay
- 지진은 예외적으로 Phase 1부터 과거 임의 시점 조회 가능 (USGS API 위임 — 자체 저장 불필요)

레이어별 네이티브 해상도(항공기 90s, 뉴스 15min)를 UI에 노출한다 — 안 하면 "타임라인이 고장난 것처럼" 보인다. 수집 갭은 스크러버에 회색 밴드로 정직하게 표시한다 (조용히 비우면 "그 시각엔 항공기가 없었다"는 거짓 세계가 된다).

### Time Replay와 보간

**원칙: 위치가 연속인 것만 보간한다. 이산 이벤트를 보간하면 데이터 거짓말이 된다.**

- 항공기: 스냅샷 2개 사이 선형 보간 + heading 기반 dead reckoning. Worker에서 계산. 각도 ±180 wrap, 날짜변경선 wrap 처리 (실버그 다발 지점 — 단위 테스트 필수)
- 태풍 트랙: 시간 파라미터화 폴리라인 슬라이스
- 지진/뉴스: 보간 금지. 등장 애니메이션(펄스)으로 시간 흐름 표현
- deck.gl TripsLayer는 CPU 보간을 해주지 않는다(공식 문서 명시) — 입력 데이터 해상도가 곧 애니메이션 해상도이므로 보간 레이어는 직접 만든다

---

## 7. Event Detail / Event Correlation

### Event Detail (Phase 1)

단일 이벤트의 원본 속성 표시. 예: `M7.1 EARTHQUAKE / Magnitude 7.1 / Depth 28km / 2026-08-18 17:32 UTC`.

### Nearby / Related Events (Phase 1 — v1의 Phase 3에서 앞당김)

룰 기반 상관은 공간 인덱스가 있으면 수십 줄이다. "핵심 차별화 기능"을 뒤로 미룰 이유가 없다.

- 룰: `distance < 300km AND |Δt| < 60min` → 관련 후보
- **단 항공기는 예외** — 근접 룰이 무의미(일본 상공 300km에 상시 수백 대). 항공기 상관은 **기준선 대비 편차**로 표현: 셀 내 밀도의 시간 변화, 평균 고도/항로각 분산 증가
- embedding/AI 기반 클러스터링은 Phase 3+

---

## 8. 아키텍처

### 8.1 전체 구성

```text
External Sources (USGS/Open-Meteo/WMO/GDACS/adsb.lol/GDELT)
      │  (모든 외부 호출은 백엔드에서만 — 키 보호 + CORS + rate limit 공유)
      ▼
Collector (Fly.io 상주 프로세스, 소스별 setInterval)
      │  UPSERT (멱등 키) + 수집 원장(collector_runs) + healthchecks.io 핑
      ▼
┌─ HOT   [Phase 2+] Postgres+PostGIS: 항공기 48h 파티션, 지진/뉴스/경보 전량
├─ WARM  [Phase 2+] Postgres: H3 res-3 × 15min 집계 (서버 사전계산 LOD)
├─ COLD  Cloudflare R2 이중 경로: raw gzip JSON 불변 + norm Parquet (egress 무료)
└─ ※ Phase 0a~1: COLD + Postgres current-state만 (§9 Phase 0a '저장 결정' 우선)
      ▼
API (bbox 필터 + 시간 질의) ── Cache-Control: s-maxage=30 ── Cloudflare CDN
      ▼
Frontend (폴링: TanStack Query refetchInterval, 소스 주기 정렬)
      ▼
Web Worker (파싱 → 정규화 → 시간 슬라이스 → 보간 → binary attributes)
      │  postMessage(transferable ArrayBuffer — 복제 0코스트)
      ▼
deck.gl (GPU 렌더)
```

- **WebSocket 없음.** 초 단위 소스가 없으므로 순손실. "LIVE" 체감이 필요해지면 Phase 2+에서 SSE (단방향, CDN 친화, 브라우저 재연결 기본 제공). README에 이 판단 근거를 소스 주기로 논증한다 — 그게 시니어 신호다.
- **Redis 없음** (current state ≈ 1.5MB → Collector 프로세스 인메모리 Map). API 인스턴스 2개+ 시점에 재검토.
- **Timescale 없음** (Supabase PG17에서 제거, Neon은 핵심 기능 비활성). 네이티브 파티셔닝 + pg_partman + BRIN.

### 8.2 프론트 스택 (확정)

```text
Vite + React + TypeScript + React Router   ← Next.js 대신 (SPA에 정직)
maplibre-gl ~5.24.0                        ← v6 금지: deck.gl 통합 단절 (PR #10566)
deck.gl ^9.3.10 (@deck.gl/mapbox MapboxOverlay, overlaid 모드)
Zustand + TanStack Query
Web Worker (comlink 선택)
Tailwind CSS + CSS 토큰
```

- **maplibre v6 금지 사유를 package.json 주석/README에 명시.** v6가 `MapboxOverlay` 의존 `map.transform`을 제거했고 대체 `@deck.gl/maplibre`는 npm 미출시. 출시되면 그때 승급.
- **globe 위 금지 목록**: `interleaved: true` (#9592 깊이/컬링), `IconLayer` (#9554 아이콘 소실 — 항공기는 ScatterplotLayer 또는 커스텀 메시 인스턴싱), 런타임 globe↔mercator 수동 토글 (#9466), HeatmapLayer/ContourLayer/MaskExtension.
- globe는 z~12에서 mercator 자동 전환 (float32 정밀도) — UX로 수용.
- **베이스맵 타일: OpenFreeMap 공개 인스턴스 — ✅ 실측 확정 (2026-08-18).** 스타일 5종 전부 200, **`https://tiles.openfreemap.org/styles/dark` 실존** (bg rgb(12,12,12), 47 layers) — 다크 저작 시작점은 이 JSON 포크 + Maputnik 편집 후 리포 커밋. 정책: 뷰/요청 무제한·상업 허용·키 불요 (SLA 없음). Protomaps 탈락: planet pmtiles 137GB self-host 부담 + 호스팅 API는 상업=스폰서십. globe 주의: `sky` 스펙 금지 (mercator 전용, maplibre #5230) + 라벨 과대/차폐는 스파이크 체크리스트로.
- 옵션: NASA GIBS Black Marble (야간 지구 위성 래스터, CORS `*`, maxzoom 8) — 저줌 배경 하이브리드 가능. 채택 시 "브라우저 직접 fetch 예외" 규칙에 GIBS 추가 결정 필요.
- Next.js를 버리는 대신 잃는 것: 동적 OG 이미지. 필요해지면 별도 엣지 함수로 해결 (서버에서 정사방위 투영 SVG 썸네일 — WebGL 불필요).
- IndexedDB는 Phase 2로 연기 (용도: 리플레이 버퍼 캐시 + 콜드 스타트 즉시 페인트). MVP는 메모리 LRU + HTTP 캐시로 충분.

### 8.3 스레드 경계

| 스레드 | 책임 |
|---|---|
| Worker | payload 파싱 → 정규화 → 시간 인덱스 → 슬라이스 → 보간 → **binary attribute 생성** (`Float32Array` position 등) → transfer |
| Main | deck.gl props 갱신 (`data: {length, attributes}`), 카메라, 픽킹, React UI |
| Main 고정 | 픽킹 결과·툴팁·선택 상태 (마우스 지연 = 체감 품질) |
| 서버 | **클러스터링/LOD 집계** (WARM 테이블) — 클라 Worker에서 매 뷰포트마다 클러스터링 금지 |

성능 병목의 실체 (30k 점은 GPU에 아무것도 아님 — deck.gl은 ~1M@60fps):
1. **attribute 재생성** — `data` 참조 갱신마다 전체 버퍼 재계산. binary attributes 직접 공급으로 우회
2. **fragment 오버드로** — 줌아웃에서 마커 면적. 반경 클램프 + `useDevicePixels: 1.5`
3. **픽킹 패스** — hover 픽킹 스로틀 또는 클릭 전용

추가: 시야 반구 컬링 (지구 뒷면 데이터를 버퍼에 안 넣음 — dot product 한 줄로 절반 절약).

### 8.4 상태 관리

```text
전역 (Zustand): currentTime · selectedLayers · selectedEvent · playbackState
지도 인스턴스 소유 (전역 금지): viewport/카메라 — 팬마다 React 리렌더 방지.
                                전역엔 200~300ms 디바운스 사본만 발행
서버 데이터: TanStack Query (히스토리 조회·상세) / 링버퍼 (LIVE 스트림) — Query에 스트림 밀어넣기 금지.
             두 경로가 같은 정규화 함수로 같은 WorldRecord 형태에 수렴해야 LIVE↔과거 전환이 안 튄다
```

### 8.5 URL State

```text
/world?lat=35.6&lng=139.7&z=5&t=1755540000000&l=eq,wx,fl,nw&sel=usgs:abc123&play=1&rate=10
```

- `t` = **UTC epoch ms** 또는 센티넬 `live` (없으면 공유 링크가 과거로 고정됨)
- 갱신은 `replaceState` + 디바운스 (pushState 금지 — 뒤로가기 파괴)
- 짧은 키 규약 (`l=eq,wx,fl,nw`)
- 직렬화/역직렬화 **라운드트립 단위 테스트** 필수

### 8.6 저장 구조 (3계층 — **Phase 2+ 목표 구조**. Phase 0a~1 저장은 §9 Phase 0a '저장 결정'이 우선)

전량 Postgres 보존 시 12개월차 $110~242/월로 폭발한다 (90초 주기 = 57.6GB/월). 대신:

| 계층 | 내용 | 용량/비용 |
|---|---|---|
| HOT (Postgres) | 항공기 raw 48h만 (타임라인 -24h + 여유). pg_partman 파티션 + DROP (DELETE 금지). 지진/뉴스/경보 전량 | 3.84GB — Supabase Pro $25 정액 안 고정 |
| WARM (Postgres) | H3 res-3 × 15min 버킷 집계 (카운트·평균고도·속도) = 서버 사전계산 LOD | ~1.15GB/월 |
| COLD (R2, 이중 경로) | ① raw 원본 gzip JSON 불변 (`raw/{source}/dt=/hour=`) ② 정규화 Parquet 시간당 compaction (`norm/{layer}/dt=/hour=`). **원본 raw 보존 필수** — 항공기는 재수집 불가라 스키마 변경 시 재파싱이 유일한 복구 경로 | 유입 0a 실측 기준: raw gzip ~10GB/월 + norm Parquet ~1.2GB/월. **불변 보존이라 누적됨** — 12개월 말 ~134GB. 비용(무료 10GB-월 공제, $0.015/GB-월 누적 과금): 1년차 합계 ~$11, 12개월차 시점 ~$1.9/월. 보존 정책: raw는 무기한(재파싱 보험 — 이 비용은 수용), 재검토 트리거 = 월 저장료 $5 초과 시 |

- Geo 인덱스: **PostGIS `geography` + GiST 채택** (반경 300km 측지 정확). H3는 집계 GROUP BY 키로 병행 (역할 분담). Geohash 탈락 (극지 왜곡 + 접두사 경계).
- 시간 인덱스: BRIN (append-only 최적, 인덱스 오버헤드 거의 0).
- **egress 예산**: bbox 필터 필수 + 바이너리 응답(Float32Array) + CDN `s-maxage=30`. JSON 전량 응답이면 월 방문자 1,250명에 무료 egress 소진.

### 8.7 Collector 신뢰성 (이 제품의 코어)

**이 제품은 과거를 파는 제품이다. Collector 다운 = 그 시간대 영구 손실 (항공기는 소급 불가).**

- 멱등 UPSERT: 지진 `(source, sourceId)` / 뉴스 `(source, sha256(url))` / 경보 `(source, sourceId, sent)` / 항공기 current(0a)=`PK(entity_id)`·history(Phase 2)=`UNIQUE(entity_id, bucket_ts)` — bucket_ts = floor(epochSeconds/90)×90, 폴링 밀림 중복 방지
- 수집 원장 `collector_runs (source, window, status, count, error)` — 재기동 시 갭 스캔, 소급 가능 소스는 백필, 불가면 `gap` 레코드로 명시
- **갭을 UI에 노출** (타임라인 회색 밴드)
- 데드맨 스위치: healthchecks.io 핑 (무료, 3줄) — 3주기 미수신 시 알림
- 재시도: 지수 백오프 + 지터, 최대 3회. **429는 재시도 금지** (크레딧 소진 의미 — 다음 슬롯 대기)
- 실행: Fly.io 상주 프로세스 ($2.02/월). Vercel Cron(1일 1회 제한)·GitHub Actions cron(지연 10~30분 + 60일 자동 비활성) 탈락

---

## 9. 개발 단계 (v2 전면 재편)

### Phase -1 — 엔진 스파이크 (1.5일) ★신설

문서만으로 결정 불가 — 쓰려는 레이어(회전 마커·경로·텍스트)가 열린 globe 버그와 1:1로 겹친다. **통과 없이 Phase 0 진입 금지.**

후보 3개, 같은 페이로드 (Scatterplot 30k점 / 항공기 2k 회전 / 경로 200 / 라벨 50):

- A. maplibre 5.24 globe + deck.gl overlaid ← 예상 승자
- B. 동일 + interleaved ← 버그 재현 확인용
- C. deck.gl 단독 `_GlobeView` ← 폴백

합격 기준 (숫자):
1. 팬·줌 중 FPS ≥ 50 (M-series), 저사양 ≥ 30
2. 30초 인터랙션 후 사라지는 마커 0 (#9554 검사)
3. 픽킹 오차 ≤ 5px — 지구 림 근처 + 날짜변경선 걸침 포함
4. 텍스트 반전 없음, 레이어가 지구 뒤로 안 사라짐 (#9592 검사)
5. z0↔z14 왕복 시 mercator 전환 무결
6. data 교체(5초 틱) 시 프레임 드롭 ≤ 1

폴백 래더: A 실패 → C → 그래도 실패 → mercator 3D(pitch)로 컨셉 수정 (Cesium은 번들 141MB라 최후 수단).

동시 산출물: 베이스맵 타일 소스 확정 ✅ + GDACS/adsb.lol 스펙 검증 ✅ + **디자인 방향 1페이지 — ⚠ 미산출 (Phase 0 진입 전 필수로 이월)** (다크 계기판/관제실 무드, 모노스페이스 수치, 시맨틱 컬러 — 지진=주황, 경보=적. 라이트 모드 없음을 명시적 결정으로 문서화).

### Phase 0a — Collector First (반나절) ★신설

**지구본 코드 한 줄 쓰기 전에 배포한다. 이 시점부터 히스토리 시계가 돈다.**

- 항공기 90s 스냅샷(6지역 스윕) + 지진 60s 수집
- **0a 저장 결정: R2 중심, Postgres 최소.** 6지역 실측 기준 사이클당 ~2,500~3,000행 × 960사이클/day × 200B ≈ **일 520MB** — Supabase Free(500MB)는 retention 24h로도 초과. 따라서:
  - **R2 (필수·전량)**: ① raw 원본 gzip JSON 불변 적재 (`raw/{source}/dt=/hour=`) ② 정규화 Parquet 시간당 compaction (`norm/{layer}/dt=/hour=`) — 두 경로 분리, 멱등 파일명(윈도 기준)
  - **Postgres (Free)**: 최신 스냅샷(current state)만 — 히스토리 테이블 없음. HOT 48h 테이블은 Phase 2 진입 시 Pro 전환과 함께 생성하고 R2에서 백필
- 0a 최소 스키마 계약: `flight_obs_current(entity_id PK, bucket_ts, lon, lat, alt_baro, gs, track, ...)` — bucket = 90s floor. Phase 2 히스토리 테이블은 `UNIQUE(entity_id, bucket_ts)` (§5 Observation ID 계약과 일치)
- UI 없음. healthchecks.io 핑만. ~150줄
- Phase 2 도달 시점에 R2에 수 주치 히스토리가 자동으로 존재

### Phase 0b — 데이터 모델 확정 (0.5일) ★신설

§5 타입 + 레이어별 temporalMode 선언 + URL 직렬화 규약. 레이어 만들기 전에 잠근다 (뒤에 하면 전면 리팩터).

### Phase 0 — Globe Prototype (4~5주)

구현: Globe + 지진 + 항공기 + Layer Toggle + Event Click.

Globe Experience 타임박스: 다크 스타일 + 대기광 + 60fps 관성 회전 + 국경/라벨 + z0~z14 무결 — **여기까지 3일, 초과 시 중단** ("지구본 예쁘게"는 무한 싱크홀).

완료 조건 (검증 가능):
- [ ] 엔진 확정 (선택 근거 1페이지)
- [ ] 실 API 지진 전건 + 항공기 5,000대+ 동시 렌더, 팬/줌 중 30fps+
- [ ] 항공기 90초 주기 갱신 확인
- [ ] 마커 클릭 → 원시 속성 표시
- [ ] **공개 URL 배포** (첫 주부터 배포가 습관 — "완성 후 배포"는 사이드 프로젝트의 무덤)

### Phase 1 — MVP (8~10주)

- 레이어: + Weather(경보+GDACS 트랙) + News(GDELT 도시별 카운트)
- Timeline: LIVE + 세션 버퍼 + **지진 한정 과거 조회** (USGS 위임)
- Event Detail + **룰 기반 Related Events** (v1 Phase 3에서 앞당김)
- **이벤트 로그 패널** (DOM 리스트 = 접근성 대체 뷰 + SEO)
- URL State + 레이어별 상태 배지
- **수직 슬라이스: "-10분 1스텝" 타임라인 이동 1개를 파이프라인 전체(저장→조회→슬라이스→보간→렌더) 관통으로 구현** — Phase 2 리스크를 앞으로 당김

완료 조건:
- [ ] 4레이어 라이브 + 각 레이어 상태 배지 동작
- [ ] 지진 과거 임의 시점 조회 + 등장 애니메이션
- [ ] URL 하나로 전체 상태 복원 (라운드트립 테스트 통과)
- [ ] 이벤트 로그 패널 키보드 순회 가능
- [ ] 어댑터·시간슬라이스·보간·URL 단위 테스트 + E2E 1본 (모킹 fixture)
- [ ] 모바일(375px)에서 열람 가능 (바텀시트 + 포인트 상한)
- [ ] 배포 URL 갱신

### Phase 2 — Time Machine (8~10주)

Phase 0a 덕에 히스토리가 이미 쌓여 있다 — "쌓기"가 아니라 "읽기"만 구현한다.

- 2a: -1h Seek (외부 API + 자체 48h HOT)
- 2b: -24h Seek + Playback + Replay (수집 24h 경과 후 자동 개방)
- 항공기 보간 재생, 갭 밴드 표시, IndexedDB 리플레이 캐시
- **케이스 스터디 퍼머링크 3건** — 실제 M7급 지진 등 `?t=...` 링크 + README GIF. 라이브 사건을 기다리지 않고 차별점(시간축+상관)을 30초 안에 증명하는 보험

완료 조건:
- [ ] -24h 임의 시점 복원 + ▶ Play 재생 (항공기 텔레포트 없음)
- [ ] 수집 갭이 스크러버에 표시됨
- [ ] 케이스 스터디 링크 3건 README 게시
- [ ] 90초 데모 영상

**═══ 여기가 "멈춰도 완성" 경계선 (누적 3~4개월) ═══**

### Phase 3+ — 선택 확장 (완성 후)

- Geo/Temporal 클러스터링 고도화, embedding 기반 상관
- 추가 레이어: GDACS 다재해 / EONET 산불·화산 / 쓰나미 CAP (v1 Phase 4의 Ship/Lightning/Traffic/Satellite는 삭제)
- AI: **"선택한 클러스터 1개 → LLM 3문장 요약" 단일 기능만** (v1 Phase 5의 World Briefing/Event Detection 삭제 — 구현 반나절에 데모 효과 큰 것만 남김)
- SSE 전환, 동적 OG 이미지

---

## 10. 품질 기준 (v2 신설)

### 성능 예산

| 항목 | 목표 |
|---|---|
| 인터랙션 FPS | ≥ 50 데스크톱 / ≥ 30 모바일 |
| LCP | < 2.5s — 첫 페인트는 정적 지구 이미지/스켈레톤 (WebGL 초기화 대기 금지) |
| INP | < 200ms (토글·스크럽) |
| 앱 JS (라이브러리 제외) | ≤ 200KB gz |
| 랜딩/앱 분리 | 지도 번들은 `/world`에서만 로드. 랜딩(`/`)은 정적 이미지 + CTA (< 150KB gz) |
| CLS | < 0.1 |

dev 오버레이 (FPS·객체 수·attribute 생성 시간·워커 큐)를 30분 투자로 초기 구축 — 없으면 성능 회귀를 인지 못 한다.

### 테스트 전략

- **Vitest 단위 (최고 가치)**: 어댑터/정규화, 시간 슬라이스(kind별), **보간(날짜변경선·극지·heading wrap 경계)**, 상관 룰, URL 라운드트립
- **Playwright E2E**: 로드 → 캔버스 → 토글 → 타임라인 → URL 복원. **모킹 fixture로 결정론 확보** (실 API 물리면 100% flaky)
- **WebGL 스크린샷 회귀 금지** (GPU별 픽셀 차이). 대신: DOM 로그 패널 스냅샷 + `pickObjectsInRect` 단정 + 프레임 시간 임계 게이트

### 접근성

- **이벤트 로그 패널 = 동일 데이터의 1급 DOM 뷰** (WebGL 캔버스는 스크린리더에 완전 불투명)
- 키보드: 레이어 토글(실제 checkbox), 타임라인(`<input type="range">`), 로그 순회, 상세 패널 포커스 트랩 + Esc
- 캔버스 `role="img"` + 동적 `aria-label`, 새 이벤트 `aria-live="polite"` (스로틀)
- `prefers-reduced-motion`: 펄스 정지, 자동 회전 off, 재생은 명시적 시작만
- 색상만으로 레이어 구분 금지 (모양/크기 병용), 다크 배경 대비 AA

### 복원력

- WS/폴링: 지수 백오프 + 지터, `visibilityState` hidden 시 폴링 정지
- WebGL 컨텍스트 손실 처리 (`webglcontextlost/restored`) — 장시간 켜두는 앱의 실제 장애
- WebGL2 미지원 폴백 안내 화면 (빈 화면 금지)
- **시드 데이터 폴백 / 데모 모드**: 소스 전멸 시 정적 스냅샷 JSON으로 지구본 유지. 면접 시연 중 API가 죽는 시나리오는 반드시 온다

### 운영

- UTC 강제 (DB timestamptz, 연산 epoch ms, 표시만 로컬)
- 시크릿: fly secrets / env — 공개 저장소이므로 .env 커밋 금지
- 자체 API rate limit (IP 토큰 버킷 — 없으면 남의 스크래퍼가 내 egress를 태운다)
- 비용 알람 (Supabase/Fly 사용량 알림 기본 비활성 — 직접 켤 것)
- 좌표 검증: `lat=0,lon=0`(널섬)·NaN 드롭 + 카운터
- **Attribution (법적 의무)**: 지도 타일 + adsb.lol ODbL 귀속 + USGS/GDELT/GDACS 출처 — UI 푸터 + README

### 예상 비용

```text
Phase 0a~1:  Fly.io $2 + Supabase Free + R2(누적 과금: 첫 달 $0 → 12개월차 ~$1.9/월) + Pages Free ≈ $2~4/월
Phase 2:     Supabase Pro $25 + Fly $2~5 + R2 누적(12개월차 ~$2/월) ≈ $27~32/월 (48h HOT 정책으로 Postgres는 정액 고정, R2만 완만 증가)
```

---

## 11. 포트폴리오 전략

### 핵심 주장 (재배열 — 달성 기준 병기)

| 주장 | 달성 기준 |
|---|---|
| 1. **이종 API → 단일 시공간 모델 정규화** | 소스 4종+ → WorldRecord 3분기 + 어댑터 단위 테스트. 가장 방어 가능 |
| 2. **시간축 복원과 보간** | -24h 임의 시점 복원 + 보간 재생 + 갭 정직 표시 + bitemporal(asKnownAt) |
| 3. **Worker↔GPU binary attribute 파이프라인** | before/after 메인 스레드 프로파일 1장 |
| 4. Massive Rendering | 실측 벤치 공개: 5만+ 포인트 60fps (환경 명시). 근거 없는 "수십만" 주장 금지 |
| 5. Rate-limit-aware ingestion & gap-honest history | 크레딧 예산 계산 + 멱등 수집 + 갭 원장 — "Realtime Architecture" 대체 문구 |

### README

- 헤드라인: **"Explore what's happening on Earth — across space and time."**
- "DevTools for Earth"는 Phase 2(시간 이동) 완성 후 사용. Phase 1에서 멈추면 "Live Map of Earth"로 정직하게
- 상단: 케이스 스터디 GIF (재생 → 지진 → 여진 확산 → 뉴스 증가, 30초)
- 아키텍처 다이어그램 + "왜 WebSocket을 안 썼는가" 논증 + 소스별 ToS/크레딧 표
- 데모 영상 90초 — 문서화는 남는 시간이 아니라 Phase 산출물

### 데모 시나리오 (v1 § 35 수정)

1. 접속 → 라이브 지구 (폴리시 몰빵 지점)
2. 일본 확대 → 지진/항공기/뉴스 카운트 확인
3. ~~태풍 선택 → 관련 항공편~~ → **GDACS 재난 트랙 선택 → 반경 내 관련 이벤트 + 항공 밀도 변화**
4. Timeline -2h → 세계 상태 복원
5. ▶ Play → 변화 재생 (항공기 보간)
6. 케이스 스터디 퍼머링크 → 서로 다른 소스가 한 사건으로 연결

---

## 12. 리스크 대장

| 리스크 | 확률 | 대응 |
|---|---|---|
| ~~globe 렌더 버그로 엔진 변경~~ | 해소 | ✅ Phase -1 완료 (2026-08-18) — A(maplibre 5.24 + overlaid) 확정 (기준 1·2·3·6 통과 + 기준 5 스냅샷 기준 통과, 기준 4는 5/6 O + 미확정 1 — 규칙 1 준용). 미확정·미시험 3건은 Phase 0 이관 (RESULT §이관 7~9). docs/spike/RESULT.md |
| ~~adsb.lol 커버리지/덤프 부실~~ | 해소 | ✅ 실측 완료 — 채택 유효. 단 동아시아 커버 유럽의 1/8 (UI 정직 표기로 대응) |
| ~~GDACS 스펙이 기대와 다름~~ | 해소 | ✅ 실측 완료 — 채택 유효, 태풍 데모 성립 |
| Collector 장애로 히스토리 구멍 | 상 | 데드맨 스위치 + 갭 원장 + UI 정직 표시 (구멍 자체를 기능으로) |
| 스코프 크리프 | 상 | Phase별 완료 조건 체크리스트 + Globe 3일 타임박스 + "경계선" 명문화 |
| 데모 중 API 다운 | 상 | 시드 스냅샷 + 데모 모드 + 케이스 스터디 퍼머링크 |
| maplibre v6/deck.gl 생태 변동 | 저 | ~5.24 핀 + 사유 주석. @deck.gl/maplibre 출시 모니터링 |

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

- ~~"Realtime"~~ → **"Live Data Integration"**. 소스 최선 해상도가 항공기 지역당 3분 / 지진 60초 / 뉴스 15분이므로 초 단위 실시간을 주장하지 않는다. `● LIVE` 표시는 "최신 가용 스냅샷"을 뜻하며, 6분(항공기 2주기) 이상 갱신이 없으면 `◐ 지연`으로 강등한다.
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
- **순환 스윕 확정: 6개 지역** — 서울·도쿄·런던·프랑크푸르트·뉴욕·LA. **지역당 3분 주기** (Workers 1분 cron × 분당 2지역 — §8.7 스케줄 계약. 90s보다 완화라 스로틀에 더 안전). 대역폭 사이클당 gzip ~300~400KB.
- rate limit (⚠ 실행 위치별로 다름 — 2026-08-19 배포 실측): 로컬 IP는 소프트 스로틀뿐이나 **Cloudflare Workers 공유 IP는 강한 per-IP 스로틀** — 첫 시도 성공률 ~14%, 429 후 10s 재시도로 40% 회수. 대체 소스는 Workers에서 전멸 (adsb.fi·airplanes.live 403, OpenSky 522 — 각 0/5). **결정 (사용자 승인 2026-08-19): 수용 + 429 10s 재시도 1회** — 실효 수집률 ~30-50%, 갭은 타임라인에 정직 표시. adsb.lol 429는 크레딧 소진이 아니라 스로틀이므로 429 재시도 금지 룰의 명시적 예외.
- **동아시아 커버리지 공백 실재** (유럽 대비 ~1/8, 피더 밀도 문제. 해양은 구조적으로 0) — UI에서 지역별 커버리지 차이를 정직하게 표기할 것.
- 히스토리 덤프: 연도별 repo에 수년 보존, 일일 GitHub Release ~3.9GB tar (항공기당 gzip trace JSON). **조건부 백필용** — 지역별 추출 불가라 전 지구 백필엔 과체중. 실시간 API 저장분이 주 소스, 덤프는 갭 메우기·과거 이벤트 온디맨드.
- ODbL 귀속 문구 (UI 크레딧 + 문서 라이선스 페이지): "Flight data from ADSB.lol, made available under the Open Database License (ODbL) v1.0". 파생 데이터셋(agg 집계) 공개 시 share-alike 유의.
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

단일 `WorldEvent`는 4레이어 중 3개를 못 담는다. 시간 의미론 3분기 + GeoJSON geometry로 확정한다.

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
  sourceId: string;                      // 원본 고유 ID → 멱등 키 (파일 내 레코드 병합 기준)
  layer: LayerId;
  revision: number;                      // 원본 정정 시 증가 (USGS 규모 정정)
  observedAt: Iso;                       // 원본이 관측/발표한 시각
  ingestedAt: Iso;                       // 우리가 알게 된 시각 (수집 지연 관찰용)
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
 *  (bucketTs = floor(epochSeconds / 180) × 180 — 수집 주기(지역당 3분)와 정렬된 중복 방지 버킷).
 *  따라서 id = `adsblol:7c2ba6:1755540000` 꼴 — 파일 내 레코드 유일 키. */
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
| observation | T 직전 버킷 파일에서 `entityId`별 최신 1건, tolerance 초과 시 stale 플래그 |

**시간 재생 모드 계약 ($0 결정에 따른 단순화 — 과대 약속 금지):** Time Machine은 **"실제로 일어난 세계" 단일 모드**다. norm 슬라이스는 원본 정정(USGS 규모 등) 도착 시 **revision을 올린 새 versioned key로 재발행**하고 manifest 포인터를 갱신한다 (§8.7 — immutable 캐시와 양립). 정정 전 옛 값은 롤링 이후 소실된다. 따라서 "그때 우리가 알던 세계"(asKnownAt/bitemporal replay)는 **지원하지 않고 주장하지도 않는다** — DB 없는 $0 아키텍처의 수용된 대가. `ingestedAt`은 수집 지연 관찰·갭 판정용으로만 쓴다. §8.7의 "같은 윈도 재실행 = 내용 동일"은 정정 미포함 기준이며, 정정 재작성은 revision 증가로 구분한다.

---

## 6. Timeline 시스템

전역 `currentTime`은 하나(UTC epoch ms)지만, **각 레이어가 T를 해석하는 방식은 위 kind 규칙으로 선언한다.** 레이어 정의에 `temporalMode: 'instant' | 'interval' | 'sampled'` + `window`를 명시하고 시간 슬라이스 함수를 레이어별로 분리한다.

범위는 Phase로 나눈다:

- **Phase 1 Timeline**: LIVE + 세션 내 버퍼 (브라우저 메모리 링버퍼, 최근 30~60분) + UI 골격
- **Phase 2 Timeline**: 서버 히스토리 기반 -24h Seek / Playback / Replay
- 지진은 예외적으로 Phase 1부터 과거 임의 시점 조회 가능 (USGS API 위임 — 자체 저장 불필요)

레이어별 네이티브 해상도(항공기 지역당 3분, 뉴스 15min)를 UI에 노출한다 — 안 하면 "타임라인이 고장난 것처럼" 보인다. 수집 갭은 스크러버에 회색 밴드로 정직하게 표시한다 (조용히 비우면 "그 시각엔 항공기가 없었다"는 거짓 세계가 된다).

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
Collector (Cloudflare Workers Cron — 1분 주기 디스패처, 소스별 슬롯)
      │  멱등 파일 적재 + 매니페스트(수집 원장) + healthchecks.io 핑
      ▼
Cloudflare R2 (단일 저장소 — DB 없음. $0 결정, 2026-08-19)
├─ raw/    원본 gzip JSON — 7일 롤링 (lifecycle rule)
├─ norm/   정규화 15분 버킷 슬라이스 (versioned key) — 90일 롤링 (lifecycle rule)
├─ pin/    퍼머링크 스냅샷 (manifest + 슬라이스 복사) — 영구
├─ agg/    H3 res-3 × 15min 집계 파일 (LOD — 수집 시 사전계산)
├─ latest.json 전 레이어 통합 최신 스냅샷 (Collector가 read-modify-write 재조립, 1req/폴)
└─ manifest/ 수집 원장 (윈도별 성공/실패/갭)
      ▼
Worker 프록시 (workers.dev 무료 서브도메인 — r2.dev 직접 노출 금지: 비프로덕션·rate limit)
      │  norm/agg: ?g= pinned(versioned URL)만 immutable, unpinned = no-cache+ETag(g) / latest = no-cache+ETag / CORS 화이트리스트
      ▼
Frontend fetch — LIVE = latest 폴링 (소스 주기 정렬), 과거 = norm 버킷 파일
      ▼
Web Worker (파싱 → 정규화 → 시간 슬라이스 → 보간 → binary attributes)
      │  postMessage(transferable ArrayBuffer — 복제 0코스트)
      ▼
deck.gl (GPU 렌더)
```

- **WebSocket 없음.** 초 단위 소스가 없으므로 순손실. "LIVE" 체감이 필요해지면 Phase 2+에서 SSE (단방향, CDN 친화, 브라우저 재연결 기본 제공). README에 이 판단 근거를 소스 주기로 논증한다 — 그게 시니어 신호다.
- **Redis 없음** — current state는 R2 `latest.json` 통합 단일 파일. 서버 상주 상태 자체가 없다.
- **Postgres 자체 없음** ($0 결정 — §8.6). Timescale·Redis 논의는 그보다 앞서 소멸. 데이터 질의는 R2 버킷 파일 + 클라이언트 계산.

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
| 수집기 | **클러스터링/LOD 집계** (R2 `agg/` 파일, 수집 시 사전계산) — 클라 Worker에서 매 뷰포트마다 클러스터링 금지 |

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

### 8.6 저장 구조 (R2 단일 — $0 제약 확정, 2026-08-19)

> **결정: 유료 인프라 불사용.** Fly.io($3~5/월)·Supabase Pro($25/월) 배제. Postgres/PostGIS 자체를 도입하지 않는다.
> Time Machine은 DB 쿼리가 아니라 **R2의 시간 버킷 파일을 Worker 프록시 경유로 fetch**하는 방식으로 구현한다 (egress 무료 + 프록시 캐시라 성립).

| 경로 | 내용 | 보존 정책 | 용량 (0a 실측 유입 기준) |
|---|---|---|---|
| `raw/{source}/dt=/hour=` | 원본 gzip JSON 불변 | **7일 롤링 삭제** — 스키마 변경 시 최근 7일만 재파싱 가능 ($0의 대가로 수용) | ~0.35GB/day → 상주 ~2.4GB |
| `norm/{layer}/dt=/slot=` | 정규화 15분 버킷 슬라이스 (gzip JSON) | **90일 롤링 삭제** (R2 lifecycle rule로 자동화 — 수동 삭제 의존 금지) | ~1.2GB/월 유입 → 상주 상한 3.6GB 고정 |
| `agg/h3r3/dt=/slot=` | H3 res-3 × 15min 집계 (LOD) — norm과 동일한 `g{generation}` versioned key (§8.7) | 영구 (연 ~0.5GB — 소량이라 허용, 5GB 도달 시 재검토) | ~40MB/월 |
| `pin/{pinId}/` | 케이스 스터디 퍼머링크 스냅샷 — **pin manifest(재생에 필요한 전 레이어·시간 윈도 파일 목록) + 해당 norm 슬라이스 복사본.** URL은 `?pin={pinId}`로 진입, 프록시가 pin manifest를 resolve. 생성 시점 스냅샷 고정 (이후 원본 정정 미반영을 명시) | 영구 (건당 수 MB) | 무시 가능 |
| `latest.json` (통합 단일 객체) | 전 레이어 최신 스냅샷 — **Collector가 read-modify-write로 재조립**: 기존 latest.json 읽기 → 이번 invocation이 갱신한 레이어/지역 분만 교체 → ETag 조건부 PUT(CAS, 충돌 시 재시도. 1분 cron이라 경합 드묾). stateless invocation이 나머지 레이어를 보존하는 유일한 경로 | 덮어쓰기, gzip 크기 [검증 필요: 실측 — 목표 500KB 이하, 초과 시 latest manifest + 변경 레이어 조건부 fetch로 전환] | 소량 상주 |
| `manifest/dt=.json` | 수집 원장 (윈도별 상태·갭) | 영구 | 무시 가능 |

- **R2 무료 한도 검산 (retention 계약 반영)**: 상주 = raw 2.45GB(7일) + norm 3.6GB(90일 롤링) ≈ 6.1GB 고정 + 증가분(agg·pin·manifest) 연 ~0.5GB. **fail-safe 선(8GB) 도달 추정 ~3.8년** — 그 전에 agg 다운샘플/보존 축소를 재검토한다 (영구 무료 주장이 아니라 '수년 운영 + 도달 전 재검토' 계약). Class A(쓰기): 1분 cron 43,200/월 + raw·norm·agg·latest·manifest PUT 합산 보수 추정 **~20만~35만/월** vs 무료 100만/월 (여유 ~3배). Class B(읽기)는 프록시 Worker 뒤라 여유. **주의: R2 무료는 hard cap이 아니다** (Standard storage 한정, 초과분 자동 과금) — 아래 fail-safe로 방어.
- **fail-safe (이중 관측)**: ① 1차 = 일 1회 prefix LIST로 **실측 용량** 산출해 manifest에 기록 (기대치 누적이 아니라 실측 — lifecycle 삭제 실패를 잡는 유일한 방법. lifecycle 삭제는 만료 후 24h+ 지연 가능하므로 허용 오차 +1일치 유입) ② 2차 = 실측 8GB 도달 시 수집 일시 정지 + 알림. 삭제·축소가 과금보다 먼저 — 자동 과금으로 새는 구조를 만들지 않는다.
- Geo 처리: PostGIS 없음 — **반경/상관 계산은 클라이언트** (이벤트 수천 개 규모라 haversine/H3로 충분, §7 상관 룰). H3 res-3 셀 키는 수집 시 부여 (§5 `h3r3` 유지).
- 시각 T 질의 (§5 계약)는 파일 단위로 구현 (Worker 프록시 경유 fetch): occurrence = 해당 슬라이스 파일들의 window 병합, interval = 활성 목록 파일, observation = T 직전 버킷 파일의 entityId별 최신.
- **공개 접근 경로 계약**: `r2.dev` 공개 URL 사용 금지 (비프로덕션·가변 rate limit·캐시 미지원). 읽기는 **Worker 프록시** (`*.workers.dev` — 커스텀 도메인 불필요). **수용량 모델 (무료 100k req/day, Cache API 히트도 invocation 1회로 과금됨에 주의)**: LIVE는 **레이어 통합 `latest.json` 1파일**로 폴링 (4레이어 각각이 아니라 1req/폴) — 60s 폴링 기준 방문자당 60req/h → 예산의 70%(70k)를 LIVE에 배정하면 **동시 체류 ~48명**, 30%는 Time Machine 조회·burst 예약. **quota 방어 (정직한 한계 명시 — ①은 CF_API_TOKEN·CF_ACCOUNT_ID 시크릿 등록 전까지 비활성, 등록 후 실 API 게이트 검증 필요)**: 요청별 정확한 전역 카운터를 의도적으로 두지 않는다 — SQLite-backed Durable Objects는 무료 플랜에도 있으나(100k req/day) 요청마다 DO 호출을 얹으면 같은 무료 예산을 이중 소모하고 아키텍처에 상태 컴포넌트가 추가된다. KV 무료는 쓰기 1k/day, R2 요청별 CAS는 Class A 낭비 — 따라서 R2-only 단순성을 유지하고 근사로 간다. 따라서 ① 사전 차단은 **근사** — daily capacity scan 시 Cloudflare GraphQL Analytics로 **전일 invocation 수** 조회, 80% 초과면 R2에 완화 플래그 기록 → Worker가 응답 헤더로 클라 폴링 주기 완화(60s→180s) 지시 ② 실시간 초과의 하드 방어는 플랫폼 Error 1027 fail-closed를 수용 (클라는 1027/오류 시 지수 백오프) ③ 비브라우저 abuse 대비 IP 단순 rate limit 내장 (CORS는 브라우저 정책일 뿐 방어가 아님). 캐시: norm/agg는 **?g= pinned(versioned URL)만 `immutable`**, unpinned는 `no-cache` + g 기반 ETag (정정으로 g가 상승하면 브라우저에 즉시 닿아야 함 — unversioned URL에 immutable 금지), latest = `no-cache` + ETag. **Worker Cache API는 기본 workers.dev 배포에선 no-op** (Cloudflare 공식 문서 명시 — custom domain/route 연결 시부터 활성, 코드는 준비돼 있으나 현재 절감 실효 없음). 따라서 R2 Class B는 Cache API 절감이 아니라 **무료 한도(월 1,000만) 직접 검산**으로 방어: LIVE 폴링 전량이 R2 read여도 동시 48명 상시 가정 월 ~207만(latest GET 48×60req/h×720h) + Time Machine 예약분(30k req/day) 전량 소진 가정 월 ~180만(포인터+슬라이스 2 read/req) + poll-relax 플래그 HEAD(isolate당 분 1회 근사) ≈ **월 ~430만 < 1,000만 (여유 ~2.3배)**.

### 8.7 Collector 신뢰성 (이 제품의 코어)

**이 제품은 과거를 파는 제품이다. Collector 다운 = 그 시간대 영구 손실 (항공기는 소급 불가).**

- 실행: **Cloudflare Workers Cron Trigger** (1분 주기, 무료 계정 cron trigger 최대 5개 — 우리는 1개만 사용). **스케줄 계약: 항공기는 90초가 아니라 '분 단위 3분 사이클'로 재정의** — 분 m%3==0에 지역 1·2, m%3==1에 지역 3·4, m%3==2에 지역 5·6 → 지역당 3분 주기(90s보다 완화, adsb.lol 스로틀에 더 안전. 표시 해상도 계약도 '지역당 3분'으로 갱신). 지진 매분, 뉴스 15분 슬롯. 호출당 지역 2개 = 순차 fetch 2회 + 파싱 — **CPU 예산(10ms)은 invocation당 리셋되므로 분할 단위 = invocation**. CPU 한도 검증·폴백 사다리는 §9 Phase 0a 착수 게이트 참조 (Paid 전환은 사다리 소진 + 사용자 명시 승인 시에만)
- 멱등성: DB UPSERT 대신 **결정론 파일명** — **`norm/{layer}/dt={date}/slot={slotStart}.g{generation}.json.gz` — 파일 단위 generation versioned key.** `generation`은 슬롯 파일의 재발행 차수로, 레코드별 `revision`(§5 — 파일 안 각 레코드의 원본 정정 카운터)과 **별개**다. 같은 윈도 재실행(내용 불변) = g0 유지, 파일 내 어떤 레코드든 정정 반영 시 g1, g2… 새 키 발행 + manifest 포인터 갱신 — immutable 장기 캐시와 양립. **agg도 동일 규칙** (정정이 집계값을 바꾸므로 unversioned 영구 키 금지). 옛 generation 정리는 경로별로 다름 — **norm 옛 g = 90일 lifecycle에 위임 / agg 옛 g = Collector 명시 DELETE** (순서 고정: 새 g 발행 → 포인터 CAS 성공 → 유예 1h 후 DELETE — 읽기 경합 결손 방지). 항공기 버킷 = floor(epochSeconds/180)×180 (§5 Observation ID 계약과 일치 — 지역당 3분 주기 정렬)
- 수집 원장 (**원자성 계약**): 윈도별 기록은 immutable 엔트리 `manifest/{layer}/dt={date}/slot={t}.g{generation}.json` — 키에 layer·generation이 들어가므로 재시도(같은 내용·같은 키)와 정정(새 g 키)이 충돌 없이 공존. 슬롯별 최신 generation 포인터는 경로별 분리 — **norm 포인터 = 일 단위 shard** `manifest/pointers/norm/dt={date}.json` (90일 lifecycle 자동 pruning — norm 본체와 수명 일치), **agg 포인터 = 영구 shard** `manifest/pointers/agg/{year}.json` (agg 본체가 영구이므로 포인터도 영구 — 90일 pruning 금지). 양쪽 다 **ETag 조건부 PUT(CAS)**, 충돌 시 재읽기 후 재시도, 전역 단일 객체 금지. 갭 스캔·백필 판정·타임라인 회색 밴드는 immutable 엔트리를 읽는다
- **갭을 UI에 노출** (타임라인 회색 밴드)
- 데드맨 스위치: healthchecks.io 핑 (무료) — 3주기 미수신 시 알림. Workers는 상주 프로세스가 아니라 "cron 미발화"도 갭으로 잡히므로 manifest 기반 감시가 1차
- 재시도: 같은 슬롯 내 1회만 (cron 주기가 짧아 다음 슬롯이 곧 옴). **429는 재시도 금지** (크레딧 소진 의미 — 다음 슬롯 대기). **명시적 예외: adsb.lol** — per-IP 스로틀이라 10s 후 1회 재시도 허용 (실측 회수율 40%, §4.3·CLAUDE.md와 동일 계약)
- 탈락 이력: Fly.io 상주($3~5/월)·Supabase(Pro $25 강제) = 비용 / Vercel Cron(1일 1회) / GitHub Actions cron(지연 10~30분 + 60일 자동 비활성)

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

- 항공기 지역당 3분 스냅샷(6지역 스윕, §8.7 스케줄 계약) + 지진 60s 수집 — **Cloudflare Workers Cron**
- 저장 = **R2 단독** (§8.6): raw 7일 롤링 + norm 15분 슬라이스 + latest 스냅샷 + manifest. DB 없음
- 산출물: wrangler 프로젝트 (cron worker + R2 바인딩) + healthchecks 핑. ~200줄
- **선행 검증 (착수 게이트)** — Workers 무료 CPU 한도(10ms/호출)를 최악 경로 3종으로 실측 (fetch 대기는 CPU 미과금이나 실측 전 단정 금지): ① 항공기 invocation = **분당 2지역**(실제 스케줄 §8.7) 파싱+정규화+H3+집계+gzip+manifest **+ latest.json read-modify-write 전체**(기존 ~500KB 객체 read/decompress/parse/merge/re-gzip/CAS 포함) ② GDELT 15분 슬롯 수 MB 파싱 ③ **daily capacity scan** = 90일 norm+agg 전수 prefix LIST(pagination 포함)+size 합산 — 초과 시 prefix별 분할 스캔 or 계정 metrics API 폴백을 계약. agg 포인터 shard는 연말 최대 엔트리 수 fixture로 CAS 재읽기·재직렬화 비용까지 확인.

**게이트 실측 결과 (2026-08-19 배포 환경):** ① 항공기 24~102ms ② GDELT 파싱 29~49ms ③ 축적 후 재측정 — **전부 명목 10ms 초과. 그러나 강제 종료(1102) 0회** = 무료 한도가 소프트하게 동작 중 (지진 단독도 ~40ms라 사다리로도 명목 달성 불가). **운영 계약: 명목 초과 상태를 인지하고 운영하되, 플랫폼이 강제하기 시작하면(1102 발생) 폴백 사다리 2단(raw-only 강등)을 즉시 발동** — 리스크 대장 참조. **측정 범위 주의: 0a 부분 범위 측정이다 (H3 스텁·agg 미구현·15분 norm 슬라이스 전환 전 코드 기준, 항공기 1지역 경로 포함)** — 게이트가 요구한 완전 최악 경로(2지역+H3+agg+~500KB latest 왕복)가 아니므로, **Phase 1 완전 경로 구현 시 재측정해 이 기록을 갱신할 것.**
- **CPU 초과 시 $0 폴백 사다리 (순서 고정)**: ① invocation 분할 (호출당 지역 수 축소 — CPU 예산은 invocation당 리셋, 사이클 주기가 그만큼 늘어남을 계약) ② 무거운 파싱을 raw-only 적재로 강등 — **단 강등 레이어는 norm 히스토리가 안 쌓여 해당 레이어 Time Machine이 그 기간 불가**함을 명시 (갭 밴드로 정직 표시) ③ 해당 레이어 수집 주기 완화. **Workers Paid($5/월)는 사다리 소진 후 + 사용자 명시 승인 시에만**
- Phase 2 도달 시점에 R2에 수 주치 norm 히스토리가 자동으로 존재

### Phase 0b — 데이터 모델 확정 (0.5일) ★신설

§5 타입 + 레이어별 temporalMode 선언 + URL 직렬화 규약. 레이어 만들기 전에 잠근다 (뒤에 하면 전면 리팩터).

### Phase 0 — Globe Prototype (4~5주)

구현: Globe + 지진 + 항공기 + Layer Toggle + Event Click.

Globe Experience 타임박스: 다크 스타일 + 대기광 + 60fps 관성 회전 + 국경/라벨 + z0~z14 무결 — **여기까지 3일, 초과 시 중단** ("지구본 예쁘게"는 무한 싱크홀).

완료 조건 (✅ 2026-08-19 전부 충족):
- [x] 엔진 확정 (docs/spike/RESULT.md)
- [x] 실 API 지진 전건 + 항공기 1,442대 동시 렌더 @ 120fps (※ '5,000대+' 원 기준은 전 지구 수집 전제 — 6지역 계약으로 조정됨. 렌더 능력 자체는 스파이크에서 30k점 120fps 검증)
- [x] 항공기 지역당 3분 주기 갱신
- [x] 마커 클릭 → 속성 패널
- [x] 공개 URL: https://live-world-pulse.pages.dev

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

- 2a: -1h Seek (지진 = USGS API 직접, 항공기 = R2 norm 최근 버킷)
- 2b: -24h Seek + Playback + Replay (R2 norm 90일 롤링 안 — 수집 24h 경과 후 자동 개방)
- 항공기 보간 재생, 갭 밴드 표시, IndexedDB 리플레이 캐시
- **케이스 스터디 퍼머링크 3건** — `?pin={pinId}` 링크 + README GIF. pin manifest가 재생에 필요한 전 레이어·윈도 파일 목록을 계약하고 슬라이스 복사본을 영구 보존 (§8.6 — 90일 롤링과 무관하게 성립). 생성 시점 스냅샷 고정. 라이브 사건을 기다리지 않고 차별점(시간축+상관)을 30초 안에 증명하는 보험

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

- UTC 강제 (파일명·레코드 전부 UTC ISO/epoch ms, 표시만 로컬)
- 시크릿: wrangler secret / env — 공개 저장소이므로 .env 커밋 금지 (필요 키: healthchecks URL + **Cloudflare API token** — daily scan의 GraphQL Analytics 조회용. 소스 API는 전부 무키)
- 자체 API rate limit (IP 토큰 버킷 — 없으면 남의 스크래퍼가 내 egress를 태운다)
- 용량 모니터 (daily capacity scan 실측치를 manifest 기록, 8GB 도달 시 수집 일시 정지 — §8.6 fail-safe. 과금 방지가 알람보다 먼저)
- 좌표 검증: `lat=0,lon=0`(널섬)·NaN 드롭 + 카운터
- **Attribution (법적 의무)**: 지도 타일 + adsb.lol ODbL 귀속 + USGS/GDELT/GDACS 출처 — UI 푸터 + README

### 예상 비용

```text
전 단계:     $0 — Cloudflare 단일 (Workers Cron 무료 + R2 무료 10GB-월 + Pages 무료)
             retention 정책(§8.6: raw 7일 롤링, norm 90일 롤링 삭제)으로 무료 한도 안 상주 유지 (fail-safe 8GB 도달 추정 ~3.8년 — 도달 전 재검토)
유료 트리거: ① Workers CPU 한도 초과 (Paid $5/월 — 폴백 사다리 소진 + 사용자 승인 시에만) ② R2 상주 8GB 도달 (fail-safe = 수집 일시 정지, §8.6)
             — 둘 다 발생 시 과금 전 축소가 우선, 과금은 사용자 명시 승인 필요
```

---

## 11. 포트폴리오 전략

### 핵심 주장 (재배열 — 달성 기준 병기)

| 주장 | 달성 기준 |
|---|---|
| 1. **이종 API → 단일 시공간 모델 정규화** | 소스 4종+ → WorldRecord 3분기 + 어댑터 단위 테스트. 가장 방어 가능 |
| 2. **시간축 복원과 보간** | -24h 임의 시점 복원 + 보간 재생 + 갭 정직 표시 (단일 사실 모드 — bitemporal 미지원을 정직하게 문서화) |
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
| Collector 장애로 히스토리 구멍 | 상 | manifest 갭 원장 + healthchecks + UI 정직 표시 (구멍 자체를 기능으로) |
| Workers 무료 CPU 한도(10ms) 초과 | **현재 상태** | 실측 24~102ms로 명목 전면 초과, 단 1102 강제종료 0회 (소프트 동작). 1102 발생 시 raw-only 강등 즉시 발동. Paid는 사용자 승인 필수 |
| raw 7일 롤링로 인한 재파싱 불가 | 중 | $0 결정의 수용된 대가. norm 스키마를 Phase 0b에서 신중히 잠그고, 스키마 변경은 7일 내 재파싱 윈도 안에서 |
| R2 lifecycle 실패 → 무료 한도 초과 과금 | 중 | R2 무료는 hard cap 아님. lifecycle rule + Collector 내장 fail-safe(8GB 도달 시 수집 정지) 이중화 |
| adsb.lol Workers IP 스로틀 (실효 수집률 ~30-50%) | **수용됨** | 429 10s 재시도 + 갭 정직 표시 (사용자 승인 2026-08-19). 대체 소스 Workers에서 전멸 실측 |
| Worker 프록시 100k req/day 소진 | 저 | 통합 latest 1req/폴 기준 동시 ~48명 + 30% 예약 (§8.6). 사전 완화 = 전일 Analytics 근사 80% 기준 폴링 완화 플래그, 실시간 초과 = 플랫폼 1027 fail-closed 수용 + 클라 지수 백오프 (정확 실시간 카운터는 의도적 미보유) |
| 스코프 크리프 | 상 | Phase별 완료 조건 체크리스트 + Globe 3일 타임박스 + "경계선" 명문화 |
| 데모 중 API 다운 | 상 | 시드 스냅샷 + 데모 모드 + 케이스 스터디 퍼머링크 |
| maplibre v6/deck.gl 생태 변동 | 저 | ~5.24 핀 + 사유 주석. @deck.gl/maplibre 출시 모니터링 |

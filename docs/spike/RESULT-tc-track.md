# TC 트랙·예보 콘 렌더 — 후보 비교와 채택 (RESULT-tc-track.md)

측정일 2026-08-20. 스파이크 이관 7("Arc/Path 지표 관통 미확정")의 **실제 발현**을 재현·규명하고
채택안을 확정한 기록. 하네스 `spike/tc.html` + `spike/scripts/shoot-tc.mjs`,
증거 `docs/phase1/shots/candidates/` (후보별 스크린샷 + `report.json`).

> 이 문서는 `RESULT.md` 이관 7의 2026-08-19 기록(“`billboard: true`로 해소”)을 **정정**한다.
> 당시 판정은 verify:layers의 **합성 fixture 트랙(5점·화면 중앙·36° 미만)** 으로만 봤다.
> 실 GDACS 트랙(38점·경도 36° 폭·화면 가장자리)으로 다시 보면 현상이 그대로 재현된다.

## 환경 (이 수치의 유효 범위)

| 항목 | 값 |
|---|---|
| 기기 / SoC | MacBook Pro / Apple M5 / 24GB, macOS 26.5.1 |
| 브라우저 | Playwright 제어 Chromium (viewport 1280×800, dpr 1, `--use-angle=metal`) |
| 라이브러리 | maplibre-gl 5.24.0, deck.gl 9.3.10 (`@deck.gl/mapbox` MapboxOverlay, **overlaid**) |
| 데이터 | **실 GDACS 활성 TC** — LALA-26 트랙 38점(lon −141.8…−177.8, lat 15…34.7), SAUDEL-26 트랙 14점 + 예보 콘 216점 (`spike/fixtures/tc-live.json`, 2026-08-20 01:49 UTC `/api/latest` 스냅샷) |
| pose | `globe` z1.5·pitch 0 / `zoom` z4·pitch 0 / `lowpitch` z3.4·**pitch 60** / `back` z1.5·pitch 0 (트랙이 지구 **뒤쪽**에 오도록 center [20,25]) |

## 계측 지표 (육안 + 객관 픽셀)

같은 pose에서 두 장을 찍어 비교한다.
1. `hide=1` — 배경색만 칠한 지구 디스크 → **마스크**(지구 픽셀)
2. 후보 선(순수 마젠타 `#ff00ff`) → 마젠타 픽셀 중 **마스크 밖** 개수 = *지구 실루엣 밖 픽셀*

WebGL 픽셀 회귀(색 비교)가 아니다 — "선이 지구 밖에 그려졌는가"만 세는 기하 단정이라
GPU별 색 차이에 영향받지 않는다 (CLAUDE.md 테스트 규칙 준수).

**선만이 아니라 콘 채움(fill)·빗금(hatch)도 같은 지표로 잰다** (2026-08-20 2차, 사후 리뷰 Med2).
1차 판정표는 선만 계측하고 "line/fill 0px"이라고 썼는데, 그 하네스의 콘은 `poly=plain`
= deck `GeoJsonLayer`여서 **네이티브 fill·hatch는 한 픽셀도 계측되지 않았다**. 2차에서 고쳤다.
- `measure=fill|hatch` — 계측 대상만 **불투명 마젠타**로 격리 렌더 (알파 0.24 채움은 배경과
  구분이 안 되므로 계측 시에만 불투명). 선은 끈다.
- `engine=deck|native` — 같은 지오메트리를 deck `GeoJsonLayer`/`PathLayer` ↔ maplibre
  `fill`/`line` 레이어로 각각 그린다.
- 빗금은 **프로덕션 `web/src/world/deck/hatch.ts`를 그대로 import**한다 (하네스 재구현 아님).
- 콘(SAUDEL-26, lon 132…153)은 트랙 pose에서 화면 밖이라 콘 전용 pose를 쓴다:
  `cglobe` z1.5·p0 / `czoom` z4·p0 / `clowpitch` z3.4·p60 (콘이 화면 중앙) /
  **`chorizon` center[160,5] z3.4·p60 · `cedge` center[110,22] z2.5·p60 (콘이 수평선 쪽)** /
  `cback` (콘이 지구 뒤). 판정은 선 후보의 `lowpitch`와 조건이 같은 **수평선 쪽 pose**로 한다 —
  콘을 화면 중앙에 두면 투영 오차가 거의 드러나지 않는다(아래 표의 clowpitch 열이 그 증거다).

## 후보 판정표

`outside%` = 선 픽셀 중 지구 실루엣 밖 비율 (낮을수록 좋음, **0이 합격**).

| 후보 | globe z1.5 | zoom z4 | **lowpitch z3.4/p60** | back(뒷반구) | 종합 |
|---|---|---|---|---|---|
| (a) PathLayer 기본 | 0% (655px) | 0% (2715px) | **19.7%** (389/1977) | 0% — 선 자체가 렌더 안 됨(폭 퇴화) | ❌ |
| (b) **GreatCircleLayer** (@deck.gl/geo-layers) | 렌더 거의 없음 (65px) | 렌더 거의 없음 (34px) | 38px 중 10.5% | 7px | ❌ **globe에서 사실상 렌더 불가** |
| (c) PathLayer + 대권 subdivision 0.5° (52→167점) | 0% (657px) | 0% (2720px) | **19.8%** (392/1981) | 0% | ❌ (a와 동일 — 원인이 chord sag가 아님) |
| (d) PathLayer + `billboard: true` (2026-08-19 채택안) | 0% (1229px) | 0% (4448px) | **39.9%** (1679/4206) | **778px 유령선** | ❌ 오히려 악화 |
| (e) (d) + `transform.isLocationOccluded` 컬링 | 0% | 0% | **30.1%** (1086/3613) | 0% ✅ | ❌ 뒷반구만 해결 |
| (f) (d) + 수평선 클리핑(project↔unproject 왕복 판정 + 이분법 교차점) | 0% (1229px) | 0% (4448px) | **32.1%** (1196/3723) | 0% ✅ | ❌ 수평선 밖 정점만 지운다 — 어긋난 정점은 못 지운다 |
| (g) **maplibre 네이티브 line/fill 레이어** | **0%** (676px) | **0%** (2835px) | **0%** (1070px) | **0%** | ✅ **채택** |

이 표의 숫자는 **트랙 선만**이다 (후보 (g)의 이름에 fill이 들어가지만 계측된 픽셀은 선이다).
면·빗금은 아래 별도 표에서 잰다.

### 콘 채움·빗금 판정표 (2026-08-20 2차 계측)

`outside%` = 그 요소의 마젠타 픽셀 중 지구 실루엣 밖 비율. `px` = 계측된 픽셀 수.

| 요소 / 엔진 | cglobe z1.5 | czoom z4 | clowpitch p60 (콘 중앙) | **chorizon p60** | **cedge p60** | cback |
|---|---|---|---|---|---|---|
| fill — deck GeoJsonLayer | 0% (1260px) | 0% (40180px) | 0.09% (15/17617) | **100%** (10872/10872) | **100%** (3613/3613) | 0% (0px) |
| fill — **maplibre 네이티브** | **0%** (1370px) | **0%** (40778px) | **0%** (9897px) | **0%** (1565px) | **0%** (1788px) | **0%** (0px) |
| hatch — deck PathLayer | 0% (243px) | 0% (1377px) | 0% (918px) | **100%** (553/553) | **100%** (392/392) | 0% (0px) |
| hatch — **maplibre 네이티브** | **0%** (288px) | **0%** (1563px) | **0%** (498px) | **0%** (48px) | **0%** (175px) | **0%** (0px) |

읽는 법 — 콘을 화면 **중앙**에 두면 (clowpitch) deck도 거의 정상으로 보인다(0.09%). 콘을
**수평선 쪽**에 두면 (chorizon·cedge) deck은 면·빗금이 **전부 지구 밖**에 그려진다(100%).
네이티브는 어느 pose에서도 0%이고, 픽셀 수가 pose마다 다른 것은 수평선 클리핑이 실제로
동작해 보이는 부분만 남기 때문이다 (deck은 클리핑을 안 해서 오히려 픽셀이 더 많다).
이로써 "line/fill/hatch 전부 네이티브가 0px"이 **선·면·빗금 각각에 대해** 계측으로 뒷받침된다.

원시 수치: `docs/phase1/shots/candidates/report.json` (`results` = 선, `areaResults` = 면·빗금).
육안 대조: `flat-{cand}-lowpitch.png`(마스크 대비) · `map-{cand}-{pose}.png`(베이스맵 위 실사) ·
`flat-{fill|hatch}-{deck|native}-{pose}.png` · `map-cone-{deck|native}-{pose}.png`.

## 원인 규명 — 압출면이 아니라 **deck의 globe 투영 자체**다

`spike/scripts/proj-error.mjs`: 트랙 정점을 deck ScatterplotLayer로 찍고, `map.project()`가
가리키는 화면 좌표에서 나선 스캔 픽킹으로 **deck이 실제로 그린 위치**를 찾아 오차를 잰다
(스파이크 기준 3 방법론 재사용).

| pose | 검사 정점 | deck에서 찾음 | 최대 오차 |
|---|---|---|---|
| globe z1.5 (pitch 0) | 52 | 52 | **1 px** |
| zoom z4 (pitch 0) | 38 | 38 | **1 px** |
| **lowpitch z3.4 (pitch 60)** | 44 | 35 (**9개 미검출**) | **59 px+** (미검출분은 60px 스캔 밖) |

즉,

- **pitch 0에서는 deck ↔ maplibre 투영이 1px 이내로 일치**한다 (Phase −1 스파이크 결론과 모순 없음).
- **pitch를 주면 화면 중심에서 먼 정점이 크게 어긋난다.** 수평선 부근·너머 정점은 지구 실루엣
  **밖 허공**으로 투영된다. maplibre 자신은 같은 정점을 수평선에서 정확히 잘라 그린다.
- 점(마커)은 정점이 하나라 어긋나도 "위치가 조금 틀린 점"이지만, 선·면은 정점이 넓게 퍼져 있어
  같은 오차가 **형태**로 드러난다 — 그게 "트랙이 허공으로 뻗는" 현상이다.
- `billboard: true`는 압출을 스크린 공간으로 옮겨 **선 굵기만** 일정하게 만든다. 위치 오차는
  그대로이고, 저각도에서 퇴화해 사라지던 뒷반구 선분까지 또렷하게 그려서 **유령선을 늘린다**
  (back pose 778px). 2026-08-19 판정이 반대로 나온 이유는 fixture 트랙이 화면 중앙의 짧은
  5점이라 오차가 눈에 띄지 않았기 때문이다.
- subdivision(0.5°)은 정점을 3배로 늘려도 수치가 그대로다 — chord sag(직선 근사 오차)는
  애초에 원인이 아니었다.
- GreatCircleLayer/ArcLayer 계열은 globe overlaid에서 **호가 거의 렌더되지 않는다**
  (에러 0·데이터 50세그먼트·픽셀 0~65). ArcLayer로 바꿔도 정점 위치에 점만 흩어진다
  (재현: `spike/scripts/arc-check.mjs`). B 리포트의 "최단경로 선은 GreatCircleLayer"
  권고는 **deck 단독(GlobeView) 전제**이고, maplibre-globe + overlaid 조합에는 적용되지 않는다.
- 클라이언트 컬링((e)·(f))은 뒷반구 유령선은 지우지만(back 0px) **저각도 오차는 못 지운다**
  (lowpitch 30~32% 잔존). 이유가 결정적이다: deck이 허공에 그리는 그 정점들을 maplibre는
  "보이는 정점"으로 판정한다(왕복 오차 0). 즉 **컬링 대상이 아닌 정점을 deck이 틀린 자리에
  그리는 것**이라 클라이언트에서 걸러낼 방법이 없다.

## 채택안 — TC 트랙·콘·빗금은 maplibre 네이티브 레이어

`web/src/world/map/tc-geometry.ts` 신설.

- 소스 1개(`alert-geometry`, GeoJSON) + 레이어 4개
  `alert-areas`(fill, 콘) · `alert-areas-outline`(line) · `alert-hatch`(line, 빗금) · `alert-tracks`(line, 트랙)
- 색은 `rank` 데이터 기반 표현식(DESIGN §2.2 hex 그대로), 선택 시 흰색으로 교체 — deck 계약과 동일
- 빗금은 기존 `deck/hatch.ts`를 그대로 재사용해 LineString 피처로 변환 (DESIGN 계약 유지:
  경보 = 폴리곤 + 빗금 보더, 트랙 = 선)
- 날짜변경선: 좌표를 직전 점 기준 ±180 언랩 (`unwrapLon`) — 안 하면 ±180을 넘는 트랙이
  지구 반대편을 가로지른다. 단위 테스트 `web/test/tc-geometry.test.ts`가 양방향 교차·극지(±85↑)를 고정
- 언랩은 **hatch 계산 전에** 적용한다 (`unwrapRings`). 순서가 뒤바뀌면 날짜변경선 콘의 원본
  lonSpan이 340°가 되어 `hatch.ts`의 스팬 가드에 걸려 **빗금이 통째로 사라진다**. 구멍(내부) ring은
  외곽 ring의 첫 점을 앵커로 언랩한다 — 독립 언랩하면 360° 밀려 엉뚱한 자리가 뚫린다
- 수집 측 대응: `collector/src/sources/gdacs.ts`의 트랙포인트 ring centroid는 경도를 **구면
  평균**(단위벡터 평균 → atan2)으로 낸다. 산술평균은 ±180을 걸친 ring(179.5·−179.5 혼재)을
  약 0°로 보내고, 그 오류는 프론트 언랩으로 복구되지 않는다(점 자체가 이미 틀린 자리다)
- 픽킹: deck(마커) 먼저, 비면 `queryRenderedFeatures`(트랙·콘, 빗금 제외 — 빗금은 장식)
- deck에는 `alert-points`(Point 폴백 마커)만 남는다. `alert-areas`/`alert-hatch`/`alert-tracks`
  deck 레이어는 제거

성능: 카메라가 움직여도 **우리 코드가 프레임마다 재계산하는 것이 없다** — 지오메트리를 한 번
`setData`로 넘기면 maplibre가 구면 셰이더로 그린다 (후보 (e)·(f)는 `move`마다 컬링·클리핑을
JS로 다시 돌려야 했다). maplibre 자체의 프레임 비용은 분리 계측하지 않았으므로 "JS 0"이라고는
쓰지 않는다. `verify:layers` 실측 **120 fps**(게이트 50, 4레이어 마커 포함 전체 씬).
레코드 참조가 그대로면 `setData`도 건너뛴다.

## 회귀 게이트 (web/scripts/verify-layers.mjs)

- `alert-tracks`·`alert-areas`·`alert-areas-outline`·`alert-hatch`가 **maplibre 레이어로 존재**하고
  각각 `queryRenderedFeatures` 결과가 **1건 이상** (레이어만 있고 비어 있으면 실패)
- deck 레이어 목록에 `alert-tracks`/`alert-hatch`가 **남아 있으면 실패** (되돌림 방지)
- 트랙 선 위 클릭 → `sel=gdacs:999999:1` (fixture 결정론)
- 스크린샷 `docs/phase1/shots/`:
  `globe-full-z1.5.png` · `globe-zoom-z4.png` · `tc-track-real-z4.png`(실 TC) ·
  `tc-track-low-pitch.png`(실 TC, pitch 60) · `tc-track-fixture-low-pitch.png`(fixture 결정론)
- fps ≥ 50

2026-08-20 실행 결과(사후 리뷰 수정 후 재실행): failures 0 · errors 0 · fps 120 ·
실 TC = LALA-26(38점) · 렌더 피처 tracks 4 / areas 2 / outline 2 / hatch 18 ·
수신 레코드 quake 6 / flight 856 / weather 383 / news 159.
이 게이트가 보는 것은 **레이어 존재·렌더 피처 수·픽킹·fps**다. "지구 밖으로 새지 않는가"는
게이트 대상이 아니고 위 shoot-tc 픽셀 계측이 담당한다 (역할을 섞어 주장하지 않는다).

## Collector — TC 트랙 수집(getgeometry) CPU

강등(WEATHER_TC_TRACK_DEGRADED)은 이번 작업 **전에 이미 해제되어 배포·가동 중**이었다
(`collector/src/collect.ts` weather-track 전용 슬롯 = 매시 57분, commit이 발행한 tc-index를 읽어
사이클당 TC 1건씩 getgeometry). 프로덕션 실동작 증거: `/api/latest`(2026-08-20 01:49 UTC)에
`gdacs:1001303:30` LALA-26 트랙 38점, `gdacs:1001305:6` SAUDEL-26 트랙 14점 + `:cone` 216점.

로컬 실측 (`collector/npm run bench:cpu`, `npm run bench:tcgeom`):

| 항목 | 로컬 CPU |
|---|---|
| weather-track 슬롯 전체 (합성 fixture) | 0.1 ~ 0.2 ms |
| **실 getgeometry 314KB 파싱 + buildTcGeometry** | **1.59 ~ 1.82 ms/회** (20회 평균, 6회 측정, 2차) |
| 대조: weather-commit 5.4 ~ 7.8 ms · news-process 8 ~ 10.9 ms |  |

2차 재측정에서 1차의 1.11~1.46 ms보다 값이 올라갔다. 구면 centroid 도입 때문인지 확인하려고
같은 하네스에서 산술평균 ↔ 구면평균을 A/B로 돌렸다: 산술 1.68·1.75·1.69 vs 구면 1.69·1.82·1.70
— **차이는 노이즈 이하**다(정점당 cos/sin 2회, 트랙포인트 14×5정점 규모). 1차와의 차이는
측정 시점 머신 상태(다른 dev 서버 동시 구동 여부)로 보이며, 어느 쪽이든 아래 결론은 같다.

슬롯당 getgeometry는 **1건 고정**(입력 크기 비례 금지 규율)이라 활성 TC가 몇 건이든
invocation 비용은 위 값에서 늘지 않는다. 로컬:프로덕션 비율 1.2~5배를 그대로 적용하면
1.9~9.1ms — 10ms 하드캡 안이지만 **여유가 거의 없는 상단**이다 (1차 기록보다 나빠졌다).

**미완 (차단)**: 프로덕션 `wrangler tail`의 cpuTime 실측은 못 했다 — `wrangler whoami`가
"Not logged in. Your auth token has expired… non-interactive"로 실패한다(사용자의 `wrangler login`
필요). 위 수치는 전부 로컬 회귀 지표이고, **최종 판정은 프로덕션 tail**이라는 CLAUDE.md 규율은
아직 충족되지 않았다.

## 남은 제약 (숨기지 않는다)

1. **deck 마커도 pitch에서 어긋난다.** 이번에 고친 건 선·면뿐이다. 같은 투영 오차가 점 마커에도
   있어 pitch 60·z3.4에서 화면 가장자리 마커는 최대 59px+ 어긋난다(위 표). pitch 0에서는 ≤1px라
   기본 사용 경로(앱은 pitch 0으로 시작하고 URL에 pitch를 싣지 않는다)에는 영향이 없다.
   → **리스크 대장 신규 항목**: "pitch 사용 시 deck 마커 위치 오차" — 대응 선택지는
   (a) pitch 제한, (b) 마커도 maplibre 네이티브(symbol/circle)로 이관, (c) 현상 수용 + 문서화.
   이번 작업 범위 밖이라 **미해결로 남긴다**.
2. **픽킹 경로가 둘**이다 (deck pickObject → maplibre queryRenderedFeatures). 우선순위는
   "마커 먼저"로 고정했고 verify:layers가 4레이어 픽킹 + 트랙 픽킹을 모두 단정한다.
3. **콘 폴리곤 subdivision은 불필요**하다 — 채택안(네이티브)에서 0.5° 대권 세분화 링을 같은
   pose로 재계측해도 픽셀이 사실상 동일하다: chorizon fill 1565px(plain) vs 1566px(subdiv),
   hatch 48px vs 48px / cedge fill 1788px vs 1788px, hatch 175px vs 174px — 넷 다 지구 밖 0px.
   maplibre가 구면에서 그리므로 원본 링을 그대로 넣는다.
   육안 대조 `cone-plain-*.png` vs `cone-subdiv-*.png`, 수치는 report.json `areaResults`의 `poly` 필드.
4. 하네스는 dpr 1·M5 단일 기기 측정이다 (스파이크와 같은 한계). 저사양·레티나 미측정.
5. GreatCircleLayer가 globe overlaid에서 렌더되지 않는 **원인**은 규명하지 않았다 (채택 후보에서
   탈락시키는 데 필요한 만큼만 확인). 재현 스크립트만 남긴다.

## 재현 방법

```bash
cd spike && npm i --no-save @playwright/test pngjs   # 하네스 전용(패키지 매니페스트 불변)
npx vite --port 5173 --strictPort &
node scripts/shoot-tc.mjs        # 선 후보×pose + 콘 fill·hatch×엔진 픽셀 계측 → docs/phase1/shots/candidates/
node scripts/proj-error.mjs      # deck ↔ maplibre 투영 오차(px)
node scripts/arc-check.mjs       # GreatCircleLayer/ArcLayer 렌더 여부 재현
# 브라우저 수동:
#   http://localhost:5173/tc.html
#     ?cand=path|gc|subdiv|billboard|cull|cull2|maplibre|none
#     &pose=globe|zoom|lowpitch|back|cglobe|czoom|clowpitch|chorizon|cedge|cback
#     &style=flat|basemap &poly=none|plain|subdiv
#     &engine=deck|native      # 콘 채움·외곽·빗금을 그리는 엔진
#     &measure=none|fill|hatch # 계측 격리(불투명 마젠타, 선 끔)
#     &at=lon,lat&z=&p=&b=     # pose 대신 임의 카메라 (탐색용)
```

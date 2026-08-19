# DESIGN — 디자인 방향 1페이지

결정 문서. 근거는 각 항목 1구절. 충돌 시 CLAUDE.md 표기 규칙 우선.

## 1. 방향 선언

**다크 계기판 / 관제실(mission control) 미학. 라이트 모드 없음 — 명시적 결정.**
근거: 'DevTools for Earth' 컨셉이 다크 + 모노스페이스 + 계기판 방향을 공짜로 준다 (docs/review/D-scope-portfolio.md #8). 데이터가 주인공, UI는 프레임.

## 2. 팔레트 (확정 hex — WCAG AA 검증 완료)

기준: OpenFreeMap dark 배경 `rgb(12,12,12)`(basemap-tiles.md 실측)과 이음새 없이 조화. 대비율은 최상층 배경 `#1e1e1e` 기준 최악값 — 전부 AA(4.5:1) 통과.

| 토큰 | hex | 대비(vs #1e1e1e) | 용도 |
|---|---|---|---|
| bg-0 | `#0c0c0c` | — | 지구본/문서 바닥 (= basemap dark bg) |
| bg-1 | `#141414` | — | 패널 (레이어·이벤트 로그·타임라인) |
| bg-2 | `#1e1e1e` | — | 행 hover·인풋·칩 |
| border | `#262626` | — | 1px 헤어라인 구분선 |
| text-hi | `#e8e8e8` | 13.61 | 본문·수치 |
| text-lo | `#9e9e9e` | 6.22 | 라벨·메타·타임스탬프 |
| quake | `#ff8a4c` | 7.14 | 지진 기준색 (주황) — 범례·로그 행 |
| alert | `#ff5c5c` | 5.51 | 기상 경보 기준색 (적) |
| flight | `#4cc9f0` | 8.67 | 항공기 기준색 (청록 cyan) |
| news | `#ffd166` | 11.56 | 뉴스 기준색 (노랑) |
| live | `#3ddc97` | 9.43 | `● LIVE` 상태 (그린) |
| stale | `#fbbf24` | 9.99 | `◐ 지연` 상태 (앰버) |

근거: 시맨틱 컬러는 severity rank(CAP 0~4)의 시각 인코딩 순위이지 물리량 비교가 아님(CLAUDE.md 데이터 계약). 기준색은 범례·이벤트 로그·UI 배지에 쓰고, 지구본 마커는 §2.2 rank 스케일로 밝기 변조. news(노랑)와 stale(앰버)는 유사 계열이나 사용 위치가 분리됨(마커 vs 헤더 배지) — 혼동 없음.

### 2.1 레이어 비색상 식별자 (확정 — PLAN §10 '색상만으로 레이어 구분 금지')

**shape가 1차 식별자, hue는 보조.** 색각 이상·회색조에서도 레이어가 갈린다.

| 레이어 | 마커 형태 | 근거 |
|---|---|---|
| 지진 | **원 + 등장 펄스 링** (ScatterplotLayer) | globe 위 IconLayer 금지(#9554) 하드 룰과 정합, 진앙=점 은유 |
| 기상 경보 | **폴리곤 반투명 채움 + 빗금(hatch) 보더** | 유일한 면(area) 데이터 — 점 마커와 원천이 다름을 형태로 노출 |
| 항공기 | **heading 방향 삼각 메시** (커스텀 메시) | IconLayer 금지 대안이자 기수 방향 정보가 무료로 실림 |
| 뉴스 | **사각 마커** | 원(지진)과 실루엣 대비 최대 — 소형 크기에서도 구분 |

### 2.2 severity rank 0~4 색 토큰 (확정 hex — 밝기 변조)

생성 규칙: 기준색의 HSL lightness만 변조 (hue·채도 고정). rank 0 = 대비 4.75:1 목표(AA 4.5 + 여유)로 이분 탐색, rank 4 = 기준 lightness +12%p, 사이 균등 4분할. 아래 대비는 최상층 배경 `#1e1e1e` 기준 스크립트 실측 — **20색 전부 AA(4.5:1) 통과, 최저 4.75:1**.

| rank | quake | 대비 | alert | 대비 | flight | 대비 | news | 대비 |
|---|---|---|---|---|---|---|---|---|
| 0 | `#f15400` | 4.77 | `#ff3d3d` | 4.75 | `#1094bd` | 4.76 | `#b57f00` | 4.76 |
| 1 | `#ff6818` | 5.75 | `#ff5454` | 5.28 | `#13b3e4` | 6.82 | `#f0a800` | 8.18 |
| 2 | `#ff813e` | 6.72 | `#ff6b6b` | 6.01 | `#35c2ee` | 8.02 | `#ffc02d` | 10.19 |
| 3 | `#ff9963` | 7.93 | `#ff8282` | 6.96 | `#5dcef1` | 9.18 | `#ffd268` | 11.65 |
| 4 | `#ffb289` | 9.51 | `#ff9999` | 8.15 | `#84daf5` | 10.58 | `#ffe3a3` | 13.31 |

크기 변조 병행 (밝기 단독 의존 금지): 마커 기준 반경 × `1.0 / 1.15 / 1.3 / 1.45 / 1.6` (rank 0→4). 색+크기 이중 인코딩으로 rank가 색각과 무관하게 읽힌다.

## 3. 타이포그래피

- **수치·좌표·시간 = JetBrains Mono** (OFL 무료, 1 weight(400)만). `font-variant-numeric: tabular-nums` 필수 — 이벤트 로그가 초 단위로 흐를 때 자릿수 흔들림 금지.
- 로딩 계약 (LCP 예산 — PLAN §10):
  - **self-host woff2** (레포 vendored — CDN 의존·외부 요청 금지, CSP `font-src 'self'`와 정합)
  - **subset = latin + digits** (U+0020–007E + U+00B0(°)·U+2013–2014) — 좌표·시각·규모 표기에 필요한 문자만
  - **파일 상한 50KB** (subset 후 실측 병기해 커밋 — 초과 시 문자 범위 재축소)
  - `font-display: swap` — 폰트 로딩이 수치 표시를 블로킹하지 않는다 (폴백 `ui-monospace`)
  - **preload 없음 — swap 폴백만** (/world가 동적 라우트라 청크 실행 시점 preload 주입이 CSS 폰트 요청을 앞서지 못함 — 실효 없음 실측). 랜딩 등 다른 라우트 선로딩 금지는 유지
- **UI 라벨 = 시스템 산세리프 스택** (`system-ui`) — 두 번째 웹폰트 금지, 라벨은 개성보다 로딩 속도.
- 크기 스케일 5단 (계기판 밀도 — 크기 아니라 굵기·색으로 위계):

| 토큰 | 크기 | 용도 |
|---|---|---|
| text-xs | 11px | 로그 메타·축 눈금 |
| text-sm | 12px | 로그 본문·레이어 항목 |
| text-md | 14px | 기본 UI·패널 제목 |
| text-lg | 18px | 이벤트 상세 헤드라인 |
| text-xl | 24px | 수치 강조 (M7.2 등) |

## 4. 밀도·레이아웃 원칙

- **계기판 밀도**: 1px 헤어라인 보더, 여백 타이트(4px 그리드: 4/8/12/16), 카드 그림자 없음 — 데이터 행 수가 여백보다 우선. 근거: 이벤트 로그 패널은 DevTools Network 탭 은유(D-scope #135) — 흘러가는 리스트가 정체성.
- **패널 3분할 + 하단 타임라인** (PLAN §3 와이어프레임 고정): 좌 LAYERS / 중 3D EARTH / 우 EVENT LOG, 하단 풀폭 타임라인. 지구본이 최대 면적 — 패널은 접이식.
- 레이어 항목마다 상태 배지 (`idle|loading|ready|stale|error`) — 부분 실패가 정상 상태, 전체 스피너 금지 (PLAN §3).
- 수집 갭 = 타임라인 회색 밴드 `#262626` — 숨기지 않고 정직 표시 (CLAUDE.md 표기 규칙).
- "Realtime" 문구 금지 → "Live Data Integration". `● LIVE`는 최신 가용 스냅샷 의미.

## 5. 모션 원칙

- **지진 = 펄스 링** (등장 시 1회 확산 + regime별 잔여 펄스), `transform`/`opacity`만 — 컴포지터 프렌들리.
- `prefers-reduced-motion`: 펄스·등장 애니메이션 전부 정적 마커로 대체, 관성 회전 off. 근거: 접근성은 PLAN §10 요구사항이지 옵션 아님.
- 지구본 관성 회전 60fps 유지 — 모션 예산은 프레임 시간 게이트로 검증(스크린샷 회귀 금지, CLAUDE.md 테스트 규칙).
- **과장 금지** — 이징 바운스·과한 트랜지션 없음. 움직임은 "새 데이터 도착"의 신호일 때만. 데이터가 주인공.
- 이산 이벤트(지진·뉴스) 위치 보간 금지 — 항공기·태풍 트랙만 보간 (데이터 계약).

## 6. 하지 말 것

- 글래스모피즘·blur 배경 금지 — 관제실은 각지고 평평하다.
- 그라데이션 장식 금지 (데이터 인코딩용 컬러 램프만 예외).
- 라운드 과다 금지 — radius 최대 4px, 배지·칩만.
- 그림자 레이어링 금지 — 깊이는 bg-0/1/2 배경 단차로만.
- 라이트 모드 금지 — 토글 만들지 않는다.

## 7. CSS 토큰 초안

```css
:root {
  /* 배경 계층 — bg-0 = OpenFreeMap dark bg와 동일 */
  --bg-0: #0c0c0c;
  --bg-1: #141414;
  --bg-2: #1e1e1e;
  --border: #262626;

  /* 텍스트 2단 — 최악 배경(#1e1e1e) 기준 AA 통과 */
  --text-hi: #e8e8e8;   /* 13.61:1 */
  --text-lo: #9e9e9e;   /*  6.22:1 */

  /* 시맨틱 레이어 기준색 — 범례·로그·배지 (마커는 아래 rank 스케일) */
  --layer-quake:  #ff8a4c;  /* 지진, 7.14:1 */
  --layer-alert:  #ff5c5c;  /* 기상 경보, 5.51:1 */
  --layer-flight: #4cc9f0;  /* 항공기, 8.67:1 */
  --layer-news:   #ffd166;  /* 뉴스, 11.56:1 */

  /* severity rank 0~4 마커 스케일 (§2.2 — 전부 ≥4.5:1 vs #1e1e1e) */
  --quake-r0: #f15400; --quake-r1: #ff6818; --quake-r2: #ff813e;
  --quake-r3: #ff9963; --quake-r4: #ffb289;
  --alert-r0: #ff3d3d; --alert-r1: #ff5454; --alert-r2: #ff6b6b;
  --alert-r3: #ff8282; --alert-r4: #ff9999;
  --flight-r0: #1094bd; --flight-r1: #13b3e4; --flight-r2: #35c2ee;
  --flight-r3: #5dcef1; --flight-r4: #84daf5;
  --news-r0: #b57f00; --news-r1: #f0a800; --news-r2: #ffc02d;
  --news-r3: #ffd268; --news-r4: #ffe3a3;

  /* 상태색 */
  --status-live:  #3ddc97;  /* ● LIVE, 9.43:1 */
  --status-stale: #fbbf24;  /* ◐ 지연, 9.99:1 */

  /* 타이포 */
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --font-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --text-xs: 11px; --text-sm: 12px; --text-md: 14px;
  --text-lg: 18px; --text-xl: 24px;

  /* 간격 — 4px 그리드 */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;

  /* 모션 */
  --dur-fast: 150ms; --dur-pulse: 1200ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --radius: 4px; /* 최대값 */
}
```

# Live World Pulse

전 세계 실시간 이벤트(지진·기상·항공기·뉴스)를 3D 지구본 + 타임라인으로 탐색하는 데이터 시각화 서비스.
현재 단계: **Phase 1 진행 중 — 4레이어(지진·항공기·기상·뉴스) 라이브 완료 + TC 트랙·콘 지오메트리. 남은 것: Timeline, 룰 기반 상관, Nearby Events** — 공개 URL https://live-world-pulse.pages.dev, Collector 가동 중 (분→작업 1개 + weather 페이지 1장/슬롯, exceededCpu 0. news-process만 10ms 초과 잔존 — PLAN §8.7) — Collector 가동 중 (lwp-collector.rhckdals123.workers.dev), 공유 계약 = `shared/` (타입·temporalMode·R2 스키마·URL 직렬화 — 기존 필드 변경 금지, 추가는 optional만). 이월 미완: 디자인 방향 1페이지(Phase 0 전 필수), RESULT §이관 8~9(7은 2026-08-20 해소 — TC 선·면은 maplibre 네이티브 레이어. 2026-08-19의 'globe Path billboard로 해소' 기록은 오판이었고 `docs/spike/RESULT-tc-track.md`가 정정), TC 트랙 슬롯 프로덕션 cpuTime 미실측(wrangler 인증 만료), GATE_TOKEN·HEALTHCHECKS_URL 시크릿(사용자). (Phase 전환 시 이 줄을 갱신할 것)
마스터 계획: `docs/PLAN.md` (검토 리포트: `docs/review/`). 아래 규칙과 충돌 시 PLAN.md가 우선.

## 기술 스택 (확정 — 변경 금지)

- `Vite + React + TypeScript + React Router` — **Next.js 아님** (SPA에 정직 → PLAN §8.2)
- `maplibre-gl ~5.24.0` **버전 핀. v6 업그레이드 금지** — v6가 MapboxOverlay 의존 `map.transform`을 제거했고 `@deck.gl/maplibre`는 npm 미출시 (PR #10566 → PLAN §8.2)
- `deck.gl ^9.3.10` — `@deck.gl/mapbox` MapboxOverlay, **overlaid 모드만**
- 상태: `Zustand`(전역) + `TanStack Query`(서버 데이터) / 무거운 계산은 `Web Worker`
- 스타일: `Tailwind CSS` + CSS 토큰
- 백엔드: **$0 제약 (2026-08-19 사용자 결정) — Cloudflare 단일.** Collector = Workers Cron(1분), 저장 = R2 단독(raw 7일 롤링 + norm 15분 슬라이스 + latest + manifest — PLAN §8.6), 프론트 = Pages. **DB 없음 — Postgres/Supabase/Fly.io 도입 금지 (비용). 유료 전환은 사용자 명시 승인 필수**

## 금지 목록 (하드 룰)

렌더링:

- globe 위 **`interleaved: true` 금지** (#9592 깊이/컬링)
- globe 위 **`IconLayer` 금지** (#9554 아이콘 소실) — 항공기는 ScatterplotLayer 또는 커스텀 메시
- **런타임 globe↔mercator 수동 토글 금지** (#9466) — z~12 자동 전환은 UX로 수용
- globe 위 **HeatmapLayer / ContourLayer / MaskExtension 금지**

아키텍처:

- **WebSocket 도입 금지** (초 단위 소스 없음 — 수집 지진 20분·항공기 지역당 10분·뉴스 15분·기상 60분, 프론트 지진 직접 폴링 60초. SSE는 Phase 2+ 재검토 → PLAN §8.1·§8.7)
- **Redis / Timescale / Postgres 도입 금지** ($0 결정 — DB 없음, R2 파일 모델 → PLAN §8.6)
- **외부 API 브라우저 직접 fetch 금지 — 유일 예외 USGS** (CORS `*`). 나머지는 전부 백엔드 경유
- **클라이언트 Worker에서 뷰포트별 클러스터링 금지** — LOD 집계는 수집 시 사전계산한 R2 `agg/` 파일 (→ PLAN §8.6)
- **TanStack Query에 LIVE 스트림 밀어넣기 금지** — 스트림은 별도 링버퍼, Query는 히스토리/상세만 (→ PLAN §8.4)
- **viewport/카메라 전역 상태 금지** — 지도 인스턴스 소유, 전역엔 200~300ms 디바운스 사본만 (→ PLAN §8.4)

데이터 소스:

- **NewsAPI·Blitzortung 사용 금지** (ToS/제한 → PLAN §4)
- **429 응답 재시도 금지** (크레딧 소진 의미 — 다음 슬롯 대기). **명시적 예외: adsb.lol** — per-IP 스로틀이라 10s 후 1회 재시도 허용 (실측 회수율 40% → PLAN §4.3)

과금 (절대 룰):

- **Cloudflare 유료 전환 절대 금지** — 플랜 변경·구독·결제 관련 명령(wrangler·대시보드·API 불문) 실행 금지. Workers/Pages는 Free 플랜 유지 (hard cap — 초과 시 1027로 멈추는 게 정상 동작이지 업그레이드 사유가 아님)
- **R2가 유일한 과금 표면** — 상주 8GB 도달 시 수집 정지(fail-safe)가 과금보다 항상 먼저. 한도 압박 시 대응 순서: 삭제·축소 → 수집 정지 → (사용자 명시 승인 후에만) 과금 검토
- 어떤 워커·에이전트도 이 룰을 "작업 완수를 위해" 우회할 수 없다

기타:

- URL 갱신에 **pushState 금지** — `replaceState` + 디바운스만
- 이산 이벤트(지진·뉴스) **보간 금지** — 위치 연속인 것(항공기·태풍 트랙)만 보간
- globe 위 **선·면 지오메트리(TC 트랙·예보 콘·빗금)는 deck 금지 — maplibre 네이티브 line/fill 레이어**(`web/src/world/map/tc-geometry.ts`). deck overlaid의 globe 투영은 pitch 0에선 maplibre와 ≤1px로 일치하지만 pitch를 주면 수평선 부근 정점이 59px+ 어긋나고 수평선 너머를 클리핑하지 않아 선이 지구 밖 허공으로 뻗는다. `billboard: true`·대권 subdivision·GreatCircleLayer·클라이언트 컬링 전부 실패(선 후보 7종 픽셀 계측 — 이전 2026-08-19의 "billboard로 해소" 기록은 fixture 한계로 인한 오판이었다). 콘 채움·빗금도 따로 계측했다 — 콘이 수평선 쪽에 놓이는 pose에서 deck는 픽셀 100%가 지구 밖, 네이티브는 0%. 판정표·재현 = `docs/spike/RESULT-tc-track.md` (스파이크 이관 7 해소, 2026-08-20). deck은 **점 마커 전용**
- **비TC 경보의 영역 폴리곤 수집 금지** — GDACS getgeometry는 이벤트당 1콜이라 활성 400여 건이면 400콜 ($0·10ms 예산 밖). 폴리곤/트랙은 **TC 한정**이고 그 밖은 Point다 (백로그 — PLAN §4.2). "폴리곤 구현" 주장을 TC 콘 범위 밖으로 넓히지 말 것

## 데이터 모델 계약 (PLAN §5)

- 단일 `WorldEvent` 타입 금지 — **3분기 고정**: `Occurrence`(지진·뉴스) / `Interval`(기상 경보) / `Observation`(항공기·태풍 중심). Track은 저장 타입이 아니라 `Observation[]` 파생 뷰
- 좌표는 **GeoJSON 순서 `[lon, lat]`** — 라벨드 튜플 `[lon: number, lat: number]`로 컴파일 타임 강제
- 시간: **UTC 강제** — 연산 epoch ms, 표시만 로컬. `observedAt`(원본 시각) + `ingestedAt`(수집 시각) 필드 유지하되 **bitemporal replay(asKnownAt)는 미지원·주장 금지** ($0 결정 — PLAN §5)
- `id = ${source}:${sourceId}` 멱등 키, `revision` 필드 필수 (USGS 규모 사후 정정)
- severity = CAP 등급 rank 0~4 + `raw` 원본값 보존 — 레이어 간 물리량 비교가 아니라 시각 인코딩 순위
- payload는 discriminated union — **`metadata: Record<string, unknown>` 백 금지**
- 시각 T 질의는 kind별 규칙 상이 (occurrence=window, interval=겹침, observation=최근 1건) — 단일 timestamp 필터 금지

## 테스트 규칙

- **WebGL 스크린샷 회귀 금지** (GPU별 픽셀 차이) — 대신 DOM 로그 패널 스냅샷 + `pickObjectsInRect` 단정 + 프레임 시간 게이트
- E2E(Playwright)는 **모킹 fixture만** — 실 API 물리면 100% flaky
- 단위 테스트 최우선 대상: 어댑터/정규화, kind별 시간 슬라이스, **보간 경계(날짜변경선·극지·heading ±180 wrap)**, 상관 룰, URL 직렬화 라운드트립
- 프레임워크: Vitest + Playwright. 패키지별 `npm test` — shared / collector / **web**(2026-08-19 추가: 시간 슬라이스·참조 안정성·상태 전이·빗금 기하)
- Workers CPU 회귀는 `collector/npm run bench:cpu`(슬롯별 process.cpuUsage) + `npm run bench:news`(단계 분해). **로컬은 회귀 탐지용, 최종 판정은 프로덕션 `wrangler tail`의 cpuTime** (로컬:프로덕션 비율이 작업별로 1.2~5배)
- **한 슬롯의 작업량은 입력 크기에 비례하지 않게 묶을 것** — GDACS 페이지는 슬롯당 1장, quake norm은 현재+직전 슬롯만. 현재 예외는 news-process(행 수 비례, Free 유예 의존 — PLAN §8.7에 명시)

## 표기·주장 규칙 (UI·문서 공통)

- "Realtime" 표기 금지 → **"Live Data Integration"**. `● LIVE`는 최신 가용 스냅샷 의미, 항공기 20분(2주기) 무갱신 시 `◐ 지연` 강등 (레이어별 tolerance = shared TEMPORAL_SPEC)
- 항공기 **"delayed / diverted" 문구 금지** — 계산 가능 지표만 (`traffic density -38% vs 24h baseline`)
- 근거 없는 **"수만~수십만 이벤트" 주장 금지** — 실측 수치 + 측정 환경·fps 병기
- 수집 갭 숨기기 금지 — 타임라인 회색 밴드로 정직 표시
- 다크 모드 단일 — **라이트 모드 없음** (명시적 디자인 결정)

## 커밋 컨벤션

형식: `타입: gitmoji 내용` — 한국어, 최대한 간략하게.
다수의 변경 사항이 있을 때는 본문에 글머리 기호(`-`) 사용.

| 타입 | gitmoji | 용도 |
|---|---|---|
| feat | ✨ | 새로운 기능 추가 |
| fix | 🐛 | 버그 수정 |
| docs | 📝 | 문서 수정 |
| style | 🎨 | 들여쓰기, 세미콜론 등 변경 |
| refactor | ♻️ | 코드 리팩토링 |
| test | ✅ | 테스트 코드 작성·수정 |
| chore | 🔧 | 외부 라이브러리 임포트 등 |

예시:

```
docs: 📝 계획서 v2 작성

- Phase -1 엔진 스파이크 신설
- 데이터 모델 3분기 확정
```

## 작업 파이프라인

작업 종류별 단계 (오케스트레이션·단독 작업 공통):

```
문서 작업:  설계 → 구현 → 리뷰 (+수정 루프)
코드 작업:  [조사*] → 설계 → 구현 → 기계 검증 → 리뷰 → 수정 루프 → 커밋
시각 작업:  코드 작업 + 기계 검증에 실행 스크린샷/FPS 실측 포함
            (* 조사는 외부 API·미검증 전제가 있을 때만 — 문서 읽기가 아니라 실측)
```

- **기계 검증** = typecheck·build·test 실제 실행 증거. 안 돌아가는 코드를 리뷰하지 않는다.
- **수정 루프** = 리뷰가 Med 이상 발견 시 `수정 → 재검증 → 재리뷰`, High 0 + Med 0까지. Low만 남으면 통과.
- 작성자와 리뷰어는 항상 분리 (같은 워커/컨텍스트에서 자기 승인 금지). 리뷰 레인은 **codex 우선** (다른 모델 교차 검증) — 기동 실패 시 claude 폴백.
- 단계 인플레이션 금지 — 보안 리뷰는 인증·키·입력 처리를 건드릴 때만 조건부 추가.

## 문서 지도

- 데이터 소스별 제약·ToS: PLAN §4 / 데이터 모델 전체 타입: PLAN §5
- 아키텍처·저장 3계층·비용: PLAN §8 / Phase별 완료 조건: PLAN §9
- 성능 예산·접근성·복원력: PLAN §10 / 리스크 대장: PLAN §12
- 검토 리포트 원문: `docs/review/`

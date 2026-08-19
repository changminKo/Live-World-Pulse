# Phase -1 엔진 스파이크 — 결과 (RESULT.md)

측정 실행: 2026-08-18. 하네스: `spike/` (DESIGN.md §1 구현), `?engine=a|b|c&auto=1` 자동 계측.
원시 JSON: `docs/spike/raw/engine-{a,b,c}.json` / 스크린샷: `docs/spike/shots/`.

## 환경 (필수 — 이거 없는 수치는 무효)

| 항목 | 값 |
|---|---|
| 기기 / SoC / RAM | MacBook Pro / Apple M5 / 24GB |
| 디스플레이 주사율 | 120Hz (rAF 실측 상한 120fps — ProMotion) |
| 브라우저 + 버전 | Chromium 151.0.0.0 (Playwright 제어, viewport 1280×800, devicePixelRatio 1) |
| maplibre-gl / deck.gl 실제 해석 버전 | `npm ls`: maplibre-gl@5.24.0, deck.gl@9.3.10 |
| OS | macOS 26.5.1 |
| 측정일 | 2026-08-18 |
| 저사양 기기 측정 여부 | **안 했음 — 리스크로 명기** (M5 단일 기기. FPS 여유폭이 크나 저사양 실측 없이는 기준 1을 일반화할 수 없음). 추가: 측정이 dpr=1(Playwright 기본)이라 레티나 실사용(dpr 2, fragment 부하 ~4배) 대비 GPU 부하 과소 — 같은 이유로 일반화 불가 |

## 판정 매트릭스 (후보 × 기준)

| # | 기준 | A (overlaid) | B (interleaved) | C (_GlobeView) |
|---|---|---|---|---|
| 1 | FPS ≥ 50 (1초 윈도 최소값) | **119.8 fps** ✅ | 116.8 fps | **94.6 fps** ✅ (회전 N/A) |
| 2 | 마커 소실 0 (N₀/N₁/센티널, 센티널 분모 9 = 12점 중 가시각 70° 내 9점만 검사) | 9976/9976, 센티널 9/9 ✅ | 9829/9829, 9/9 (아래 †) | 10652/10652, 9/9 ✅ |
| 3 | 픽킹 오차 ≤ 5px (중앙/림/날짜변경선 최대) | **1 px** ✅ | 1 px | **5 px** ✅ (림 4~5px) |
| 4 | 텍스트 반전·레이어 소실 없음 (육안 6항목) | 5/6 O + 1 미확정 | 기록만 (판정 대상 아님) | **2 X** (TextLayer 소실) ❌ |
| 5 | z0↔z14 왕복 무결 | N₂=9976 보존, JS 에러 0 — **스냅샷 기준 ✅** (전환 순간 연속 관찰 미실시·z0 미시험 — 이관 8·9) | N₂=9829 보존, 에러 0 | N₂=10652 보존, 에러 0 ✅ (z12+ 지터: 미확정) |
| 6 | data 교체 드롭 ≤ 1 (틱 12회 최대 드롭) | **0** ✅ `[0×12]` | 0 `[0×12]` | **0** ✅ `[0×12]` |
| — | SimpleMeshLayer(항공기 회전) globe 동작 | ✅ (렌더·회전 확인) | ✅ | ✅ |
| — | 종합 | **합격 — 채택** | (판정 대상 아님 — 재현 기록 †) | 자동 기준 통과·육안 기준 4 실패 (폴백 순위 유지, 라벨 대안 필요) |

† **B(interleaved) 재현 기록 — 금지 목록 실측 근거:** 동일 pose·동일 데이터에서 픽 가능 마커 9,829개 vs A 9,976개 = **147개(-1.5%)가 깊이 버퍼에 차폐**되어 픽킹 불능 (#9592 깊이/컬링 계열). 자체 실행 내에서는 일관(N₀=N₁=N₂)이라 자동 검사만으로는 안 걸림 — overlaid 대조군이 있어야 드러난다. `interleaved: true` 금지 유지.

- N₀가 후보 간 다른 것(9976/9829/10652)은 투영·컬링 차이로 가시 영역이 달라서다. 기준 2는 **후보 내 보존**(N₀=N₁=N₂)을 본다.
- 참고: 항공기 2,000대는 SimpleMeshLayer 렌더 정상. 기준 6은 매 틱 항공기 배열 통째 교체(naive 최악 케이스)에서 드롭 0 — attribute 재생성 비용이 이 페이로드 규모에선 문제가 아님 (M5 한정).

## 육안 체크리스트 상세 (§4-4, 후보별 O/X + 한 줄 관찰)

| 항목 | A | B | C |
|---|---|---|---|
| 남반구 라벨 정립 (반전 없음) | **O** — SYDNEY·SAO PAULO 정립 (`shots/a-poseP-sentinels.png`, `a-south-rot.png`) | O | **X — 라벨 자체가 없음** (아래 참조) |
| 림 근처 라벨 정립·판독 가능 | **O** — 림 근처 베이스맵·deck 라벨 정립 | O | X (동일) |
| 회전 중 deck 레이어 지구 뒤로 소실 없음 (앞면 먹힘) | **O** — bearing 30° 관찰 + 회전 시퀀스 후 카운트 보존 | O | 회전 N/A — 점·항공기 팬/줌 중 먹힘 없음 |
| ArcLayer 호 지표 관통 없음 | **미확정** — 스크린샷 판독 한계, 관통 의심 장면은 없었음 | 미확정 | 미확정 |
| 라벨 과대/차폐 없음 (OpenFreeMap 라벨 이중 표시) | **O(관찰 병기)** — 크기 비정상 없음. 단 베이스맵 지명 라벨과 deck TextLayer **이중 표시 확인** (예상대로, basemap-tiles.md 지적) — Phase 0에서 스타일 라벨 억제 검토 필요 | O(동일) | N/A (베이스맵 없음) |
| 베이스맵 자체 렌더 정상 (타일 구멍·투영 깨짐) | **O** — z1.5~z14 전 구간 정상 (`a-z117.png`, `a-z124.png`) | O | N/A — 국경 GeoJSON 정상 |

각주: C는 no-op 전환(rotate-back)에서 onTransitionEnd 미발화 → 폴백 타임아웃(raw 4001ms)으로 진행 — 1초 유휴가 끼어 카메라 스크립트 총시간이 A/B와 약간 다름 (계측 왜곡 아님).

**C의 TextLayer 소실 (중대 발견):** 공통 `layers.ts`의 동일 TextLayer가 A/B에선 렌더되고 C(_GlobeView)에선 두 pose(런던 z6 `c-poseP.png`, 시드니 z4 `c-sydney.png`) 모두 **전혀 렌더되지 않음**. JS 에러 0 — 조용한 소실. C를 쓰려면 라벨을 다른 방식(HTML 오버레이 등)으로 구현해야 함.

**A/B 추가 관찰 (기존 항목 밖):** 저줌에서 지구 원반 **밖** 허공에 항공기 메시·Arc 일부가 잔상처럼 렌더됨 (`a-poseP-sentinels.png` 좌측 검은 하늘) — 뒷반구 데이터가 컬링되지 않고 화면 밖 투영으로 새는 overlaid 특성. 원반 안 데이터 정합엔 영향 없음(카운트·픽킹 통과). Phase 0에서 뒷반구 데이터 필터(각거리 컷)로 해결 가능 — 리스크 대장 후보.

**z12 globe→mercator 자동 전환 (기준 5 육안, A):** z11.7/z12.4 스냅샷 대조 — 센티널 정위치 유지, 이중상·스케일 점프 없음. 연속 프레임 관찰은 미실시 (전환 순간의 튐은 **미확정**, 스냅샷 기준 무결).

## 재현성

A는 계측 확정 후 조건 동일 2회 실행: fps min 119.9/119.8, N₀ 9976/9976, 틱 드롭 0/0 — 재현 확인. B·C는 각 1회 (판정 규칙 1 준용으로 축소 — §6 타임박스 규율).

## 판정 규칙 적용 (측정 전 고정된 §5 규칙)

**규칙 1 준용: A가 기준 1·2·3·6 통과 + 기준 5 스냅샷 기준 통과(전환 순간·z0 미확정 — 이관 8·9) + 기준 4는 5/6 O + 미확정 1건(Arc 관통 — 실패 관찰 없음, 이관 7)** (원문 '전부 통과'의 준용 — 규칙 2 경로로 가도 C가 기준 4 명백 실패라 결론 불변. 미확정·미시험 3건은 Phase 0 이관 7~9로 추적) → **A (maplibre-gl 5.24 globe + MapboxOverlay overlaid) 확정.**

- C는 실행 확인을 넘어 전체 측정까지 완료 — 자동 기준 전부 통과했으나 TextLayer 소실로 육안 기준 4 실패. 폴백 1순위 지위는 유지하되, 폴백 발동 시 라벨 대안 구현이 전제 조건임을 기록.
- B 결과는 interleaved 금지 목록의 실측 근거로 첨부 (147개 마커 깊이 차폐).
- 폴백 래더(규칙 2·3) 발동 없음. SimpleMeshLayer 정상 — 항공기 렌더 방식 SimpleMeshLayer 확정 (규칙 5 불필요).

## 계측이 DESIGN과 다르게 확정된 지점 (전부 계측 유효성 사유 — 판정 기준 완화 아님)

1. **픽킹 오차 측정법 (§4-3):** `pickObject({radius: r})` r-증가 스캔 → **project점 중심 나선 픽셀 스캔**(r=0..10, 각 반경 원주를 radius:0으로 픽)으로 대체. deck pickObject는 radius 내 top-most **1개만** 반환 — 30k 고밀도에서 겹친 일반 점이 최근접이면 r을 늘려도 같은 점만 나와 영구 miss(실측: 全 케이스 오차 ∞로 오판). 의미(오차 = project점↔실제 픽 가능 위치 거리)는 동일.
2. **림 센티널 좌표 (§4-3 "~80°"):** z2 globe 수평선은 카메라 유한 거리 탓에 각거리 ~75°에서 잘림 (실측: 원반 반경 315px = asin(315/326)). 80°는 물리적으로 렌더 불가 — 림 케이스를 70.6°/67.1°로 확정 (§3-2가 좌표 확정을 구현에 위임).
3. **sentinel-1 lat 0→10 (§3-2 "lat 0/±40"):** s0[179.9,0]·s1[-179.9,0]은 0.4° 간격 — z3 검사 pose에서 8px 원끼리 겹쳐 top을 뺏겨 가짜 오차 7px 발생(실측). 날짜변경선 양쪽+상이 lat 의도 보존, 겹침만 해소.
4. **센티널 draw order:** points 배열 끝(최상단)으로 — 일반 점에 가려지는 계측 오염 방지.
5. **가시성 판정 각도:** 85°→70° (수평선 75° 실측 - 마진 5°). 수평선 밖 점을 소실로 오판하는 것을 방지.
6. **engine-c 배경:** deck v9 luma 타입에 `parameters.clearColor` 부재 — canvas CSS `#0a0a0d`로 동일 효과.
7. **실행 방식:** DESIGN §0 비범위는 '브라우저 수동 실행'이었으나 실제 측정은 Playwright 제어 Chromium으로 수행 (환경 표에 명시). 결정론·재현성엔 유리, dpr=1 과소 부하 한계는 환경 표 참조.
8. **관성 팬 미구현 (§4-1 스텝 5):** easeTo 단순 이동으로 대체 — 관성 감쇠 곡선 미재현. 판정 영향 미미 (프레임 부하는 이동 자체가 지배).

## 원시 데이터 부록

auto=1 JSON 덤프 전문 (logs 포함): `docs/spike/raw/engine-a.json` · `engine-b.json` · `engine-c.json`

핵심 수치 발췌:

```json
// A (overlaid) — 채택
{"criteria1_fps": {"minWindowFps": 119.8, "medianFps": 120.5, "p95FrameMs": 9.8},
 "criteria2_markers": {"n0": 9976, "n1": 9976, "sentinel": "9/9"},
 "criteria3_picking_maxPx": {"poseP": 1, "dateline": 1},
 "criteria5_roundtrip": {"n2": 9976, "preserved": true, "jsErrors": 0},
 "criteria6_tickDrops": {"perTick": [0,0,0,0,0,0,0,0,0,0,0,0], "max": 0}}

// B (interleaved) — 재현 기록
{"criteria1_fps": {"minWindowFps": 116.8}, "criteria2_markers": {"n0": 9829, "vs_A": -147},
 "criteria6_tickDrops": {"max": 0}}

// C (_GlobeView) — 자동 통과, TextLayer 소실
{"criteria1_fps": {"minWindowFps": 94.6}, "criteria2_markers": {"n0": 10652, "n1": 10652, "sentinel": "9/9"},
 "criteria3_picking_maxPx": {"poseP": 5, "dateline": 1},
 "criteria6_tickDrops": {"max": 0}}
```

## Phase 0 이관 사항

1. **엔진 확정: maplibre-gl ~5.24.0 globe + deck.gl 9.3.10 MapboxOverlay overlaid** (CLAUDE.md 핀 그대로).
2. 항공기 렌더: **SimpleMeshLayer 확정** (globe 위 인스턴싱·회전 정상, 2k 틱 교체 드롭 0).
3. OpenFreeMap dark 자체 라벨 ↔ deck TextLayer 이중 표시 — 스타일 레이어 억제 검토.
4. 저줌 뒷반구 데이터의 원반 밖 잔상 — 각거리 컷 필터 검토 (리스크 대장).
5. 저사양 기기 미측정 — Phase 0 성능 예산 수립 시 실측 필요.
6. C 폴백 사용 시 전제: TextLayer 소실 해결책 필수.
7. ~~**[미확정 이월] Arc 지표 관통 여부 (기준 4)**~~ → **해소 (2026-08-19, Phase 1)**. 실데이터 PathLayer(TC 트랙)를 저고도각(pitch 60·z3.4)에서 확인한 결과, 기본 압출은 **지표 접평면**에서 일어나 리본이 지구 실루엣 밖으로 떠 보였다. `billboard: true`(스크린 공간 압출)로 해소 — 좌표 세분화(subdivision)는 원인이 chord sag가 아니라 압출면이라 효과가 없고, GreatCircleLayer는 `@deck.gl/geo-layers` 추가 의존이라 불필요했다. 계약: **globe 위 선 레이어는 `billboard: true` 고정** (web/src/world/deck/layer-factory.ts alert-tracks·alert-hatch). 회귀 게이트 = `npm run verify:layers`의 `tc-track-low-pitch.png` + 트랙 픽킹 단정.
8. **[미확정 이월] z12 globe→mercator 전환 순간 연속 프레임** — 스냅샷 대조는 무결, 전환 순간 튐은 미관찰. Phase 0에서 육안 확인.
9. **[미시험 이월] z0 시작 왕복** — 자동 시퀀스가 z1.5까지만 감 (합격 기준 문구는 z0↔z14). Phase 0에서 z0 포함 재확인.
10. 계측 하네스 재사용 시 개선 2건: minWindowFps가 1초 초과 단일 스톨을 못 봄 (max frame time 지표 추가), probes 화면 밖 projection 센티널의 hit/miss 분류 보강.

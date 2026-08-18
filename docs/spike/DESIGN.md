# Phase -1 엔진 스파이크 — 설계서 (DESIGN.md)

작성일 2026-08-18. 근거: `docs/PLAN.md` §8.2·§8.3·§9 Phase -1, `docs/review/B-frontend-engine.md`, `docs/review/research/basemap-tiles.md`, `CLAUDE.md` 하드 룰.

## 0. 목적과 비범위

**목적:** 후보 3개(A/B/C)를 같은 페이로드·같은 계측으로 구동해 PLAN §9의 합격 기준 6개를 숫자로 판정한다. 산출물은 `docs/spike/RESULT.md` 하나다. 스파이크 코드는 **전량 버리는 코드**다.

**비범위 (하지 않는다):**

- 실 API 연동 (전부 시드 고정 합성 데이터)
- Playwright/CI 자동화 (1.5일 예산 — 브라우저 수동 실행 + 자동 계측 스크립트로 충분)
- Worker / binary attributes 파이프라인 (Phase 0 이후 주제 — 스파이크는 최악 케이스인 "naive `data` 배열 교체"를 일부러 측정한다)
- 디자인 저작, 접근성, 모바일 (Phase 0+)
- WebGL 스크린샷 회귀 (CLAUDE.md 금지 — DOM 로그 패널 + `pickObjects` 단정 + 프레임 시간만)

| 후보 | 구성 | 역할 |
|---|---|---|
| **A** | maplibre-gl 5.24 globe + deck.gl 9.3.10 `MapboxOverlay` **overlaid** | 예상 승자 — 본 판정 대상 |
| **B** | A와 동일 + `interleaved: true` | **버그 재현 증거 수집용** (#9592). 판정 대상 아님 — 금지 목록의 실측 근거 확보 |
| **C** | deck.gl 단독 `_GlobeView` (maplibre 없음, 국경 GeoJSON) | 폴백 1순위 |

---

## 1. 스파이크 프로젝트 구조

### 1-1. 본 프로젝트와 분리 — repo 안 `spike/` 디렉터리

- 위치: 리포 루트 `spike/`. **독립 package.json** (루트에 아직 코드 0줄 — 워크스페이스 아님, 그냥 별도 npm 프로젝트).
- **승격 금지 룰:** `spike/` 코드는 어떤 형태로도 미래의 `src/`로 복사·이동 금지. 승격되는 것은 `docs/spike/RESULT.md`의 **수치와 판정뿐**이다. `spike/README.md` 첫 줄에 명시:

  ```
  ⚠️ 버리는 코드. Phase -1 판정 후 읽기 전용. main src로 승격 금지 (docs/spike/DESIGN.md §1-1).
  ```

- `.gitignore`(루트)에 `spike/node_modules/`, `spike/dist/` 추가. 스파이크 소스 자체는 **커밋한다** (재현 가능해야 RESULT가 근거가 됨).

### 1-2. 디렉터리 레이아웃

```
spike/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html                      # 캔버스 컨테이너 + 로그 패널 마운트
├── README.md                       # 버리는 코드 경고 + 실행법 3줄
├── fixtures/
│   └── ne_110m_countries.geojson   # Natural Earth 110m (~230KB, 후보 C 국경용, 커밋)
└── src/
    ├── main.ts                     # ?engine=a|b|c 파싱 → 어댑터 동적 import
    ├── engines/
    │   ├── types.ts                # EngineHandle 계약 (§2-2)
    │   ├── engine-a.ts             # maplibre globe + MapboxOverlay(overlaid)
    │   ├── engine-b.ts             # engine-a 재사용 + {interleaved: true}
    │   └── engine-c.ts             # _GlobeView + 국경 GeoJsonLayer
    ├── layers.ts                   # 공통 deck 레이어 팩토리 (payload → Layer[])
    ├── payload/
    │   ├── rng.ts                  # mulberry32 시드 PRNG
    │   ├── generate.ts             # 30k점 / 항공기 2k / 경로 200 / 라벨 50 + 센티널
    │   └── ticker.ts               # 5초 틱 시뮬레이터
    └── measure/
        ├── fps.ts                  # rAF 프레임 시간 수집기
        ├── camera-script.ts        # 자동 카메라 시퀀스 (30초)
        ├── probes.ts               # 픽킹 오차 / 마커 카운트 검사
        └── panel.ts                # DOM 로그 패널 + 결과 JSON 덤프 버튼
```

### 1-3. package.json (버전 정확히 — CLAUDE.md 핀 준수)

```json
{
  "name": "lwp-engine-spike",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "maplibre-gl": "~5.24.0",
    "deck.gl": "^9.3.10"
  },
  "devDependencies": {
    "typescript": "~5.9.2",
    "vite": "^7.1.0"
  }
}
```

- `maplibre-gl ~5.24.0` — **v6 금지.** v6가 `MapboxOverlay` 의존 `map.transform` 제거, `@deck.gl/maplibre` npm 미출시 (PR #10566). package.json 위쪽에 주석 불가하므로 README에 사유 명시.
- `deck.gl` 엄브렐라 하나로 `@deck.gl/core`·`layers`·`geo-layers`·`mesh-layers`·`mapbox` 전부 커버 — 스파이크에서 개별 패키지 쪼개지 않는다.
- React 없음 — **바닐라 TS.** 스파이크에 React는 소음 (본 프로젝트가 React인 것과 무관, 여긴 엔진만 본다).
- typescript/vite는 설치 시점 최신 마이너 허용 (핵심 핀은 maplibre/deck 둘뿐).
- 설치 후 `npm ls maplibre-gl deck.gl`로 실제 해석 버전을 RESULT.md 환경 표에 기록.

---

## 2. 비교 하네스 설계

### 2-1. 진입: 라우트 아님, **쿼리 파라미터**

```
http://localhost:5173/?engine=a          # 수동 관찰 모드
http://localhost:5173/?engine=a&auto=1   # 자동 계측 모드 (로드 → 카메라 스크립트 → 검사 → JSON 덤프)
```

- 라우터 의존성 0. `main.ts`가 `URLSearchParams` 읽고 `import('./engines/engine-a')` 동적 로드.
- `auto=1`이면 §4의 시퀀스가 자동 실행되고, 끝나면 로그 패널에 결과 JSON 표시 + 클립보드 복사 버튼.
- 페이로드·계측·레이어 팩토리는 3후보 공통. **엔진 어댑터만 분리** — 비교의 공정성은 여기서 나온다.

### 2-2. 엔진 어댑터 계약 (`engines/types.ts`)

```ts
interface EngineHandle {
  /** 5초 틱마다 새 payload 주입 — naive 교체(새 배열 참조)를 일부러 사용 */
  setPayload(p: Payload): void;
  /** 카메라 스크립트 스텝 실행. 완료 Promise. */
  flyTo(step: CameraStep): Promise<void>;
  /** lngLat → 화면 px (픽킹 오차 검사용) */
  project(lngLat: [number, number]): { x: number; y: number };
  /** deck 픽킹 프록시 */
  pickObject(opts: { x: number; y: number; radius: number }): PickInfo | null;
  pickObjects(opts: { x: number; y: number; width: number; height: number }): PickInfo[];
  /** 현재 카메라 pose 스냅샷 (동일 pose 재현 검사용) */
  getCameraPose(): CameraPose;
  destroy(): void;
}

interface CameraStep {
  center: [lon: number, lat: number];
  zoom: number;
  bearing?: number;   // C는 미지원 — 어댑터가 무시하고 로그에 'bearing skipped' 기록
  pitch?: number;     // 동일
  durationMs: number;
}
```

- **C의 bearing/pitch 미지원**(GlobeView 공식 제약: "No support for rotation")은 어댑터가 조용히 무시하되 로그에 남긴다. RESULT 매트릭스에 "회전 시퀀스 N/A" 명기 — 감점 요소로 기록하지, 스킵으로 숨기지 않는다.

### 2-3. 후보별 어댑터 요점

**A (`engine-a.ts`):**

```ts
const map = new maplibregl.Map({
  container, style: 'https://tiles.openfreemap.org/styles/dark',
  center: [139.7, 35.6], zoom: 1.5,
});
map.on('style.load', () => map.setProjection({ type: 'globe' }));
const overlay = new MapboxOverlay({ interleaved: false, layers: makeLayers(payload) });
map.addControl(overlay);
```

- **`sky` 스펙 절대 추가 금지** — mercator 전용, globe에서 깨짐 (maplibre #5230, basemap-tiles.md 실측). 대기광이 필요하면 확인만 하고 스타일은 건드리지 않는다.
- **overlay는 globe 설정 후에 attach** — #9466이 attach 순서에 따라 다르게 깨진다고 보고됨. 순서를 코드 주석으로 고정하고, 시간 남으면 역순도 1회 실험해 로그만 남긴다.
- 런타임 globe↔mercator 수동 토글 금지 (#9466) — `GlobeControl` 넣지 않는다.

**B (`engine-b.ts`):** `engine-a.ts`의 팩토리를 그대로 import, `{ interleaved: true }`만 다르게. 코드 중복 0.

**C (`engine-c.ts`):**

```ts
new Deck({
  views: new _GlobeView(),
  initialViewState: { longitude: 139.7, latitude: 35.6, zoom: 1.5 },
  controller: true,
  layers: [countriesLayer, ...makeLayers(payload)],
  parameters: { clearColor: [0.04, 0.04, 0.05, 1] },  // 다크 배경 — 베이스맵 없음
});
```

- 국경: `fixtures/ne_110m_countries.geojson` → `GeoJsonLayer` (stroke만, fill 없음). 네트워크 의존 0.
- 텍스처 구·타일 시도 금지 (TileLayer는 GlobeView에서 experimental — 스파이크 범위 밖).

---

## 3. 페이로드(fixture) 설계

### 3-1. 결정: 시드 고정 합성 데이터

실 API 배제. `mulberry32(42)` 하나에서 전 페이로드 생성 — **같은 시드 = 같은 배열 = 후보 간·재실행 간 결정론.** 틱 t의 상태도 `f(seed, t)`로 순수 함수 (재실행하면 같은 60초가 재현된다).

### 3-2. 구성 (PLAN §9 페이로드 그대로)

| 항목 | 수량 | 레이어 | 생성 규칙 |
|---|---|---|---|
| 이벤트 점 | 30,000 | `ScatterplotLayer` | 구면 균등 분포 (`lon=360u-180`, `lat=asin(2v-1)`). 반경 3~8px, 색 4종. 정적 (틱 무관) |
| 항공기 | 2,000 | `SimpleMeshLayer` (주) / `ScatterplotLayer` (예비) | 초기 위치 균등 + `heading` 0~360 + 속도 상수. 틱마다 heading 방향 전진. **±180 경도 wrap 필수** — 의도적으로 200대를 날짜변경선 부근(lon 170~-170)에 배치 |
| 경로 | 200 | `ArcLayer` (`greatCircle: true`) | 도시쌍 랜덤 200개. 정적. 30개는 날짜변경선 횡단 쌍으로 강제 |
| 라벨 | 50 | `TextLayer` (billboard 기본) | 주요 도시 50개 하드코딩 (남반구 15개 이상 포함 — 텍스트 반전 검사는 남반구·림 근처에서 잘 드러남) |
| **센티널** | 12 | 위 점 30k에 포함 (id `sentinel-0..11`) | **고정 좌표 12점** — 픽킹·마커 소실 검사 전용. 배치: 날짜변경선 걸침 4점 (lon ±179.9, lat 0/±40), 극지 2점 (lat ±75), 중앙권 6점 (검사 pose에서 림 근처/중앙에 오도록 §4-3에서 좌표 확정) |

**항공기 회전 표현 (IconLayer 금지 — #9554 대안):**

- **주안:** `SimpleMeshLayer` + 코드로 만든 삼각형 메시(정점 3개, `new Geometry({...})`) 인스턴싱. `getOrientation: d => [0, -d.heading, 0]` (yaw). 이것이 Phase 0에서 실제로 쓸 방식이므로 **globe 위 SimpleMeshLayer 동작 여부 자체가 스파이크 검증 항목**이다.
- **예비:** SimpleMeshLayer가 globe에서 깨지면 같은 데이터로 `ScatterplotLayer` 폴백(방위 표현 포기)을 5분 안에 전환할 수 있게 `layers.ts`에 플래그 (`?mesh=0`). 깨짐 자체를 RESULT에 기록 — 이게 Phase 0 항공기 렌더 방식을 결정한다.

### 3-3. 5초 틱 시뮬레이션 (`ticker.ts`)

- `setInterval(5000)` × 12회 = 60초. 매 틱 항공기 2,000개의 **새 배열**을 생성해 `setPayload()` — 참조 교체로 attribute 전체 재생성을 유발하는 **최악 케이스를 일부러** 측정한다 (합격 기준 6이 이 조건에서의 프레임 드롭이므로).
- 30k 점·경로·라벨은 틱에서 참조 유지 (항공기만 교체 — 실서비스와 동일한 갱신 패턴).
- 틱 번호를 로그 패널에 표시. 각 틱 직후 1초간의 프레임 시간을 §4-6이 수집.

---

## 4. 측정 계측 설계 (합격 기준 6개 ↔ 측정 방법 1:1)

### 자동/육안 구분 총괄

| # | 기준 | 방식 |
|---|---|---|
| 1 | FPS ≥ 50 | **자동** (rAF 수집기 + 카메라 스크립트) |
| 2 | 마커 소실 0 | **자동** (동일 pose pickObjects 카운트 대조 + 센티널 12점 전수) |
| 3 | 픽킹 오차 ≤ 5px | **자동** (project→pick 반경 스캔) |
| 4 | 텍스트 반전·레이어 소실 없음 | **육안 체크리스트** (자동화 비용 > 가치 — 픽셀 판독은 스크린샷 회귀 금지 룰과 충돌) |
| 5 | z0↔z14 왕복 무결 | **반자동** (스크립트 왕복 + 종료 시 자동 카운트 검사, 전환 순간 튐은 육안) |
| 6 | data 교체 프레임 드롭 ≤ 1 | **자동** (틱 직후 프레임 시간 윈도 분석) |

과잉 자동화 금지: Playwright 없음, CI 없음, 스크린샷 diff 없음. 사람이 브라우저 열고 `auto=1` 한 번 돌리면 1·2·3·5·6이 JSON으로 나오고, 4와 5의 육안 항목만 체크리스트로 남긴다.

### 4-1. 기준 1 — FPS ≥ 50 (`fps.ts` + `camera-script.ts`)

- **수집:** `requestAnimationFrame` 루프에서 프레임 간 delta(ms) 전량 배열 수집. 계산 지표: 1초 슬라이딩 윈도 평균 FPS의 **최소값**, 중앙값 FPS, p95 프레임 시간(ms).
- **합격 판정: 카메라 스크립트 구간 전체에서 1초 윈도 평균 FPS 최소값 ≥ 50** (M-series 기준). 시작 첫 1초(초기 컴파일/업로드)는 워밍업으로 제외.
- **자동 카메라 스크립트 (총 ~30초, 3후보 동일):**

  | 스텝 | 내용 | 시간 |
  |---|---|---|
  | 1 | 팬: 도쿄 → 뉴욕 → 상파울루 (easeTo 체인) | 9s |
  | 2 | 줌인: z1.5 → z6 (런던) | 5s |
  | 3 | 회전: bearing 0→180→0 @ z3 (**C는 N/A — 로그 기록**) | 6s |
  | 4 | 날짜변경선 횡단 팬: lon 160 → -160 | 5s |
  | 5 | 줌아웃 z6 → z1.5 + 관성 팬 | 5s |

- 주사율 함정: 120Hz 디스플레이면 rAF 상한이 다르다 — 환경 표에 디스플레이 Hz 기록, 판정은 FPS 값 그대로 (50은 60Hz/120Hz 어디서든 유효).

### 4-2. 기준 2 — 마커 소실 0 (#9554 회귀) (`probes.ts`)

이중 검사, 둘 다 자동:

1. **동일 pose 카운트 대조:** 검사 pose P(고정: center [139.7, 35.6], z2, bearing 0)에서 시작 직후 `pickObjects({전체 뷰포트})` 카운트 = N₀ 기록 → 30초 카메라 스크립트 실행 → **pose P로 복귀** → 같은 호출로 N₁. **판정: N₁ = N₀.** 같은 pose·같은 정적 데이터면 카운트는 결정론적이어야 한다 (항공기는 틱으로 움직이므로 카운트 대상에서 제외 — `layerIds`로 30k 점 레이어만).
2. **센티널 전수:** pose P에서 보이는 반구에 놓인 센티널(§3-2)을 각각 `project → pickObject(radius 8)`. **판정: 예상 가시 센티널 전부 hit.**

- `pickObjects`의 `maxObjects` 상한 주의 — 30k 전수 대신 뷰포트를 4분할해 호출하거나 `maxObjects: 50000` 명시.
- 이 카운트 로그가 CLAUDE.md의 "DOM 로그 패널 스냅샷" 역할을 겸한다.

### 4-3. 기준 3 — 픽킹 오차 ≤ 5px (`probes.ts`)

- **케이스 자동 배치 (3픽 pose 고정):**
  - **중앙:** pose P 화면 중앙 부근 센티널 1점 (대조군)
  - **림 근처:** pose P에서 카메라 중심으로부터 각거리 ~80°인 센티널 2점 (지구 원반 가장자리) — 좌표는 pose P 기준으로 미리 계산해 §3-2 센티널에 박아둔다
  - **날짜변경선:** center [179.9, 0] pose로 이동 후 lon ±179.9 센티널 4점
- **측정:** `screen = project(lngLat)` → `pickObject({x, y, radius: r})`을 r = 0, 1, 2, … 10으로 증가시키며 첫 hit의 r을 오차로 기록. hit 대상 id가 해당 센티널인지 확인 (다른 점을 잡으면 miss로 처리하고 계속).
- **판정: 전 케이스 오차 ≤ 5px.** r=10까지 miss면 "픽킹 불능"으로 기록 (오차 ∞ — 사실상 #9554/#9592 계열 증거).

### 4-4. 기준 4 — 텍스트 반전·레이어 소실 (#9592) — 육안 체크리스트

자동화하지 않는 이유: "위아래 뒤집힌 텍스트"의 프로그램 판정은 픽셀 판독 = 스크린샷 회귀 금지 룰과 충돌하고, 1.5일 예산 초과. 대신 **RESULT.md에 넣을 고정 체크리스트** (후보별 O/X):

- [ ] 남반구 라벨(시드니·상파울루·케이프타운) 텍스트 정립 (반전 없음)
- [ ] 림 근처 라벨 정립·판독 가능
- [ ] 지구 회전 중 deck 레이어(점·항공기·경로)가 지구 **뒤로** 사라지지 않음 (뒷면으로 넘어간 데이터가 안 보이는 건 정상, 앞면 데이터가 지구에 먹히는 게 버그)
- [ ] ArcLayer 호가 지표를 뚫고 들어가지 않음
- [ ] **라벨 과대/차폐 없음** (basemap-tiles.md 지적: OpenFreeMap dark 자체 라벨과 deck TextLayer 이중 표시 — 저줌에서 라벨 크기 비정상·상호 차폐 여부. A/B만 해당)
- [ ] 베이스맵 자체 렌더 정상 (타일 구멍·투영 깨짐 없음)

각 항목은 카메라 스크립트 스텝 3(회전)과 스텝 4(날짜변경선) 중에 관찰. 소요 후보당 ~3분.

### 4-5. 기준 5 — z0↔z14 왕복 무결 (반자동)

- 스크립트: pose P → `flyTo(z14, 도쿄)` → 3초 대기 → `flyTo(z1.5)` → pose P 복귀 → §4-2의 카운트 검사 재실행. **자동 판정: 카운트 보존 + JS 에러 0.**
- **육안 (globe→mercator 전환 구간, z~12):** 전환 순간 deck 레이어 튐/이중상/스케일 점프 여부. 체크리스트 1항목.
- C는 z12+ 고정밀 미지원(공식 제약)이므로 z14에서의 지터를 육안 항목에 추가.

### 4-6. 기준 6 — data 교체 프레임 드롭 ≤ 1 (자동)

- 틱(§3-3) 직후 1초 윈도의 프레임 시간을 태깅 수집. **드롭 프레임 정의: 프레임 시간 > 33.4ms** (60Hz 기준 2프레임 예산 초과).
- **판정: 12회 틱 각각에서 드롭 프레임 ≤ 1.** 결과는 틱별 배열로 기록 (`[0,1,0,0,...]`) — 평균으로 뭉개지 않는다.
- 카메라 정지 상태(pose P)에서 측정 (인터랙션 FPS와 교란 분리). 측정 중 마우스 입력 금지를 로그 패널에 안내 문구로 표시.

### 4-7. 로그 패널 (`panel.ts`)

- 화면 우하단 고정 DOM. 표시: 엔진 id, 틱 번호, 실시간 FPS, 마지막 검사 결과, JS 에러 카운트 (`window.onerror` 후킹).
- `auto=1` 종료 시 결과 전체를 JSON으로 표시 + "복사" 버튼 → RESULT.md 부록에 그대로 붙인다.

---

## 5. 결과 기록 양식 — `docs/spike/RESULT.md` 템플릿

````markdown
# Phase -1 엔진 스파이크 — 결과 (RESULT.md)

## 환경 (필수 — 이거 없는 수치는 무효)

| 항목 | 값 |
|---|---|
| 기기 / SoC / RAM | 예: MacBook Pro 14 M3 Pro / 18GB |
| 디스플레이 주사율 | 예: 120Hz (ProMotion) |
| 브라우저 + 버전 | 예: Chrome 139.x |
| maplibre-gl / deck.gl 실제 해석 버전 | `npm ls` 출력 |
| OS | macOS xx.x |
| 측정일 | 2026-08-xx |
| 저사양 기기 측정 여부 | 했음/안 했음 (안 했으면 리스크로 명기) |

## 판정 매트릭스 (후보 × 기준)

| # | 기준 | A (overlaid) | B (interleaved) | C (_GlobeView) |
|---|---|---|---|---|
| 1 | FPS ≥ 50 (1초 윈도 최소값) | __ fps | __ fps | __ fps (회전 N/A) |
| 2 | 마커 소실 0 (N₀=__ / N₁=__ / 센티널 __/12) | ✅/❌ | ✅/❌ | ✅/❌ |
| 3 | 픽킹 오차 ≤ 5px (중앙/림/날짜변경선 최대) | __ px | __ px | __ px |
| 4 | 텍스트 반전·레이어 소실 없음 (육안 6항목) | __/6 | __/6 | __/6 |
| 5 | z0↔z14 왕복 무결 | ✅/❌ | ✅/❌ | ✅/❌ (z12+ 지터: __) |
| 6 | data 교체 드롭 ≤ 1 (틱 12회 최대 드롭) | __ | __ | __ |
| — | SimpleMeshLayer(항공기 회전) globe 동작 | ✅/❌ | ✅/❌ | ✅/❌ |
| — | 종합 | **합격/불합격** | (판정 대상 아님 — 재현 기록) | **합격/불합격** |

## 육안 체크리스트 상세 (§4-4 항목별, 후보별 O/X + 한 줄 관찰)

## 판정 규칙 (측정 전에 고정 — 사후 조정 금지)

1. **A가 기준 1·2·3·4·5·6 전부 통과 → A 확정.** C는 실행 확인 수준만 기록해도 됨. B 결과는 interleaved 금지 목록의 실측 근거로 첨부.
2. **A가 하나라도 실패 → C 전체 측정.** C 전부 통과 → C 채택 (= 베이스맵 타일 포기 + 국경 GeoJSON 결정을 PLAN §8.2에 반영해야 함 — 코디네이터 에스컬레이션).
3. **A·C 모두 실패 → 폴백 최종단: mercator 3D(pitch) 컨셉 수정.** 스파이크 워커가 결정하지 않는다 — RESULT에 실패 수치를 적고 에스컬레이션 (PLAN §9 폴백 래더, Globe Experience 우선순위 부정이므로 계획 개정 사안).
4. **회색지대:** 기준 미달 폭 10% 이내(예: FPS 46)면 실패로 판정하되 "근소 실패" 표기 + 원인 프로파일(attribute 재생성? 오버드로?) 1문단 첨부. 기준을 깎아 통과시키지 않는다.
5. SimpleMeshLayer 실패 + 나머지 통과 → 엔진은 합격, **항공기 렌더 방식만 ScatterplotLayer로 확정** (별도 행 기록).

## 원시 데이터 부록

(auto=1 JSON 덤프를 후보별로 붙인다)
````

---

## 6. 작업 순서와 타임박스 (1.5일 = 12h)

| # | 작업 | 예산 | 완료 기준 |
|---|---|---|---|
| 1 | 스캐폴드: `spike/` vite+ts, 의존성 설치, `?engine=` 셸, 빈 캔버스 | 0.5h | `npm run dev` + typecheck 통과 |
| 2 | 페이로드: rng + generate(30k/2k/200/50 + 센티널 12) + ticker | 1.5h | 콘솔에서 생성물 카운트·시드 재현 확인 |
| 3 | 계측: fps + camera-script + probes + panel | 1.5h | 더미 엔진에서 JSON 덤프 나옴 |
| 4 | **후보 A**: maplibre globe(OpenFreeMap dark, sky 금지) + overlaid + 레이어 4종 + SimpleMeshLayer 항공기 | 2.5h | 화면에 전 레이어 + 틱 동작 |
| 5 | **후보 B**: interleaved 플래그 분기 | 0.5h | 동일 화면 (깨져도 OK — 그게 데이터) |
| 6 | **후보 C**: `_GlobeView` + 국경 GeoJsonLayer + 동일 레이어 | 1.5h | 화면 + 틱 동작 (bearing N/A 로그) |
| 7 | 측정 실행: 후보 3개 × (`auto=1` 1회 + 육안 체크 3분) + 재실행 1회로 재현성 확인 | 2.0h | 후보별 JSON + 체크리스트 확보 |
| 8 | RESULT.md 작성 + 판정 | 1.0h | 매트릭스 완성, 판정 규칙 적용 |
| 9 | 버퍼 (SimpleMeshLayer 폴백 전환, OpenFreeMap 장애 대응 등) | 1.0h | — |

**타임박스 규율:**

- 스텝 4가 3.5h를 넘으면 (예산+1h) 즉시 에스컬레이션 — "A가 그냥 안 뜬다"는 그것 자체가 중대 발견이다.
- 스텝 7에서 후보 A가 판정 규칙 1로 확정되면 C 측정은 실행 확인(15분)으로 축소 가능 — 남는 시간은 저사양 측정 또는 조기 종료.
- 총 12h 소진 시점에 남은 항목은 "미측정"으로 RESULT에 정직하게 기록하고 종료. 미측정을 통과로 적지 않는다.

---

## 부록 — 하드 룰 재확인 (구현 워커 체크용)

- [ ] maplibre-gl **~5.24.0** 핀, v6 금지 (PR #10566)
- [ ] overlaid만 본 판정 — `interleaved: true`는 후보 B의 재현 실험 안에서만 존재
- [ ] **IconLayer 금지** — 항공기는 SimpleMeshLayer(주)/ScatterplotLayer(예비)
- [ ] HeatmapLayer/ContourLayer/MaskExtension 미사용
- [ ] 런타임 globe↔mercator 토글 UI 없음
- [ ] **`sky` 스펙 스타일에 추가 금지** (mercator 전용 — maplibre #5230)
- [ ] 타일: `https://tiles.openfreemap.org/styles/dark` (키 불요)
- [ ] 실 API 호출 0 (합성 데이터만) — E2E/실API 물리기 금지 룰과 일치
- [ ] WebGL 스크린샷 회귀 없음 — pickObjects 단정 + 프레임 시간 + DOM 로그 패널
- [ ] 좌표는 전부 `[lon, lat]` 순서 (GeoJSON 계약)
- [ ] spike 코드 → main src 승격 금지 (RESULT.md 수치만 승격)

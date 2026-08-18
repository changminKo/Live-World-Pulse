# 검토 B — 프론트엔드 아키텍처 / 렌더링 엔진 (Live World Pulse)

조사일 2026-08-18. 코드 없음 → 계획서 자체 검토. 파일 생성/수정 없음.

## 0. 세 줄 결론

1. **14번(MapLibre+deck.gl)과 34번(Globe Experience 최우선)은 양립한다. 단 계획서가 모르는 조건이 붙는다.** MapLibre globe projection은 v5.0.0부터 정식 기능이고 deck.gl 9.1부터 3개 통합 모드 모두 지원한다. 그러나 (a) **maplibre-gl v6과 deck.gl 9.3.10 통합은 현재 깨져 있다** — v6 카메라 리팩터가 `MapboxOverlay`가 의존하는 private `map.transform`을 제거했고, 대체 패키지 `@deck.gl/maplibre`는 **아직 npm에 없다(오픈 PR)**. (b) globe 위 deck.gl 레이어에 미해결 버그가 남아 있다(IconLayer 소멸, 텍스트 상하 반전, interleaved 깊이/컬링). → **문서만으로 결정 불가. 1~2일 스파이크 필수.**
2. **스택(13번)은 Next.js·IndexedDB가 과잉, 결정적으로 빠진 게 3개**다 — 베이스맵 타일 소스/스타일, API 키 프록시, **시계열 보간(interpolation)**. 특히 보간 없이는 9번 Time Replay와 항공기 레이어가 성립하지 않는다. TripsLayer는 CPU 보간을 해주지 않는다(문서 명시).
3. **8번 "모든 Layer 같은 시간 기준 동기화"는 현 문장 그대로는 구현 불가능한 요구**다. 지진(instant)·항공기(sampled state)·기상경보(interval)·뉴스(decay window)는 시간 의미론이 다르다. 16번 `WorldEvent` 스키마가 point-in-time 점 이벤트만 표현 가능해서, Phase 2에서 반드시 스키마 리팩터로 터진다. **지금 고쳐야 할 1순위.**

---

## 1. 엔진 판정과 근거

### 1-1. MapLibre GL JS globe projection 현황

- Globe projection은 **MapLibre GL JS 5.0.0 (2025-01)** 에서 정식 릴리스. 실험 플래그 아님. [확인됨: https://maplibre.org/roadmap/maplibre-gl-js/globe-view/ , maplibre-gl 5.0.0]
- 최신 버전 **maplibre-gl 6.4.0 (2026-08-16 published)**. 5.x 계열 마지막은 **5.24.0 (2026-04-23)**. 6.0.0은 2026-07-22. [확인됨: registry.npmjs.org/maplibre-gl dist-tags/time]
- globe는 **줌 ~12에서 자동으로 mercator로 전환**된다. 이유는 float32 정밀도 — "one float32 value per 2.5 meters" 수준이라 고줌 globe는 정밀도가 깨진다. 전환은 애니메이션으로 부드럽게 처리. [확인됨: https://github.com/maplibre/maplibre-gl-js/blob/main/developer-guides/globe.md]
- v6 breaking changes: **WebGL2 필수(WebGL1 제거), ESM only(UMD·CSP 빌드 삭제, `maplibre-gl.mjs`)**, `#pragma mapbox`→`#pragma maplibre`, `zoomLevelsToOverscale` 기본값 4로 변경(queryRenderedFeatures/폴리곤 라벨에 부작용 가능), 이벤트가 클래스로 변경(`instanceof` 대신 `type` 검사), `styleimagemissing` 핸들러에서 `addImage()` 직접 호출 금지. [확인됨: https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/]

**판정:** "완전한 3D globe 경험에서 Cesium보다 제한적일 수 있음"(14번)은 **2026년 기준 틀린 서술**이다. globe 자체는 정식 지원된다. 실제 제약은 다른 곳에 있다 → 아래.

### 1-2. globe 위 deck.gl 레이어 — 실제로 동작하는가

**공식 입장:** "Maplibre's globe projection is fully supported." "deck.gl now works seamlessly with the MapLibre v5 globe view for all three Basemap Integration Modes." MapboxOverlay는 별도 설정 없이 globe 맵에서 동작. deck.gl **9.1 (2025-01-21)** 에서 MapLibre 팀과 협업해 들어갔다. [확인됨: https://deck.gl/docs/api-reference/mapbox/overview , https://deck.gl/docs/whats-new , deck.gl 9.1]

**그런데 문서가 v5까지만 말한다.** v6 언급이 없다. 그리고 실제 상태는 이렇다.

> **[확인됨 — 결정적] deck.gl PR #10566 "Add @deck.gl/maplibre for MapLibre GL JS v4/5/6" (open, created 2026-08-16, updated 2026-08-17):**
> "MapLibre v6 makes a dedicated integration timely. It is WebGL2-only and ESM-only, and **its camera refactor removed the private `map.transform` object that `MapboxOverlay` depends on**."
> URL: https://github.com/visgl/deck.gl/pull/10566

→ **즉 maplibre-gl 6.x + deck.gl 9.3.10(`@deck.gl/mapbox`) 조합은 지금 성립하지 않는다.** 그리고 대체 패키지 `@deck.gl/maplibre`는 **npm에 존재하지 않는다(registry 404)**. [확인됨: `curl registry.npmjs.org/@deck.gl%2Fmaplibre` → `{"error":"Not found"}`]

**현재 열려 있는 globe 관련 버그 (모두 미해결):**

| 이슈 | 상태 | 내용 |
|---|---|---|
| [#9592](https://github.com/visgl/deck.gl/issues/9592) `[Bug] MapLibre Globe Integration` | **open**, 2025-04-18 생성 / **2026-04-20 갱신**, 하위 이슈 2개 중 0개 완료 | interleaved 시 deck 레이어가 globe **뒤로 들어감**(depth 조정으로도 해결 안 됨), **텍스트가 상하 반전**, 컬링 문제 |
| [#9554](https://github.com/visgl/deck.gl/issues/9554) `[Bug] Icon Layer on Globe Projection` | **open**, 2025-03-29 생성 / **2026-04-01 갱신** | mercator는 정상. globe에서 **IconLayer 아이콘이 인터랙션 후 사라지고**, 좌표가 틀림(플로리다 점이 원점에 렌더). **interleaved·overlaid 양쪽 모두 재현**. deck.gl ^9.1.0 |
| [#9466](https://github.com/visgl/deck.gl/issues/9466) `[Bug] Deck with Maplibre Globe synchronization issue` | **open**, 2025-02-25 생성 / **2026-04-19 갱신** | `GlobeControl`로 globe↔mercator 전환 시 deck 레이어가 **변형됨**. MapboxOverlay를 globe 켜기 전/후 어느 순서로 붙이냐에 따라 다르게 깨짐 |
| [#9357](https://github.com/visgl/deck.gl/issues/9357) BitmapLayer on globe | closed 2025-08-13 | 참고: globe 위 래스터 계열은 수정 이력 있음 |

**모드별 판정:**
- **overlaid (`MapboxOverlay`, 기본):** deck이 자기 캔버스에 별도 렌더 → 두 렌더러가 독립적이라 공식 문서도 "more robust"라고 표현. **globe에서도 이쪽이 안전한 쪽.** 단 #9554(Icon), #9466(전환 시 변형)은 여기서도 재현. 그리고 maplibre Popup/컨트롤이 deck 위로 올라오는 z-order 이슈([#8530](https://github.com/visgl/deck.gl/issues/8530))가 있어 DOM 팝업을 쓸 거면 확인 필요.
- **interleaved (`interleaved: true`):** WebGL2 필요, `maplibre-gl@>3`. deck 레이어를 maplibre 레이어 스택에 `beforeId`로 끼워넣어 깊이 정렬 가능. **하지만 globe에서 #9592의 깊이/컬링/텍스트 반전이 정확히 이 모드의 문제다.** MVP에서 쓰지 말 것.
- **reverse-controlled:** deck이 위, maplibre 인터랙션 차단. maplibre 컨트롤·플러그인 사용 불가(`@deck.gl/widgets`로 대체). 이 프로젝트엔 부적합(지도 인터랙션이 핵심).

**[의견]** 실무 결론: **overlaid 고정. interleaved는 MVP 금지.** 그리고 **IconLayer를 항공기에 쓰지 말 것** — 회전 아이콘(방위각)이 정확히 #9554가 깨뜨리는 케이스다. 대안: `ScatterplotLayer`(방위 표현 포기) 또는 `ScenegraphLayer`/커스텀 `SimpleMeshLayer`로 삼각형 메시 인스턴싱(방위각 = `getOrientation`). 이건 스파이크에서 검증해야 한다.

### 1-3. deck.gl `_GlobeView` (MapLibre 없이 deck 단독)

- **여전히 experimental.** 문서 원문: "This class is experimental, which means it does not provide the compatibility and stability that one would typically expect from other `View` classes." [확인됨: https://deck.gl/docs/api-reference/core/globe-view , deck.gl 9.3.x]
- 명시된 제약 [확인됨, 동일 URL]:
  - **"No support for rotation (`pitch` or `bearing`). The camera always points towards the center of the earth, with north up."**
  - **"No high-precision rendering at high zoom levels (> 12)."** (MapLibre globe의 z12 mercator 전환과 같은 원인)
  - `coordinateSystem`은 **`'lnglat'` 전용**.
  - GlobeView + MapView 혼용/전환 시 렌더링 이슈 알려짐.
  - `TileLayer`, `MVTLayer` 지원은 **experimental**.
  - **미지원:** `HeatmapLayer`, `ContourLayer`, `MaskExtension`. (`TerrainLayer`는 9.3에서 지원 추가)
  - GeoJSON path/polygon은 직선/평면이 구면으로 **워프**됨. 최단경로 선은 `GreatCircleLayer` 사용.
- 9.3에서 개선: TerrainLayer / `_TerrainExtension` / Tile3DLayer가 GlobeView에서 정상 렌더, back-face culling 기본 활성. [확인됨: whats-new v9.3]
- **`GlobeController`의 tilt/inertia/pan은 v9.4.0-alpha.1(2026-07-16)에 들어갔다 — 안정 버전 9.3.10에는 없다.** [확인됨: GitHub releases, "feat(core): GlobeController with inertia, tilt & pan (#10298)"]
- 졸업 트래커 [#9199](https://github.com/visgl/deck.gl/issues/9199) **open, 2024-10-03 생성 / 2026-06-23 갱신.** 남은 과제로 **view-state 제약 모델, globe-aware 보간(카메라 트랜지션), MapLibre projection 동기화, billboard/컬링 불일치, path·polygon geometry subdivision**이 명시돼 있다.
  → **path/polygon subdivision이 미완이라는 건 ArcLayer·PathLayer·TripsLayer(태풍 경로, 항공 경로)가 globe에서 아직 신뢰 대상이 아니라는 뜻이다.** 이 프로젝트가 쓰려는 레이어와 정확히 겹친다.

### 1-4. CesiumJS + Resium 대안 — 실제 무게

- **cesium 1.144.0 (2026-08-04)**, npm tarball unpacked **141.1 MB**. **resium 1.25.0 (2026-08-07)**, unpacked 0.8 MB, peer `cesium: 1.x`, `react >=18.2.0`. [확인됨: registry.npmjs.org]
- `Viewer` 모듈을 import하면 번들이 **약 23 MB 증가**한다는 커뮤니티 보고. tree-shaking으로 개별 모듈 import는 가능하지만, Viewer/Scene을 쓰는 순간 대부분 끌려온다. Cesium은 코드 외에 **Assets/Workers/Widgets 정적 파일을 따로 서빙**해야 해서 빌드 설정 부담도 있다. [확인됨: https://community.cesium.com/t/large-bundle-size/10724 , https://cesium.com/blog/2022/07/19/build-tooling-updates-coming-to-cesiumjs/]
- **웹 성능 규칙(landing < 150KB gz)과 두 자릿수 MB는 같은 문장에 들어갈 수 없다.** 포트폴리오 첫 로딩이 곧 첫인상인 프로젝트에서 이건 실점 요인이다. [의견]
- **deck.gl 연동: 공식 경로 없음.** deck.gl 공식 베이스맵 목록은 ArcGIS / Google Maps / harp.gl / Leaflet / Mapbox GL JS / MapLibre GL JS / OpenLayers / Apple Maps — **Cesium은 없다**. Cesium과의 협업은 **OGC 3D Tiles 스펙 지원(Tile3DLayer)** 에 한정된다. Cesium 연동은 커뮤니티 디스커션([#8415](https://github.com/visgl/deck.gl/discussions/8415)) 수준. [확인됨: https://deck.gl/docs/get-started/using-with-map]
- **Cesium의 진짜 강점은 이 계획서와 정확히 맞는 부분이 하나 있다:** Cesium은 `Clock` / `JulianDate` / `SampledPositionProperty`(내장 시간 보간) / CZML 을 갖고 있다. 즉 **8·9번(Timeline·Time Replay)과 항공기 보간을 프레임워크가 공짜로 준다.** deck.gl에는 이에 대응하는 기능이 없다(직접 만들어야 함). [확인됨: Cesium 시간 동태 API — 개념 수준]
- 반면 **30k~300k 포인트**에서 Cesium `Entity` API는 느리다. `PointPrimitiveCollection`/`BillboardCollection` 저수준 API로 내려가야 하고, 그 순간 Resium의 선언적 이점이 사라진다. 그리고 32번 포트폴리오 포인트 1번이 "Massive Data Rendering"이다. [의견]

**판정: MVP에서 Cesium 탈락.** 번들 무게 + 대량 포인트에서 저수준 API 강제 + deck.gl 공식 연동 부재. 단 **"보간·시간축을 프레임워크가 준다"는 점은 인정하고, deck.gl을 택하면 그 보간을 우리가 직접 만들어야 한다는 비용을 계획서에 적어야 한다.**

### 1-5. three.js / react-globe.gl 대안

- **three 0.185.1 (2026-07-01, min 0.69MB / gzip 178.5KB)**, **react-globe.gl 2.38.0 (2026-05-16)**, globe.gl 2.46.1. [확인됨: registry.npmjs.org, bundlephobia]
- react-globe.gl은 three-globe 래퍼. 예쁜 데모용으로 훌륭하다. 하지만 이 프로젝트에는 **없는 것이 너무 많다**: 벡터 타일 베이스맵 없음(텍스처 구 + GeoJSON 국경만), 줌 기반 LOD 없음, 시간축 없음, GPU picking이 대량 포인트에서 정식 지원 아님, 클러스터링 없음, 좌표계/투영 유틸 없음. `pointsData`는 병합 지오메트리 방식이라 수만 개는 렌더는 되지만 개별 픽킹·부분 업데이트가 어렵다.
- **[의견] 판정: 부적합.** 이걸 택하면 결국 deck.gl이 이미 가진 것(attribute 관리, picking, LOD, 타일링)을 직접 재구현하게 된다. 포트폴리오 서술상으로도 "deck.gl 대신 three로 직접 만들었다"는 32번의 GPU Rendering 항목을 오히려 약화시킨다(바퀴 재발명 = 판단력 감점).

### 1-6. 최종 엔진 권고

**권고 조합 (MVP):**

```
maplibre-gl  ^5.24.0        ← v6 아님. 의도적 핀 고정.
deck.gl      ^9.3.10        (@deck.gl/mapbox MapboxOverlay)
mode         overlaid       (interleaved: false)
projection   globe          (z12 이후 mercator 자동 전환을 UX로 수용)
```

**왜 v6가 아니라 v5.24인가 (가장 중요한 실무 판정):**
maplibre-gl v6는 `MapboxOverlay`가 쓰는 private `map.transform`을 제거했다. 대체 `@deck.gl/maplibre`는 오픈 PR이고 npm에 없다. → **오늘 v6를 쓰면 deck.gl 통합이 안 된다.** v5.24.0은 globe projection 정식 지원(5.0+)을 이미 갖고 있으므로 기능 손실이 없다. `@deck.gl/maplibre`가 릴리스되면 그때 v6로 올린다. **이 결정을 계획서에 명시하고, `package.json`에 `~5.24.0`으로 핀하고, 이유를 주석으로 남길 것.** [확인됨: PR #10566 본문]

**금지 목록 (MVP):**
- `interleaved: true` → #9592
- globe 위 `IconLayer` → #9554
- globe 위 `HeatmapLayer` / `ContourLayer` / `MaskExtension` → GlobeView 미지원 (overlaid+MapboxOverlay는 MapView 경로일 수 있으나, globe 카메라와 히트맵 조합은 별도 검증 필요)
- 런타임 globe↔mercator 수동 토글 버튼 → #9466

### 1-7. **문서만으로 결정 불가. 스파이크 필수.** — 명확한 답

**결론: 스파이크 없이 결정하면 안 된다.** 근거는 "잘 모르겠다"가 아니라 구체적이다. 계획서가 쓰려는 레이어 집합(회전 아이콘 = 항공기, Arc/Trips = 태풍·항로, Text = 라벨)이 **현재 열려 있는 globe 버그와 정확히 1:1로 겹친다**. 문서는 "fully supported"라고 하고 이슈 트래커는 2026-04까지 갱신된 미해결 버그를 보여준다. 이 불일치는 코드로만 해소된다.

**스파이크 설계 (권고: 1.5일, Phase 0보다 앞. "Phase -1")**

3개 후보를 **같은 데이터셋·같은 측정 기준**으로 비교:

| 후보 | 구성 |
|---|---|
| **A** | maplibre-gl 5.24 globe + deck.gl 9.3.10 `MapboxOverlay` **overlaid** |
| **B** | 동일 + **interleaved: true** (버그 재현 확인용, 탈락 예상) |
| **C** | deck.gl **단독 `_GlobeView`** (maplibre 없음, 텍스처 구 + GeoJsonLayer 국경) |

**동일 페이로드:** ScatterplotLayer 30,000점 / 항공기 2,000개(방위각 회전 필요) / ArcLayer 또는 TripsLayer 200개 경로 / TextLayer 라벨 50개.

**합격 기준 (숫자로):**
1. 팬·줌·회전 중 **지속 FPS ≥ 50** (M-series 기준), 저사양 노트북 ≥ 30
2. 30초 연속 인터랙션 후 **사라지는 마커 0개** (#9554 회귀 검사)
3. **픽킹 오차 ≤ 5px** — 특히 **지구 테두리(림) 근처**와 **날짜변경선(±180°) 걸침**에서
4. 텍스트 상하 반전 없음, deck 레이어가 지구 뒤로 사라지지 않음 (#9592 회귀 검사)
5. z0 → z14 왕복 시 mercator 전환 구간에서 레이어 튐/변형 없음
6. `data` 배열 교체(항공기 5초 틱) 시 **프레임 드롭 ≤ 1프레임**

**폴백 래더:** A 실패 → C(단독 GlobeView, 베이스맵 타일 포기하고 국경 GeoJSON) → 그래도 실패 → **globe 포기하고 mercator 3D(pitch 있는 평면 지도)로 컨셉 수정.** Cesium은 마지막 수단(번들 비용을 감수한다는 별도 결정이 필요).

**중요:** 폴백 3번(globe 포기)은 34번 최우선순위 "Globe Experience"를 부정한다. 그래서 **이 스파이크가 프로젝트 리스크의 대부분을 앞으로 당겨 해소하는 유일한 수단**이다. Phase 0에서 알게 되면 늦다.

---

## 2. 스택 판정 (13번) — 과잉 / 부족

### 2-1. Next.js — **조건부 과잉. 현재 계획서 조합에서는 과잉이다.**

- WebGL 지도는 **반드시** `dynamic(() => import('./Map'), { ssr: false })` 로 격리해야 한다(maplibre/deck.gl은 import 시점에 `window` 접근). 즉 **앱의 핵심 화면에 SSR은 0의 이득**이다. [확인됨: https://deck.gl/docs/get-started/using-with-react + Next.js dynamic ssr:false 패턴]
- v6의 **ESM-only**는 번들러 설정 이슈를 추가로 만든다(v5.24 핀이면 완화).
- Next.js가 실익을 주는 지점은 딱 3개다: **(a) Route Handler를 BFF로 써서 외부 API 키를 숨긴다, (b) 24번 URL State에 대응하는 동적 OG 이미지 생성, (c) 랜딩/문서 페이지 정적 생성.**
- **그런데 18번에서 이미 별도 API Server(Collector·Normalizer·Storage·Query·Realtime Gateway)를 세운다.** 그러면 (a)가 중복된다. → **Next.js + 별도 API 서버 = 서버 2개. MVP에서 과잉.**

**[의견] 권고: 둘 중 하나로 정하라.**
- **옵션 1 (추천):** **Vite + React + React Router**. SPA 성격에 정직하게 맞음. 빌드 빠름, 설정 단순, RSC 복잡도 0. 별도 API 서버가 BFF와 키 프록시를 담당.
- **옵션 2:** **Next.js를 유일한 백엔드로** 쓰고 18번 별도 API 서버를 없앤다(Route Handler + cron으로 수집). 서버 1개. 단 실시간 게이트웨이(WS)는 Next에서 껄끄러움 → SSE로 대체.
- **옵션 2를 택할 이유가 하나 있다:** (b) OG 이미지. 24번 URL을 슬랙/트위터에 붙였을 때 그 시점 지구본 썸네일이 나오면 포트폴리오 임팩트가 크다. 이건 순수 프론트로는 못 한다.

### 2-2. Zustand — **적절.** 23번 상태 목록과 잘 맞음. 단 `viewport`는 주의 → 3-9 참조.

### 2-3. TanStack Query — **적절하되 경계가 틀릴 위험.**
TanStack Query는 request/response 캐시다. **WebSocket/SSE 스트림을 query cache에 밀어넣는 것은 안티패턴**이다(무한 무효화, 캐시 키 폭발).
**[의견] 권고 경계:**
- **TanStack Query 담당:** 히스토리 스냅샷 조회(`GET /events?from&to&layers&bbox`), 이벤트 상세, 정적 메타. 즉 **타임라인이 과거를 볼 때.**
- **별도 스트림 스토어 담당(Query 아님):** LIVE 모드의 WS/SSE 푸시. 레이어별 **ring buffer**(최근 N분 고정 크기)로 받고, Zustand 또는 순수 mutable ref에 보관. React 리렌더는 초당 1회 이하로 스로틀.
- 이 두 소스가 **같은 정규화 함수를 통과해 같은 `WorldEvent` 배열 형태로 수렴**해야 한다. 안 그러면 LIVE→과거 전환 때 화면이 튄다.

### 2-4. Web Worker — **적절하되 21번 책임 분담이 비현실적.**

21번은 Worker가 `event filtering / geo calculation / clustering / timeline filtering / aggregation` 을 한다고 적었다. 문제:
- **문제 1: 왕복 비용.** 필터링 결과를 매번 JS 객체 배열로 postMessage하면 구조화 복제(structured clone) 비용이 필터 이득을 잡아먹는다. 30k 객체 복제는 프레임 예산을 넘긴다.
- **문제 2: deck.gl이 원하는 형태와 다르다.** deck.gl은 `data.attributes`로 **typed array(binary attributes)를 직접 받으면 CPU attribute 생성을 완전히 우회**한다. Worker는 "필터된 객체 배열"이 아니라 **`Float32Array`(position), `Uint8Array`(color), `Float32Array`(radius)를 만들어 `transfer`로 넘겨야** 한다. transferable ArrayBuffer는 소유권 이동이라 사실상 0 코스트다. [확인됨: https://deck.gl/docs/developer-guide/loading-data ("it may contain a field `attributes` if the application wishes to supply binary buffers directly to the layer, where the keys in `data.attributes` correspond to the accessor name"), https://deck.gl/docs/developer-guide/performance ("bypass the CPU-bound attribute generation completely"), https://loaders.gl/docs/developer-guide/concepts/binary-data]

**[의견] 권고 경계선 (계획서 21번 대체안):**

| 스레드 | 책임 |
|---|---|
| **Worker** | 원본 payload 파싱(JSON/protobuf/Arrow) → 정규화 → **시간 인덱스 구축** → 시간 슬라이스 → 보간 → **binary attribute 생성** → `postMessage(buffers, [transferables])` |
| **Main** | deck.gl 레이어 props 갱신(`data: {length, attributes}`), 카메라, 픽킹, React UI |
| **Main (절대 Worker 아님)** | 픽킹 결과 처리, 툴팁, 선택 상태 — 이건 마우스 이벤트 지연이 곧 체감 품질 |
| **Worker 부적합** | 클러스터링을 매 뷰포트 변화마다 Worker에서 하는 것 → 3-7 참조. 서버 사전계산으로 옮겨야 함 |

### 2-5. IndexedDB — **용도 불명. MVP 과잉. Phase 2로 미뤄라.**

계획서 어디에도 IndexedDB를 무엇에 쓸지 없다(13번에 이름만 있음). 19번 저장 구조는 전부 서버 측(Redis/PostgreSQL) 이야기다.

**[의견] 쓸 만한 용도 3개 (Phase 2 = Time Machine에서):**
1. **리플레이 버퍼 캐시.** 타임라인을 -3h ↔ -1h 로 왕복 스크럽할 때 매번 재요청하면 느리다. `(layer, timeBucket)` 키로 정규화된 슬라이스를 저장 → 스크럽이 즉시 응답. 이게 IndexedDB의 유일한 정당한 킬러 유즈케이스다.
2. **콜드 스타트 즉시 페인트.** 마지막 알려진 세계 상태를 저장 → 새로고침 시 네트워크 대기 없이 지구본에 점이 먼저 찍힌다(그 다음 LIVE로 교체). 체감 LCP 개선.
3. 항공기 히스토리 스냅샷(용량이 크고 재사용률 높음).

**경고:** IndexedDB 쓰기는 공짜가 아니다. **5초마다 오는 항공기 틱을 매번 쓰면 안 된다.** 시간 버킷(예: 1분) 단위로 배치 커밋. 그리고 저장 형식은 JSON이 아니라 **typed array를 Blob으로** — 파싱 비용을 없앤다.

**MVP 대안(더 단순):** 메모리 LRU(Map) + HTTP `Cache-Control` + `stale-while-revalidate`. IndexedDB 없이도 MVP는 충분하다.

### 2-6. Tailwind CSS — **적절.** 단 다크 전용 디자인 시스템 토큰(CSS custom properties)을 Tailwind 위에 별도로 두는 편이 낫다(3-13 참조).

### 2-7. **빠진 것 (스택 레벨) — 이게 과잉보다 훨씬 중요하다**

| # | 빠진 것 | 왜 치명적인가 |
|---|---|---|
| **F1** | **베이스맵 타일 소스 & 스타일 결정** | MapLibre는 렌더러일 뿐, **스타일 JSON + 벡터 타일 소스가 없으면 화면이 비어 있다.** 후보: MapTiler(키 필요, 무료 쿼터 제한), **OpenFreeMap / Protomaps(pmtiles, 무료·자체 호스팅 가능)**, Stadia. 그리고 "우주에서 본 어두운 지구" 스타일은 **직접 저작해야 하는 디자인 산출물**이다. 34번 "Globe Experience"의 실체가 바로 이것인데 계획서에 없다. **결정 안 하면 Phase 0에서 막힌다.** |
| **F2** | **API 키 프록시 / CORS** | 항공(OpenSky 등)·기상·뉴스 API를 브라우저에서 직접 부르면 **키가 노출되고 CORS로 막힌다.** 서버 프록시 + 서버측 레이트리밋 필수. 18번에 암시는 되나 프론트 계획엔 없다. |
| **F3** | **시계열 보간 (interpolation)** | **가장 큰 누락.** 3-6 참조. |
| **F4** | **WS/SSE 재연결·백오프·탭 가시성 스로틀** | 실시간 앱의 절반이 이 코드다. `document.visibilityState === 'hidden'`이면 스트림 중단/폴링 정지 — 안 하면 백그라운드 탭이 배터리와 쿼터를 태운다. |
| **F5** | **WebGL 컨텍스트 손실 처리** | `webglcontextlost` / `webglcontextrestored`. 장시간 켜두는 앱(=이 앱의 컨셉)에서 실제로 발생한다. 처리 없으면 검은 화면. |
| **F6** | **WebGL2 미지원 폴백 메시지** | maplibre v6는 WebGL2 필수, deck interleaved도 WebGL2 필수. 구형 환경에 "지원 안 됨" 안내 화면 필요(빈 화면 금지). |
| **F7** | **UTC 규율** | 타임라인이 전 지구 기준인데 계획서에 시간대 언급이 0이다. **저장·연산·URL은 전부 UTC(epoch ms), 표시만 로컬.** 24번 `time=2026-08-18T18:00`은 타임존이 없어서 이미 애매하다. 이 종류의 버그는 조용히 들어와서 늦게 터진다. |

---

## 3. 계획서에서 틀린 전제 또는 위험한 가정

### 3-1. [확인됨] 14번 "MapLibre는 완전한 3D globe 경험에서 Cesium보다 제한적일 수 있음" — **근거가 틀렸다**
MapLibre globe는 5.0.0(2025-01)부터 정식 기능이고 deck.gl 9.1이 공식 지원한다. **실제 제약은 계획서가 지목한 곳이 아니다.** 진짜 제약은 (a) z12 mercator 자동 전환, (b) 안정 deck.gl에서 GlobeView pitch/bearing 미지원(tilt는 9.4-alpha), (c) **maplibre v6 통합 단절**, (d) globe 위 Icon/Text/depth 미해결 버그. → 위험 평가가 엉뚱한 곳을 보고 있어서, 실제 리스크가 무방비다.

### 3-2. [확인됨] 13번이 "MapLibre / Cesium / deck.gl"을 나란히 나열 — **셋 다 넣으면 안 된다**
MapLibre와 Cesium은 각각 자기 카메라 모델·좌표계·렌더 루프를 가진 **경쟁 엔진**이다. 둘을 동시에 넣으면 번들 2배 + 카메라 동기화 지옥. **13번은 14번의 결정을 반영해 단일 엔진으로 좁혀 다시 써야 한다.** 지금은 "아직 안 정했다"를 스택 목록으로 위장한 상태다.

### 3-3. [확인됨] 21번 "React DOM ❌ 30,000 markers → deck.gl WebGL ✅" — **결론은 맞지만 병목 진단이 틀렸다**
deck.gl 공식 성능 문서: ScatterplotLayer는 **~1M 아이템까지 팬/줌 중 60FPS**, 10M에서 10-20FPS로 떨어진다(2015 MacBook Pro 기준). [확인됨: https://deck.gl/docs/developer-guide/performance] → **30k는 GPU에게 아무것도 아니다.** 32번이 자랑하려는 "수만~수십만 렌더링"은 deck.gl 입장에서 도전이 아니다.

**실제 병목은 3곳이고, 계획서는 셋 다 언급하지 않는다:**
1. **attribute 재생성 (진짜 범인).** 문서 원문: "When the `data` prop changes, the layer will recalculate all of its GPU buffers. The time required for this is proportional to the number of items in your `data` prop." → **항공기가 5초마다 새 배열로 갱신되면 5초마다 30k개 버퍼를 CPU에서 다시 만든다.** 이게 프레임 드롭의 원인이다. 해결: `data` 참조 동일성 유지 + `updateTriggers`로 변한 attribute만 갱신 + **binary attributes 직접 공급.**
2. **fragment shader 커버리지.** 문서: 반경 5px 점 하나가 ~100 픽셀 → 점 개수보다 **화면 점유 면적**이 비용이다. z0에서 지구 전체에 큰 마커를 뿌리면 오버드로가 폭발한다. **줌아웃에서 마커 반경을 키우는 흔한 디자인이 정확히 이걸 유발한다.**
3. **picking 오버헤드.** 픽킹은 오프스크린 렌더 패스 추가. 30만 점에서 hover 픽킹을 항상 켜두면 프레임당 2회 렌더가 된다. → **hover 픽킹은 스로틀하거나 클릭 픽킹만 쓸 것.**
- 참고로 레이어 개수는 여유: "close to 100 deck.gl layers" 까지 문제없음.

### 3-4. [의견/확인됨] 8번 "모든 Layer가 같은 시간 기준으로 동기화되어야 한다" — **현 문장으로는 구현 불가능**
"같은 시간 기준"이 레이어마다 다른 걸 의미해야 한다:

| 레이어 | 시간 의미론 | `currentTime = T`가 뜻하는 것 |
|---|---|---|
| Earthquake | **instant event** | `[T - W, T]` 구간에 발생한 지진 (W = 표시 윈도, 예: 1h). 최근일수록 강조(4번 Marker Pulse) |
| Aviation | **sampled continuous state** | T 시점의 **위치를 보간해서** 계산. 스냅샷 사이를 메워야 함 |
| Weather Alert | **interval** | `valid_from ≤ T ≤ valid_to` 인 경보 (구간 겹침 판정) |
| Typhoon path | **sampled trajectory** | T까지의 경로(꼬리) + T 시점 위치 |
| News | **event + decay** | `[T - W, T]` 카운트, 시간 감쇠 가중 |

→ **하나의 전역 `currentTime`은 옳지만, 각 레이어가 "T를 어떻게 해석하는지"를 선언해야 한다.** 권고: 레이어 정의에 `temporalMode: 'instant' | 'interval' | 'sampled'` + `window` 를 명시하고, 시간 슬라이스 함수를 레이어별로 분리. **이걸 안 정하고 레이어를 먼저 만들면 27번(Phase 2)에서 전부 뜯는다.**

### 3-5. [의견] 16번 `WorldEvent` 스키마 — **표현력 부족. Phase 2에서 확실히 터진다**
```ts
location: { latitude: number; longitude: number }   // 점만 표현 가능
timestamp: number                                   // 순간만 표현 가능
```
그런데 실제 데이터는:
- 항공기 = 시간에 따라 움직이는 점 (샘플 시퀀스)
- 태풍 경로 = 시간 축을 가진 **폴리라인**
- 기상 경보 = **폴리곤 + [시작, 종료] 구간**
- 지진 = 점 + 순간 (유일하게 맞음)

→ `metadata: Record<string, unknown>` 에 다 밀어넣게 되고, 그 순간 타입 안전성과 Worker 정규화가 무너진다.

**권고 스키마(지금 고칠 것):**
```ts
type Geometry =
  | { kind: 'point'; lat: number; lon: number; altM?: number }
  | { kind: 'linestring'; coords: Float64Array }      // 경로/항적
  | { kind: 'polygon'; rings: Float64Array[] }        // 경보 영역
type Temporal =
  | { kind: 'instant'; at: number }                   // epoch ms, UTC
  | { kind: 'interval'; from: number; to: number }
  | { kind: 'sampled'; samples: { t: number; lat: number; lon: number }[] }
interface WorldEvent {
  id: string; source: string; type: LayerType
  geometry: Geometry; temporal: Temporal
  severity?: number; metadata: Record<string, unknown>
}
```

### 3-6. [확인됨] 9번 Time Replay — **보간 계획이 아예 없다. 최대 누락.**
"17:00 → 17:10 → 17:20" 처럼 스냅샷을 이어 붙이면 항공기가 **텔레포트**한다. 부드럽게 움직이려면 스냅샷 사이를 보간해야 한다.
- deck.gl `TripsLayer` 문서 명시: **"The TripLayer does not interpolate the input data on the CPU, and you will need to compute it yourself."** [확인됨: https://deck.gl/docs/api-reference/geo-layers/trips-layer]
- 즉 `currentTime` prop을 매 프레임 올려도, **입력 데이터의 시간 해상도가 곧 애니메이션 해상도**다. 60초 스냅샷을 10fps로 재생하면 60초마다 한 번씩 점프한다.

**권고:**
- 항공기: 스냅샷 2개(t0, t1) 사이 **선형 보간 + heading 기반 dead reckoning**. Worker에서 `T`에 대해 `Float32Array` 위치를 만들어 넘긴다. 각도는 최단 회전(±180 wrap) 처리, 경도는 날짜변경선 wrap 처리 — 이 두 개가 실제 버그 발생 지점.
- 태풍 경로: 시간 파라미터화된 폴리라인 → `TripsLayer` + `currentTime`, 또는 직접 슬라이스.
- 지진/뉴스: 보간 금지(이산 이벤트). 대신 **등장 애니메이션**(펄스)으로 시간 흐름을 표현.
- **원칙: 위치가 연속인 것만 보간한다. 이산 이벤트를 보간하면 데이터 거짓말이 된다.** 포트폴리오에서 이 구분을 명시적으로 문서화하면 오히려 강점이 된다.

### 3-7. [의견] 22번 LOD — **표는 있고 메커니즘이 없다. 게다가 난이도 방향이 거꾸로다**
- "누가 클러스터를 만드는가"가 없다. 클라이언트 Worker에서 뷰포트 변할 때마다 30만 점 클러스터링 = 스크롤마다 수백 ms 스파이크. → **서버가 줌 레벨별로 사전 집계**해서 주는 게 정답(H3/Geohash 셀 집계, 20번의 후보와 이어진다). 클라이언트 클러스터링은 수천 점 이하에서만.
- **더 중요한 착각: z0(지구 전체)이 가장 쉬운 게 아니라 가장 어렵다.** 줌아웃에서는 뷰포트 컬링이 아무것도 걸러주지 못한다(전부 화면 안). 게다가 3-3의 오버드로 문제가 겹친다. 22번은 "줌 낮음 = 데이터 적게"라고 적었지만, **적게 보여주려면 먼저 전부를 집계해야 한다** — 그 집계 위치가 서버냐 클라이언트냐가 핵심 결정인데 비어 있다.
- 그리고 globe에서는 **지구 뒷면(반대편)이 보이지 않는다** → 시야 반구 컬링(dot product > 0)만으로 절반을 버릴 수 있다. deck GlobeView는 9.3에서 back-face culling 기본 활성이지만, **데이터 레벨 컬링(뒷면 데이터를 아예 버퍼에 안 넣기)** 은 우리가 해야 한다. 이건 계획서에 없고, 저비용 고효과다.

### 3-8. [의견] 24번 URL State — **필드가 부족하고 갱신 전략이 없다**
`/world?lat&lng&zoom&time&layers` 로는 상태 복원이 안 된다. 빠진 것:
- **타임존** (`time=2026-08-18T18:00`이 어디 시간?) → `t=1755540000000` (epoch ms) 또는 `...Z` 강제
- **LIVE 여부** (`t=live` 센티넬 필요. 없으면 공유 링크가 항상 과거로 고정됨)
- `selectedEvent`, `playbackRate`, `playing`, (globe면) `bearing`/`pitch`
- **갱신 전략:** 팬/줌마다 `pushState` 하면 히스토리가 수백 개 쌓여 뒤로가기가 망가진다. → **`replaceState` + 200~300ms 디바운스**, 사용자가 "링크 복사"를 누를 때만 최종 상태 확정.
- **길이:** layers 목록 + 카메라 + 시간이면 곧 길어진다. 짧은 키(`l=eq,wx,fl,nw`) 규약을 처음부터 정할 것.

### 3-9. [의견] 23번 "viewport를 전역 상태에 둔다" — **전형적인 성능 함정**
Zustand에 `viewport`를 넣고 `onViewStateChange`마다 set하면 **팬 중 매 프레임 React 트리가 리렌더**된다. 30k 레이어 props 재계산까지 딸려온다.
**권고:** 카메라는 **deck/maplibre 인스턴스가 소유(uncontrolled)**. 전역 스토어에는 **디바운스된 사본**만 발행하고, 그 사본은 URL 동기화와 "현재 보이는 영역 요약" 같은 저빈도 소비자만 읽는다. `useSyncExternalStore` + selector로 구독 범위를 좁힐 것.

### 3-10. [의견] 25번 Phase 0 완료 조건 — **측정 불가**
"3D Earth에서 지진 + 항공기 동시 표시 가능"은 50개 점을 12FPS로 그려도 통과한다. → 1-7의 숫자 기준으로 대체할 것.

### 3-11. [의견] 34번 "1. Globe Experience" — **정의가 없어서 무한히 늘어난다**
포트폴리오 프로젝트에서 가장 흔한 실패는 "지구본을 예쁘게"에 3주를 쓰는 것이다. **완료 정의를 써라.** 예: "다크 스타일 + 대기광(atmosphere) + 별 배경 + 60FPS 관성 회전 + 국경/도시 라벨 + z0~z14 왕복 무결함. 여기까지 3일. 초과 시 중단." (참고: MapLibre는 atmosphere 예제를 공식 제공한다 — https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-an-atmosphere/ [확인됨])

### 3-12. [의견] 6번·35번 — **데스크톱 전용 가정**
좌측 사이드바 + 하단 타임라인 레이아웃과 6단계 데모 시나리오 모두 데스크톱이다. **포트폴리오 링크는 모바일에서 열린다.** 그리고 모바일 GPU에서 30k 점 + 오버드로는 실제로 죽는다. → 모바일 예산(예: 5k점 상한, 반경 축소, 픽킹 클릭 전용)과 바텀시트 레이아웃이 필요. 지금은 언급 0.

### 3-13. [의견] 4번 "Marker Pulse = Recent Event", 9번 Playback — **모션 접근성 위반**
계속 뛰는 펄스 + 자동 회전 + 재생은 `prefers-reduced-motion` 사용자에게 접근성 문제다(그리고 배터리). 계획서에 언급 0. → 3-14 / 4-2 참조.

---

## 4. 추가 권고 (계획서에 아예 없는 프론트엔드 관심사)

### 4-1. 접근성 — **가장 크게 빠진 항목**
Canvas WebGL 지구본은 스크린리더에 **완전히 보이지 않는다.** 지도만 만들면 이 앱은 AT 사용자에게 빈 페이지다.
**권고:**
- **동일 데이터의 DOM 대체 뷰 필수.** "이벤트 목록"을 `<table>`/`<ul>`로 렌더(정렬·필터 동일). 장식이 아니라 **1급 뷰**로. 부수효과: 디버깅과 테스트가 쉬워지고, SEO/OG도 이걸로 해결된다.
- 키보드: 레이어 토글(체크박스, 실제 `<input>`), 타임라인(**`<input type="range">` 기반** — 화살표키/Home/End 공짜), 이벤트 목록 순회(Tab/방향키), 상세 패널 열릴 때 포커스 이동 + Esc 닫기 + focus trap.
- `aria-live="polite"` 로 "새 지진 M6.2 발생" 알림(단, 스로틀 — 초당 알림은 소음).
- 지구본 캔버스에 `role="img"` + 동적 `aria-label`("현재 표시: 지진 32건, 항공기 1,240대, 2026-08-18 18:00 UTC").
- 색 대비: 다크 배경 위 마커 색이 WCAG AA를 넘는지 검증. **색상만으로 레이어를 구분하지 말 것**(모양/크기 병용) — 색각 이상 대응.

### 4-2. Reduced Motion
`prefers-reduced-motion: reduce` 일 때: 펄스 애니메이션 정지(정적 링으로), 자동 회전 off, 카메라 트랜지션 즉시 이동, 재생은 **사용자가 명시적으로 시작할 때만** 동작. CSS 미디어쿼리 + JS `matchMedia` 양쪽.

### 4-3. 반응형 / 모바일
- 브레이크포인트 320/375/768/1024/1440 검증.
- 모바일 레이아웃: 레이어 패널 → 바텀시트, 타임라인 → 하단 고정 슬라이더(엄지 도달 범위), 상세 → 전체화면 시트.
- **모바일 성능 예산 별도:** 포인트 상한, `devicePixelRatio` 상한(`useDevicePixels: 1.5` 정도로 클램프 — 이거 하나로 fragment 비용이 절반 이하), hover 픽킹 비활성(터치엔 hover 없음).
- 터치 제스처: 1지점 회전 vs 2지점 줌이 지구본에서 충돌하기 쉬움 → maplibre 기본 핸들러 유지 권장(직접 구현 금지).

### 4-4. 로딩 / 에러 / 빈 상태 — **부분 실패가 정상 상태다**
4개 독립 업스트림이면 **하나 죽는 건 예외가 아니라 일상**이다.
- 레이어 **각각**이 자기 상태를 갖는다: `idle | loading | ready | stale | error`. 레이어 목록 UI에 그 상태를 배지로 노출("Flights · 데이터 지연 2분", "News · 일시 오류").
- **전체 화면 스피너 금지.** 지구본은 즉시 나오고 레이어가 개별로 채워진다.
- `stale` 개념 필수: LIVE인데 3분간 갱신이 없으면 "● LIVE"를 "◐ 지연"으로 바꾼다. **거짓 LIVE 표시가 신뢰를 깬다.**
- 에러 바운더리: 지도 컴포넌트를 감싸고, WebGL 실패 시 정적 지도 이미지 + 이벤트 목록으로 우아하게 강등.

### 4-5. 오프라인 / 복원력
- SW로 앱 셸 + 베이스맵 스타일/폰트/스프라이트 캐시(타일은 용량 커서 선택적).
- 오프라인 시 "마지막 확인: 18:32 UTC" 배너 + IndexedDB 스냅샷으로 읽기 전용 표시.
- 재연결: 지수 백오프 + 지터, `online`/`offline` 이벤트, 복귀 시 델타 재동기(전체 재요청 금지).

### 4-6. 테스트 전략 — 계획서에 0
- **Vitest 단위(가장 가치 높음):** 데이터 어댑터/정규화(16번), 시간 슬라이스 함수(레이어별 temporalMode), **보간 함수(날짜변경선·극지·heading wrap 경계)**, 상관 규칙(11번의 300km/60min), geo 유틸, URL state 직렬화/역직렬화 **라운드트립**. 여기가 버그가 사는 곳이고, 여기가 GPU 없이 테스트 가능한 곳이다.
- **Playwright E2E:** 앱 로드 → 지구본 캔버스 존재 → 레이어 토글 반영 → 타임라인 이동 시 이벤트 수 변화 → URL 복원. **고정 fixture(모킹된 API)로 결정론 확보** — 실시간 API를 E2E에 물리면 100% flaky.
- **⚠️ WebGL 스크린샷 회귀 테스트는 하지 말 것.** GPU/드라이버/안티에일리어싱 차이로 픽셀이 매번 다르다. 대신 (a) 대체 DOM 뷰(4-1)에 스냅샷 테스트, (b) `deck.pickObjectsInRect`로 "이 영역에 N개 객체가 있다"를 단정, (c) FPS/드로우콜을 계측해 임계값 회귀 감시.
- **성능 회귀 게이트:** CI에서 고정 fixture 30k 포인트를 렌더하고 attribute 생성 시간 + 프레임 시간을 기록, 임계 초과 시 실패.

### 4-7. i18n
포트폴리오면 **영어 1순위**(리크루터/해외). 한국어 병행. 지금 정해야 하는 이유: 날짜·숫자 포맷(`Intl.DateTimeFormat`/`NumberFormat`), 지명 표기(타일 스타일의 `name:en` vs `name:ko` 필드 선택), 텍스트 확장으로 인한 레이아웃. 뒤에 붙이면 하드코딩 문자열을 전수 색출해야 한다.

### 4-8. SEO / OG
- `/world` 자체는 SEO 대상이 아니다(클라이언트 렌더). 하지만 **랜딩 페이지는 SEO 대상**이고, 33번 메시지가 그 자리에 온다.
- **24번 URL State + 동적 OG 이미지 = 강한 포트폴리오 훅.** 공유 링크마다 그 시점 지구본 썸네일. 구현: 서버에서 해당 시점 이벤트를 조회해 **SVG/Canvas로 정적 지구 투영 썸네일 생성**(WebGL 없이 정사방위 투영 + 점 찍기로 충분). Next.js를 쓸 유일하게 설득력 있는 이유이기도 하다(2-1 옵션 2).
- 4-1의 DOM 대체 뷰가 있으면 SEO도 그걸로 해결된다(일석이조).

### 4-9. 다크 모드
이 앱은 **다크 전용이 정답**이다(우주에서 본 지구). **"라이트 모드 없음"을 명시적 결정으로 문서화**하라 — 그러면 토글을 안 만드는 게 미완성이 아니라 디자인 결정이 된다. 단 텍스트 대비(AA)와 `color-scheme: dark` 메타는 챙길 것.

### 4-10. 성능 예산 (숫자로)
| 항목 | 목표 |
|---|---|
| 인터랙션 중 FPS | ≥ 50 (데스크톱), ≥ 30 (모바일) |
| LCP | < 2.5s — **첫 페인트는 WebGL 초기화가 아니라 정적 지구 이미지/스켈레톤** |
| INP | < 200ms (레이어 토글, 타임라인 스크럽) |
| `/world` JS (앱 코드, 라이브러리 제외) | ≤ 200KB gz |
| 라이브러리 | maplibre-gl + deck.gl은 **합쳐서 수백 KB gz** — 절대 랜딩과 같은 번들에 넣지 말 것 |
| CLS | < 0.1 (타임라인/패널이 나중에 나타나며 밀지 않도록 자리 예약) |

**⚠️ 웹 성능 규칙의 "landing < 150KB gz"는 maplibre+deck.gl과 공존 불가.** → **랜딩(`/`)과 앱(`/world`)을 라우트 분리하고 지도 번들은 `/world`에서만 로드.** 랜딩은 정적 지구 이미지 + CTA. 이게 예산을 지키는 유일한 방법이다.

### 4-11. 개발자 계측
dev 전용 오버레이: FPS, 레이어별 객체 수, 마지막 attribute 생성 시간, WS 지연, 워커 큐 길이. **없으면 성능 회귀를 인지조차 못 한다.** 30분 작업으로 프로젝트 내내 이득.

---

## 5. 수정 권고 (계획서 항목별)

| 항목 | 현재 | 이렇게 고쳐라 |
|---|---|---|
| **13** | MapLibre / Cesium / deck.gl 나열 | 단일 엔진으로 확정: `maplibre-gl ~5.24.0` + `deck.gl ^9.3.10` + overlaid. **v6 핀 금지 이유를 주석으로.** Next.js는 2-1 옵션 중 택1 명시. IndexedDB는 Phase 2로 이동. **F1(타일 소스/스타일), F2(키 프록시), F3(보간)를 스택에 추가.** |
| **14** | "MapLibre가 제한적일 수 있음" (근거 부실) | 확인된 사실로 교체: globe는 v5.0+ 정식 / z12 mercator 전환 / GlobeView experimental·pitch 없음 / **v6 통합 단절(PR #10566)** / 열린 버그 #9592·#9554·#9466. 그리고 **"스파이크로 결정" 게이트를 명시.** |
| **8** | "모든 Layer 같은 시간 기준 동기화" | "전역 `currentTime`(UTC epoch ms) 1개 + 레이어별 `temporalMode(instant/interval/sampled)`와 `window` 선언. 슬라이스 함수는 레이어별 구현." (3-4 표를 그대로 삽입) |
| **16** | point + timestamp 스키마 | 3-5의 `Geometry` / `Temporal` 유니온으로 확장. **지금 고칠 것.** |
| **9** | 스냅샷 나열 | "연속 위치 데이터는 Worker에서 선형 보간 + heading dead reckoning. 이산 이벤트는 보간 금지, 등장 애니메이션으로 표현. TripsLayer는 CPU 보간 미제공." 명시 |
| **21** | Worker에 filtering/clustering/aggregation | 2-4 표로 교체. **핵심: Worker 출력은 객체 배열이 아니라 transferable typed array(binary attributes).** 클러스터링은 서버로 이동. |
| **22** | LOD 밀도 표 | "집계 주체 = 서버(H3/Geohash 셀별 줌 레벨 사전 집계). 클라이언트는 시야 반구 컬링 + 반경 클램프만." + z0이 최악 케이스임을 명시 |
| **23** | viewport를 전역 상태에 | "카메라는 지도 인스턴스 소유. 전역엔 디바운스 사본만." + `currentTime`은 UTC epoch ms 단일 소스 |
| **24** | `lat/lng/zoom/time/layers` | `t`(epoch ms 또는 `live`), `sel`(선택 이벤트), `rate`, `play` 추가. `replaceState` + 디바운스. 짧은 키 규약. 라운드트립 단위 테스트 |
| **25** | "지진+항공기 동시 표시" | 1-7의 6개 숫자 합격 기준으로 교체 |
| **34** | "1. Globe Experience" | 완료 정의 + 타임박스 명시(3-11) |
| **6·35** | 데스크톱 전용 | 모바일 레이아웃과 모바일 성능 예산 추가(4-3). 데모 시나리오에 모바일 1회 통과 포함 |
| **4** | Marker Pulse | `prefers-reduced-motion` 대응 명시 |
| **신규** | — | **"§ 접근성"** 섹션 신설(4-1, 4-2). 대체 DOM 뷰를 1급 산출물로 |
| **신규** | — | **"§ 테스트 전략"** 섹션 신설(4-6). **WebGL 스크린샷 회귀 금지**를 명문화 |
| **신규** | — | **"§ 성능 예산"** 섹션 신설(4-10). 랜딩/앱 라우트 분리 |
| **신규** | — | **"§ 복원력"**: 재연결 백오프, 탭 가시성 스로틀, WebGL 컨텍스트 손실, WebGL2 폴백, stale 표시(4-4/4-5, F4/F5/F6) |

---

## 6. 우선순위가 잘못된 부분 (34번 / 25~30번)

**현재:** `1 Globe → 2 Realtime → 3 Layer System → 4 Timeline → 5 Replay → 6 Correlation → 7 Data → 8 AI`

### 6-1. [의견] **엔진 스파이크가 Phase 0보다 앞에 없다 — 가장 큰 순서 오류**
14번은 "우선 검토한다"로 끝나고 결정 게이트가 없다. 그런데 엔진 선택이 틀렸다는 걸 Phase 2(Time Machine)에서 알게 되면 **전면 재작성**이다. → **"Phase -1: 엔진 스파이크(1.5일, 합격 기준 6개, 폴백 래더)"를 신설하고, 통과 없이는 Phase 0 진입 금지.**

### 6-2. [의견] **Timeline이 4번인데, 시간 데이터 모델은 Layer System(3번)보다 먼저여야 한다**
시간 의미론(3-4)이 `WorldEvent` 스키마(3-5)를 결정하고, 스키마가 레이어 props와 Worker 출력 형태를 결정한다. **레이어를 먼저 만들고 시간을 나중에 끼우면 3-5에서 말한 리팩터가 확정된다.**
→ **"Timeline UI"는 4번에 둬도 되지만, "Temporal Data Model(설계)"은 3번보다 앞으로 올려라.** 순서: `1 Globe(스파이크 통과) → 2 Temporal+Event 스키마(설계, 0.5일) → 3 Realtime → 4 Layer System → 5 Timeline UI → 6 Replay → ...`

### 6-3. [의견] **News가 MVP에 있는 게 과대평가** (4번 MVP Layer 4 / 26번)
뉴스는 **지명 추출(NER/geocoding)** 이 필요해 MVP 4개 중 노력이 가장 크고, 정확도 문제(동명 지명, "Washington"이 사람인지 도시인지)가 곧 **눈에 보이는 버그**로 읽힌다. 시각적 보상은 4개 중 가장 낮다(점 하나).
→ **MVP에서는 "도시별 뉴스 카운트"까지만**(사전에 정의한 상위 도시 화이트리스트 + 단순 매칭). 자유 지명 추출은 Phase 2. 4번의 Tokyo 트리 예시는 카운트만으로도 성립한다.

### 6-4. [의견] **Event Correlation의 위치가 자기모순** (10번 vs 34번)
10번은 Correlation을 **"서비스의 핵심 차별화 기능"** 이라 못 박았는데, 34번에서 **6번**이고 28번(Phase 3)이다. 그런데 11번의 규칙은 `distance < 300km AND |Δt| < 60min` — **구현 난이도가 매우 낮다(공간 인덱스 있으면 수십 줄).**
→ **모순을 해소하라.** 규칙 기반 상관은 **MVP(Phase 1)에 넣어라.** 비용 대비 차별화 효과가 프로젝트 전체에서 가장 높다. 35번 데모 시나리오 3·6번이 이것에 의존하므로, Phase 3에 두면 **"1차 완성" 정의 자체가 Phase 3까지 미뤄진다** — 이건 계획서 내부 불일치다.

### 6-5. [의견] **접근성·모바일이 우선순위 목록에 아예 없다**
둘 다 **초기에 하면 저렴하고, 데스크톱 레이아웃이 굳은 뒤엔 비싸다.** 특히 4-1의 대체 DOM 뷰는 접근성 + SEO + 테스트 + 디버깅을 한 번에 해결하므로 **Phase 1에 넣는 게 순이익**이다. → 34번 목록에 "3.5 Accessible Data View" 삽입 권고.

### 6-6. [의견] **Phase 2(Time Machine)가 실질적으로 가장 어려운데 순서상 중간에 묻혀 있다**
27번의 "1시간 전 세계 ↔ 현재 세계 자연스럽게 이동"은 서버 스토리지 스키마(19번), 시간 인덱스, 보간(3-6), 캐시(IndexedDB), 그리고 레이어별 시간 의미론(3-4)이 **전부 맞아야** 성립한다. 이 프로젝트에서 기술적으로 가장 위험한 지점이다.
→ Phase 1 안에 **"타임라인 -10분 1스텝만 동작하는 수직 슬라이스"** 를 넣어 리스크를 앞으로 당겨라. 전체 히스토리 없이도 파이프라인 전체(저장→조회→슬라이스→보간→렌더)를 한 번 관통해 보는 게 목적.

### 6-7. [의견] 32번 포트폴리오 포인트와 우선순위의 불일치
32번 1번이 "Massive Data Rendering: 수만~수십만"인데, 3-3에서 봤듯 **deck.gl에게 30k는 자랑거리가 아니다.** 포트폴리오에서 실제로 어필되는 건 다음 3개다: **(a) 이종 API를 하나의 시공간 모델로 정규화(16번), (b) 시간 축 복원과 보간(9번), (c) Worker↔GPU 사이 binary attribute 파이프라인(2-4).** → 32번 문구를 이 순서로 재배열하고, "수십만 점"은 **측정 근거와 함께**(어떤 하드웨어, 어떤 FPS) 쓸 것. 근거 없는 숫자 주장은 리뷰어에게 역효과다.

---

## 부록 — 확인한 버전 / 근거 URL

| 대상 | 버전 (2026-08-18 기준) | 근거 |
|---|---|---|
| maplibre-gl | **6.4.0** (2026-08-16) / 5.x 마지막 **5.24.0** (2026-04-23) / 6.0.0 (2026-07-22) | registry.npmjs.org/maplibre-gl |
| deck.gl | **9.3.10** (2026-08-11), 9.4.0-alpha.2 (2026-07-29) | registry.npmjs.org/deck.gl, GitHub releases |
| @deck.gl/maplibre | **존재하지 않음 (npm 404)** — PR #10566 open | registry 404 / github.com/visgl/deck.gl/pull/10566 |
| cesium | **1.144.0** (2026-08-04), unpacked 141.1MB | registry.npmjs.org/cesium |
| resium | **1.25.0** (2026-08-07), peer cesium 1.x / react>=18.2 | registry.npmjs.org/resium |
| three | **0.185.1** (2026-07-01), gzip 178.5KB | registry / bundlephobia |
| react-globe.gl | **2.38.0** (2026-05-16) | registry.npmjs.org/react-globe.gl |
| globe.gl | 2.46.1 (2026-05-16) | registry |

**핵심 근거 링크**
- MapLibre globe roadmap (v5.0.0 정식): https://maplibre.org/roadmap/maplibre-gl-js/globe-view/
- MapLibre globe 내부 설계 (z12 mercator 전환, float32 정밀도): https://github.com/maplibre/maplibre-gl-js/blob/main/developer-guides/globe.md
- MapLibre v5→v6 마이그레이션 (WebGL2 필수, ESM only): https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/
- MapLibre atmosphere globe 예제: https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-an-atmosphere/
- deck.gl @deck.gl/mapbox 개요 (globe fully supported / interleaved WebGL2 / maplibre>3): https://deck.gl/docs/api-reference/mapbox/overview
- deck.gl MapLibre 통합 3모드: https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre
- deck.gl GlobeView (experimental, 제약 목록): https://deck.gl/docs/api-reference/core/globe-view
- deck.gl 공식 베이스맵 목록 (Cesium 없음): https://deck.gl/docs/get-started/using-with-map
- deck.gl 성능 가이드 (1M@60fps, attribute 재생성, fragment 비용, ~100 레이어): https://deck.gl/docs/developer-guide/performance
- deck.gl 데이터 로딩 (binary attributes): https://deck.gl/docs/developer-guide/loading-data
- deck.gl TripsLayer ("does not interpolate the input data on the CPU"): https://deck.gl/docs/api-reference/geo-layers/trips-layer
- deck.gl whats-new (9.1 MapLibre globe, 9.3 GlobeView 확장): https://deck.gl/docs/whats-new
- **PR #10566 (v6가 `map.transform` 제거 → MapboxOverlay 단절)**: https://github.com/visgl/deck.gl/pull/10566
- 트래커 #9199 GlobeView graduation (open, 2026-06-23): https://github.com/visgl/deck.gl/issues/9199
- 버그 #9592 MapLibre Globe Integration (open, 2026-04-20): https://github.com/visgl/deck.gl/issues/9592
- 버그 #9554 IconLayer on Globe (open, 2026-04-01): https://github.com/visgl/deck.gl/issues/9554
- 버그 #9466 Globe 동기화 (open, 2026-04-19): https://github.com/visgl/deck.gl/issues/9466
- 버그 #8530 maplibre Popup z-order (overlaid): https://github.com/visgl/deck.gl/issues/8530
- Cesium 번들 크기 (Viewer ~23MB): https://community.cesium.com/t/large-bundle-size/10724
- loaders.gl transferable ArrayBuffer: https://loaders.gl/docs/developer-guide/concepts/binary-data

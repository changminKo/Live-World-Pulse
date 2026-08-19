# Phase 0 — 지진+항공기 라이브 레이어 연결 결과 (2026-08-19)

## 구조

```
shared/src/
  coords.ts           validateLonLat — collector에서 승격 (리뷰 Med5)
  normalize-usgs.ts   normalizeUsgs·quakeSeverity — collector에서 승격, web LIVE와 동일 함수 (PLAN §8.4)
web/src/data/
  poll-loop.ts        폴링 루프 (ETag/304 · X-Poll-Interval 존중(200·304 공통) ·
                      백오프 지수+지터 ±30%, 네트워크/스키마 오류 포함 ·
                      visibilitychange hidden 정지) — TanStack Query 미사용 (하드 룰)
  live-store.ts       Zustand LIVE 스토어 — 레이어별 records+asOf+status(idle/loading/ready/stale/error)
                      +errorCount, stale = 시간 규칙만 (shared TEMPORAL_SPEC flight tolerance 6분 공용 —
                      폴 1회 오류는 강등 사유 아님), quakeArrivals(신규 도착 추적)
  latest-source.ts    프록시 latest.json → 지역별 asOf 비교 병합기 (createFlightSource) —
                      변한 지역 배열만 교체, 무변경 폴은 직전 스냅샷 참조 유지 + sliceObservation dedupe
  live-controller.ts  폴 루프 2개(60s) + stale 재평가 틱(30s) 오케스트레이션 (USGS 정규화는 shared)
web/src/state/
  world-ui-store.ts   레이어 토글 + 선택(sel) — URL l·sel 양방향 (replaceState만) +
                      popstate·라우트 재진입 시 URL→스토어 재동기화 (syncFromUrl)
  url-sync.ts         writeUrlKeys 확장 (기존 카메라 디바운스 로직 보존)
web/src/world/deck/
  flight-mesh.ts      삼각 메시 (positions+normals+texCoords — SimpleMeshLayer attribute 단정 대응)
  layer-factory.ts    createLayerBuilder — memo 캐시로 참조 관리,
                      quake ScatterplotLayer(rank 색+크기 이중 인코딩) + 펄스 링(uniform만 변조) +
                      flight SimpleMeshLayer **지역 단위 분할** (변한 지역 레이어만 재생성)
  attach-live-layers.ts 스토어↔overlay 연결, 클릭 픽킹(pickObject), 펄스 rAF (reduced-motion/숨김 정지)
web/src/world/panels/
  LayerPanel.tsx      실토글(지진·항공기) + 상태 배지('지연 N분') + 기상·뉴스 'Phase 1' disabled
  EventLogPanel.tsx   지진 로그 prepend (occurredAt 내림차순) + 스로틀(5s) aria-live 어나운서
  EventDetailPanel.tsx 클릭 상세 (지진 M·깊이·장소·시각 / 항공기 콜사인·고도·속도·기종) —
                      열릴 때 패널 포커스 이동 + Tab 트랩 + Esc 닫기 + 트리거 포커스 복귀 (PLAN §10)
  HeaderBar           status prop 소비 — ● LIVE / ◐ 지연 / ○ STANDBY
web/scripts/verify-layers.mjs  기계 검증 (npm run verify:layers)
```

## 기계 검증 실측 (verify-layers.mjs, 실 API)

- **마커 수**: 지진 9 (USGS all_hour, 1h window slice — 실측은 폴 시점에 따라 변동) /
  항공기 **1,442** (6지역 → sliceObservation entityId dedupe)
- **fps 120** (마커 렌더 + 자동 회전, 1440×900, headless Chromium `--use-angle=metal`) —
  게이트 ≥50 (PLAN §10 데스크톱 목표, 리뷰 Low2로 상향)
- **클릭 픽킹**: 항공기 `adsblol:780bfb:*` 클릭 → sel URL 반영 + 상세 패널 표시 + 빈 곳 클릭 해제 ✓
- **토글**: flight off → `l=eq,wx,nw` / 복원 → `l` 생략(기본값) / 카메라 파라미터 보존 ✓
- **헤더 배지**: `● LIVE` (지진 ready). 항공기는 검증 시점에 collector 측 adsb.lol 수집 갭으로
  asOf 22분 경과 → 배지 `지연 22분` — stale 정직 표기가 실데이터로 동작 증명
- console/page 에러 0, typecheck·build 통과, 기존 verify:globe 회귀 통과 (URL 계약·랜딩 번들 누수 0)
- 스크린샷: `docs/phase0/shots/globe-full-z1.5.png` (동아시아 z1.5) ·
  `docs/phase0/shots/globe-zoom-z4.png` (일본 z4 — 도쿄 지역 항공기 삼각 메시 + heading 회전)

## 하드 룰 체크

| 룰 | 상태 |
|---|---|
| TanStack Query에 LIVE 스트림 금지 | ✓ 전용 poll-loop + Zustand |
| globe 위 IconLayer 금지 | ✓ SimpleMeshLayer 삼각 메시 |
| interleaved: true 금지 | ✓ overlaid 유지 |
| 외부 API 직접 fetch 금지 (USGS 예외) | ✓ 항공기는 Worker 프록시 경유 |
| 429 재시도 금지 / 1027 백오프 | ✓ 지수 백오프 (즉시 재시도 없음) |
| pushState 금지 | ✓ replaceState만 (기존 파라미터 보존) |
| 이산 이벤트 보간 금지 | ✓ 펄스는 위치 고정, uniform만 변조 |
| hover 픽킹 금지 | ✓ 클릭 전용 (pickObject radius 6px) |
| viewport 전역 상태 금지 | ✓ zoom은 map 인스턴스 직독 (zoomend) |
| 'Realtime'·'delayed/diverted' 표기 금지 | ✓ Live Data Integration / 계산 지표만 |
| 매 폴 레이어 전체 재생성 억제 | △ 지역 단위 참조 안정화 — 무변경 폴은 스냅샷 참조 유지, 200이어도 asOf 변한 지역의 레이어만 재생성 (지역별 3분 주기라 60s 폴 대부분 무변경). 변한 지역은 attribute 재계산 발생 — binary attribute 사전계산 경로는 Phase 1 과제 (PLAN §8.3) |
| reduced-motion | ✓ 펄스 정적 링 대체 (기존 회전 정지와 정합) |

## 발견·특이사항

1. **프록시 실 호스트 = `lwp-collector.rhckdals123.workers.dev`** — 태스크 지시의
   `lwp-collector.lwp-collector.workers.dev`는 DNS 미해석 (CLAUDE.md의 `lwp-collector.workers.dev`도
   계정 서브도메인 누락). CLAUDE.md 현재 단계 줄 갱신 권장.
2. **deck.gl 함정 (스파이크 지식)**: 레이어 인스턴스는 deck에서 제거(finalize)된 뒤 재사용 불가
   (`assert !internalState`) — 토글 off→on에서 재현. memo 캐시는 출력에서 빠진 레이어를 즉시
   폐기해야 한다 (layer-factory.ts에 주석 명문화). SimpleMeshLayer는 mesh에
   positions+normals+texCoords 3종 attribute를 요구.
3. **shared 승격 완료 (리뷰 Med5)**: `normalizeUsgs`·`quakeSeverity`·`validateLonLat`를
   shared/src로 승격 (collector 구현 verbatim 이동 — R2 출력 바이트 불변, collector 테스트
   92개 통과 유지). collector는 기존 경로 re-export, web은 usgs-source.ts 삭제 후 shared 참조.
   부수 효과: web LIVE도 이제 null island(0,0) 드롭 — collector 계약과 일치.
4. **collector 관찰**: 검증 시점 latest.json updatedAt은 전진하는데 flight 지역 asOf가
   02:17:49Z에서 정체 (adsb.lol 갭 추정 — 지역당 3분 주기 계약보다 김). 클라이언트는 계약대로
   stale 강등 표시. collector 측 원인은 이 태스크 범위 밖.

## 리뷰 반영 (2026-08-19 수정 태스크 — Med 5·Low 2)

- **Med1** live-store: stale 판정을 시간 규칙(기준 시각 대비 6분 = 2주기)만으로 —
  폴 1회 오류는 error 메시지·`errorCount`(연속 실패 카운터, 성공 시 0)만 기록, 즉시 강등 없음.
- **Med2** poll-loop: 백오프 지터 ±30% + 네트워크/스키마 오류(kind 'error')도 backoffCount 증가.
  X-Poll-Interval을 200뿐 아니라 304 경로에서도 읽어 적용 (`pollIntervalOf` 공통 헬퍼).
- **Med3** EventDetailPanel: 열릴 때 `role="dialog"` 패널로 포커스 이동, Tab 포커스 트랩,
  Esc 닫기, 닫힘(언마운트 포함) 시 열기 전 포커스 요소 복귀 — 실브라우저 검증 통과.
- **Med4** flights 참조 안정화: createFlightSource가 지역별 asOf 비교로 변한 지역 배열만 교체,
  무변경 폴은 직전 스냅샷 참조 그대로. layer-factory는 지역 단위 SimpleMeshLayer 분할로
  변한 지역 레이어만 재생성. binary attributes는 Phase 1 (PLAN §8.3).
- **Med5** normalizeUsgs·quakeSeverity·validateLonLat shared 승격 — 위 발견 3 참조.
- **Low1** world-ui-store: popstate 리스너 + WorldPage 마운트 시 syncFromUrl —
  같은 SPA 세션 URL 재진입에도 스토어·URL 정합. 실브라우저 검증 통과.
- **Low2** verify-layers fps 게이트 30 → 50 (PLAN §10 데스크톱 목표).

재검증 (전부 실 API): shared typecheck+테스트 23 PASS / collector typecheck+테스트 92 PASS /
web typecheck+build PASS / verify:layers PASS (quakes 9·flights 1442·fps 120≥50·픽킹·토글·에러 0,
스크린샷 2장 갱신) / 포커스·popstate 일회성 런타임 검증 PASS.

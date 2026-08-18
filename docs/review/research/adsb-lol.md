# [실측] adsb.lol 조사 리포트 (2026-08-18, 13:24~13:35 UTC 실측)

## 1. API 실측
- OpenAPI: `https://api.adsb.lol/api/openapi.json` (docs: /docs). 핵심 엔드포인트:
  - `GET /v2/lat/{lat}/lon/{lon}/dist/{radius}` = `GET /v2/point/{lat}/{lon}/{radius}` — **radius 최대 250nm**
  - 부가: /v2/mil, /v2/sqk/{squawk}, /v2/hex, /v2/callsign, /v2/closest, POST /api/0/routeset(콜사인→루트)
- 응답 구조: `{ac: [...], total, now(epoch ms), ptime}` — ADSBExchange v2 호환 (drop-in replacement 공식 명시)
- 항공기 필드(도쿄 99대 기준 존재율): hex 100% / lat·lon 100% / alt_baro 100% / gs 100% / flight(콜사인) 99% / track 90% / t(기종) 92% / r(등록번호) 92% / category 100% / seen_pos 100% / mlat·rssi 포함. **icao24=hex, 필요 필드 전부 있음.**
- 크기·레이턴시(250nm, 비압축/압축): 런던 480KB→gzip 120KB, 뉴욕 370KB, 도쿄 60KB, 서울 44KB. 단발 레이턴시 1.0~2.1s (서울-독일 서버 왕복 포함).

## 2. 커버리지 실측 (250nm, 13:24 UTC)
| 지역 | 대수 | 현지시각 |
|---|---|---|
| 런던 51.51,-0.13 | 804 | 14:24 (피크) |
| 뉴욕 40.71,-74.01 | 726 | 09:24 (피크) |
| 도쿄 35.68,139.77 | 99 | 22:24 (저녁) |
| 서울 37.5,127.0 | 73 | 22:24 (저녁) |
- **동아시아 공백 실재: 유럽 대비 약 1/8~1/10.** 시간대 보정해도 실제 트래픽 대비 현저히 적음 (하네다·인천 반경 250nm 실공역은 수백 대 규모). 피더 밀도 문제. 해양(태평양·인도양)은 피더 자체가 없어 사실상 0 — MLAT/ADS-B 지상 수신 특성상 구조적.

## 3. Rate limit
- 문서(github.com/adsblol/api README): "Rate limits are dynamic based on the environment load. If you get 4xx errors, you are doing something wrong." 숫자 명시 없음, 헤더에 rate limit 정보 없음(cache-control: no-store만). 향후 API 키(피더 대상) 도입 예고.
- 실측 15연속(간격 0): **429 없음. 대신 소프트 스로틀** — 1~3s → 7번째부터 8~10s로 지연 급증, 2회는 20s 타임아웃. 서버측 큐잉으로 추정.
- 실측 페이스드(2s 간격, 4지역×2회전): 전부 200, 1.5~7.5s. **간격 두면 안정.**

## 4. 히스토리 덤프 (github.com/adsblol/globe_history_YYYY)
- 연도별 repo: 2023/2024/2025/2026 전부 존재 → **보존 수년치** (2024 repo 1455GiB, 2026 현재 1422GiB).
- **일일 GitHub Release**: `v2026.08.17-planes-readsb-prod-0.tar.aa`(2GB)+`.ab`(1.9GB) = **하루 약 3.9GB** (staging 복제본 + mlatonly 322MB 별도). `cat *.aa *.ab | tar -x`로 결합.
- 부분 다운로드로 내부 실측: `./heatmap/`(재생용 bin) + `./traces/{icao 끝2자리}/trace_full_{icao}.json` (**gzip JSON, 항공기당 1파일/1일**).
- 실제 파일 추출 검증: `trace_full_7c2ba6.json` → `{icao, r:"VH-IWO", t:"PC12", desc, timestamp(자정 epoch), trace: [[초offset, lat, lon, alt_baro, gs, track, flags, vert_rate, {상세}, source, alt_geom], ...]}` 2657포인트. 포맷 문서 = wiedehopf/readsb README-json.md#trace-jsons.

## 5. ODbL 귀속
- API·히스토리 모두 공식 문서에 **License: ODbL 1.0** 명시 (www.adsb.lol/docs/open-data/api, /historical). 별도 요구 문구는 없음 → ODbL §4.3 표준 노티스 필요:
  > "Flight data from [ADSB.lol](https://adsb.lol), made available under the [Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1.0/)."
- 파생 DB(우리 WARM 집계 등) 공개 시 share-alike 적용 대상임을 유의. UI 크레딧 + 문서 라이선스 페이지 두 곳 표기 권장.

## 6. 순환 스윕 설계 검증
- 제약: 소프트 스로틀상 **버스트 금지, 실효 안전선 ≈ 1 req/5s 이상 간격** (2s 간격도 통과했으나 레이턴시 흔들림).
- 권장: **지역 6개** — 서울(인천권), 도쿄, 유럽(런던), 유럽동부(프랑크푸르트 50.0/8.6 — 런던 250nm 미커버 보완), 북미동부(뉴욕), 북미서부(LA 34.05/-118.25). 250nm 원이라 도쿄-서울(약 640nm)은 병합 불가, 각각 필요.
- 계산: 6 콜/사이클 × 5s 간격 + 레이턴시(≤8s) ≈ **사이클 40~80s → 90s 주기(CLAUDE.md 항공기 90s 갱신)에 정확히 부합.** 평균 1콜/15s로 스로틀 여유 큼. 대역폭: 사이클당 gzip ≈ 300~400KB → 시간당 ~15MB.

## 판정
- **(a) PLAN §4.3 'adsb.lol 지역 한정' 채택: O (유효)** — API 무인증·ADSBX v2 호환·필드 충분·페이스드 폴링 안정. 단 전역 스윕은 불가(소프트 스로틀+250nm 제한)이므로 '지역 한정' 전제 그대로 유지.
- **(b) 권장: 6개 지역(서울·도쿄·런던·프랑크푸르트·뉴욕·LA), 지역당 90s 주기, 콜 간 5s 간격 순차.** 429 재시도 금지 룰은 여기선 '지연 급증 시 사이클 스킵'으로 해석 적용.
- **(c) 히스토리 덤프 Time Machine 백필: 조건부 O** — 데이터는 완전(일일·항공기별 전체 트레이스·수년 보존·ODbL)하나 하루 3.9GB tar를 통째로 받아 재처리해야 함(지역별 추출 불가, 파일이 icao 기준). 전 지구 백필용으론 과체중, **선별 백필(특정 일자·특정 지역 이벤트 연동) + 서버측 배치 파이프라인(R2 Parquet 변환) 전제로 쓸 만함.** 실시간 API 저장분을 주 소스로, 덤프는 갭 메우기·과거 이벤트 온디맨드용 권장.

한계: 커버리지 측정은 단일 시점(UTC 13:24) 1회 — 시간대별 변동 미측정. 레이턴시는 로컬(한국)→독일 서버 기준.

--- 요약 3문장: adsb.lol API·커버리지·rate limit·히스토리 덤프를 실제 HTTP 호출로 실측했고(4지역 250nm 호출, 15연속 스로틀 테스트, 3.9GB 일일 tar 부분 다운로드로 trace JSON 구조까지 검증), PLAN §4.3 '지역 한정' 채택은 유효(O)로 판정. 핵심 발견: 429 대신 소프트 스로틀(연속 호출 시 1.3s→10s+ 지연), 동아시아 커버리지는 유럽의 1/8 수준으로 공백 실재, 히스토리는 ODbL 일일 릴리스(항공기당 gzip JSON 트레이스)로 조건부 백필 가능. 남은 것 없음 — 권장값(6지역·90s 주기·콜 간 5s)과 ODbL 귀속 문구를 PLAN 반영하면 됨(파일 수정은 리뷰 전용이라 안 함).
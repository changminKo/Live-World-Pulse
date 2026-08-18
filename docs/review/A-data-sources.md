PLAN.md의 4개 MVP 레이어(지진/기상/항공기/뉴스) 외부 소스를 공식 문서 + 실제 HTTP 호출 실측(약 25개 엔드포인트)으로 전수 검증하고, Time Machine 레이어별 가능/불가와 저장량을 실측 수치로 산출했다. 결론: Earthquake·Weather수치·News는 무료로 완전 실현 가능하나, Aviation은 "전 지구+실시간+과거+공개게시" 4개를 동시에 만족하는 무료 소스가 존재하지 않으며 OpenSky ToS가 사실상 블로커다. 파일은 하나도 만들지 않았고 리포트 전문은 터미널 출력에 있다.

=== 핵심 판정 ===

[1] Time Machine (-24h) 레이어별
| Layer | -1h | -24h | 외부만으로? |
| Earthquake | O | O | O — FDSN starttime/endtime, 최대 20,000건/쿼리 |
| Weather 수치 | O | O | O — Open-Meteo past_days 실측 72h 반환, ERA5 archive 200 |
| Weather 경보 | 부분 | 부분 | 미국(NWS 7일)만. 전 지구는 현재 활성 CAP뿐 → X |
| Weather 태풍경로 | X | X | X — NHC는 현재 스냅샷만 |
| Aviation | 조건부 | X | X — OpenSky는 인증 시 "딱 1시간". 그 이상은 Trino(대학/정부/항공당국 전용) |
| News(좌표) | O | O | O — 단 GDELT raw 파일 경로로만 (DOC API는 좌표 없음, GEO API는 현재 404) |

[2] ★ 최대 리스크 — OpenSky ToS (확인됨: opensky-network.org/about/terms-of-use)
"Use of the REST API in any operational capacity — including integration into a live product, service, or automated system (even if only internal) — requires a previous written agreement, even for non-profit or governmental entities."
+ "(iii) You will not distribute, disclose, transfer or otherwise make available the data set(s) to any third party"
+ AWS 등 hyperscaler IP 차단 가능 명시 → Vercel/Lambda 배포 위험
→ 공개 포트폴리오가 OpenSky를 상시 폴링해 지구본에 뿌리는 건 서면 합의 없이는 ToS 위반.
대안: adsb.lol(ODbL, 재배포 허용) 지역 한정 — 단 전역 엔드포인트 없음(실측 OpenAPI), 250nm 타일로 전 지구 커버 시 1,136 호출 = 1req/s에서 19분/스윕.
adsb.fi·airplanes.live는 실측 HTTP 403(Cloudflare 차단)으로 서버에서도 접근 불가.

[3] OpenSky 실측 (2026-08-18T11:15Z)
/states/all 익명 → 200, 8,757대, 1,139,605 B, 8.8초, 130.1 B/aircraft
크레딧 실측: 전 지구 호출=4, bbox 호출=3 (X-Rate-Limit-Remaining 400→396→393)
익명 400/day = 14.4분 간격 / 등록 4,000 = 86초 / 피더 8,000 = 43초
→ 계획서가 그리는 10초급 Time Replay는 라이선스 티어 아니면 불가

[4] 저장량 (실측 기반)
Aviation 60초 × 35B 컬럼형 × 13k대 = 0.66 GB/day, 19.7 GB/월. 24h TTL 롤링 시 0.66 GB 상주.
같은 조건을 raw JSON으로 저장하면 2.44 GB/day, 0.07 TB/월 — 4배 차이.
10초 주기면 3.93 GB/day(컬럼형) / 14.62 GB/day(JSON) — 단 크레딧상 불가능.
Earthquake 249건/day = 36 MB/년 (무시 가능).
News GDELT export.CSV 115,790 B × 96 = 11.1 MB/day = 0.33 GB/월 (실측 파일 크기).
→ 24h Time Machine 전체 약 2 GB 상주. 금전 비용 0.

[5] News — 계획서 전제가 틀림
GDELT DOC 2.0 실측 응답 필드 전량: url/url_mobile/title/seendate/socialimage/domain/language/sourcecountry → lat/lon 없음. sourcecountry는 언론사 국가지 사건 위치가 아님.
GDELT GEO 2.0: 4가지 파라미터 조합 모두 HTTP 404 (동시간대 DOC은 429 반환 = 서버 생존). 현재 사용 불가.
DOC rate limit: 내 4번째 호출에서 429 실측 (문헌상 IP당 5초 1회).
→ 좌표는 GDELT Events/GKG raw 15분 파일(ActionGeo_Lat/Long)로만 얻는다. 직접 NER은 불필요하나 파일 파이프라인은 계획서에 없는 작업량.
NewsAPI Developer: 100 req/day + 24시간 지연 + "cannot be used in staging or production" → 배제 권고.

=== 계획서 틀린 전제 8건 (요약) ===
1. "모든 Layer 같은 시간 기준 동기화"(8장) — Aviation -24h 외부 조달 불가. collector 상시 가동 전제가 문서에 없음.
2. "Weather = 태풍+경보"(4장) — 전 지구 무료 단일 소스 없음. 3~4개 합성 필요.
3. ★ 데모 시나리오 "규슈 태풍"(7·10·35장) — NHC는 대서양/동태평양만. 서태평양은 JTWC/JMA 관할이고 공식 JSON API 없음. 포트폴리오 핵심 데모가 소스 공백 위에 있음.
4. "뉴스에서 지역 추출"(4장) — DOC API가 안 해줌(실측), GEO API 404.
5. MVP 4레이어 난이도 균등 가정 — 실제 Earthquake 1 ≪ News 4 < Weather 5 < Aviation 7.
6. "수만~수십만 이벤트 렌더링"(32장) — 실측 동시 확보 가능치는 항공기 8,757 + 지진 249/day + 뉴스 수천. 십만 급 근거 없음.
7. 데이터 접근 경로 — USGS만 CORS * 로 브라우저 직접 fetch 가능(실측). adsb.fi/airplanes.live는 서버에서도 403.
8. ToS/라이선스 검토 항목이 계획서에 아예 없음.

=== 추가 권고 소스 (전부 실측 200, 계획서 미기재) ===
WMO Alert Hub sources.json (전 지구 공식 CAP 경보 레지스트리, 134 KB) ← Weather 경보 공백의 정답
GDACS geteventlist (홍수/지진/태풍/화산 다재해 GeoJSON, 142 KB) ← Phase 2 다수 레이어 한 번에
NASA EONET v3 (산불/화산/폭풍/빙산, 카테고리 구조가 계획서 Layer 모델과 일치)
NASA FIRMS (위성 산불, MAP_KEY 무료, 5,000 req/10min)
NOAA tsunami.gov CAP (쓰나미 — 계획서 12장 AI 예시를 실제로 뒷받침)
OpenAQ v3(대기질), AISstream.io(선박 AIS, 전 세계 구독 시 ~300 msg/s)
Blitzortung(번개)은 상업 이용 강력 금지 → 채택 비권고.

=== 수정 권고 우선순위 1 ===
R1. Aviation 범위 재정의 — (a)OpenSky 서면합의 요청 / (b)adsb.lol 지역한정(권장, 즉시 실행 가능) / (c)Phase 4로 연기. 셋 중 택1을 지금 결정해야 함.
R2. collector를 Phase 2 → Phase 0으로 앞당길 것. 현재 계획대로면 Phase 2 완성 시점에 과거 데이터가 0이라 "구현은 됐는데 볼 게 없는" 상태가 됨.
R3. Time Machine을 2a(-1시간, 외부 API로 즉시) / 2b(-24시간, 수집 24h 경과 후 자동 개방)로 분리.
R4. Weather를 Open-Meteo(수치) + WMO CAP/NWS(경보) + NHC/JTWC파서(태풍) 3소스 합성으로 명문화.
R5. News를 GDELT raw 15분 파일 파이프라인으로 재설계, DOC API는 보조로만, NewsAPI 배제.

=== 무료 지속 가능성 결론 ===
Earthquake O / Weather 수치 O(타일 캐시 필수) / Weather 경보 O / Weather 태풍 O(JTWC 파서 직접 구현) / News O — 금전 비용 0.
Aviation만 △: 비용은 0인데 ToS가 관문. adsb.lol 지역한정이면 O, OpenSky 전 지구면 서면 합의 필요.
키 필요: OpenSky(OAuth2), NASA FIRMS, OpenAQ, AISstream. 키 불필요: USGS, Open-Meteo, NWS(UA만), GDELT, NHC, GDACS, EONET, WMO Alert Hub, adsb.lol.

리포트 전문(소스별 판정표 / Time Machine 표 / 저장량 계산 / 틀린 전제 8건 / 추가 권고 / 수정 권고 11건 / 실측 로그 25줄)은 이 터미널 출력에 있음. 파일 생성·수정 0건.
REPORT_PATH: {"taskId":"task_fcf8a0a1da99","dispatchId":"ctx_4e2c883b6730","outcome":"succeeded"}

# lwp-collector (Phase 0a)

지진(USGS 매분) + 항공기(adsb.lol, m%3 지역 디스패치) 수집 → R2 단독 저장.
계약 전문: `docs/PLAN.md` §8.6(저장)·§8.7(신뢰성)·§9(게이트).

## 명령

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest (fake R2 orchestration 포함)
npm run deploy      # wrangler deploy (Node 22 필요: nvm exec 22 npx wrangler deploy)
npm run tail        # wrangler tail --format json
```

## 시크릿

```sh
wrangler secret put HEALTHCHECKS_URL   # 데드맨 스위치 핑 (없으면 스킵)
wrangler secret put GATE_TOKEN         # /__gates/* 인증 — 미설정 시 게이트 전체 404 (fail-closed)
```

게이트 호출: `curl -H "x-gate-token: $GATE_TOKEN" https://<worker>/__gates/quake1`

## R2 lifecycle rule (설정 완료 — 재현용 기록)

`lwp-data` 버킷에 이미 적용된 규칙. 재구축 시 아래로 재현 (PLAN §8.6 보존 정책):

```sh
# raw 7일 롤링
npx wrangler r2 bucket lifecycle add lwp-data --prefix raw/ --expire-days 7 --name raw-7d-rolling
# norm 90일 롤링 (옛 generation 정리 포함 — §8.7)
npx wrangler r2 bucket lifecycle add lwp-data --prefix norm/ --expire-days 90 --name norm-90d-rolling
# norm 포인터 shard — 본체와 수명 일치 (agg 포인터는 영구, 규칙 걸지 말 것)
npx wrangler r2 bucket lifecycle add lwp-data --prefix manifest/pointers/norm/ --expire-days 90 --name norm-pointers-90d

# 검증
npx wrangler r2 bucket lifecycle list lwp-data
```

## capacity fail-safe (PLAN §8.6)

- 매일 UTC 03:07 invocation이 prefix별 paginated LIST로 실측 용량 산출 →
  `manifest/capacity/dt={date}.json` 기록.
- 실측 8GB 초과 시 `manifest/halt.json` 생성 → 이후 모든 invocation은 수집 스킵 + 로그.
- 해제(수동): 보존 축소 후 `npx wrangler r2 object delete lwp-data/manifest/halt.json`

## 수집 원장

- `manifest/{layer}/dt=/slot={t}.g{g}.json` — norm 발행 immutable 엔트리 (해시·카운트)
- `manifest/status/{layer}/dt=/slot={t}.{scheduledMs}.json` — 성공-empty / 부분 실패 / 전면 실패
  (정상 non-empty 성공은 norm 엔트리가 담당 — 실제 빈 세계와 갭을 구분하는 원장)
- `manifest/format/norm-slot-900.json` — 2026-08-19 norm 슬라이스 60s/180s → 900s 전환 기록.
  이전 객체는 재작성하지 않음, 파일 내 `slotDurationSec` 필드가 정본.

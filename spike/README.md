⚠️ 버리는 코드. Phase -1 판정 후 읽기 전용. main src로 승격 금지 (docs/spike/DESIGN.md §1-1).

# LWP 엔진 스파이크

실행법:

```
npm install
npm run dev
# 브라우저: http://localhost:5173/?engine=a        (수동 관찰)
#          http://localhost:5173/?engine=a&auto=1  (자동 계측 → JSON 덤프)
```

- `engine=a` maplibre 5.24 globe + MapboxOverlay(overlaid) / `engine=b` interleaved(#9592 재현용) / `engine=c` deck 단독 `_GlobeView`
- `mesh=0` 항공기 SimpleMeshLayer → ScatterplotLayer 폴백
- **maplibre-gl은 `~5.24.0` 핀 — v6 업그레이드 금지.** v6가 MapboxOverlay 의존 `map.transform`을 제거했고 `@deck.gl/maplibre`는 npm 미출시 (PR #10566, PLAN §8.2).

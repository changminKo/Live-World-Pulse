import { useEffect } from 'react';
import GlobeCanvas from './GlobeCanvas';
import HeaderBar from './panels/HeaderBar';
import LayerPanel from './panels/LayerPanel';
import EventLogPanel from './panels/EventLogPanel';
import EventDetailPanel from './panels/EventDetailPanel';
import TimelineBar from './panels/TimelineBar';
import { startLiveController } from '../data/live-controller';
import { derivePulseStatus, useLiveStore } from '../data/live-store';
import { useWorldUiStore } from '../state/world-ui-store';

/** 폰트 preload 없음 — /world는 동적 청크라 주입 preload가 CSS 폰트 요청을 앞서지
 *  못함(실효 없음 실측). font-display: swap 폴백만 사용 (DESIGN §3). */

/** PLAN §3 와이어프레임 고정: 좌 LAYERS / 중 3D EARTH / 우 EVENT LOG / 하단 풀폭 타임라인 */
export default function WorldPage() {
  // 라우트 재진입 시 URL(l·sel) → 스토어 재동기화 — 같은 SPA 세션에서 다른 URL로
  // 다시 들어와도 스토어가 모듈 초기 파스에 머무르지 않게 (리뷰 Low1)
  useEffect(() => {
    useWorldUiStore.getState().syncFromUrl();
  }, []);

  // LIVE 파이프라인 — 마운트 시 폴 루프 시작, 언마운트 시 정지
  useEffect(() => startLiveController(), []);

  const earthquake = useLiveStore((s) => s.earthquake);
  const flight = useLiveStore((s) => s.flight);
  const pulse = derivePulseStatus({ earthquake, flight });

  return (
    <div className="grid h-full grid-cols-[216px_1fr_288px] grid-rows-[44px_1fr_52px] bg-[var(--bg-0)]">
      <div className="col-span-3">
        <HeaderBar status={pulse === 'live' ? 'live' : pulse === 'stale' ? 'stale' : 'standby'} />
      </div>
      <LayerPanel />
      <main className="relative min-h-0 min-w-0">
        <GlobeCanvas />
        <EventDetailPanel />
      </main>
      <EventLogPanel />
      <div className="col-span-3">
        <TimelineBar />
      </div>
    </div>
  );
}

import GlobeCanvas from './GlobeCanvas';
import HeaderBar from './panels/HeaderBar';
import LayerPanel from './panels/LayerPanel';
import EventLogPanel from './panels/EventLogPanel';
import TimelineBar from './panels/TimelineBar';

/** 폰트 preload 없음 — /world는 동적 청크라 주입 preload가 CSS 폰트 요청을 앞서지
 *  못함(실효 없음 실측). font-display: swap 폴백만 사용 (DESIGN §3). */

/** PLAN §3 와이어프레임 고정: 좌 LAYERS / 중 3D EARTH / 우 EVENT LOG / 하단 풀폭 타임라인 */
export default function WorldPage() {
  return (
    <div className="grid h-full grid-cols-[216px_1fr_288px] grid-rows-[44px_1fr_52px] bg-[var(--bg-0)]">
      <div className="col-span-3">
        <HeaderBar />
      </div>
      <LayerPanel />
      <main className="relative min-h-0 min-w-0">
        <GlobeCanvas />
      </main>
      <EventLogPanel />
      <div className="col-span-3">
        <TimelineBar />
      </div>
    </div>
  );
}

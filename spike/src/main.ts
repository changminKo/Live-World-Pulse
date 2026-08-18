import type { EngineFactory, EngineHandle, Payload } from './engines/types';
import { createPayloadSource } from './payload/generate';
import { PAYLOAD_SEED } from './payload/rng';
import { startTicker, TICK_COUNT } from './payload/ticker';
import { FpsMeter } from './measure/fps';
import {
  POSE_P,
  runCameraScript,
  runZoomRoundtrip,
  sleep,
} from './measure/camera-script';
import {
  countVisibleMarkers,
  checkSentinels,
  measurePickingError,
  POSE_P_PICK_CASES,
  DATELINE_PICK_CASES,
  DATELINE_POSE_CENTER,
} from './measure/probes';
import { createPanel } from './measure/panel';

type EngineId = 'a' | 'b' | 'c';

const ENGINE_LOADERS: Record<EngineId, () => Promise<{ default: EngineFactory }>> = {
  a: () => import('./engines/engine-a'),
  b: () => import('./engines/engine-b'),
  c: () => import('./engines/engine-c'),
};

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const engineId = (params.get('engine') ?? 'a') as EngineId;
  const auto = params.get('auto') === '1';
  const useMesh = params.get('mesh') !== '0'; // ?mesh=0 → ScatterplotLayer 폴백

  const app = document.getElementById('app');
  if (!app) throw new Error('#app 컨테이너 없음');

  const panel = createPanel(document.body);
  panel.set('engine', engineId);
  panel.set('mesh', useMesh ? 'SimpleMeshLayer' : 'Scatterplot(폴백)');
  panel.set('tick', '0');

  if (!ENGINE_LOADERS[engineId]) {
    panel.log(`알 수 없는 engine=${String(engineId)} — a|b|c 중 하나`);
    return;
  }

  const source = createPayloadSource(PAYLOAD_SEED);
  const initialPayload = source.atTick(0);
  panel.log(
    `payload: points=${initialPayload.points.length} aircraft=${initialPayload.aircraft.length} arcs=${initialPayload.arcs.length} labels=${initialPayload.labels.length}`,
  );

  panel.log(`engine ${engineId} 로딩...`);
  const { default: factory } = await ENGINE_LOADERS[engineId]();
  const engine = await factory(app, initialPayload, { useMesh }, (m) => panel.log(m));
  panel.log('engine ready');
  // 계측 디버깅용 노출 (브라우저 콘솔에서 project/pick 대조)
  (window as unknown as { __spike: unknown }).__spike = { engine };

  const fps = new FpsMeter();
  fps.start();
  setInterval(() => panel.set('fps', String(fps.currentFps())), 500);

  if (auto) {
    await runAutoSequence(engine, engineId, useMesh, source, fps, panel);
  } else {
    // 수동 관찰 모드: 틱 즉시 시작
    startTicker(
      (t) => source.atTick(t),
      (e) => {
        panel.set('tick', `${e.tick}/${TICK_COUNT}`);
        engine.setPayload(e.payload);
      },
      () => panel.log('틱 12회 완료 (60초)'),
    );
  }
}

interface Panel {
  log(msg: string): void;
  set(key: string, value: string): void;
  showResult(result: unknown): void;
  errorCount(): number;
  logs(): string[];
}

/** auto=1 자동 계측 시퀀스 — 기준 1·2·3·5·6 자동 판정 (DESIGN §4) */
async function runAutoSequence(
  engine: EngineHandle,
  engineId: EngineId,
  useMesh: boolean,
  source: { atTick(t: number): Payload },
  fps: FpsMeter,
  panel: Panel,
): Promise<void> {
  const viewport = {
    width: document.getElementById('app')!.clientWidth,
    height: document.getElementById('app')!.clientHeight,
  };

  panel.log('auto: 워밍업 2초');
  await sleep(2_000);

  // 기준 2 — pose P에서 N0 + 센티널 + pose P 픽킹 (중앙/림)
  panel.log('auto: pose P 이동');
  await engine.flyTo(POSE_P);
  await sleep(500);
  const n0 = countVisibleMarkers(engine, viewport);
  const sentinelBefore = checkSentinels(engine, viewport);
  const pickingPoseP = measurePickingError(engine, POSE_P_PICK_CASES);
  panel.log(`N0=${n0}, 센티널 ${sentinelBefore.hit.length}/${sentinelBefore.expected.length}`);

  // 기준 1 — 카메라 스크립트 30초 (FPS 수집)
  const script = await runCameraScript(engine, (m) => panel.log(m));
  const fpsStats = fps.statsIn(script.startedAtMs, script.endedAtMs);
  panel.log(`FPS: min1sWindow=${fpsStats.minWindowFps} median=${fpsStats.medianFps} p95=${fpsStats.p95FrameMs}ms`);

  // 기준 2 — pose P 복귀 후 N1
  await engine.flyTo(POSE_P);
  await sleep(500);
  const n1 = countVisibleMarkers(engine, viewport);
  const sentinelAfter = checkSentinels(engine, viewport);
  panel.log(`N1=${n1} (N0=${n0}) — ${n1 === n0 ? '보존' : '불일치!'}`);

  // 기준 3 — 날짜변경선 pose 픽킹 (z3: z4는 lat ±40 센티널이 화면 밖으로 나감.
  // s0/s1 겹침은 s1 lat 이동으로 해소 — generate.ts SENTINELS 주석 참조)
  panel.log('auto: 날짜변경선 pose 픽킹');
  await engine.flyTo({ center: DATELINE_POSE_CENTER, zoom: 3, durationMs: 2_000 });
  await sleep(500);
  const pickingDateline = measurePickingError(engine, DATELINE_PICK_CASES);

  // 기준 5 — z0↔z14 왕복 후 카운트 보존
  await runZoomRoundtrip(engine, (m) => panel.log(m));
  await engine.flyTo(POSE_P);
  await sleep(500);
  const n2 = countVisibleMarkers(engine, viewport);
  panel.log(`roundtrip 후 N2=${n2} — ${n2 === n0 ? '보존' : '불일치!'}`);

  // 기준 6 — pose P 정지 상태에서 틱 12회, 틱별 드롭 프레임
  panel.log('auto: 틱 측정 60초 — 마우스 입력 금지');
  const tickDrops: number[] = [];
  const tickTimes: number[] = [];
  await new Promise<void>((resolve) => {
    startTicker(
      (t) => source.atTick(t),
      (e) => {
        panel.set('tick', `${e.tick}/${TICK_COUNT}`);
        engine.setPayload(e.payload);
        tickTimes.push(e.timestampMs);
      },
      () => resolve(),
    );
  });
  await sleep(1_200); // 마지막 틱 직후 1초 윈도 확보
  for (const t of tickTimes) tickDrops.push(fps.dropsAfter(t));
  panel.log(`틱별 드롭: [${tickDrops.join(',')}] (max=${Math.max(...tickDrops)})`);

  const result = {
    engine: engineId,
    aircraftLayer: useMesh ? 'SimpleMeshLayer' : 'ScatterplotLayer(폴백)',
    measuredAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    viewport,
    devicePixelRatio: devicePixelRatio,
    criteria1_fps: fpsStats,
    criteria2_markers: {
      n0,
      n1,
      preserved: n1 === n0,
      sentinelBefore,
      sentinelAfter,
    },
    criteria3_picking: { poseP: pickingPoseP, dateline: pickingDateline },
    criteria5_roundtrip: { n2, preserved: n2 === n0, jsErrors: panel.errorCount() },
    criteria6_tickDrops: {
      perTick: tickDrops,
      max: Math.max(...tickDrops),
      pass: Math.max(...tickDrops) <= 1,
    },
    cameraScript: script.steps,
    jsErrorCount: panel.errorCount(),
    finalPose: engine.getCameraPose(),
    logs: panel.logs(),
  };
  panel.log('auto 완료 — 결과 JSON ↓ (RESULT.md 부록에 붙일 것)');
  panel.showResult(result);
}

boot().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;top:8px;left:8px;color:#ff6b6b;z-index:1001">boot 실패: ${msg}</pre>`,
  );
});

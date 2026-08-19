import { parseAppState } from '@lwp/shared';

/** URL 동기화 (PLAN §8.5) — shared/url-state 직렬화 + replaceState + 디바운스.
 *  pushState 금지 (뒤로가기 파괴 — CLAUDE.md 하드 룰). */

export interface CameraState {
  lng: number;
  lat: number;
  zoom: number;
}

/** 초기 카메라: URL에 카메라 파라미터 없으면 동아시아 z1.5 (태스크 스펙) */
const WORLD_INITIAL_CAMERA: CameraState = { lng: 127.5, lat: 35.9, zoom: 1.5 };

export function readInitialCamera(search: string = window.location.search): CameraState {
  const params = new URLSearchParams(search);
  const hasCamera = params.has('lat') || params.has('lng') || params.has('z');
  if (!hasCamera) return WORLD_INITIAL_CAMERA;
  const state = parseAppState(params);
  return { lng: state.lng, lat: state.lat, zoom: state.z };
}

const URL_DEBOUNCE_MS = 300;
/** 연속 이동(자동 회전)에도 최소 이 주기로는 URL 반영 — trailing 디바운스 starvation 방지 */
const URL_MAX_WAIT_MS = 1_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

let urlTimer: ReturnType<typeof setTimeout> | undefined;
let pendingCamera: CameraState | undefined;
let firstScheduledAt: number | undefined;
let scheduledPathname: string | undefined; // 스케줄 당시 경로 — 라우트 전환 후 발화 시 목적지 URL 오염 방지

function applyUrl(): void {
  clearTimeout(urlTimer);
  urlTimer = undefined;
  firstScheduledAt = undefined;
  const camera = pendingCamera;
  const forPath = scheduledPathname;
  pendingCamera = undefined;
  scheduledPathname = undefined;
  if (!camera) return;
  // 라우트가 바뀌었으면 버린다 — 떠난 페이지의 카메라를 목적지 URL에 쓰면 오염 (재검증 Med 재현)
  if (forPath !== undefined && forPath !== window.location.pathname) return;
  // 원본 URLSearchParams를 베이스로 카메라 3키만 교체 — 외부 쿼리(utm_ 등)·미지 파라미터·
  // play=maybe 같은 비정규 값도 그대로 보존 (재직렬화로 정규화하지 않는다. 재리뷰 Med).
  const params = new URLSearchParams(window.location.search);
  params.set('lat', String(round2(camera.lat)));
  params.set('lng', String(round2(camera.lng)));
  params.set('z', String(round2(camera.zoom)));
  const qs = params.toString();
  const next =
    (qs ? `${window.location.pathname}?${qs}` : window.location.pathname) + window.location.hash;
  // history.state 보존 — React Router가 idx 등을 state에 둔다 (null로 덮으면 라우터 파괴)
  window.history.replaceState(window.history.state, '', next);
}

/** 카메라 이동 시 호출 — 디바운스(300ms) + maxWait(1s) 후 replaceState.
 *  lng은 호출측에서 wrap(±180) 보장. hash·외부 쿼리·router state 전부 보존. */
export function scheduleUrlUpdate(camera: CameraState): void {
  const now = Date.now();
  pendingCamera = camera;
  scheduledPathname = window.location.pathname;
  if (firstScheduledAt === undefined) firstScheduledAt = now;
  clearTimeout(urlTimer);
  const sinceFirst = now - firstScheduledAt;
  const wait = Math.min(URL_DEBOUNCE_MS, Math.max(0, URL_MAX_WAIT_MS - sinceFirst));
  urlTimer = setTimeout(applyUrl, wait);
}

export function cancelUrlUpdate(): void {
  clearTimeout(urlTimer);
  urlTimer = undefined;
  pendingCamera = undefined;
  scheduledPathname = undefined;
  firstScheduledAt = undefined;
}

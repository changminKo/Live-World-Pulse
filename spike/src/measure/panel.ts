/** DOM 로그 패널 + 결과 JSON 덤프 (DESIGN §4-7) — CLAUDE.md "DOM 로그 패널" 역할 */

export interface Panel {
  log(msg: string): void;
  set(key: string, value: string): void;
  showResult(result: unknown): void;
  errorCount(): number;
  logs(): string[];
}

export function createPanel(root: HTMLElement): Panel {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'right:8px',
    'bottom:8px',
    'width:380px',
    'max-height:60vh',
    'overflow:auto',
    'background:rgba(10,10,16,0.88)',
    'border:1px solid #333',
    'border-radius:6px',
    'padding:8px 10px',
    'font:11px/1.5 ui-monospace,Menlo,monospace',
    'color:#cfd3dc',
    'z-index:1000',
    'white-space:pre-wrap',
  ].join(';');
  root.appendChild(el);

  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'border-bottom:1px solid #333;padding-bottom:4px;margin-bottom:4px';
  const noticeEl = document.createElement('div');
  noticeEl.style.cssText = 'color:#e8b33f;margin-bottom:4px';
  noticeEl.textContent = '측정 중 마우스 입력 금지 (auto 모드)';
  const logEl = document.createElement('div');
  const resultEl = document.createElement('div');
  el.append(statusEl, noticeEl, logEl, resultEl);

  const status = new Map<string, string>();
  const logLines: string[] = [];
  let errors = 0;

  const renderStatus = () => {
    statusEl.textContent = [...status.entries()]
      .map(([k, v]) => `${k}: ${v}`)
      .join('  |  ');
  };

  const panel: Panel = {
    log(msg: string) {
      const line = `[${(performance.now() / 1000).toFixed(1)}s] ${msg}`;
      logLines.push(line);
      const div = document.createElement('div');
      div.textContent = line;
      logEl.appendChild(div);
      // 로그 100줄 상한 — 패널 DOM 무한 성장 방지
      while (logEl.childNodes.length > 100) logEl.removeChild(logEl.firstChild!);
      el.scrollTop = el.scrollHeight;
    },
    set(key: string, value: string) {
      status.set(key, value);
      renderStatus();
    },
    showResult(result: unknown) {
      const json = JSON.stringify(result, jsonSafe, 2);
      resultEl.textContent = '';
      const btn = document.createElement('button');
      btn.textContent = '결과 JSON 복사';
      btn.style.cssText =
        'margin:6px 0;padding:4px 10px;background:#2a6df4;color:#fff;border:0;border-radius:4px;cursor:pointer';
      btn.onclick = () => {
        navigator.clipboard.writeText(json).then(
          () => panel.log('클립보드 복사 완료'),
          (e: unknown) => panel.log(`복사 실패: ${String(e)}`),
        );
      };
      const pre = document.createElement('pre');
      pre.style.cssText = 'background:#111;border:1px solid #333;padding:6px;overflow:auto;max-height:30vh';
      pre.textContent = json;
      resultEl.append(btn, pre);
      el.scrollTop = el.scrollHeight;
    },
    errorCount: () => errors,
    logs: () => [...logLines],
  };

  window.addEventListener('error', (e) => {
    errors += 1;
    panel.set('jsErrors', String(errors));
    panel.log(`JS error: ${e.message}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    errors += 1;
    panel.set('jsErrors', String(errors));
    panel.log(`unhandled rejection: ${String(e.reason)}`);
  });
  panel.set('jsErrors', '0');

  return panel;
}

/** Infinity 등 JSON 비직렬화 값 처리 (픽킹 불능 = -1) */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !isFinite(value)) return -1;
  return value;
}

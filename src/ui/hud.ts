import type { FrameStats, FrameSummary } from './frameStats';

/** Minimum time between overlay text updates (at most 4 per second). */
const UPDATE_MS = 250;

/**
 * Debug overlay in the top-left corner: frame p50 / p99 and draw calls.
 * Lives in the DOM above the canvas, so it never enters the WebGL frame.
 */
export class FrameHud {
  private readonly el: HTMLDivElement;
  private readonly summary: FrameSummary = { p50: 0, p99: 0, max: 0, samples: 0 };
  private last = -Infinity;

  constructor(parent: HTMLElement) {
    const el = document.createElement('div');
    el.id = 'hud-frame';
    const s = el.style;
    s.position = 'fixed';
    s.left = '4px';
    s.top = '4px';
    s.padding = '2px 4px';
    s.font = '11px/1.2 ui-monospace, Menlo, Consolas, monospace';
    s.color = '#d8d8d8';
    s.background = 'rgba(12, 12, 18, 0.7)';
    s.pointerEvents = 'none';
    s.whiteSpace = 'pre';
    s.zIndex = '10';
    parent.appendChild(el);
    this.el = el;
  }

  /** Call once per frame; rewrites the text only every UPDATE_MS. */
  update(nowMs: number, stats: FrameStats, drawCalls: number, extra?: () => string): void {
    if (nowMs - this.last < UPDATE_MS) return;
    this.last = nowMs;
    const f = stats.summarize(this.summary);
    const tail = extra ? `\n${extra()}` : '';
    this.el.textContent = `p50 ${f.p50.toFixed(1)}\np99 ${f.p99.toFixed(1)}\ndc  ${drawCalls}${tail}`;
  }
}

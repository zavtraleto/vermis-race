import type { ZoneStickView } from '../input/zoneStick';

/** R81d stick look (numbers in src/data/sprites.json "stick"). */
export interface StickOverlayConfig {
  ring: string; // ring colour while input.drift is off
  ringDrift: string; // ring colour while input.drift is on
  dot: string; // dot under the finger
  edge: string; // drift border marks
  lineWidthPx: number; // ring and mark stroke width, CSS px
  dotRadiusPx: number; // dot radius, CSS px
  edgeMarkPx: number; // half height of a drift border mark, CSS px
}

/**
 * R81d: while the finger is on the screen, a ring of radius stickRadius around the touch point, a dot
 * under the finger and marks at the drift border stickRadius*driftEdge on both sides; the ring
 * changes colour while input.drift is on. A 2D canvas over the game canvas (DOM UI layer, outside
 * the WebGL frame, pointer-transparent). Redraws only when something it shows changes; no
 * allocations per frame.
 */
export class StickOverlay {
  private readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private shown = false;
  private ax = NaN;
  private ay = NaN;
  private fx = NaN;
  private fy = NaN;
  private r = NaN;
  private drift = false;

  constructor(
    parent: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly cfg: StickOverlayConfig,
    private readonly driftEdge: () => number,
  ) {
    const el = document.createElement('canvas');
    el.id = 'stick';
    const s = el.style;
    s.position = 'fixed';
    s.pointerEvents = 'none';
    s.zIndex = '6';
    parent.appendChild(el);
    const ctx = el.getContext('2d');
    if (ctx === null) throw new Error('2d context missing');
    this.el = el;
    this.ctx = ctx;
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  /** Fits the overlay onto the canvas rectangle (the 9:16 game area). */
  layout(): void {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const s = this.el.style;
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    this.el.width = Math.max(1, Math.round(r.width * dpr));
    this.el.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ax = NaN; // force a redraw
    this.shown = true;
  }

  /** Call once per frame with the stick and the player's current input.drift. */
  update(stick: ZoneStickView & { readonly activeId: number | null }, drift: boolean): void {
    const ctx = this.ctx;
    if (stick.activeId === null) {
      if (this.shown) {
        ctx.clearRect(0, 0, this.el.width, this.el.height);
        this.shown = false;
        this.ax = NaN;
      }
      return;
    }
    const r = stick.radiusPx;
    if (
      this.shown &&
      stick.anchorX === this.ax &&
      stick.anchorY === this.ay &&
      stick.fingerX === this.fx &&
      stick.fingerY === this.fy &&
      r === this.r &&
      drift === this.drift
    )
      return;
    this.shown = true;
    this.ax = stick.anchorX;
    this.ay = stick.anchorY;
    this.fx = stick.fingerX;
    this.fy = stick.fingerY;
    this.r = r;
    this.drift = drift;
    const cfg = this.cfg;
    ctx.clearRect(0, 0, this.el.width, this.el.height);
    ctx.lineWidth = cfg.lineWidthPx;
    // Ring: the steering zone.
    ctx.strokeStyle = drift ? cfg.ringDrift : cfg.ring;
    ctx.beginPath();
    ctx.arc(this.ax, this.ay, r, 0, 2 * Math.PI);
    ctx.stroke();
    // Drift border marks at +-stickRadius*driftEdge.
    const e = r * this.driftEdge();
    const h = cfg.edgeMarkPx;
    ctx.strokeStyle = cfg.edge;
    ctx.beginPath();
    ctx.moveTo(this.ax - e, this.ay - h);
    ctx.lineTo(this.ax - e, this.ay + h);
    ctx.moveTo(this.ax + e, this.ay - h);
    ctx.lineTo(this.ax + e, this.ay + h);
    ctx.stroke();
    // Dot under the finger.
    ctx.fillStyle = cfg.dot;
    ctx.beginPath();
    ctx.arc(this.fx, this.fy, cfg.dotRadiusPx, 0, 2 * Math.PI);
    ctx.fill();
  }
}

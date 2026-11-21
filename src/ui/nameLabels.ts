import type { Car } from '../sim/types';

/** What the labels read each frame (filled by RivalModels.update, game px of 360x640). */
export interface LabelSource {
  readonly labelCount: number;
  readonly labelCar: Int32Array;
  readonly labelX: Float32Array;
  readonly labelY: Float32Array;
}

const FILL = '#e8e8e8';
const NEMESIS = '#ff4f6a';
const OUTLINE = '#0c0c12';
// Monospace glyph advance as a share of the font size (box estimate for the overlap test).
const MONO_ADVANCE = 0.62;
// Most labels per frame (scratch buffers).
const MAX_LABELS = 64;

/**
 * R67 rival name labels: a 2D canvas over the game canvas at the device pixel ratio (crisp text
 * on the upscaled 360x640 picture), pointer-transparent, UI layer. The text stays upright, but its
 * anchor points turn with the picture roll (R27/R27c) so the names stay over the cars. Names
 * are prebuilt strings; draw() only clears and fills text (no allocations per frame).
 */
export class NameLabels {
  private readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private sx = 1;
  private sy = 1;
  private readonly done = new Uint8Array(MAX_LABELS);
  /** Drawn label boxes: centre x, base y, half width (game px). */
  private readonly boxes = new Float32Array(MAX_LABELS * 3);

  constructor(
    parent: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly names: readonly string[],
    private readonly gameW: number,
    private readonly gameH: number,
    /** Label font size in game px, read on layout (sprites.json rivals.labelPx). */
    private readonly style: { labelPx: number },
  ) {
    const el = document.createElement('canvas');
    el.id = 'names';
    el.style.cssText = 'position:fixed;pointer-events:none;z-index:4';
    parent.appendChild(el);
    const ctx = el.getContext('2d');
    if (ctx === null) throw new Error('2d context unavailable');
    this.el = el;
    this.ctx = ctx;
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

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
    this.sx = this.el.width / this.gameW;
    this.sy = this.el.height / this.gameH;
    // Resizing resets the context state.
    const ctx = this.ctx;
    ctx.font = `900 ${Math.round(this.style.labelPx * this.sy)}px ui-monospace,"Lucida Console",Consolas,monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, Math.round(2.5 * this.sy));
    ctx.strokeStyle = OUTLINE;
  }

  /**
   * Nearest rival first (lowest on screen); a label whose box would overlap one already drawn is
   * skipped, so names never pile up near the horizon. Box width is estimated from the monospace
   * advance (MONO_ADVANCE x font size per character), no text measuring.
   */
  draw(src: LabelSource, cars: readonly Car[], rollDeg = 0): void {
    const ctx = this.ctx;
    // R27c: the same roll as the game picture (> 0 = counter-clockwise) about the screen centre,
    // in game px (square), y down.
    const ra = (rollDeg * Math.PI) / 180;
    const rc = Math.cos(ra);
    const rs = Math.sin(ra);
    const cx = this.gameW / 2;
    const cy = this.gameH / 2;
    ctx.clearRect(0, 0, this.el.width, this.el.height);
    const n = src.labelCount < MAX_LABELS ? src.labelCount : MAX_LABELS;
    const done = this.done;
    done.fill(0, 0, n);
    const h = this.style.labelPx;
    let drawn = 0;
    for (let k = 0; k < n; k++) {
      let best = -1;
      for (let i = 0; i < n; i++)
        if (done[i] === 0 && (best < 0 || src.labelY[i]! > src.labelY[best]!)) best = i;
      done[best] = 1;
      const c = cars[src.labelCar[best]!]!;
      const name = this.names[c.nameId];
      if (name === undefined) continue;
      const dx = src.labelX[best]! - cx;
      const dy = src.labelY[best]! - cy;
      const gx = cx + dx * rc + dy * rs;
      const gy = cy - dx * rs + dy * rc;
      const half = 0.5 * name.length * MONO_ADVANCE * h;
      let free = true;
      for (let j = 0; j < drawn && free; j++) {
        const o = j * 3;
        const b = this.boxes;
        if (
          gx - half < b[o]! + b[o + 2]! &&
          gx + half > b[o]! - b[o + 2]! &&
          gy > b[o + 1]! - h &&
          gy - h < b[o + 1]!
        )
          free = false;
      }
      if (!free || drawn * 3 >= this.boxes.length) continue;
      this.boxes[drawn * 3] = gx;
      this.boxes[drawn * 3 + 1] = gy;
      this.boxes[drawn * 3 + 2] = half;
      drawn++;
      const x = Math.round(gx * this.sx);
      const y = Math.round(gy * this.sy);
      ctx.strokeText(name, x, y);
      ctx.fillStyle = c.nemesis === 1 ? NEMESIS : FILL;
      ctx.fillText(name, x, y);
    }
  }
}

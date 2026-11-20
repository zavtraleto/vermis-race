import type { Car } from '../sim/types';

/** Size and corner offset of a HUD block over the canvas (src/data/sprites.json). */
export interface HudLayout {
  widthEm: number; // canvas width in em: em = min(canvas width / widthEm, canvas height / heightEm)
  heightEm: number; // canvas height in em (caps em when the canvas is wider than a tall phone)
  marginEm: number; // offset from the canvas corner, em
}

/** HUD em in CSS px for the canvas rectangle: width governs on a portrait phone. */
export function hudEm(r: DOMRect, l: HudLayout): number {
  return Math.min(r.width / l.widthEm, r.height / l.heightEm);
}

// Text-zoom guard: rendered HUD text further than this fraction from the intended size is
// treated as browser text zoom and compensated (a measuring tolerance, not a tunable).
const TEXT_ZOOM_TOLERANCE = 0.05;
const PROBE_TEXT = '0000';
// Probe size in root em: large, so hinted whole-pixel glyph advances at small sizes do not make
// the measured ratio jump between frames.
const PROBE_EM = 10;

/**
 * Keeps a HUD root's text at the intended size when the browser scales text on its own (Chrome
 * for iOS "Zoom Text" sets -webkit-text-size-adjust on body; the CSS guard on the root is the
 * first line, this is the second). A hidden digit probe inside the root is measured against the
 * same string measured by a 2D canvas, which text zoom does not touch, and the root font-size is
 * divided by the ratio. Re-fits when the probe changes size (zoom applied after load). Runs only on
 * construction, resize and probe resize, never per frame.
 */
export class HudFontFit {
  private readonly probe: HTMLSpanElement;
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(
    private readonly root: HTMLElement,
    relayout: () => void,
  ) {
    const p = document.createElement('span');
    p.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;line-height:1;font-size:${PROBE_EM}em`;
    p.textContent = PROBE_TEXT;
    root.appendChild(p);
    this.probe = p;
    this.ctx = document.createElement('canvas').getContext('2d');
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(relayout).observe(p);
  }

  /**
   * Sets the root font-size to px CSS px, divided by the text zoom measured at the size set now
   * when it is off. A change resizes the probe, so the observer re-measures until it settles.
   */
  apply(px: number): void {
    const s = this.root.style;
    let set = parseFloat(s.fontSize);
    if (!(set > 0)) {
      set = px;
      s.fontSize = `${px}px`;
    }
    const ctx = this.ctx;
    if (ctx === null) {
      if (set !== px) s.fontSize = `${px}px`;
      return;
    }
    const cs = getComputedStyle(this.root);
    ctx.font = `${cs.fontWeight} ${set * PROBE_EM}px ${cs.fontFamily}`;
    const want = ctx.measureText(PROBE_TEXT).width;
    const got = this.probe.getBoundingClientRect().width;
    const k = want > 0 && got > 0 ? got / want : 1;
    const fit = Math.abs(k - 1) > TEXT_ZOOM_TOLERANCE ? px / k : px;
    if (Math.abs(fit - set) > 0.01) s.fontSize = `${fit}px`;
  }
}

/** R28 speedometer (numbers in src/data/sprites.json "speedometer"). */
export interface SpeedometerConfig extends HudLayout {
  vmaxKmh: number; // km/h shown at speed = vmax
  segments: number; // bar segments from 0 to vmax
  boostSegments: number; // extra segments past vmax (boost zone)
}

/** What the speedometer shows: speed as a fraction of vmax (may exceed 1) and the boost flag. */
export interface SpeedReading {
  ratio: number;
  boosting: boolean;
}

/**
 * Adapter over the sim car (R52). Boosting covers both H5 variants: the slingshot timer (B) and
 * the in-cone boost (A), which shows as speed above vmax. No allocations: fills `out`.
 */
export function readSpeed(out: SpeedReading, car: Car, speed: number, vmax: number): SpeedReading {
  out.ratio = vmax > 0 ? speed / vmax : 0;
  // R86d: the drift turbo shows as the slipstream boost does.
  out.boosting = car.boostTicks > 0 || car.turboTicks > 0 || out.ratio > 1;
  return out;
}

// HUD look (docs/art-bible.md "HUD"): no plate over the road; digits, label and skewed bar segments
// keep a hard 1px dark outline (no blur) to read on any road colour; stencil-like spaced label;
// accent colour only for boost. No transitions: state changes are steps. Text-size-adjust and text
// zoom are reset on the root (HudFontFit is the fallback).
const STYLE = `
#speedo{position:fixed;pointer-events:none;z-index:5;display:flex;flex-direction:column;
align-items:flex-start;font-family:ui-monospace,"Lucida Console",Consolas,monospace;
font-weight:900;color:#e8e8e8;line-height:1;-webkit-font-smoothing:none;font-smooth:never;
-webkit-text-size-adjust:100%;text-size-adjust:100%;-webkit-text-zoom:reset;
text-shadow:1px 0 0 #0c0c12,-1px 0 0 #0c0c12,0 1px 0 #0c0c12,0 -1px 0 #0c0c12}
#speedo .top{display:flex;align-items:flex-end}
#speedo .num{font-size:2.6em;letter-spacing:0.02em;font-variant-numeric:tabular-nums}
#speedo .unit{font-family:"Arial Narrow","Roboto Condensed",sans-serif-condensed,Bahnschrift,
ui-monospace,monospace;font-stretch:condensed;font-size:0.9em;font-weight:700;color:#b8b8c0;
letter-spacing:0.3em;margin:0 0 0.3em 0.45em}
#speedo .bar{display:flex;gap:0.14em;align-items:flex-end;margin-top:0.3em;padding-left:0.2em}
#speedo .seg{width:0.42em;background:#3a3a42;transform:skewX(-18deg);box-shadow:0 0 0 1px #0c0c12}
#speedo .seg.on{background:#e8e8e8}
#speedo .seg:not(.boost)+.seg.boost{margin-left:0.32em}
#speedo .seg.boost{background:#4a1c26}
#speedo .seg.boost.on{background:#c0283c}
#speedo.boosting .num{color:#ffe14a}
#speedo.boosting .seg.boost.on{background:#ffe14a}
`;

/**
 * R28 speedometer in the bottom-left corner of the 9:16 game area: big km/h number and a
 * segmented bar with a boost zone past vmax. DOM over the canvas (UI layer, never rolled by R27),
 * pointer-transparent. Text and classes change only when the shown value changes; layout is
 * recomputed only on resize.
 */
export class Speedometer {
  private readonly root: HTMLDivElement;
  private readonly num: HTMLSpanElement;
  private readonly segs: HTMLSpanElement[] = [];
  private readonly fit: HudFontFit;
  private shownKmh = -1;
  private shownLit = -1;
  private shownBoost = false;

  constructor(
    parent: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly cfg: SpeedometerConfig,
  ) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.id = 'speedo';
    this.num = document.createElement('span');
    this.num.className = 'num';
    this.num.textContent = '0';
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = 'KM/H';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const total = cfg.segments + cfg.boostSegments;
    for (let i = 0; i < total; i++) {
      const s = document.createElement('span');
      s.className = i < cfg.segments ? 'seg' : 'seg boost';
      // Rising bar: each segment a little taller than the previous one.
      s.style.height = `${0.6 + (1.1 * i) / Math.max(1, total - 1)}em`;
      bar.appendChild(s);
      this.segs.push(s);
    }
    const top = document.createElement('div');
    top.className = 'top';
    top.append(this.num, unit);
    root.append(top, bar);
    parent.appendChild(root);
    this.root = root;
    this.fit = new HudFontFit(root, () => this.layout());
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  /** Fits the widget into the canvas rectangle (the 9:16 game area). */
  layout(): void {
    const r = this.canvas.getBoundingClientRect();
    const s = this.root.style;
    const em = hudEm(r, this.cfg);
    const m = em * this.cfg.marginEm;
    this.fit.apply(em);
    s.left = `${r.left + m}px`;
    s.bottom = `${window.innerHeight - r.bottom + m}px`;
  }

  update(reading: SpeedReading): void {
    const cfg = this.cfg;
    const ratio = reading.ratio > 0 ? reading.ratio : 0;
    const kmh = Math.round(ratio * cfg.vmaxKmh);
    if (kmh !== this.shownKmh) {
      this.shownKmh = kmh;
      this.num.textContent = String(kmh);
    }
    const total = this.segs.length;
    let lit = Math.round(ratio * cfg.segments);
    if (lit > total) lit = total;
    if (lit !== this.shownLit) {
      const from = Math.max(0, Math.min(lit, this.shownLit));
      const to = Math.max(lit, this.shownLit);
      for (let i = from; i < to; i++) this.segs[i]!.classList.toggle('on', i < lit);
      this.shownLit = lit;
    }
    if (reading.boosting !== this.shownBoost) {
      this.shownBoost = reading.boosting;
      this.root.classList.toggle('boosting', reading.boosting);
    }
  }
}

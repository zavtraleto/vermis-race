import type { Car } from '../sim/types';

/** R28 speedometer (numbers in src/data/sprites.json "speedometer"). */
export interface SpeedometerConfig {
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

const STYLE = `
#speedo{position:fixed;pointer-events:none;z-index:5;display:flex;flex-direction:column;
align-items:flex-start;font-family:ui-monospace,"Lucida Console",Consolas,monospace;
font-weight:900;color:#e8e8e8;line-height:1;-webkit-font-smoothing:none;font-smooth:never;
text-shadow:0.08em 0.08em 0 #0c0c12}
#speedo .num{font-size:3.2em;letter-spacing:0.02em;font-variant-numeric:tabular-nums}
#speedo .unit{font-size:0.9em;color:#8a8a92;margin:0.15em 0 0.35em 0.15em;letter-spacing:0.12em}
#speedo .bar{display:flex;gap:0.18em;align-items:flex-end}
#speedo .seg{width:0.5em;background:#2a2a31;box-shadow:0.1em 0.1em 0 #0c0c12}
#speedo .seg.on{background:#d8d8d8}
#speedo .seg.boost{background:#3a1a22}
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
    root.append(this.num, unit, bar);
    parent.appendChild(root);
    this.root = root;
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  /** Fits the widget into the canvas rectangle (the 9:16 game area). */
  layout(): void {
    const r = this.canvas.getBoundingClientRect();
    const s = this.root.style;
    const em = r.height / 48;
    s.fontSize = `${em}px`;
    s.left = `${r.left + em * 1.2}px`;
    s.bottom = `${window.innerHeight - r.bottom + em * 1.2}px`;
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

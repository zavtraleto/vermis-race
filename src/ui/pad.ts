import type { Pad } from '../input/pad';
import { padDot, padLayout, type PadDot, type PadLayout } from '../input/padLayout';
import type { PadConfig, PadViewConfig } from '../input/types';

// R214 colours: thin semi-transparent lines that do not hide the road.
const LINE_COLOR = 'rgba(232, 232, 232, 0.28)';
const AXIS_COLOR = 'rgba(232, 232, 232, 0.18)';
const BRAKE_COLOR = 'rgba(224, 72, 88, 0.4)';
const DOT_COLOR = 'rgba(232, 232, 232, 0.55)';

const SVG_NS = 'http://www.w3.org/2000/svg';

function line(parent: SVGSVGElement, color: string, width: number): SVGLineElement {
  const l = document.createElementNS(SVG_NS, 'line');
  l.setAttribute('stroke', color);
  l.setAttribute('stroke-width', String(width));
  parent.appendChild(l);
  return l;
}

function setLine(l: SVGLineElement, x1: number, y1: number, x2: number, y2: number): void {
  l.setAttribute('x1', String(x1));
  l.setAttribute('y1', String(y1));
  l.setAttribute('x2', String(x2));
  l.setAttribute('y2', String(y2));
}

/**
 * R214 visible control pad: the R202 grid (rectangle, X/Y axes, dead-zone marks, gas/lift and
 * lift/brake borders) and the finger dot, drawn in the DOM over the game area (no three.js draw
 * calls), pointer-transparent. Lines come from padLayout and are rebuilt only on resize; per frame
 * only visibility and the dot are written, and only when they change.
 */
export class PadOverlay {
  private readonly root: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly rect: SVGRectElement;
  private readonly axisX: SVGLineElement;
  private readonly axisY: SVGLineElement;
  private readonly deadL: SVGLineElement;
  private readonly deadR: SVGLineElement;
  private readonly brake: SVGLineElement;
  private readonly dot: HTMLDivElement;
  private readonly layoutOut: PadLayout = {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    centerX: 0,
    centerY: 0,
    deadLeft: 0,
    deadRight: 0,
    liftY: 0,
    brakeY: 0,
  };
  private readonly dotOut: PadDot = { x: 0, y: 0 };
  private shown = false;
  private dotShown = false;
  private dotX = NaN;
  private dotY = NaN;

  constructor(
    parent: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly cfg: PadConfig,
    private readonly view: PadViewConfig,
  ) {
    const root = document.createElement('div');
    root.dataset.testid = 'pad';
    const s = root.style;
    s.position = 'fixed';
    s.pointerEvents = 'none';
    s.zIndex = '4';
    s.display = 'none';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.style.position = 'absolute';
    svg.style.left = '0';
    svg.style.top = '0';
    svg.style.overflow = 'visible';
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', LINE_COLOR);
    rect.setAttribute('stroke-width', String(view.lineWidth));
    svg.appendChild(rect);
    this.rect = rect;
    this.axisX = line(svg, AXIS_COLOR, view.lineWidth); // also the gas/lift border (y = 0)
    this.axisY = line(svg, AXIS_COLOR, view.lineWidth);
    this.deadL = line(svg, LINE_COLOR, view.lineWidth);
    this.deadR = line(svg, LINE_COLOR, view.lineWidth);
    this.brake = line(svg, BRAKE_COLOR, view.lineWidth);
    root.appendChild(svg);
    this.svg = svg;

    const dot = document.createElement('div');
    dot.dataset.testid = 'pad-dot';
    const d = dot.style;
    const r = view.dotRadius;
    d.position = 'absolute';
    d.left = `${-r}px`;
    d.top = `${-r}px`;
    d.width = `${2 * r}px`;
    d.height = `${2 * r}px`;
    d.borderRadius = '50%';
    d.background = DOT_COLOR;
    d.display = 'none';
    root.appendChild(dot);
    this.dot = dot;

    parent.appendChild(root);
    this.root = root;
    this.layout();
    window.addEventListener('resize', () => this.layout());
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(() => this.layout()).observe(canvas);
  }

  /** Fits the grid to the canvas rectangle (the game area). Only on resize. */
  layout(): void {
    const r = this.canvas.getBoundingClientRect();
    const s = this.root.style;
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    this.svg.setAttribute('width', String(r.width));
    this.svg.setAttribute('height', String(r.height));
    const L = this.layoutOut;
    padLayout(this.cfg, r.width, r.height, L);
    this.rect.setAttribute('x', String(L.left));
    this.rect.setAttribute('y', String(L.top));
    this.rect.setAttribute('width', String(L.right - L.left));
    this.rect.setAttribute('height', String(L.bottom - L.top));
    setLine(this.axisX, L.left, L.liftY, L.right, L.liftY);
    setLine(this.axisY, L.centerX, L.top, L.centerX, L.bottom);
    const m = this.view.deadMark / 2;
    setLine(this.deadL, L.deadLeft, L.centerY - m, L.deadLeft, L.centerY + m);
    setLine(this.deadR, L.deadRight, L.centerY - m, L.deadRight, L.centerY + m);
    setLine(this.brake, L.left, L.brakeY, L.right, L.brakeY);
    this.dotX = NaN; // force the dot to be rewritten against the new layout
  }

  /** Per frame: visible only during the race; the dot follows the active finger. */
  update(visible: boolean, pad: Pad): void {
    if (visible !== this.shown) {
      this.shown = visible;
      this.root.style.display = visible ? 'block' : 'none';
    }
    const on = visible && pad.activeId !== null;
    if (on !== this.dotShown) {
      this.dotShown = on;
      this.dot.style.display = on ? 'block' : 'none';
    }
    if (!on) return;
    const d = this.dotOut;
    padDot(this.cfg, this.layoutOut, pad.fingerX, pad.fingerY, d);
    if (d.x === this.dotX && d.y === this.dotY) return;
    this.dotX = d.x;
    this.dotY = d.y;
    this.dot.style.transform = `translate(${d.x}px, ${d.y}px)`;
  }
}

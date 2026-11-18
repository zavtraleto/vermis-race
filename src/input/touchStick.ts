import type { InputFrame } from '../sim/types';
import type { TouchStickConfig } from './types';

/**
 * Response curve of scheme A: raw is clamped to [-1, 1]; |raw| <= deadZone -> 0;
 * otherwise sign(raw) * |raw|^responseExp.
 */
export function stickResponse(raw: number, cfg: TouchStickConfig): number {
  const r = raw > 1 ? 1 : raw < -1 ? -1 : raw;
  const m = Math.abs(r);
  if (m <= cfg.deadZone) return 0;
  const v = m ** cfg.responseExp;
  return r < 0 ? -v : v;
}

/**
 * Pure model of touch scheme A, relative stick (no DOM). Coordinates are CSS px relative to the
 * top-left corner of the game area (the letterboxed 9:16 canvas); time is explicit ms, monotonic.
 *
 * - pointerDown inside the steering zone (y >= height * (1 - steerZoneFrac)) while no pointer is
 *   active makes that pointer active and sets anchorX = x, downY = y. Any other pointerDown is
 *   ignored (returns false) and that pointer's later events are ignored too.
 * - raw = (x - anchorX) / R, R = stickRadiusFrac * width. If |x - anchorX| > R the anchor is dragged
 *   so that |x - anchorX| = R (no dead travel on reversal).
 * - While active: steer = stickResponse(raw), no smoothing; drift = (y - downY >= driftPullDownPx).
 * - pointerUp / pointerCancel of the active pointer = release: drift false at once, steer goes from
 *   its value at release toward 0 at 1/releaseMs per ms.
 * - brake is always false (open question Q7).
 */
export interface TouchStick {
  /** Game area size in CSS px. Call before pointerDown and whenever the area changes. */
  setArea(width: number, height: number): void;
  /** Returns true if this pointer became the active one. */
  pointerDown(id: number, x: number, y: number, tMs: number): boolean;
  pointerMove(id: number, x: number, y: number, tMs: number): void;
  pointerUp(id: number, tMs: number): void;
  pointerCancel(id: number, tMs: number): void;
  /** Id of the active pointer, or null. */
  readonly activeId: number | null;
  /** Fills `out` for time tMs. No allocations. */
  read(tMs: number, out: InputFrame): void;
}

export function createTouchStick(cfg: TouchStickConfig): TouchStick {
  let width = 0;
  let height = 0;
  let active: number | null = null;
  let anchorX = 0;
  let downY = 0;
  let steer = 0;
  let drift = false;
  // Release phase: |steer| falls from |releaseSteer| at 1/releaseMs per ms since releaseT.
  let releasing = false;
  let releaseSteer = 0;
  let releaseT = 0;

  function release(id: number, tMs: number): void {
    if (id !== active) return;
    active = null;
    drift = false;
    releasing = true;
    releaseSteer = steer;
    releaseT = tMs;
  }

  return {
    get activeId(): number | null {
      return active;
    },
    setArea(w: number, h: number): void {
      width = w;
      height = h;
    },
    pointerDown(id: number, x: number, y: number): boolean {
      if (active !== null) return false;
      // Same as y >= height * (1 - frac), but exact at the boundary for the configured numbers.
      if (y < height - height * cfg.steerZoneFrac) return false;
      active = id;
      anchorX = x;
      downY = y;
      steer = 0;
      drift = false;
      releasing = false;
      return true;
    },
    pointerMove(id: number, x: number, y: number): void {
      if (id !== active) return;
      const r = cfg.stickRadiusFrac * width;
      const dx = x - anchorX;
      if (dx > r) anchorX = x - r;
      else if (dx < -r) anchorX = x + r;
      steer = r > 0 ? stickResponse((x - anchorX) / r, cfg) : 0;
      drift = y - downY >= cfg.driftPullDownPx;
    },
    pointerUp(id: number, tMs: number): void {
      release(id, tMs);
    },
    pointerCancel(id: number, tMs: number): void {
      release(id, tMs);
    },
    read(tMs: number, out: InputFrame): void {
      if (releasing) {
        const dt = tMs > releaseT ? tMs - releaseT : 0;
        const m = Math.abs(releaseSteer) - dt / cfg.releaseMs;
        if (m > 0) steer = releaseSteer < 0 ? -m : m;
        else {
          steer = 0;
          releasing = false;
        }
      }
      out.steer = steer;
      out.brake = false;
      out.drift = drift;
    },
  };
}

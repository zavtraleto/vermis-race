import type { InputFrame } from '../sim/types';
import type { PadConfig } from './types';

/** R202 steer from the X axis u in [-1, 1]: dead zone, then linear to the stop. */
export function padSteer(u: number, cfg: PadConfig): number {
  const c = u > 1 ? 1 : u < -1 ? -1 : u;
  const m = c < 0 ? -c : c;
  if (m <= cfg.steerDead) return 0;
  const s = (m - cfg.steerDead) / (1 - cfg.steerDead);
  return c < 0 ? -s : s;
}

/** R202 gas and brake from the Y axis y in [-1, 1] (up = +); writes out.gas and out.brake. */
export function padPedals(y: number, cfg: PadConfig, out: InputFrame): void {
  const c = y > 1 ? 1 : y < -1 ? -1 : y;
  if (c >= 0) {
    out.gas = 1;
    out.brake = 0;
  } else if (c >= -cfg.liftZone) {
    out.gas = 1 + c / cfg.liftZone;
    out.brake = 0;
  } else {
    out.gas = 0;
    out.brake = (-c - cfg.liftZone) / (1 - cfg.liftZone);
  }
}

/**
 * Pure model of the R202 control pad (no DOM). Coordinates are CSS px relative to the top-left
 * corner of the game area; the pad centre is the area centre. One finger: the first pointerDown
 * while none is active becomes the active pointer. Released: steer 0, gas 1, brake 0.
 * driftTap (the re-touch gesture of R202) and the visible pad (R214) come in later slices.
 */
export interface Pad {
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

export function createPad(cfg: PadConfig): Pad {
  let width = 0;
  let height = 0;
  let active: number | null = null;
  let fx = 0;
  let fy = 0;
  const release = (id: number): void => {
    if (id === active) active = null;
  };
  return {
    setArea(w: number, h: number): void {
      width = w;
      height = h;
    },
    pointerDown(id: number, x: number, y: number): boolean {
      if (active !== null) return false;
      active = id;
      fx = x;
      fy = y;
      return true;
    },
    pointerMove(id: number, x: number, y: number): void {
      if (id !== active) return;
      fx = x;
      fy = y;
    },
    pointerUp: release,
    pointerCancel: release,
    get activeId(): number | null {
      return active;
    },
    read(_tMs: number, out: InputFrame): void {
      out.driftTap = false;
      if (active === null || width <= 0 || height <= 0) {
        // R201: a released finger = steer 0, full gas, no brake.
        out.steer = 0;
        out.gas = 1;
        out.brake = 0;
        return;
      }
      // R202: X over steerSpan of the half-width, Y over the rectangle half-height, up = +.
      const halfW = width / 2;
      const halfH = height / 2;
      out.steer = padSteer((fx - halfW) / (cfg.steerSpan * halfW), cfg);
      padPedals((halfH - fy) / (cfg.padHalfH * halfH), cfg, out);
    },
  };
}

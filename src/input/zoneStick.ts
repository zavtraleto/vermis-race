import type { InputFrame } from '../sim/types';
import type { TouchStick } from './touchStick';
import type { TouchStickConfig } from './types';

/** R81d: what the stick overlay draws (CSS px relative to the game area). */
export interface ZoneStickView {
  /** Touch-down point (the stick centre). */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Current finger position. */
  readonly fingerX: number;
  readonly fingerY: number;
  /** Zone radius stickRadius * width, px. */
  readonly radiusPx: number;
  /** The drift latch of this touch. */
  readonly drift: boolean;
}

export type ZoneStick = TouchStick & ZoneStickView;

/**
 * R81c touch stick with a zone (driftEntry 3). Pure model, no DOM; coordinates as in touchStick.
 * - pointerDown: same steering-zone rule as scheme A (y >= height * (1 - steerZoneFrac)); the
 *   touch-down point is the centre and never moves.
 * - steer = clamp(dx / R, -1, 1), R = stickRadius * width, dx = x - touch-down x; linear.
 * - drift is false until |dx| >= R * driftEdge on any move of this touch, then true until release.
 * - Release (up / cancel): drift false at once; steer returns to 0 at 1/releaseMs per ms (as scheme A).
 * - brake is always false.
 */
export function createZoneStick(cfg: TouchStickConfig): ZoneStick {
  let width = 0;
  let height = 0;
  let active: number | null = null;
  let anchorX = 0;
  let anchorY = 0;
  let fingerX = 0;
  let fingerY = 0;
  let steer = 0;
  let drift = false;
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
    get anchorX(): number {
      return anchorX;
    },
    get anchorY(): number {
      return anchorY;
    },
    get fingerX(): number {
      return fingerX;
    },
    get fingerY(): number {
      return fingerY;
    },
    get radiusPx(): number {
      return cfg.stickRadius * width;
    },
    get drift(): boolean {
      return drift;
    },
    setArea(w: number, h: number): void {
      width = w;
      height = h;
    },
    pointerDown(id: number, x: number, y: number): boolean {
      if (active !== null) return false;
      if (y < height - height * cfg.steerZoneFrac) return false;
      active = id;
      anchorX = fingerX = x;
      anchorY = fingerY = y;
      steer = 0;
      drift = false;
      releasing = false;
      return true;
    },
    pointerMove(id: number, x: number, y: number): void {
      if (id !== active) return;
      fingerX = x;
      fingerY = y;
      const r = cfg.stickRadius * width;
      const dx = x - anchorX;
      const raw = r > 0 ? dx / r : 0;
      steer = raw > 1 ? 1 : raw < -1 ? -1 : raw;
      // R81c: the first crossing of the drift border latches the drift until release.
      if (r > 0 && (dx < 0 ? -dx : dx) >= r * cfg.driftEdge) drift = true;
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

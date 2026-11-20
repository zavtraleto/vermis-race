import type { InputFrame } from '../sim/types';
import type { TouchStick } from './touchStick';
import type { TouchStickConfig } from './types';

/**
 * R81c touch stick with a zone (driftEntry 3). Pure model, no DOM; coordinates as in touchStick.
 * - pointerDown: same steering-zone rule as scheme A (y >= height * (1 - steerZoneFrac)); the
 *   touch-down point is the centre and never moves.
 * - steer = clamp(dx / R, -1, 1), R = stickRadius * width, dx = x - touch-down x; linear.
 * - drift is false until, on any move of this touch, dy >= R * driftPull (R81g, dy = y - touch-down y,
 *   screen y grows downward; driftPull 0 = off) or |dx| >= R * driftEdge (R81c sideways border,
 *   driftEdge 0 = off); then true until release, even when the finger goes back up. dy never steers.
 * - Release (up / cancel): drift false at once; steer returns to 0 at 1/zoneReleaseMs per ms
 *   (R81c, T68: zoneReleaseMs 0 = steer 0 on the first read; releaseMs of other schemes untouched).
 * - brake is always false.
 */
export function createZoneStick(cfg: TouchStickConfig): TouchStick {
  let width = 0;
  let height = 0;
  let active: number | null = null;
  let anchorX = 0;
  let anchorY = 0;
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
    setArea(w: number, h: number): void {
      width = w;
      height = h;
    },
    pointerDown(id: number, x: number, y: number): boolean {
      if (active !== null) return false;
      if (y < height - height * cfg.steerZoneFrac) return false;
      active = id;
      anchorX = x;
      anchorY = y;
      steer = 0;
      drift = false;
      releasing = false;
      return true;
    },
    pointerMove(id: number, x: number, y: number): void {
      if (id !== active) return;
      const r = cfg.stickRadius * width;
      const dx = x - anchorX;
      const raw = r > 0 ? dx / r : 0;
      steer = raw > 1 ? 1 : raw < -1 ? -1 : raw;
      // R81c: the first crossing of the drift border latches the drift until release.
      if (r > 0 && cfg.driftEdge > 0 && (dx < 0 ? -dx : dx) >= r * cfg.driftEdge) drift = true;
      // R81g: the first pull down by R * driftPull latches the drift until release.
      if (r > 0 && cfg.driftPull > 0 && y - anchorY >= r * cfg.driftPull) drift = true;
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
        const m = cfg.zoneReleaseMs > 0 ? Math.abs(releaseSteer) - dt / cfg.zoneReleaseMs : 0;
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

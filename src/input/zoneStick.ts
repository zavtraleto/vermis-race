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
 * - R81h (H19): cfg.touchDrift is read at each pointerDown and kept for that touch (absent = 'B').
 *   A: a move with |dx| >= R * flickDist within flickMs of the touch-down latches the drift until
 *   release; later moves of the touch never do. B: the R81g / R81c latches above. C: a touch-down in
 *   the bottom driftZoneFrac of the steering zone drifts at once until release, a higher one never.
 *   In A and C driftPull and driftEdge do not act.
 * - brake is always false.
 * - R151 (model C, car.model 2, read live): no drift latch (drift always false); a second axis
 *   throttle from dy: dead = thrDead*R, full = thrFull*R; down, with room = height - y0 - edgeMargin
 *   (>= 4 px) < full: dead *= room/full, full = room; t = min(1, (|dy| - dead)/(full - dead))^thrExp
 *   past the dead zone, throttle = -t down, +t up, smoothed with thrTauMs between reads; 0 at once
 *   on release. R155: in state DRIFT the steer travel is driftSteerMul*R (switches at once).
 */
/**
 * The car the zone stick serves, read live (R151, R155): model 2 (C) adds the throttle axis, drops
 * the drift latches, and in state DRIFT steers over driftSteerMul*R.
 */
export interface ZoneStickCar {
  readonly model: number;
  readonly state?: 'GRIP' | 'DRIFT';
}

const PX_EPS = 1e-9;

export function createZoneStick(cfg: TouchStickConfig, car?: ZoneStickCar): TouchStick {
  let width = 0;
  let height = 0;
  let active: number | null = null;
  let anchorX = 0;
  let anchorY = 0;
  let steer = 0;
  let drift = false;
  let mode: 'A' | 'B' | 'C' = 'B';
  let downT = 0;
  let releasing = false;
  let releaseSteer = 0;
  let releaseT = 0;
  let dxRaw = 0; // R151: last move of the active touch from its touch-down point
  let dyRaw = 0;
  let thr = 0; // R151 smoothed throttle
  let readT = 0;

  /** R151 raw throttle of the finger dy (screen y down: dy > 0 = lift). */
  function throttleOf(r: number): number {
    let full = (cfg.thrFull ?? 0) * r;
    let dead = (cfg.thrDead ?? 0) * r;
    if (dyRaw > 0) {
      let room = height - anchorY - (cfg.edgeMargin ?? 0);
      if (room < 4) room = 4;
      if (room < full) {
        dead *= room / full;
        full = room;
      }
    }
    const a = dyRaw < 0 ? -dyRaw : dyRaw;
    // PX_EPS: float slack of the px subtraction (a finger exactly on the dead-zone border reads 0).
    if (a <= dead + PX_EPS || full <= dead) return 0;
    let k = (a - dead) / (full - dead);
    if (k > 1) k = 1;
    const t = Math.pow(k, cfg.thrExp ?? 1);
    return dyRaw > 0 ? -t : t;
  }

  function release(id: number, tMs: number): void {
    if (id !== active) return;
    active = null;
    drift = false;
    thr = 0; // R151: throttle 0 on the first read after release
    dxRaw = 0;
    dyRaw = 0;
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
    pointerDown(id: number, x: number, y: number, tMs: number): boolean {
      if (active !== null) return false;
      if (y < height - height * cfg.steerZoneFrac) return false;
      active = id;
      anchorX = x;
      anchorY = y;
      downT = tMs;
      readT = tMs;
      dxRaw = 0;
      dyRaw = 0;
      thr = 0;
      mode = cfg.touchDrift ?? 'B';
      steer = 0;
      // R81h C: the bottom driftZoneFrac of the steering zone makes a drift touch.
      drift = mode === 'C' && y >= height - height * cfg.steerZoneFrac * cfg.driftZoneFrac;
      releasing = false;
      return true;
    },
    pointerMove(id: number, x: number, y: number, tMs: number): void {
      if (id !== active) return;
      const r = cfg.stickRadius * width;
      const dx = x - anchorX;
      dxRaw = dx;
      dyRaw = y - anchorY;
      const raw = r > 0 ? dx / r : 0;
      steer = raw > 1 ? 1 : raw < -1 ? -1 : raw;
      if (mode === 'C') return;
      if (mode === 'A') {
        // R81h A: a sideways flick within flickMs of the touch-down latches the drift until release.
        if (r > 0 && tMs - downT <= cfg.flickMs && (dx < 0 ? -dx : dx) >= r * cfg.flickDist)
          drift = true;
        return;
      }
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
      const modelC = car?.model === 2;
      const r = cfg.stickRadius * width;
      if (modelC && active !== null) {
        // R151/R155: linear steer over R, over driftSteerMul*R while the car is in DRIFT.
        const travel = car.state === 'DRIFT' ? r * (cfg.driftSteerMul ?? 1) : r;
        const raw = travel > 0 ? dxRaw / travel : 0;
        steer = raw > 1 ? 1 : raw < -1 ? -1 : raw;
        // R151: throttle smoothed with thrTauMs since the last read.
        const target = r > 0 ? throttleOf(r) : 0;
        const dt = tMs > readT ? tMs - readT : 0;
        const tau = cfg.thrTauMs ?? 0;
        thr = tau > 0 ? thr + (target - thr) * (1 - Math.exp(-dt / tau)) : target;
      }
      readT = tMs;
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
      // R151: model C has no drift latch; the throttle axis is written only in model C.
      out.drift = modelC ? false : drift;
      if (modelC) out.throttle = thr;
    },
  };
}

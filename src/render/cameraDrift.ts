import { approach } from './driftVisual';

/** R27c camera shift into the turn and horizon roll (render only; numbers in src/data/camera.json). */
export interface CamDriftConfig {
  camDriftShift: number; // half-widths of lateral camera shift at |g| = 1 in DRIFT (0 = off)
  camRollDeg: number; // degrees of horizon roll at |g| = 1 in DRIFT (0 = off)
  camGripMul: number; // share of the DRIFT target applied in GRIP
  camDriftTau: number; // s, time constant of the exponential approach
}

/** R27c render state (not sim state). */
export interface CamDrift {
  shiftX: number;
  rollDeg: number;
}

/**
 * R27c: moves state toward g*k*camDriftShift / g*k*camRollDeg (g = normalised signed body angle
 * R89, clamped to ±1; k = 1 in DRIFT, camGripMul in GRIP) with time constant camDriftTau.
 * Mutates state, no allocations.
 */
export function stepCamDrift(
  state: CamDrift,
  g: number,
  drifting: boolean,
  dt: number,
  cfg: CamDriftConfig,
): void {
  const gc = g > 1 ? 1 : g < -1 ? -1 : g;
  const k = drifting ? 1 : cfg.camGripMul;
  state.shiftX = approach(state.shiftX, gc * k * cfg.camDriftShift, dt, cfg.camDriftTau);
  state.rollDeg = approach(state.rollDeg, gc * k * cfg.camRollDeg, dt, cfg.camDriftTau);
}

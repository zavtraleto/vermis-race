/** Keyboard steering ramp. */
export interface KeyboardConfig {
  /** Time for steer to travel 0 -> 1 (and 1 -> 0) while a key is held / released, ms. */
  steerRampMs: number;
}

/** Touch scheme A: relative stick (H2 A, kickoff-brief "Управление"). */
export interface TouchStickConfig {
  /** Stick radius R as a fraction of the game area width. */
  stickRadiusFrac: number;
  /** |raw| <= deadZone -> steer 0. */
  deadZone: number;
  /** steer = sign(raw) * |raw|^responseExp. */
  responseExp: number;
  /** Time for steer to return from full lock (|steer| = 1) to 0 after release, ms. */
  releaseMs: number;
  /** Steering zone = bottom fraction of the game area height, full width. */
  steerZoneFrac: number;
  /** H3 A: finger this many CSS px below the touch-down point -> drift. */
  driftPullDownPx: number;
  /** H3 C: |steer| at or past this starts the touch drift. */
  autoDriftSteer: number;
  /** H3 C: the touch drift ends when steer toward the drift side falls below this. */
  autoDriftRelease: number;
  /** H3 D: a touch-down at most this many ms after the last up is armed for the re-touch drift. */
  retouchWindowMs: number;
  /** H3 D: an armed touch moved this many CSS px sideways from its touch-down point drifts. */
  retouchSwipePx: number;
  /** H3 E: steer changing by at least this much within flickWindowMs is a flick (drift). */
  flickDelta: number;
  /** H3 E: flick time window, ms. */
  flickWindowMs: number;
  /** R81c zone stick radius as a fraction of the game area width. */
  stickRadius: number;
  /** R81c sideways drift border as a multiple of stickRadius (0 = no sideways border). */
  driftEdge: number;
  /** R81g pull-down drift: finger moved down by this multiple of stickRadius latches the drift (0 = off). */
  driftPull: number;
  /** R81c zone stick: ms for the released steer to return to 0 (0 = at once). */
  zoneReleaseMs: number;
  /** R81h (H19) touch drift mode of the zone stick, read at each touch-down; absent = 'B'. */
  touchDrift?: 'A' | 'B' | 'C';
  /** R81h A: flick window after touch-down, ms. */
  flickMs: number;
  /** R81h A: sideways flick distance as a multiple of stickRadius. */
  flickDist: number;
  /** R81h C: bottom fraction of the steering zone where a touch-down drifts. */
  driftZoneFrac: number;
  // R151 (model C) vertical axis of the zone stick; optional until input.json carries them.
  /** R151 vertical dead zone as a multiple of stickRadius*width. */
  thrDead?: number;
  /** R151 full vertical travel as a multiple of stickRadius*width. */
  thrFull?: number;
  /** R151 throttle = t^thrExp after the dead zone. */
  thrExp?: number;
  /** R151 px kept above the bottom edge when the travel down is short. */
  edgeMargin?: number;
  /** R151 ms, exponential smoothing of the throttle. */
  thrTauMs?: number;
  /** R155 [директор 2026-11-22] in DRIFT of model C the steer travel is driftSteerMul*R: steer = clamp(dx/(R*driftSteerMul), -1, 1). */
  driftSteerMul?: number;
}

export interface InputConfig {
  keyboard: KeyboardConfig;
  touch: TouchStickConfig;
}

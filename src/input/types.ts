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
  /** R81c drift border as a multiple of stickRadius. */
  driftEdge: number;
  /** R81c zone stick: ms for the released steer to return to 0 (0 = at once). */
  zoneReleaseMs: number;
}

export interface InputConfig {
  keyboard: KeyboardConfig;
  touch: TouchStickConfig;
}

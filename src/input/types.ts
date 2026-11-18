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
}

export interface InputConfig {
  keyboard: KeyboardConfig;
  touch: TouchStickConfig;
}

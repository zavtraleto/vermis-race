/** R202 control pad (`pad`): a rectangle centred on the screen; numbers in src/data/input.json. */
export interface PadConfig {
  /** R202 finger X offset that gives full steer, share of the screen half-width. */
  steerSpan: number;
  /** R202 steer dead zone around the centre, share of the X travel. */
  steerDead: number;
  /** R202 half-height of the rectangle, share of the screen half-height. */
  padHalfH: number;
  /** R202 bottom share of the rectangle half-height where the gas falls (below it: brake). */
  liftZone: number;
  /** R202 drift entry: seconds from the lift to the re-touch, and from the re-touch to the steer. */
  retouchWindow: number;
  /** R202 drift entry: |steer| needed within retouchWindow after the re-touch. */
  retouchSteer: number;
}

/** R214 look of the visible pad (CSS px); positions come from padLayout. */
export interface PadViewConfig {
  /** Stroke width of the pad lines. */
  lineWidth: number;
  /** Full height of a dead-zone mark across the X axis. */
  deadMark: number;
  /** Radius of the finger dot. */
  dotRadius: number;
}

export interface InputConfig {
  pad: PadConfig;
  padView: PadViewConfig;
}

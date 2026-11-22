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
}

export interface InputConfig {
  pad: PadConfig;
}

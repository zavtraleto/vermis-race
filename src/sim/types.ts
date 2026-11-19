export interface InputFrame {
  steer: number;
  brake: boolean;
  drift: boolean;
}

export interface Car {
  kind: 'player' | 'rival' | 'traffic';
  z: number;
  x: number;
  speed: number;
  vx: number;
  steer: number;
  heading: number;
  state: 'GRIP' | 'DRIFT';
  dir: -1 | 0 | 1;
  offTicks: number; // R21 consecutive ticks with |x| > 1, 0 on road
  angle: number; // R22 drift angle, signed (+ right), angle*dir in [0, 1]; 0 in GRIP
  driftHeld: boolean; // R20 drift input of the previous tick (rising-edge detection)
  armTicks: number; // R20 ticks since the rising edge of the drift input while armed, 0 otherwise
  lowTicks: number; // R21 consecutive DRIFT ticks with angle*dir < driftAngleExit
}

export interface RaceState {
  tick: number;
  rng: number;
  cars: Car[];
}

export interface CarParams {
  vmax: number;
  accel: number;
  brake: number;
  steerRate: number;
  steerRise: number;
  grip: number;
  gripDrift: number;
  centrifugal: number;
  centMulDrift: number;
  driftRate: number;
  driftArmTime: number; // R20 seconds after the rising edge during which drift entry is armed
  offroadMul: number;
  offroadGrip: number; // R15b grip in R12 while |x| > 1
  offroadSteerMul: number; // R15b multiplier of the R11 target while |x| > 1
  kCurve: number; // R13 K_CURVE, tuning (brief section 3)
  xLimit: number; // R18 lateral limit, half-widths
  driftEnterSpeed: number; // R20 enter only above driftEnterSpeed * vmax
  driftEnterSteer: number; // R20 enter only with |steer| above this
  driftExitSpeed: number; // R21 forced exit below driftExitSpeed * vmax
  driftOffroadTime: number; // R21 forced exit after this many seconds off road in a row (H11 A only)
  driftOffroad: number; // H11 / R21b: 1 = B (drift works off road), 0 = A (asphalt-only entry, forced exit)
  driftAngleStart: number; // R20 |angle| on drift entry
  driftAngleExit: number; // R21 angle*dir below this counts as a small angle
  driftStraightTime: number; // R21 seconds of small angle in a row that end the drift
  driftAngleResponse: number; // R22 angle chase rate toward the steer, 1/s
  driftSpeedLoss: number; // R22 speed cap = vmax * (1 - driftSpeedLoss * |angle|)
  driftBrake: number; // R22 deceleration above the cap, vmax per second
}

export interface Segment {
  curve: number;
  /** R30 road height at the END of the segment, segment lengths (visual only). Absent = 0. */
  y?: number;
}

export interface Track {
  segments: Segment[];
}

/** One road piece, javascript-racer addRoad style. Lengths in segments, curve in curve units (+ right). */
export interface TrackSection {
  enter: number;
  hold: number;
  leave: number;
  curve: number;
  hill?: number; // R30 height change over the whole section, segment lengths (+ up)
}

export interface TrackDef {
  sections: TrackSection[];
}

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
  driftDrag: number;
  offroadMul: number;
  offroadGrip: number; // R15b grip in R12 while |x| > 1
  offroadSteerMul: number; // R15b multiplier of the R11 target while |x| > 1
  kCurve: number; // R13 K_CURVE, tuning (brief section 3)
  xLimit: number; // R18 lateral limit, half-widths
}

export interface Segment {
  curve: number;
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
}

export interface TrackDef {
  sections: TrackSection[];
}

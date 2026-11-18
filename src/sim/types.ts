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
}

export interface Segment {
  curve: number;
}

export interface Track {
  segments: Segment[];
}

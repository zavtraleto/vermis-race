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
  bumpTicks: number; // R43 remaining invulnerability ticks after a contact
  draft: number; // R51 slipstream charge in [0, 1]
  boostTicks: number; // R52 (H5 B) remaining boost ticks after leaving the cone with a full charge
  // Model B (R80-R89, H14):
  yaw: number; // R83 body heading relative to the road tangent, lateral units
  yawRate: number; // R83
  vel: number; // R84 direction of motion relative to the road tangent, lateral units
  carry: number; // R82b visible slip left over from the last state change, decays
  recover: number; // OBSOLETE (to be removed by the implementer together with R83 blending)
  steerHist: number[]; // R81 ring buffer of raw steer, fixed length STEER_HIST
  steerHistHead: number; // R81 next write index
  steerHistCount: number; // R81 number of recorded ticks, up to STEER_HIST
}

export interface RaceState {
  tick: number;
  rng: number;
  cars: Car[];
}

export interface CarParams {
  model: number; // H14: 0 = model A (R10-R22d), 1 = model B (R80-R89)
  // Model B parameters (R80-R89b), see docs/research/yaw-slip-spike.md section 2.
  kYaw: number;
  latScale: number;
  yawFullSpeed: number;
  yawRateMax: number;
  yawAlign: number;
  yawResponse: number;
  velGrip: number;
  slipGripMax: number;
  slipGripLimit: number;
  slipFull: number; // R83/R87 visible slip at full steer in DRIFT
  slipResponse: number; // R83 DRIFT slip chase natural rate, 1/s
  driftLat: number; // R84 DRIFT lateral authority of the slip and of counter-steer
  driftPush: number; // R84 DRIFT push by the road turn, times A
  carryDecay: number; // R82b 1/s
  yawRateMaxDrift: number; // OBSOLETE
  yawAlignDrift: number;
  yawResponseDrift: number;
  velGripDrift: number;
  slipDriftMax: number;
  slipHardMax: number;
  slipDrag: number;
  flickDelta: number; // R81 steer change that enters a drift (car param, distinct from the H3 E input config)
  flickWindow: number; // R81 seconds
  kickBase: number;
  kickGain: number;
  gripRecoverTime: number;
  slipSnapMax: number;
  snapLoss: number;
  snapCatch: number;
  slipViewFull: number;
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
  offroadVelMul: number; // R84 model B: g and smax multiplier in GRIP while |x| > 1 (1 = none)
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
  carLength: number; // R40 contact length along z, segments
  carHitW: number; // R40 player hit width, half-widths
  trafficHitW: number; // R40 traffic hit width, half-widths
  bumpSpeedLoss: number; // R41 rear hit, vmax
  bumpSideLoss: number; // R41 side contact, vmax
  bumpFloor: number; // R41 speed floor, vmax
  bumpKick: number; // R42 lateral speed kick
  bumpInvulnTime: number; // R43 seconds
  bumpAngleLoss: number; // R44 drift angle loss
  driftAutoExit: number; // R21c / H12: 1 = small-angle exit on (H12 A), 0 = off (H12 B)
  draftLength: number; // R50 cone length ahead, segments
  draftWidth: number; // R50 cone width, half-widths
  draftChargeTime: number; // R51 seconds to charge 0 -> 1 in the cone
  draftDecayTime: number; // R51 seconds to decay 1 -> 0 outside the cone
  draftCapMul: number; // R52 speed cap multiplier while boosted
  draftAccelMul: number; // R52 acceleration multiplier while boosted
  boostTime: number; // R52 (H5 B) seconds the boost lasts after leaving the cone
  draftBoost: number; // H5: 0 = A, 1 = B
}

/** R71 traffic pool config (src/data/traffic.json) plus the lane count of the road. */
export interface TrafficConfig {
  trafficMax: number;
  trafficSpawnAhead: number;
  trafficDespawnBehind: number;
  trafficGapMin: number;
  trafficGapMax: number;
  trafficSpeedMin: number;
  trafficSpeedMax: number;
  lanes: number;
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

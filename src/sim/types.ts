export interface InputFrame {
  steer: number;
  brake: boolean;
  drift: boolean;
  /** R151 (model C) second axis in [-1, 1]: +1 up ("gas"), -1 down ("lift"), 0 centre / released.
   * Optional [директор 2026-11-22]: absent = 0; model C reads `throttle ?? 0`, A and B ignore it. */
  throttle?: number;
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
  steerHist: number[]; // R81 ring buffer of raw steer, fixed length STEER_HIST
  steerHistHead: number; // R81 next write index
  steerHistCount: number; // R81 number of recorded ticks, up to STEER_HIST
  deflectTicks: number; // R81b (C) consecutive ticks of one-sign deflection
  autoTicks: number; // R81e (variant 4) consecutive counted ticks toward an auto drift entry
  turbo: number; // R86c (H18) drift charge in [0, 1]
  turboTicks: number; // R86c (H18) remaining turbo ticks after a drift exit
  driftTicks: number; // R86e/R87 ticks of the current drift, 0 in GRIP
  scrubDebt: number; // R86e scrub debt (speed units) of the first debtTime seconds of a drift
  relSide: number; // R85f release memory side sign(vInf), 0 = no memory
  relV: number; // R85f target lateral course vT of the release memory, half-widths/s at vmax
  crashTicks: number; // R48 remaining crash ticks, 0 = driving
  crashSpeed0: number; // R48 speed at the moment of the hit
  crashX0: number; // R48 x at the moment of the hit
  cruise: number; // R41b traffic speed given by R71 (player and rivals 0)
  skill: number; // R62 bot level: 0 novice, 1 average, 2 expert (player 0)
  pace: number; // R62 personal multiplier of vmax (player 1)
  nameId: number; // R62 index into the rival names (player and traffic -1)
  place: number; // R66 race place, 1 = leader (stored at the end of the step)
  role: number; // R62b 0 close, 1 ahead, 2 behind (player 0)
  slot: number; // R62b target gap d = z - zPlayer, segments, signed
  slotTicks: number; // R62b ticks left until the slot is redrawn
  nemesis: number; // R62b 1 for the single hunter, else 0
  band: number; // R63 smoothed rubber band, cap = vmax*pace*(1 + band)
  joinTicks: number; // R63b ticks left of the 'joined the race' notice
}

export interface RaceState {
  tick: number;
  rng: number;
  cars: Car[];
}

export interface CarParams {
  model: number; // H14: 0 = model A (R10-R22d), 1 = model B (R80-R89), 2 = model C (R150-R164)
  // Model C parameters (R153-R159), angles in degrees. Optional until cars/base.json carries them
  // (the implementer adds the data and may make them required).
  liftOn?: number; // R154 throttle <= -liftOn is the lift edge
  liftOff?: number; // R154 throttle > -liftOff re-arms the edge
  driftWindow?: number; // R154 s, entry window after a lift
  switchWindow?: number; // R158 s, window after a drift end (other side only)
  betaEntry?: number; // R154 deg, window angle at full steer
  winTau?: number; // R154 s, window angle filter
  betaOn?: number; // R154/R158 deg, drift threshold
  driftEndDelay?: number; // R158 s below betaOn before the drift ends
  entryFloor?: number; // R155 deg, floor of the angle target while the window lives
  betaPerA?: number; // R153 deg of hold angle per unit of A
  refLook?: number; // R153 s of road ahead averaged
  refTau?: number; // R153 s, reference smoothing
  uHold?: number; // R155 finger share that holds the reference angle
  betaMax?: number; // R155 deg, slip limit
  betaTau?: number; // R155/R157 s, angle chase
  latPerDeg?: number; // R156 half-widths/s per degree over the hold angle
  thrLat?: number; // R156 half-widths/s per unit throttle (up = wider)
  velGripC?: number; // R156 1/s, course chase in DRIFT
  railK?: number; // R156 1/s, rails times sin(beta)
  bumpFrom?: number; // R156 cushion start, share of the half-width
  bumpGain?: number; // R156 half-widths/s inward at the edge
  outSlide?: number; // R156 half-widths/s^2, outward course turn limit
  missFree?: number; // R157 deg
  missLoss?: number; // R157 share of vmax per degree
  missCap?: number; // R157 deg
  missBrake?: number; // R157 vmax/s
  liftDecelDrift?: number; // R157 vmax/s at throttle -1 in DRIFT
  thrAccelUp?: number; // R157 accel gain at throttle +1 in DRIFT
  liftDecel?: number; // R159 vmax/s at throttle -1 in GRIP
  exitRamp?: number; // R159 s, GRIP lead ramp after a drift end
  slipDeg?: number; // R156/R158 degrees per lateral unit of yaw (R89, copied from sprites.json weight)
  // Model B parameters (R80-R89b), see docs/research/calm-drift-spike.md section 3.
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
  driftPush: number; // R84 DRIFT push by the road turn, times A (turn toward the drift side or straight)
  wrongPush: number; // R84 DRIFT push when the turn is against the drift side (A*dir < 0)
  driftCounter: number; // R84 DRIFT authority of the finger against dir: 0 none, 1 full
  carryDecay: number; // R82b 1/s
  velGripDrift: number; // R84 DRIFT vel chase rate, 1/s
  driftLead: number; // R85 DRIFT lead of the finger over the body angle, 0 = off
  gripLead: number; // R85b GRIP lead of vx toward the steady vel of the current steer, 0 = off
  gripDodge: number; // R85c GRIP dodge: extra vx per unit of raw steer on straights, 0 = off
  dodgeFadeA: number; // R85c |A| at which the dodge has faded to 0
  driftMinU: number; // R83b floor of the finger share uc in DRIFT, 0 = off
  driftRail: number; // R84c H21 drift rails in [0, 1]: share of the corner push above the R83b floor removed, 0 = off
  releaseHold: number; // R85f H20: 1 = release memory on (B), 0 = off (A)
  releaseSlide: number; // R85f growth of the release memory target, half-widths/s^2
  driftDive: number; // R84b inward dive above the knee of the gained angle, 0 = off
  driftKnee: number; // R84b share of the full angle above which the dive starts (< 1)
  leadRamp: number; // R85d seconds for the drift lead to ramp in from entry, 0 = off
  debtTime: number; // R86e seconds of drift during which the scrub piles up as debt, 0 = off
  slipDrag: number; // R86 GRIP speed cost of the visible slip
  gripScrub: number; // R86b H17: 1 = on (B), 0 = off (A)
  scrubStart: number; // R86b share of the grip limit gripA above which GRIP loses speed
  scrubRate: number; // R86b speed loss per unit of need above scrubStart, vmax per second
  driftTurbo: number; // R86c H18: 1 = on (B), 0 = off (A)
  turboChargeTime: number; // R86c seconds of full drift angle to charge 0 -> 1
  turboTime: number; // R86c seconds of turbo at a full charge
  turboCap: number; // R86c speed cap while boosted = vmax * (1 + turboCap)
  turboAccelMul: number; // R86c acceleration multiplier while boosted
  turboMin: number; // R86c smallest charge that gives a turbo on exit
  flickDelta: number; // R81 steer change that enters a drift (car param, distinct from the H3 E input config)
  flickWindow: number; // R81 seconds
  kickBase: number; // R81 initial slip rate at flickDelta
  kickGain: number; // R81 extra slip rate per unit of steer change above flickDelta
  driftEntry: number; // R81b/R81c H16: 0 = A flick, 1 = B road-dependent flick, 2 = C deflection, 3 = D zone stick, 4 = E auto drift (R81e), 5 = F drift in every corner (R81f)
  flickLook: number; // R81b segments looked ahead
  flickCornerMin: number; // R81b smallest |curve| that counts as a corner
  flickCornerMul: number; // R81b threshold multiplier toward a corner
  flickStraightMul: number; // R81b threshold multiplier on a straight / against a corner
  deflectEnter: number; // R81b |steer| that counts as a deflection
  deflectTime: number; // R81b seconds of deflection to enter
  autoSteer: number; // R81e steer toward the corner that counts
  autoHold: number; // R81e seconds of counted ticks to enter
  autoLook: number; // R81e seconds of road looked ahead
  autoNeed: number; // R81e needAhead that counts
  cornerCurve: number; // R81f |curve| at or above which a segment is a corner segment
  cornerGap: number; // R81f segments ahead in which a same-side corner segment keeps the drift
  cornerSpan: number; // R83c line share per unit of steer around the hold share h
  cornerMinU: number; // R83c lowest share uc in variant 5
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
  driftSpeedLoss: number; // R22 / R86 speed cap = vmax * (1 - driftSpeedLoss * |angle|)
  driftBrake: number; // R22 deceleration above the cap, vmax per second
  carLength: number; // R40 contact length along z, segments
  carHitW: number; // R40 player hit width, half-widths
  trafficHitW: number; // R40 traffic hit width, half-widths
  bumpSpeedLoss: number; // R41 rear hit, vmax
  bumpSideLoss: number; // R41 side contact, vmax
  bumpPush: number; // R41 rear hit: traffic speed >= v0 + bumpPush, vmax
  bumpPushDecay: number; // R41b pushed traffic returns to cruise, player vmax per second
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
  lampEvery: number; // R47 lamp posts on segment boundaries with index multiple of this
  lampOffset: number; // R47 lamp |x|, half-widths
  lampHitW: number; // R47 lamp hit width, half-widths
  crashMinSpeed: number; // R47 minimum speed for a crash, vmax
  crashTime: number; // R48 seconds
  crashReturnX: number; // R48 |x| where the car is put back on the road
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

/** R60-R65 rivals config (src/data/rivals.json) plus the lane count of the road. */
export interface RivalConfig {
  rivalCount: number;
  rivalGridGap: number;
  rivalGridBehind: number;
  rivalSkillWeights: [number, number, number]; // weights of novice, average, expert
  rivalPaceSpread: number;
  rivalNameCount: number;
  rubberBand: number; // H15: 1 = A (on), 0 = B (off)
  rivalRoles: [number, number, number]; // R62b counts of close / ahead / behind
  slotClose: [number, number];
  slotAhead: [number, number];
  slotBehind: [number, number];
  nemesisSlot: [number, number];
  slotTimeMin: number; // seconds
  slotTimeMax: number;
  bandRange: number;
  bandBoost: number;
  bandSlow: number;
  bandViewDist: number;
  bandViewMul: number;
  nemesisViewMul: number;
  bandAttack: number; // 1/s
  bandRelease: number; // 1/s
  bandStartDelay: number; // seconds
  poolRadius: number; // R63b segments
  poolSpawnBehind: number;
  joinShowTime: number; // seconds
  rivalBumpLoss: number; // R65, vmax
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

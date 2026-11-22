/** R201: one tick of input (player, rival bot, scripted bot). */
export interface InputFrame {
  steer: number; // R201 steer target, -1..1 (+ right)
  gas: number; // R201 0..1
  brake: number; // R201 0..1
  driftTap: boolean; // R201/R202 drift entry event on this tick
}

export interface Car {
  kind: 'player' | 'rival' | 'traffic';
  // R200 driving state; angles in radians, + right.
  z: number;
  x: number;
  speed: number;
  travel: number; // R200 direction of the velocity relative to the road tangent
  heading: number; // R200 body heading relative to the road tangent
  steer: number; // R200 steer after smoothing, -1..1
  travelRate: number; // R200/R207 turn rate of travel, rad/s (lagged)
  slipRate: number; // R200 change of slip over the last tick / DT, rad/s
  counter: number; // R200/R206 counter-steer share 0..1
  driftTimer: number; // R200/R208 drift timer, ticks
  edge: number; // R200/R209 edge push 0..1
  refAngle: number; // R200/R209 reference angle
  wallTicks: number; // R200/R211
  prevGas: number; // R200/R208 input of the previous tick
  prevBrake: number; // R200/R208
  bumpTicks: number; // R43 remaining invulnerability ticks after a contact
  draft: number; // R51 slipstream charge in [0, 1]
  boostTicks: number; // R52 (H5 B) remaining boost ticks after leaving the cone with a full charge
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
  vmax: number;
  vmaxKmh: number; // R200 km/h at speed 1 (copied from sprites.json speedometer, one source)
  halfWidthM: number; // R200/R210 road half-width, metres
  steerInTime: number; // R203 seconds for steer 0 -> 1 away from zero
  steerOutTime: number; // R203 seconds for steer 1 -> 0 toward zero
  wheelMax: number; // R203 wheel angle at steer 1, degrees
  wheelBase: number; // R206/R207 metres
  gripFront: number; // R206 front axle limit atan(gripFront*g*wheelBase/v^2)
  rearMu: number; // R207 rear grip of the car, T = slipRecover*atan(gripRear*rearMu*g*wheelBase/v^2)
  slipRecover: number; // R207 1/s, scale of the travel catch-up limit T
  slipDecay: number; // R207 1/s, travel catch-up per radian of slip
  slipRateMax: number; // R207 |travelRate| limit, deg/s
  slipMax: number; // R207 |slip| limit, degrees
  slipGrip: number; // R204/R208 below this |slip| (degrees) traction is 1
  slipLatch: number; // R208 drift latch angle, degrees
  driftTraction: number; // R204 traction when |slip| >= slipGrip
  railGrip: number; // R209 outside drift c = railGrip*sin^2(slip), share per OR2 tick
  roadTurn: number; // R210 rad per segment at curve 1
  driftWindow: number; // R208 seconds the window stays open after an opening
  driftHold: number; // R208 seconds the latch keeps the drift after |slip| <= slipLatch
  gripFrontDrift: number; // R208 drift set: R206 uses it instead of gripFront while driftTimer > 0
  slipDecayDrift: number; // R208 drift set: R207 uses it instead of slipDecay while driftTimer > 0
  gripDrift: number; // R208 rear grip share in drift before the drops
  dropFull: number; // R208 grip drop at full gas
  dropLift: number; // R208 grip drop with the gas lifted (scaled by cs)
  brakeTapOn: number; // R208 brake level of a brake tap
  gasTapMax: number; // R208 gas below this counts as lifted for a brake tap
  assistSpeed: number; // R205 km/h above which the countersteer assist works
  assistLead: number; // R205 seconds the wheels lead the slip rate
  assistFull: number; // R205 |steer| at which the assist puts the wheels fully on wheelGo
  assistMax: number; // R205 |wheelGo| limit, degrees
  railDrift: number; // R209 in drift c = railDrift*|sin(slip)|, share per OR2 tick
  edgePull: number; // R209 edge pull strength (H24)
  edgeFall: number; // R209 edge falls no faster than this per OR2 tick
  refRateMax: number; // R209 refAngle moves at most this many degrees per OR2 tick
  refGain: number; // R209 refAngle target per radian of road turn ahead (H25)
  refLook: number; // R209 segments ahead summed for the reference angle
  refGrip: number; // R208 rear grip added beyond refAngle (H25)
  hypAssist: number; // H23 R205: 1 = A (on), 0 = B (off)
  hypEdge: number; // H24 R209 edge: 1 = A, 0 = B
  hypRef: number; // H25 R209 reference angle: 1 = A, 0 = B
  hypBrakeTap: number; // H26 R208 brake tap: 1 = A, 0 = B
  wallKillAngle: number; // R211 impact angle above which the wall kills the slip, degrees
  wallTime: number; // R211 seconds the slip is held 0 after such a hit
  accel: number; // R204 vmax per second at gas 1
  engineBrake: number; // R204 vmax per second at gas 0
  brakeDecel: number; // R204 vmax per second at brake 1
  offroadMul: number; // R15
  xLimit: number; // R18 lateral limit, half-widths
  carLength: number; // R40 contact length along z, segments
  carHitW: number; // R40 player hit width, half-widths
  trafficHitW: number; // R40 traffic hit width, half-widths
  bumpSpeedLoss: number; // R41 rear hit, vmax
  bumpSideLoss: number; // R41 side contact, vmax
  bumpPush: number; // R41 rear hit: traffic speed >= v0 + bumpPush, vmax
  bumpPushDecay: number; // R41b pushed traffic returns to cruise, player vmax per second
  bumpFloor: number; // R41 speed floor, vmax
  bumpKick: number; // R42 lateral speed kick (unused until the collisions slice, ADR 0005)
  bumpInvulnTime: number; // R43 seconds
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

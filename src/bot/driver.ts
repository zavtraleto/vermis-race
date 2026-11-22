// T16 driver bots. A bot reads only what a player sees (its car and the track ahead) and
// writes an InputFrame (R201); it goes through the same step() as a human. Pure, deterministic,
// allocation-free per tick (same boundary as src/sim).
// R212: the bot steers at full gas toward its line, aiming at where the car will be in aimTime s (its
// travel angle; the road turn is covered by the hold steer) plus the steer that holds the curve ahead
// in grip (R203/R207). Before a corner its speed cannot hold in grip (R206 front limit vs the
// curvature ahead) it taps drift (driftTap, steer into the corner), holds a slip angle with the steer
// in the drift, and on the exit countersteers until |slip| < slipLatch, then centres (R215(5)).
// Before a corner too sharp for its drift (brakeShare) it brakes with gas 0 (pad bottom third).
import { DT, G, SEG_PER_UNIT } from '../sim/constants';
import type { Car, CarParams, InputFrame, Track } from '../sim/types';

/** Where the bot puts the car laterally: road centre, or the inside of the corner ahead. */
export type AimMode = 'centre' | 'inside';
/** ignore: drive as if the road were empty; avoid: weave around traffic cars ahead (R70, R46). */
export type TrafficMode = 'ignore' | 'avoid';

export interface BotParams {
  steerLookahead: number; // s of road ahead averaged for the inside line
  aim: AimMode;
  insideX: number; // inside line target, half-widths (aim = inside)
  insideFullCurve: number; // |mean curve ahead| at which the full insideX is used
  steerGain: number; // steer per half-width of error to the target line
  aimTime: number; // s ahead at which the lateral position is predicted (R212)
  cornerShare: number; // R212 drift when a corner ahead needs more than this share of the R206 limit; 0 = never
  driftLook: number; // s of road ahead scanned for a corner that needs a drift (R212)
  brakeShare: number; // R212 brake before a corner needing more than this times the R206 limit; 0 = never
  driftSlip: number; // deg, largest slip the bot asks for in a drift (R212)
  slipGain: number; // steer per deg of slip error in a drift (R212)
  slipLead: number; // s ahead at which the slip is predicted from slipRate in a drift (R212)
  noiseAmp: number; // std of the low-passed steering noise, steer units; 0 = off
  noiseTau: number; // s, low-pass time constant of the noise
  reactionDelay: number; // s between deciding a steer value and applying it, <= MAX_DELAY_TICKS*DT
  traffic: TrafficMode;
  trafficLookaheadSeg: number; // segments ahead scanned for traffic cars in the path
  trafficMargin: number; // half-widths of clearance added to the R40 hit width when passing
  trafficEdge: number; // |x| limit of a passing gap, half-widths
}

/** Longest supported reaction delay, ticks (0.5 s at DT = 1/120). Structural: sizes the ring buffer. */
export const MAX_DELAY_TICKS = 60;

/** Flat, serializable per-bot state. rng follows the mulberry32 pattern of src/sim/rng.ts (R2). */
export interface BotState {
  rng: number;
  noise: number;
  /** Ring buffer of decided steer values, so a delayed bot outputs what it decided reactionDelay ago. */
  steerQueue: number[];
  head: number;
  /** R212 drift entry side (+1 / -1) held from the tap until the latch; 0 = not entering. */
  entry: number;
}

export function createBot(seed: number): BotState {
  const steerQueue: number[] = [];
  for (let i = 0; i < MAX_DELAY_TICKS + 1; i++) steerQueue.push(0);
  return { rng: seed | 0, noise: 0, steerQueue, head: 0, entry: 0 };
}

/** mulberry32, same algorithm as nextRandom in src/sim/rng.ts, on the bot's own state. */
function nextUnit(bot: BotState): number {
  let t = (bot.rng + 0x6d2b79f5) | 0;
  bot.rng = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function wrap(i: number, n: number): number {
  const m = i % n;
  return m < 0 ? m + n : m;
}

/**
 * Cars the weaving (R46) steers around: every traffic car, and another race car (R65 contact,
 * rivals) only while it is slower than this one (a faster one pulls away). Never the car itself.
 */
function isObstacle(t: Car, car: Car): boolean {
  if (t === car) return false;
  return t.kind === 'traffic' || t.speed < car.speed;
}

/**
 * True when the lateral move from x0 to x1 crosses the band (R40 hit width + margin) of a traffic
 * car in the scan window. A band that already contains x0 may be left on the side x0 is on.
 */
function crosses(
  x0: number,
  x1: number,
  car: Car,
  cars: readonly Car[],
  bp: BotParams,
  clear: number,
  back: number,
): boolean {
  const lo = x0 < x1 ? x0 : x1;
  const hi = x0 < x1 ? x1 : x0;
  for (let i = 0; i < cars.length; i++) {
    const t = cars[i]!;
    if (!isObstacle(t, car)) continue;
    const dz = t.z - car.z;
    if (dz <= back || dz > bp.trafficLookaheadSeg) continue;
    const l = t.x - clear;
    const h = t.x + clear;
    if (h <= lo || l >= hi) continue; // band outside the move
    const startsIn = x0 > l && x0 < h;
    const endsIn = x1 > l && x1 < h;
    // Inside a band the car may only leave it on its own side (never across the traffic car).
    if (!startsIn || endsIn || (x0 - t.x) * (x1 - t.x) < 0) return true;
  }
  return false;
}

/**
 * Weaving (R46): if reaching xWant means ending in or crossing the band of a traffic car within
 * trafficLookaheadSeg, the reachable free position beside one of those cars (|x| <= trafficEdge)
 * nearest to xWant; NaN when the way is clear or no gap exists. Reads positions only.
 */
function avoidX(
  bp: BotParams,
  car: Car,
  cars: readonly Car[],
  p: CarParams,
  xWant: number,
): number {
  const clear = (p.carHitW + p.trafficHitW) / 2 + bp.trafficMargin;
  const back = -p.carLength;
  // A car already inside a band always steers out of it (never through it).
  if (
    !crosses(car.x, xWant, car, cars, bp, clear, back) &&
    !crosses(car.x, car.x, car, cars, bp, clear, back)
  )
    return NaN;
  let best = NaN;
  let bestD = Infinity;
  for (let i = 0; i < cars.length; i++) {
    const t = cars[i]!;
    if (!isObstacle(t, car)) continue;
    const dz = t.z - car.z;
    if (dz <= back || dz > bp.trafficLookaheadSeg) continue;
    for (let s = -1; s <= 1; s += 2) {
      const c = t.x + s * clear;
      if (c > bp.trafficEdge || c < -bp.trafficEdge) continue;
      const d = c > xWant ? c - xWant : xWant - c;
      if (d < bestD && !crosses(car.x, c, car, cars, bp, clear, back)) {
        best = c;
        bestD = d;
      }
    }
  }
  return best;
}

/**
 * Adds the bot's steering noise to the decided steer, clamps it, and returns the steer decided
 * reactionDelay ago (the one applied now), or this one when `now`.
 */
function humanize(bot: BotState, bp: BotParams, decided: number, now: boolean): number {
  let steer = decided;
  if (bp.noiseAmp > 0) {
    // Low-passed uniform noise, scaled so its stationary std equals noiseAmp.
    const a = 1 - Math.exp(-DT / bp.noiseTau);
    bot.noise += (2 * nextUnit(bot) - 1 - bot.noise) * a;
    steer += (bp.noiseAmp * bot.noise) / Math.sqrt(a / (2 - a) / 3);
  }
  if (steer > 1) steer = 1;
  if (steer < -1) steer = -1;
  // Reaction delay: decide now, act reactionDelay later (zero delay = act now).
  const q = bot.steerQueue;
  const qn = q.length;
  bot.head = (bot.head + 1) % qn;
  q[bot.head] = steer;
  if (now) return steer; // R212 drift entry: the steer into the corner comes with the tap
  let delay = Math.round(bp.reactionDelay / DT);
  if (delay > qn - 1) delay = qn - 1;
  return q[wrap(bot.head - delay, qn)]!;
}

/**
 * R212: the side (+1 right, -1 left) of the first segment within driftLook s that needs a path
 * curvature above cornerShare of what the car holds in grip at the current speed: the R206 front
 * limit gripFront*g/v^2 or the full lock tan(wheelMax)/wheelBase; 0 when every corner there holds.
 */
function driftSide(bp: BotParams, car: Car, track: Track, p: CarParams, seg0: number): number {
  const segs = track.segments;
  const n = segs.length;
  const segM = p.vmaxKmh / 3.6 / SEG_PER_UNIT;
  const v = (car.speed * p.vmaxKmh) / 3.6;
  const lock = Math.tan((p.wheelMax * Math.PI) / 180) / p.wheelBase;
  const grip = v > 0 ? (p.gripFront * G) / (v * v) : Infinity;
  const kMax = bp.cornerShare * (grip < lock ? grip : lock);
  const reach = Math.round(car.speed * SEG_PER_UNIT * bp.driftLook);
  for (let i = 0; i <= reach; i++) {
    const c = segs[wrap(seg0 + i, n)]!.curve;
    if (((c < 0 ? -c : c) * p.roadTurn) / segM > kMax) return c > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * R212 speed: 2 = brake, 1 = lift the gas, 0 = full gas. Too fast for a segment ahead means it needs
 * a path curvature above brakeShare times the R206 grip limit gripFront*g/v^2 at this speed (the
 * sharpest this level trusts its drift with). The bot presses the brake (gas 0, an H26 tap) only
 * while that corner is more than a drift window away and within braking distance (brake 1, gas 0,
 * R204) and the wheel is inside the R206 grip steer (`press`: a tap with the wheel turned latches a
 * drift), holds a started brake until the speed is down, and otherwise only lifts the gas.
 */
function speedCall(
  bp: BotParams,
  car: Car,
  track: Track,
  p: CarParams,
  seg0: number,
  press: boolean,
): number {
  const segs = track.segments;
  const n = segs.length;
  const segM = p.vmaxKmh / 3.6 / SEG_PER_UNIT;
  const v = (car.speed * p.vmaxKmh) / 3.6;
  const decel = ((p.brakeDecel + p.engineBrake) * p.vmaxKmh) / 3.6; // m/s^2
  const early = v * p.driftWindow; // m the window of a brake tap lasts
  const reach = Math.ceil(((v * v) / (2 * decel) + early) / segM) + 1;
  let call = 0;
  for (let i = 0; i <= reach; i++) {
    const c = segs[wrap(seg0 + i, n)]!.curve;
    const k = ((c < 0 ? -c : c) * p.roadTurn) / segM; // road curvature, 1/m
    if (k <= 0) continue;
    const va2 = (bp.brakeShare * p.gripFront * G) / k; // v^2 this level drifts through there
    if (v * v <= va2) continue;
    if (car.prevBrake > 0) return 2;
    const d = i * segM;
    if (press && d >= early && (v * v - va2) / (2 * decel) + early >= d) return 2;
    call = 1;
  }
  return call;
}

/** Writes the bot's InputFrame for this tick into `out` (R201): steer to the line, full gas. */
export function botInput(
  bot: BotState,
  bp: BotParams,
  car: Car,
  track: Track,
  p: CarParams,
  out: InputFrame,
  cars?: readonly Car[],
): void {
  const segs = track.segments;
  const n = segs.length;
  const seg0 = wrap(Math.floor(car.z), n);
  // Mean curve of the road covered in steerLookahead s at the current speed (at least 1 segment).
  let d = Math.round(car.speed * SEG_PER_UNIT * bp.steerLookahead);
  if (d < 1) d = 1;
  let sum = 0;
  for (let i = 0; i < d; i++) sum += segs[wrap(seg0 + i, n)]!.curve;
  const curve = sum / d;
  let xTarget = 0;
  if (bp.aim === 'inside') {
    let r = curve / bp.insideFullCurve;
    if (r > 1) r = 1;
    if (r < -1) r = -1;
    xTarget = bp.insideX * r; // + curve = right turn, inside = +x
  }
  if (bp.traffic === 'avoid' && cars !== undefined) {
    const xa = avoidX(bp, car, cars, p, xTarget);
    if (xa === xa) xTarget = xa;
  }
  // R210: the road turns under the car at omega; `hold` below already turns the car with it, so the
  // predicted lateral move over aimTime is the travel angle only (no second road-turn term).
  const v = (car.speed * p.vmaxKmh) / 3.6;
  const omega = curve * p.roadTurn * car.speed * SEG_PER_UNIT;
  const t = bp.aimTime;
  const xAhead = car.x + (v * Math.sin(car.travel) * t) / p.halfWidthM;
  // R206/R207 in grip: yaw = v*tan(wheel)/wheelBase, so holding omega needs this steer.
  const hold = v > 0 ? Math.atan((omega * p.wheelBase) / v) / ((p.wheelMax * Math.PI) / 180) : 0;
  let steer = hold + bp.steerGain * (xTarget - xAhead);
  // R212: steer at which the R206 front limit binds. A drift starts only when the corner ahead needs
  // one and the line asks for more turn into it than that (a car heading inside its line does not).
  const gripSteer =
    Math.atan((p.gripFront * G * p.wheelBase) / (v * v)) / (p.wheelMax * (Math.PI / 180));
  const side = bp.cornerShare > 0 ? driftSide(bp, car, track, p, seg0) : 0;
  const turnIn = side !== 0 && steer * side >= gripSteer;
  const slip = car.heading - car.travel;
  const deg = Math.PI / 180;
  let tap = false;
  let now = false;
  const aslip = slip < 0 ? -slip : slip;
  const latch = p.slipLatch * deg;
  const ahead = slip + car.slipRate * bp.slipLead; // slip predicted slipLead s ahead
  // R212 entry: from the tap, through the window (driftTimer above driftHold), steer into the corner
  // until the slip predicted slipLead s ahead reaches the latch (the countersteer needs that long).
  const holdTicks = Math.round(p.driftHold / DT);
  if (car.driftTimer <= holdTicks || ahead * bot.entry >= latch) bot.entry = 0;
  if (bot.entry !== 0) {
    steer = bot.entry;
    now = true;
  } else if (car.driftTimer > 0 && (side !== 0 || (car.driftTimer > holdTicks && aslip < latch))) {
    // R212 in a drift (or a brake-tap window, H26, not latched yet): travel turns toward the body at
    // slipDecayDrift*slip (R207), so the yaw rate the line steer asks for becomes a slip angle (at most
    // driftSlip), held by the steer on the slip predicted slipLead s ahead (neutral steer keeps
    // rotating, countersteer straightens).
    const max = bp.driftSlip * deg;
    let want = (v * steer * p.wheelMax * deg) / p.wheelBase / p.slipDecayDrift;
    if (want > max) want = max;
    if (want < -max) want = -max;
    steer = (bp.slipGain * (want - ahead)) / deg;
  } else if (car.driftTimer > 0) {
    // R212 exit (R215(5)): countersteer (damped, on the predicted slip) until |slip| < slipLatch,
    // then the wheel to centre.
    steer = aslip < latch ? 0 : (-bp.slipGain * ahead) / deg;
  } else if (turnIn) {
    tap = true; // R212 entry: driftTap with the steer into the corner
    steer = side;
    now = true;
    bot.entry = side;
  }
  out.steer = humanize(bot, bp, steer, now);
  // R212: before a corner too sharp for this level's drift, brake as the pad bottom third: gas 0.
  const press = (car.steer < 0 ? -car.steer : car.steer) < gripSteer;
  const call = bp.brakeShare > 0 ? speedCall(bp, car, track, p, seg0, press) : 0;
  out.gas = call > 0 ? 0 : 1;
  out.brake = call === 2 ? 1 : 0;
  out.driftTap = tap;
}

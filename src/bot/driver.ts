// T16 driver bots. A bot reads only what a player sees (its car and the track ahead) and
// writes an InputFrame (R201); it goes through the same step() as a human. Pure, deterministic,
// allocation-free per tick (same boundary as src/sim).
// R212 minimal (slice 1): the bot steers at full gas toward its line, aiming at where the car will be
// in aimTime s (its travel angle and the road curving away, R210) plus the steer that holds the
// curve ahead in grip (R203/R207), and brakes before a corner its speed cannot hold in grip (R206
// front limit vs the curvature ahead); it never drifts yet (drift entry, counter-steer come later).
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
  cornerShare: number; // R212 brake when a corner ahead needs more than this share of the R206 limit; 0 = never
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
}

export function createBot(seed: number): BotState {
  const steerQueue: number[] = [];
  for (let i = 0; i < MAX_DELAY_TICKS + 1; i++) steerQueue.push(0);
  return { rng: seed | 0, noise: 0, steerQueue, head: 0 };
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
 * reactionDelay ago (the one applied now).
 */
function humanize(bot: BotState, bp: BotParams, decided: number): number {
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
  let delay = Math.round(bp.reactionDelay / DT);
  if (delay > qn - 1) delay = qn - 1;
  return q[wrap(bot.head - delay, qn)]!;
}

/**
 * R212: true when a segment within braking distance needs a path curvature above cornerShare of
 * what the car holds in grip there at the current speed: the R206 front limit
 * tan(atan(gripFront*g*wheelBase/v^2))/wheelBase = gripFront*g/v^2 and the full lock
 * tan(wheelMax)/wheelBase. Braking distance from v to the speed that segment allows, at brakeDecel.
 */
function mustBrake(bp: BotParams, car: Car, track: Track, p: CarParams, seg0: number): boolean {
  const segs = track.segments;
  const n = segs.length;
  const segM = p.vmaxKmh / 3.6 / SEG_PER_UNIT;
  const v = (car.speed * p.vmaxKmh) / 3.6;
  const decel = (p.brakeDecel * p.vmaxKmh) / 3.6; // m/s^2
  const lock = (bp.cornerShare * Math.tan((p.wheelMax * Math.PI) / 180)) / p.wheelBase;
  const reach = Math.ceil((v * v) / (2 * decel) / segM) + 1;
  for (let i = 0; i <= reach; i++) {
    const c = segs[wrap(seg0 + i, n)]!.curve;
    const k = ((c < 0 ? -c : c) * p.roadTurn) / segM; // road curvature, 1/m
    if (k <= 0) continue;
    if (k > lock) return true; // no speed holds it in grip: slow down as much as possible
    const va2 = (bp.cornerShare * p.gripFront * G) / k; // allowed v^2 there
    if (v * v > va2 && (v * v - va2) / (2 * decel) >= i * segM) return true;
  }
  return false;
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
  // R210: the road turns under the car at omega; the car's path relative to the road over aimTime.
  const v = (car.speed * p.vmaxKmh) / 3.6;
  const omega = curve * p.roadTurn * car.speed * SEG_PER_UNIT;
  const t = bp.aimTime;
  const xAhead = car.x + (v * (Math.sin(car.travel) * t - 0.5 * omega * t * t)) / p.halfWidthM;
  // R206/R207 in grip: yaw = v*tan(wheel)/wheelBase, so holding omega needs this steer.
  const hold = v > 0 ? Math.atan((omega * p.wheelBase) / v) / ((p.wheelMax * Math.PI) / 180) : 0;
  out.steer = humanize(bot, bp, hold + bp.steerGain * (xTarget - xAhead));
  const brake = bp.cornerShare > 0 && mustBrake(bp, car, track, p, seg0);
  out.gas = brake ? 0 : 1;
  out.brake = brake ? 1 : 0;
  out.driftTap = false;
}

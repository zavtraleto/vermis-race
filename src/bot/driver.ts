// T16 driver bots. A bot reads only what a player sees (its car and the track ahead) and
// writes an InputFrame (R4); it goes through the same step() as a human. Pure, deterministic,
// allocation-free per tick (same boundary as src/sim).
import { DT, SEG_PER_UNIT } from '../sim/constants';
import type { Car, CarParams, InputFrame, Track } from '../sim/types';

/** Where the bot puts the car laterally: road centre, or the inside of the corner ahead. */
export type AimMode = 'centre' | 'inside';
/** never: no brake; hold: brake while the curve ahead exceeds the hold limit; late: brake at the last point that still reaches the limit. */
export type SpeedMode = 'never' | 'hold' | 'late';
/** never: no drift input; corners: drift through corners with |curve| >= driftMinCurve (R20-R22). */
export type DriftMode = 'never' | 'corners';

export interface BotParams {
  steerLookahead: number; // s of road ahead used for steering, also the x-correction time constant
  brakeLookahead: number; // s of road ahead scanned for speed decisions
  aim: AimMode;
  insideX: number; // inside line target, half-widths (aim = inside)
  insideFullCurve: number; // |mean curve ahead| at which the full insideX is used
  speed: SpeedMode;
  steerReserve: number; // share of steer kept free for x correction when computing the hold limit
  edgeMargin: number; // half-widths kept from the outer edge when using road width (speed = late)
  noiseAmp: number; // std of the low-passed steering noise, steer units; 0 = off
  noiseTau: number; // s, low-pass time constant of the noise
  reactionDelay: number; // s between deciding a steer value and applying it, <= MAX_DELAY_TICKS*DT
  drift: DriftMode;
  driftMinCurve: number; // drift only through corners at least this sharp (|curve|)
  driftLookahead: number; // s of road ahead: drift is held while such a corner is this close
  driftApproach: number; // s of road ahead: in GRIP, steer to the entry line when such a corner is this close
  driftEntryX: number; // entry line toward the inside of the drift corner, half-widths (negative = outside)
  driftLineX: number; // line held in DRIFT toward the inside, half-widths
  driftKickSteer: number; // |steer| used in GRIP to pass driftEnterSteer (R20)
  driftFeedLookahead: number; // s of road ahead averaged for the drift equilibrium feed-forward
  driftGain: number; // 1/s, lateral speed per unit x error toward the target line in DRIFT
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

/**
 * Highest sp = speed/vmax at which steer s still holds the line on curve c.
 * R11 steady lateral speed s*steerRate*sp*(1-0.25 sp) plus a width allowance a*sp
 * (outward drift the bot accepts, a = allowed drift speed per unit sp) must cover the
 * R13 push |c|*sp^2*centrifugal*kCurve. Dividing by sp:
 *   sp <= (s*steerRate + a) / (0.25*s*steerRate + |c|*centrifugal*kCurve).
 * Returns >= 1 when the curve does not limit the speed.
 */
export function holdSpeedLimit(c: number, s: number, allowance: number, p: CarParams): number {
  const k = (c < 0 ? -c : c) * p.centrifugal * p.kCurve;
  const den = 0.25 * s * p.steerRate + k;
  if (den <= 0) return Infinity;
  return (s * p.steerRate + allowance) / den;
}

function wrap(i: number, n: number): number {
  const m = i % n;
  return m < 0 ? m + n : m;
}

/** Writes this tick's input for `car` into `out`. Reads car + track ahead only. */
export function botInput(
  bot: BotState,
  bp: BotParams,
  car: Car,
  track: Track,
  p: CarParams,
  out: InputFrame,
): void {
  const segs = track.segments;
  const n = segs.length;
  const sp = car.speed / p.vmax;
  const k = p.centrifugal * p.kCurve;
  const segPerSec = car.speed * SEG_PER_UNIT;
  const seg0 = wrap(Math.floor(car.z), n);

  // Steering: aim at a target x within steerLookahead, feed forward the mean R13 push ahead.
  let dSteer = Math.round(segPerSec * bp.steerLookahead);
  if (dSteer < 1) dSteer = 1;
  let sum = 0;
  for (let i = 0; i < dSteer; i++) sum += segs[wrap(seg0 + i, n)]!.curve;
  const cMean = sum / dSteer;
  let xTarget = 0;
  if (bp.aim === 'inside') {
    let r = cMean / bp.insideFullCurve;
    if (r > 1) r = 1;
    if (r < -1) r = -1;
    xTarget = bp.insideX * r; // + curve = right turn, inside = +x (R19 signs)
  }
  // Drift corners (R20): the nearest segment with |curve| >= driftMinCurve, its distance and side.
  let driftSign = 0;
  let driftAt = 0;
  let dDrift = Math.round(segPerSec * bp.driftLookahead);
  if (dDrift < 1) dDrift = 1;
  if (bp.drift === 'corners') {
    let dScan = Math.round(segPerSec * bp.driftApproach);
    if (dScan < dDrift) dScan = dDrift;
    for (let i = 0; i < dScan; i++) {
      const c = segs[wrap(seg0 + i, n)]!.curve;
      if (c >= bp.driftMinCurve || c <= -bp.driftMinCurve) {
        driftSign = c > 0 ? 1 : -1;
        driftAt = i;
        break;
      }
    }
  }
  const inDrift = car.state === 'DRIFT';
  // Drift is held while the corner is within driftLookahead; dir is fixed until exit (R20),
  // so a drift corner the other way releases first.
  const wantDrift = driftSign !== 0 && driftAt < dDrift && (!inDrift || driftSign === car.dir);

  let steer: number;
  if (inDrift && wantDrift && sp > 0) {
    xTarget = bp.driftLineX * car.dir;
    // R22: steer around the equilibrium (target = push) for the curve just ahead, plus a
    // proportional pull toward the target line. target = dir*lerp(min, max, (steer*dir+1)/2)*driftRate*sp.
    let dFeed = Math.round(segPerSec * bp.driftFeedLookahead);
    if (dFeed < 1) dFeed = 1;
    let feed = 0;
    for (let i = 0; i < dFeed; i++) feed += segs[wrap(seg0 + i, n)]!.curve;
    feed /= dFeed;
    const push = feed * sp * sp * p.centrifugal * p.centMulDrift * p.kCurve;
    const vxReq = push + bp.driftGain * (xTarget - car.x);
    const lerp = (vxReq * car.dir) / (p.driftRate * sp);
    const t = (lerp - p.driftSteerMin) / (p.driftSteerMax - p.driftSteerMin);
    steer = car.dir * (2 * t - 1);
  } else {
    let cFeed = cMean;
    if (driftSign !== 0 && !inDrift) {
      // Approach to a drift corner: go to the entry line and hold only the push under the car,
      // so the drift starts without the inward lateral speed that DRIFT cannot take back (R22).
      xTarget = bp.driftEntryX * driftSign;
      cFeed = segs[seg0]!.curve;
    }
    const vxReq = (xTarget - car.x) / bp.steerLookahead + cFeed * sp * sp * k;
    const authority = p.steerRate * sp * (1 - 0.25 * sp); // R11 vx per unit steer
    steer = authority > 0 ? vxReq / authority : 0;
    // R20: in GRIP, turn into the coming drift corner past driftEnterSteer.
    if (wantDrift && steer * driftSign < bp.driftKickSteer) steer = driftSign * bp.driftKickSteer;
  }

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
  out.steer = q[wrap(bot.head - delay, qn)]!;
  out.drift = wantDrift;

  // Speed. Drift corners are taken without braking: their segments are ignored here.
  out.brake = false;
  if (bp.speed === 'never') return;
  let dBrake = Math.round(segPerSec * bp.brakeLookahead);
  if (dBrake < 1) dBrake = 1;
  const sHold = 1 - bp.steerReserve;
  const cSkip = bp.drift === 'corners' ? bp.driftMinCurve : Infinity;
  if (bp.speed === 'hold') {
    let cMax = 0;
    for (let i = 0; i < dBrake; i++) {
      const c = segs[wrap(seg0 + i, n)]!.curve;
      const ac = c < 0 ? -c : c;
      if (ac > cMax && ac < cSkip) cMax = ac;
    }
    out.brake = sp > holdSpeedLimit(cMax, sHold, 0, p);
    return;
  }

  // late: find the steepest segment ahead and the length of the corner around it
  // (the ribbon map shows the whole corner), then allow outward drift across the road.
  let iMax = 0;
  let cMax = 0;
  for (let i = 0; i < dBrake; i++) {
    const c = segs[wrap(seg0 + i, n)]!.curve;
    const ac = c < 0 ? -c : c;
    if (ac > cMax && ac < cSkip) {
      cMax = ac;
      iMax = i;
    }
  }
  if (cMax <= 0) return;
  const cSign = segs[wrap(seg0 + iMax, n)]!.curve;
  const half = 0.5 * cMax;
  let len = 1;
  for (let i = iMax + 1; i < iMax + n; i++) {
    const c = segs[wrap(seg0 + i, n)]!.curve;
    if (c * cSign <= 0 || (c < 0 ? -c : c) < half) break;
    len++;
  }
  for (let i = iMax - 1; i > iMax - n; i--) {
    const c = segs[wrap(seg0 + i, n)]!.curve;
    if (c * cSign <= 0 || (c < 0 ? -c : c) < half) break;
    len++;
  }
  // Drift budget W from the inside line to the outer edge over the corner time T = len/(sp*vmax*SEG):
  // allowed drift speed W/T = a*sp with a = W*vmax*SEG/len.
  const width = bp.insideX + 1 - bp.edgeMargin;
  const allowance = width > 0 ? (width * p.vmax * SEG_PER_UNIT) / len : 0;
  const frac = car.z - Math.floor(car.z);
  const next = car.speed + p.accel * DT; // speed after one more tick without brake (R14)
  for (let i = 0; i < dBrake; i++) {
    const c = segs[wrap(seg0 + i, n)]!.curve;
    if ((c < 0 ? -c : c) >= cSkip) continue;
    const lim = holdSpeedLimit(c, sHold, allowance, p);
    if (lim >= 1) continue;
    const v = lim * p.vmax;
    let d = i - frac; // segments until that segment starts
    if (d < 0) d = 0;
    // R14 constant decel: distance (segments) = SEG*(v0^2 - v^2)/(2*brake).
    const reach = Math.sqrt(v * v + (2 * p.brake * d) / SEG_PER_UNIT);
    if (next > reach) {
      out.brake = true;
      return;
    }
  }
}

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
/**
 * Line held in DRIFT. fixed: driftLineX toward the inside. width: use the road width (R22b skill):
 * aim to reach driftExitX on the outside exactly where the drift ends, so the angle carried is the
 * smallest that still keeps the car on the asphalt.
 */
export type DriftLine = 'fixed' | 'width';
/** ignore: drive as if the road were empty; avoid: weave around traffic cars ahead (R70, R46). */
export type TrafficMode = 'ignore' | 'avoid';

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
  driftLine: DriftLine;
  driftExitX: number; // width line: x toward the outside to reach at the end of the drift, half-widths
  driftAngleFloor: number; // width line: lowest |angle| held (kept above driftAngleExit, R21)
  driftPlanMin: number; // width line: s, lower bound of the time left used to aim at the exit
  traffic: TrafficMode;
  trafficLookaheadSeg: number; // segments ahead scanned for traffic cars in the path
  trafficMargin: number; // half-widths of clearance added to the R40 hit width when passing
  trafficEdge: number; // |x| limit of a passing gap, half-widths
  trafficSteerTime: number; // s, x-correction time constant toward the gap in GRIP
  // Model B driver (H14): feedback gains, not a model inversion.
  bSteerGain: number; // GRIP: steer per half-width of error to the target line
  bSteerDamp: number; // GRIP: steer per half-width/s of lateral speed (vx), subtracted
  bCurveGain: number; // GRIP: steer per unit of (mean curve ahead x sp)
  bLookahead: number; // s of road ahead averaged for the curvature term
  bDriftSteerGain: number; // DRIFT: steer per half-width of error to the drift line
  bDriftSteerDamp: number; // DRIFT: steer per half-width/s of vx, subtracted
  bDriftCurveGain: number; // DRIFT: steer per unit of (mean curve ahead x sp)
  bGripMargin: number; // share of the full steer the bot trusts GRIP with (R83/R84 hold steer); above it: drift
  bDriftLineX: number; // DRIFT: line held toward the inside of the drift, half-widths (negative = outside)
  bFlickLook: number; // s of road ahead: flick into a drift when such a corner is this close
  bReleaseLook: number; // s of road ahead: release the drift when no drift corner is this close
  bReleaseFrac: number; // in DRIFT a corner still counts while its turn exceeds this share of the grip cap
  bDipSteer: number; // |steer| of the counter-steer before the flick
  bDipTime: number; // s of counter-steer
  bKickTime: number; // s of full steer into the corner after the counter-steer
  bTrafficGain: number; // line gain multiplier while steering to a gap beside traffic (R46)
  // Model C driver (R162). Optional until bots.json carries them.
  cLead?: number; // s before the corner start to lift (< 0: -cLead s after the start)
  cErr?: number; // relative finger error around uHold
  cErrPeriod?: number; // s, period of the finger error
  cUseThr?: boolean; // line by throttle in DRIFT
  cKx?: number; // line by steer in DRIFT
  cRelease?: boolean; // lets the finger go at the corner end
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
  /** Model B: ticks into a planned flick (R81), 0 = none. */
  flick: number;
  /** Model B: side of the planned flick. */
  flickDir: number;
  /** Model B: decided drift input (1/0), same ring and delay as steerQueue. */
  driftQueue: number[];
}

export function createBot(seed: number): BotState {
  const steerQueue: number[] = [];
  for (let i = 0; i < MAX_DELAY_TICKS + 1; i++) steerQueue.push(0);
  return {
    rng: seed | 0,
    noise: 0,
    steerQueue,
    head: 0,
    flick: 0,
    flickDir: 0,
    driftQueue: steerQueue.slice(),
  };
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

/**
 * True when segment i belongs to a drift corner: the run of same-sign curve around it (ramps
 * included) reaches |curve| >= cSkip somewhere. Such segments are taken in DRIFT, not braked for.
 */
function inDriftCorner(segs: Track['segments'], n: number, i: number, cSkip: number): boolean {
  const sign = segs[wrap(i, n)]!.curve;
  if (sign === 0) return false;
  for (let d = -1; d <= 1; d += 2) {
    for (let j = 0; j < n; j++) {
      const c = segs[wrap(i + d * j, n)]!.curve;
      if (c * sign <= 0) break;
      if (c >= cSkip || c <= -cSkip) return true;
    }
  }
  return false;
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
 * reactionDelay ago (the one applied now). Shared by both driving models.
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
  return q[wrap(bot.head - delayTicks(bp, qn), qn)]!;
}

function delayTicks(bp: BotParams, qn: number): number {
  const delay = Math.round(bp.reactionDelay / DT);
  return delay > qn - 1 ? qn - 1 : delay;
}

/** Segments covered in `secs` at segPerSec, at least 1. */
function ahead(segPerSec: number, secs: number): number {
  const d = Math.round(segPerSec * secs);
  return d < 1 ? 1 : d;
}

/** Mean curve of the `d` segments from seg0 on (d >= 1). */
function meanCurve(segs: Track['segments'], n: number, seg0: number, d: number): number {
  let sum = 0;
  for (let i = 0; i < d; i++) sum += segs[wrap(seg0 + i, n)]!.curve;
  return sum / d;
}

/**
 * Model B driver (H14, R80-R88). A feedback driver, not a model inversion: steer = gain on the
 * lateral error to a target line - damping on the lateral speed + a gain on the curvature ahead
 * (gains per skill level in bots.json). A corner whose GRIP hold steer exceeds bGripMargin is taken
 * in DRIFT: a planned flick (R81: an optional short counter-steer, then a full steer into the corner
 * with the drift input held), the input held through the corner and released at the exit (R82).
 * Reaction delay and noise as in A.
 */
function botInputB(
  bot: BotState,
  bp: BotParams,
  car: Car,
  track: Track,
  p: CarParams,
  out: InputFrame,
  cars: readonly Car[] | undefined,
): void {
  const weave = bp.traffic === 'avoid' && cars !== undefined;
  const segs = track.segments;
  const n = segs.length;
  const sp = car.speed / p.vmax;
  const segPerSec = car.speed * SEG_PER_UNIT;
  const seg0 = wrap(Math.floor(car.z), n);
  // What the bot trusts GRIP to hold, as a road turn rate A: the R83/R84 steady state on a curve
  // needs steer A*(1 + yawAlign/velGrip)/(yawRateMax*f); GRIP is trusted up to bGripMargin of it.
  let f = sp / p.yawFullSpeed;
  if (f > 1) f = 1;
  const gripCap = (bp.bGripMargin * p.yawRateMax * f) / (1 + p.yawAlign / p.velGrip);
  const turn = sp * p.kYaw; // A per unit curve at the current speed
  const inDrift = car.state === 'DRIFT';
  if (inDrift) bot.flick = 0;
  // R81f "Боты" (driftEntry 5): the sim decides entry and exit by the road; a drifting bot keeps the
  // drift input down all lap, plans no flick and does not brake; the side search uses gripCap 0.
  const v5 = p.driftEntry === 5;
  const v5Drift = v5 && bp.drift === 'corners';
  const cap = v5 ? 0 : gripCap;

  // Drift corner ahead within bFlickLook (GRIP) / bReleaseLook (DRIFT): the first segment GRIP
  // cannot hold; in DRIFT a bend the other way first ends the drift.
  let driftSign = 0;
  if (bp.drift === 'corners' && turn > 0) {
    const look = ahead(segPerSec, inDrift ? bp.bReleaseLook : bp.bFlickLook);
    for (let i = 0; i < look; i++) {
      const c = segs[wrap(seg0 + i, n)]!.curve;
      const a = (c < 0 ? -c : c) * turn;
      if (inDrift && c * car.dir < 0 && a > cap * bp.bReleaseFrac) break;
      if (a > (inDrift ? cap * bp.bReleaseFrac : cap)) {
        driftSign = c > 0 ? 1 : -1;
        break;
      }
    }
  }
  const holdDrift = inDrift && driftSign === car.dir;

  // Target line: centre or the inside of the bend ahead (as in model A); in DRIFT driftLineX.
  const cMean = meanCurve(segs, n, seg0, ahead(segPerSec, bp.steerLookahead));
  let xTarget = 0;
  if (holdDrift) xTarget = bp.bDriftLineX * car.dir;
  else if (bp.aim === 'inside') {
    let r = cMean / bp.insideFullCurve;
    if (r > 1) r = 1;
    if (r < -1) r = -1;
    xTarget = bp.insideX * r; // + curve = right turn, inside = +x (R19 signs)
  }
  // R46 weaving: the gap beside a traffic car in the way, taken with bTrafficGain x the line gain.
  let lineMul = 1;
  if (weave) {
    const xa = avoidX(bp, car, cars, p, xTarget);
    if (xa === xa) {
      xTarget = xa;
      lineMul = bp.bTrafficGain;
    }
  }
  const cAhead = meanCurve(segs, n, seg0, ahead(segPerSec, bp.bLookahead));
  let steer = holdDrift
    ? bp.bDriftCurveGain * cAhead * sp +
      bp.bDriftSteerGain * lineMul * (xTarget - car.x) -
      bp.bDriftSteerDamp * car.vx
    : bp.bCurveGain * cAhead * sp +
      bp.bSteerGain * lineMul * (xTarget - car.x) -
      bp.bSteerDamp * car.vx;

  // R81 planned flick: counter-steer for bDipTime with the drift input up until its last tick (else
  // the dip itself is a flick the wrong way), then full steer into the corner for bKickTime with it held, then the
  // line controller; held until DRIFT, or until the flick has had time to reach the car (reaction
  // delay + dip + kick + flickWindow) and failed. The drift input goes through the same delay.
  if (
    !v5 &&
    !inDrift &&
    bot.flick === 0 &&
    driftSign !== 0 &&
    car.speed > p.driftEnterSpeed * p.vmax
  ) {
    bot.flick = 1;
    bot.flickDir = driftSign;
  }
  let drift = holdDrift;
  if (!inDrift && bot.flick > 0) {
    // R81: a flick counts only inside one hold, so the hold starts on the last pre-kick tick (the
    // dip steer, or the line steer without a dip) and the kick follows inside it.
    // R81b C (driftEntry 2): no flick; no dip, and the full steer is held past deflectTime (the
    // entry comes on the tick after deflectTime/DT qualifying ticks), with a tick of margin.
    const byDeflect = p.driftEntry === 2;
    const dip = byDeflect ? 0 : Math.round(bp.bDipTime / DT);
    const pre = dip < 1 ? 1 : dip;
    let kick = Math.round(bp.bKickTime / DT);
    if (byDeflect && kick < Math.round(p.deflectTime / DT) + 2)
      kick = Math.round(p.deflectTime / DT) + 2;
    const f = bot.flick;
    const timeout =
      delayTicks(bp, bot.steerQueue.length) + pre + kick + Math.round(p.flickWindow / DT);
    if (p.driftEntry === 3) {
      // R81c (driftEntry 3): no flick, no dip; the drift input goes down together with a full steer
      // toward the corner, so the entry tick sees steer of the corner's sign.
      if (f <= kick) steer = bot.flickDir;
      drift = true;
    } else {
      if (f <= dip) steer = -bot.flickDir * bp.bDipSteer;
      else if (f > pre && f <= pre + kick) steer = bot.flickDir;
      drift = f >= pre;
    }
    bot.flick = f >= timeout ? 0 : f + 1;
  }
  out.steer = humanize(bot, bp, steer);
  const dq = bot.driftQueue;
  dq[bot.head] = drift ? 1 : 0;
  out.drift = dq[wrap(bot.head - delayTicks(bp, dq.length), dq.length)] === 1;
  // R81f "Боты": the drift input is held on every tick (no reaction delay: the finger never lifts).
  if (v5) out.drift = v5Drift;

  // Speed: brake only for a corner the bot neither drifts nor trusts GRIP with at this speed.
  // R81f "Боты": a drifting bot (drift 'corners') never brakes.
  out.brake = false;
  if (bp.speed === 'never' || inDrift || bot.flick > 0 || v5Drift) return;
  const dBrake = ahead(segPerSec, bp.brakeLookahead);
  for (let i = 0; i < dBrake; i++) {
    const c = segs[wrap(seg0 + i, n)]!.curve;
    const a = (c < 0 ? -c : c) * turn;
    if (a > gripCap && (bp.drift !== 'corners' || car.speed <= p.driftEnterSpeed * p.vmax)) {
      out.brake = true;
      return;
    }
  }
}

/**
 * Writes this tick's input for `car` into `out`. Reads car + track ahead only, and (traffic =
 * avoid) the positions of the traffic cars in `cars`, read-only.
 */
export function botInput(
  bot: BotState,
  bp: BotParams,
  car: Car,
  track: Track,
  p: CarParams,
  out: InputFrame,
  cars?: readonly Car[],
): void {
  // H14: the driver follows the car's driving model.
  if (p.model === 2) throw new Error('not implemented: model C driver (R162)');
  if (p.model === 1) {
    botInputB(bot, bp, car, track, p, out, cars);
    return;
  }
  const weave = bp.traffic === 'avoid' && cars !== undefined;
  const segs = track.segments;
  const n = segs.length;
  const sp = car.speed / p.vmax;
  const k = p.centrifugal * p.kCurve;
  const segPerSec = car.speed * SEG_PER_UNIT;
  const seg0 = wrap(Math.floor(car.z), n);
  // R22d: a corner GRIP holds at vmax with the bot's usable steer (1 - steerReserve) is faster
  // without the drift cap (R22), so only sharper corners are drift corners:
  // R11/R13 at sp = 1: 0.75 * s * steerRate >= |c| * centrifugal * kCurve.
  const cGrip = k > 0 ? (0.75 * (1 - bp.steerReserve) * p.steerRate) / k : Infinity;
  const cDrift = cGrip > bp.driftMinCurve ? cGrip : bp.driftMinCurve;

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
  const inDrift = car.state === 'DRIFT';
  // In DRIFT: does the road bend the other way before that corner (no same-side carry-over)?
  let opposite = false;
  if (bp.drift === 'corners') {
    let dScan = Math.round(segPerSec * bp.driftApproach);
    if (dScan < dDrift) dScan = dDrift;
    for (let i = 0; i < dScan; i++) {
      const c = segs[wrap(seg0 + i, n)]!.curve;
      if (c >= cDrift || c <= -cDrift) {
        driftSign = c > 0 ? 1 : -1;
        driftAt = i;
        break;
      }
      if (c * car.dir < 0) opposite = true;
    }
  }
  // Drift is held while the corner is within driftLookahead, or, already in DRIFT, carried into
  // the next same-side corner within driftApproach if the road does not bend the other way first.
  // dir is fixed until exit (R20), so a drift corner the other way releases first.
  const sameSide = inDrift && driftSign === car.dir;
  const wantDrift =
    driftSign !== 0 &&
    (driftAt < dDrift || (sameSide && !opposite)) &&
    (!inDrift || driftSign === car.dir);

  let steer: number;
  // DRIFT: the inward move around a traffic car needs more than the full angle; slow down (R14
  // brake) so the push (sp^2) shrinks faster than the angle's lateral speed (sp).
  let trafficBrake = false;
  if (inDrift && wantDrift && sp > 0) {
    // R22: hold the angle whose lateral target equals the push of the curve just ahead, plus a
    // pull toward the line. Lateral target = angle*driftRate*sp, and the angle settles at
    // clamp(steer*dir, 0, 1)*dir, so the steer that holds angle a is dir*a.
    let dFeed = Math.round(segPerSec * bp.driftFeedLookahead);
    if (dFeed < 1) dFeed = 1;
    let feed = 0;
    for (let i = 0; i < dFeed; i++) feed += segs[wrap(seg0 + i, n)]!.curve;
    feed /= dFeed;
    const push = feed * sp * sp * p.centrifugal * p.centMulDrift * p.kCurve;
    let vxReq: number;
    let floor = 0;
    if (bp.drift === 'corners' && bp.driftLine === 'width') {
      // Where does this drift end? The last same-side drift-corner segment ahead that the drift
      // is carried to (no opposite bend, no gap longer than the approach scan).
      let dGap = Math.round(segPerSec * bp.driftApproach);
      if (dGap < dDrift) dGap = dDrift;
      let last = 0;
      for (let i = 0; i < n; i++) {
        const c = segs[wrap(seg0 + i, n)]!.curve;
        if (c * car.dir < 0 || i - last > dGap) break;
        if (c * car.dir >= cDrift) last = i;
      }
      let tLeft = last / segPerSec;
      if (tLeft < bp.driftPlanMin) tLeft = bp.driftPlanMin;
      // Drift out from wherever the car is to the outside edge line by the end of the drift.
      vxReq = push + (-bp.driftExitX * car.dir - car.x) / tLeft;
      floor = bp.driftAngleFloor;
    } else {
      xTarget = bp.driftLineX * car.dir;
      vxReq = push + bp.driftGain * (xTarget - car.x);
    }
    if (weave) {
      // R22: in DRIFT the line is moved through the angle; the path runs to the planned line.
      const xLine = bp.driftLine === 'width' ? -bp.driftExitX * car.dir : bp.driftLineX * car.dir;
      const xa = avoidX(bp, car, cars, p, xLine);
      if (xa === xa) {
        vxReq = push + (xa - car.x) / bp.trafficSteerTime;
        trafficBrake = (vxReq * car.dir) / (p.driftRate * sp) > 1;
      }
    }
    let angle = (vxReq * car.dir) / (p.driftRate * sp);
    if (angle < floor) angle = floor;
    if (angle > 1) angle = 1;
    steer = car.dir * angle;
  } else {
    let cFeed = cMean;
    if (driftSign !== 0 && !inDrift) {
      // Approach to a drift corner: go to the entry line and hold only the push under the car,
      // so the drift starts without the inward lateral speed that DRIFT cannot take back (R22).
      xTarget = bp.driftEntryX * driftSign;
      cFeed = segs[seg0]!.curve;
    }
    let tau = bp.steerLookahead;
    let away = 0; // side the car must move to clear a traffic car, 0 = no traffic in the way
    if (weave) {
      const xa = avoidX(bp, car, cars, p, xTarget);
      if (xa === xa) {
        xTarget = xa;
        tau = bp.trafficSteerTime;
        away = xa > car.x ? 1 : -1;
      }
    }
    const vxReq = (xTarget - car.x) / tau + cFeed * sp * sp * k;
    const authority = p.steerRate * sp * (1 - 0.25 * sp); // R11 vx per unit steer
    steer = authority > 0 ? vxReq / authority : 0;
    // R20: in GRIP, turn into the coming drift corner past driftEnterSteer.
    // (Not toward a traffic car being avoided: the entry waits until it is clear.)
    if (wantDrift && away !== -driftSign && steer * driftSign < bp.driftKickSteer)
      steer = driftSign * bp.driftKickSteer;
  }

  out.steer = humanize(bot, bp, steer);
  // R20 needs a rising edge with the applied steer already past driftEnterSteer: in GRIP press only
  // then, and release for a tick after a press that did not start a drift, so the next one is an
  // edge again. In DRIFT hold it while the corner wants it; release (R21) when it ends.
  out.drift = inDrift
    ? wantDrift
    : wantDrift && !car.driftHeld && car.steer * driftSign > p.driftEnterSteer;

  // Speed. Drift corners are taken without braking: their segments are ignored here.
  out.brake = trafficBrake;
  if (trafficBrake) return;
  if (bp.speed === 'never') return;
  let dBrake = Math.round(segPerSec * bp.brakeLookahead);
  if (dBrake < 1) dBrake = 1;
  const sHold = 1 - bp.steerReserve;
  const cSkip = bp.drift === 'corners' ? cDrift : Infinity;
  if (bp.speed === 'hold') {
    let cMax = 0;
    for (let i = 0; i < dBrake; i++) {
      const c = segs[wrap(seg0 + i, n)]!.curve;
      const ac = c < 0 ? -c : c;
      if (ac > cMax && ac < cSkip && !inDriftCorner(segs, n, seg0 + i, cSkip)) cMax = ac;
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
    if (ac > cMax && ac < cSkip && !inDriftCorner(segs, n, seg0 + i, cSkip)) {
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
    if (lim >= 1 || inDriftCorner(segs, n, seg0 + i, cSkip)) continue;
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

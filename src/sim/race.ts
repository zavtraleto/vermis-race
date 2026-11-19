import { DT, K_HEADING, SEG_PER_UNIT, STEER_HIST } from './constants';
import { nextRandom } from './rng';
import type {
  Car,
  CarParams,
  InputFrame,
  RaceState,
  RivalConfig,
  Segment,
  Track,
  TrafficConfig,
} from './types';

export function createRace(seed: number, carCount: number, trafficCount = 0): RaceState {
  const cars: Car[] = [];
  // R70: traffic cars are appended after the player and rivals.
  for (let i = 0; i < carCount + trafficCount; i++) {
    cars.push({
      kind: i >= carCount ? 'traffic' : i === 0 ? 'player' : 'rival',
      z: 0,
      x: 0,
      speed: 0,
      vx: 0,
      steer: 0,
      heading: 0,
      state: 'GRIP',
      dir: 0,
      offTicks: 0,
      angle: 0,
      driftHeld: false,
      armTicks: 0,
      lowTicks: 0,
      bumpTicks: 0,
      draft: 0,
      boostTicks: 0,
      yaw: 0,
      yawRate: 0,
      vel: 0,
      carry: 0,
      steerHist: new Array<number>(STEER_HIST).fill(0),
      steerHistHead: 0,
      steerHistCount: 0,
      deflectTicks: 0,
      crashTicks: 0,
      crashSpeed0: 0,
      crashX0: 0,
      skill: 0,
      pace: 1,
      nameId: -1,
      place: 0,
      role: 0,
      slot: 0,
      slotTicks: 0,
      nemesis: 0,
      band: 0,
      joinTicks: 0,
    });
  }
  // R2: RNG state is a plain 32-bit int inside the state.
  return { tick: 0, rng: seed | 0, cars };
}

/** Advances the race by exactly one DT, in place. inputs[i] and params[i] belong to cars[i]. */
export function step(
  state: RaceState,
  inputs: readonly InputFrame[],
  track: Track,
  params: readonly CarParams[],
  traffic?: TrafficConfig,
  rivals?: RivalConfig,
): void {
  const segments = track.segments;
  const segCount = segments.length;
  const cars = state.cars;
  // R63: the rubber band distance uses the player z at the start of the step.
  const lead = cars[0];
  const hasPlayer = lead !== undefined && lead.kind === 'player';
  const playerZ0 = hasPlayer ? lead.z : 0;
  const bandOn = rivals !== undefined && rivals.rubberBand === 1 && hasPlayer;
  // R63: the band target is 0 for the first bandStartDelay seconds (tick at the start of the step).
  const bandDelayed = rivals !== undefined && state.tick < Math.round(rivals.bandStartDelay / DT);
  // R4: cars updated in index order, each with its own input and params.
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i]!;
    const input = inputs[i]!;
    const p = params[i]!;

    // R70: traffic is on rails, only R16 runs (no input, no R10-R22, heading stays).
    if (car.kind === 'traffic') {
      car.z += car.speed * DT * SEG_PER_UNIT;
      continue;
    }
    // R43: the invulnerability window counts down in the car's own update.
    if (car.bumpTicks > 0) car.bumpTicks--;

    if (car.kind === 'rival') {
      if (car.joinTicks > 0) car.joinTicks--; // R63b
      if (rivals !== undefined && car.slotTicks > 0) {
        // R62b: the slot is redrawn from the role range on the tick the timer reaches 0.
        car.slotTicks--;
        if (car.slotTicks === 0) drawSlot(state, car, rivals);
      }
      // R63: smoothed slot band; 0 without a rival config or with H15 B.
      if (bandOn) updateBand(car, rivals, car.z - playerZ0, bandDelayed);
      else car.band = 0;
    }

    // R48: during a crash input and the driving rules (R10-R22, R80-R87, R50-R52) do not apply.
    if (car.crashTicks > 0) {
      crashStep(car, p);
      continue;
    }
    const z0 = car.z;
    // R62/R63: the speed cap is vmax*pace*(1 + band) (pace 1 and band 0 for the player: exactly vmax).
    const vcap = p.vmax * car.pace * (1 + car.band);

    // R11/R13: sp uses the speed before R14 updates it.
    const sp0 = car.speed / p.vmax;
    // R13/R17/R19: segment under the car, before z advances.
    let seg = Math.floor(car.z) % segCount;
    if (seg < 0) seg += segCount;
    const curve = segments[seg]!.curve;

    // R21: consecutive off-road ticks (|x| > 1 at the start of the step), reset on the asphalt.
    const off = car.x > 1 || car.x < -1;
    car.offTicks = off ? car.offTicks + 1 : 0;

    // H14: model B (R80-R87) replaces R10-R15b and R20-R22; R16/R17 below are shared.
    if (p.model === 1) {
      const speedB = stepModelB(car, input, p, cars, segments, seg, off, vcap);
      car.heading += curve * speedB * K_HEADING * DT; // R17
      car.z += speedB * DT * SEG_PER_UNIT; // R16
      lampHit(car, z0, p, segCount); // R47/R64: after R16, before R40
      continue;
    }

    // R10: steer slews toward input at most steerRise per second.
    const rise = p.steerRise * DT;
    let dSteer = input.steer - car.steer;
    if (dSteer > rise) dSteer = rise;
    if (dSteer < -rise) dSteer = -rise;
    car.steer += dSteer;

    // R20: rising edge of the drift input; driftHeld is written every tick.
    const rising = input.drift && !car.driftHeld;
    car.driftHeld = input.drift;
    // R20: the edge arms entry (armTicks = 1); it grows while held; release, entry or burning out
    // past driftArmTime reset it to 0 (held input cannot re-arm: no edge while driftHeld).
    if (!input.drift) car.armTicks = 0;
    else if (rising) car.armTicks = 1;
    else if (car.armTicks > 0) car.armTicks++;
    const armed = car.armTicks > 0 && car.armTicks * DT <= p.driftArmTime;
    if (car.armTicks > 0 && !armed) car.armTicks = 0; // R20: burnt out; no re-arm until the next edge

    // R20/R21: GRIP <-> DRIFT transitions on the smoothed steer and the speed before R14.
    // R21b (H11 B, driftOffroad = 1): no off-road condition on entry or exit.
    const offroadBlocks = p.driftOffroad !== 1;
    let entered = false;
    if (car.state === 'GRIP') {
      if (
        armed &&
        car.speed > p.driftEnterSpeed * p.vmax &&
        (car.steer > p.driftEnterSteer || car.steer < -p.driftEnterSteer) &&
        !(offroadBlocks && off)
      ) {
        car.state = 'DRIFT';
        car.dir = car.steer > 0 ? 1 : -1;
        car.angle = car.dir * p.driftAngleStart; // R20
        car.lowTicks = 0;
        car.armTicks = 0; // R20: entry consumes the arm
        entered = true;
      }
    } else if (
      !input.drift ||
      car.speed < p.driftExitSpeed * p.vmax ||
      (p.driftAutoExit === 1 && car.lowTicks * DT > p.driftStraightTime) || // R21 / R21c (H12 A)
      (offroadBlocks && car.offTicks * DT > p.driftOffroadTime)
    ) {
      car.state = 'GRIP';
      car.dir = 0;
      car.angle = 0;
      car.lowTicks = 0;
    }
    const drift = car.state === 'DRIFT';

    // R50-R52: slipstream of the player, on the positions at the start of the step (traffic after
    // the player in index order has not moved yet). R40 (end of step) zeroes it on contact.
    let boosted = false;
    if (car.kind === 'player') boosted = slipstream(car, cars, p, drift);

    let target: number;
    let grip: number;
    let cm: number;
    let cap = vcap;
    if (drift) {
      // R22: the angle chases clamp(steer*dir, 0, 1) * dir; R20: the entry tick keeps driftAngleStart.
      if (!entered) {
        let aim = car.steer * car.dir;
        if (aim < 0) aim = 0;
        if (aim > 1) aim = 1;
        car.angle += (aim * car.dir - car.angle) * (1 - Math.exp(-p.driftAngleResponse * DT));
      }
      const absAngle = car.angle * car.dir;
      // R21: consecutive small-angle ticks, counted on the angle after the chase.
      car.lowTicks = absAngle < p.driftAngleExit ? car.lowTicks + 1 : 0;
      // R22: lateral target from the angle, gripDrift, centMulDrift; no R15b. Speed cap from |angle|.
      target = car.angle * p.driftRate * sp0;
      cap = vcap * (1 - p.driftSpeedLoss * absAngle);
      grip = p.gripDrift;
      cm = p.centMulDrift;
    } else {
      // R11: grip lateral speed target.
      // R15b: off road (|x| > 1 at the start of the step) the target is scaled by offroadSteerMul
      // and the catch-up uses offroadGrip; variant A is offroadGrip = grip, offroadSteerMul = 1.
      target = car.steer * p.steerRate * sp0 * (1 - 0.25 * sp0);
      if (off) target *= p.offroadSteerMul;
      grip = off ? p.offroadGrip : p.grip;
      // R13: cm = 1 in GRIP.
      cm = 1;
    }
    // R12: exponential catch-up.
    car.vx += (target - car.vx) * (1 - Math.exp(-grip * DT));

    // R13/R19: lateral move plus centrifugal push outward.
    car.x += car.vx * DT - curve * sp0 * sp0 * p.centrifugal * cm * p.kCurve * DT;

    // R18: clamp to xLimit, zero vx only if it points into the wall.
    if (car.x > p.xLimit) {
      car.x = p.xLimit;
      if (car.vx > 0) car.vx = 0;
    } else if (car.x < -p.xLimit) {
      car.x = -p.xLimit;
      if (car.vx < 0) car.vx = 0;
    }

    // R14: automatic throttle, brake, speed not below 0; the cap is vmax (R22 in DRIFT, R52 boosted).
    // R22: in DRIFT, above the cap speed falls by driftBrake (not below the cap), below it the
    // normal R14 throttle runs up to the cap. Brake input is plain R14 in both states.
    // R52: boosted, the GRIP cap is vmax * draftCapMul and the throttle accel * draftAccelMul; in
    // DRIFT the R22 cap stays (caps do not stack). Above the cap (boost over, cone left) speed
    // falls by driftBrake down to the cap, as in R22.
    if (boosted && !drift) cap = vcap * p.draftCapMul;
    const accel = boosted ? p.accel * p.draftAccelMul : p.accel;
    let speed = throttle(car.speed, input.brake, cap, accel, p);
    // R15: offroad slowdown.
    if (car.x > 1 || car.x < -1) speed *= Math.pow(p.offroadMul, 60 * DT);
    car.speed = speed;

    // R17: heading from the curve of the segment under the car, with the final speed.
    car.heading += curve * speed * K_HEADING * DT;

    // R16: z advances by post-update speed.
    car.z += speed * DT * SEG_PER_UNIT;
    lampHit(car, z0, p, segCount); // R47/R64: after R16, before R40
  }
  // R71: respawn after R16 of all cars, relative to the player.
  if (hasPlayer && traffic !== undefined) respawnTraffic(state, traffic, lead.z, params[0]!.vmax);
  // R63b: rivals beyond poolRadius of the player (end of the step) are replaced on this tick.
  if (hasPlayer && rivals !== undefined) poolRivals(state, rivals, lead);
  // R40/R64: traffic contact of every race car at the end of the step, in index order.
  for (let i = 0; i < cars.length; i++) {
    if (cars[i]!.kind !== 'traffic') bumpTraffic(cars[i]!, cars, params[i]!);
  }
  // R65: contact between race cars after R40 (rivalBumpLoss comes from the rival config).
  if (rivals !== undefined) raceContacts(cars, params, rivals);
  // R66: places at the end of the step.
  updatePlaces(cars);
  // R1: one fixed step.
  state.tick++;
}

/**
 * R14 with the cap rule of R22/R52: brake slows by brake*DT; above the cap speed falls by driftBrake
 * (not below the cap); below it the throttle adds accel up to the cap. Never below 0.
 */
function throttle(
  speed0: number,
  brake: boolean,
  cap: number,
  accel: number,
  p: CarParams,
): number {
  let speed: number;
  if (brake) speed = speed0 - p.brake * DT;
  else if (speed0 > cap) {
    speed = speed0 - p.driftBrake * DT;
    if (speed < cap) speed = cap;
  } else {
    speed = speed0 + accel * DT;
    if (speed > cap) speed = cap;
  }
  return speed < 0 ? 0 : speed;
}

/**
 * R47: the player hits a lamp post when z crossed (or reached) a boundary of a segment whose track
 * index is a multiple of lampEvery (the lamps R32 draws), |x| is inside the hit band around
 * lampOffset and the speed is above crashMinSpeed*vmax. Values are those of the end of the step.
 */
function lampHit(car: Car, z0: number, p: CarParams, segCount: number): void {
  const halfW = (p.carHitW + p.lampHitW) / 2;
  const ax = car.x < 0 ? -car.x : car.x;
  const d = ax - p.lampOffset;
  if (!(d < halfW && d > -halfW) || !(car.speed > p.crashMinSpeed * p.vmax)) return;
  // Segment boundaries b with z0 < b <= z (at most one per tick at road speeds).
  for (let b = Math.floor(z0) + 1; b <= car.z; b++) {
    let seg = b % segCount;
    if (seg < 0) seg += segCount;
    if (seg % p.lampEvery !== 0) continue;
    // R48: the crash starts with the speed and x of the end of this step.
    car.crashTicks = Math.round(p.crashTime / DT);
    car.crashSpeed0 = car.speed;
    car.crashX0 = car.x;
    car.state = 'GRIP';
    car.dir = 0;
    car.vel = 0;
    car.yaw = 0;
    car.yawRate = 0;
    car.carry = 0;
    car.angle = 0;
    car.vx = 0;
    car.draft = 0;
    car.boostTicks = 0;
    car.steerHistCount = 0;
    car.deflectTicks = 0;
    return;
  }
}

/**
 * R48 crash tick: input ignored, speed falls linearly from crashSpeed0 to 0 and x moves linearly
 * from crashX0 to sign(crashX0)*crashReturnX over crashTime; z advances as R16. The last tick
 * lands exactly on the road point with speed 0 and starts the R43 invulnerability.
 */
function crashStep(car: Car, p: CarParams): void {
  car.steer = 0;
  car.driftHeld = false;
  car.crashTicks--;
  const target = car.crashX0 < 0 ? -p.crashReturnX : p.crashReturnX;
  if (car.crashTicks === 0) {
    car.speed = 0;
    car.x = target;
    car.bumpTicks = Math.round(p.bumpInvulnTime / DT);
  } else {
    const f = car.crashTicks / Math.round(p.crashTime / DT);
    car.speed = car.crashSpeed0 * f;
    car.x = target + (car.crashX0 - target) * f;
  }
  car.z += car.speed * DT * SEG_PER_UNIT; // R16
}

/** R87: angle = slip/slipFull in DRIFT, 0 in GRIP. */
function viewAngle(car: Car, p: CarParams): number {
  if (car.state !== 'DRIFT') return 0;
  return (car.yaw - car.vel) / p.slipFull;
}

/**
 * R81 entry: GRIP -> DRIFT on side dir with the initial slip rate `rate` (> 0). The visible slip
 * is continuous; what lies against dir goes to carry; vel is kept.
 */
function enterDrift(car: Car, dir: 1 | -1, rate: number): void {
  car.state = 'DRIFT';
  car.dir = dir;
  const vis = car.yaw - car.vel + car.carry;
  const slip0 = vis * dir > 0 ? vis : 0;
  car.yaw = car.vel + slip0;
  car.carry = vis - slip0;
  car.yawRate = dir * rate;
}

/**
 * R81b B: threshold multiplier for a flick of sign(best). cAhead = the curve of largest modulus on
 * segments seg..seg+flickLook (lap wrap); toward a corner of at least flickCornerMin: flickCornerMul,
 * otherwise flickStraightMul.
 */
export function flickMul(
  segments: readonly Segment[],
  seg: number,
  best: number,
  p: CarParams,
): number {
  const n = segments.length;
  let cAhead = 0;
  let j = seg;
  for (let k = 0; k <= p.flickLook; k++) {
    const c = segments[j]!.curve;
    if ((c < 0 ? -c : c) > (cAhead < 0 ? -cAhead : cAhead)) cAhead = c;
    j = j + 1 >= n ? 0 : j + 1;
  }
  const absC = cAhead < 0 ? -cAhead : cAhead;
  return absC >= p.flickCornerMin && cAhead * best > 0 ? p.flickCornerMul : p.flickStraightMul;
}

/**
 * Model B tick (R80-R87) of a player or rival car; returns the speed after R86 (also stored).
 * `off` is |x| > 1 at the start of the step; offTicks is already updated by the caller.
 */
function stepModelB(
  car: Car,
  input: InputFrame,
  p: CarParams,
  cars: readonly Car[],
  segments: readonly Segment[],
  seg: number,
  off: boolean,
  vcap: number,
): number {
  const curve = segments[seg]!.curve;
  // R80: raw steer, no R10 slew. prevSteer is the raw steer of the previous tick (R81b C sign).
  const prevSteer = car.steer;
  let steer = input.steer;
  if (steer > 1) steer = 1;
  if (steer < -1) steer = -1;
  car.steer = steer; // R87
  car.driftHeld = input.drift;
  // R21b (H11 B, driftOffroad = 1): no off-road condition; H11 A blocks entry off road and ends
  // the drift after driftOffroadTime off road, as in model A.
  const offroadBlocks = p.driftOffroad !== 1;
  const canEnter =
    car.state === 'GRIP' &&
    input.drift &&
    car.speed > p.driftEnterSpeed * p.vmax &&
    !(offroadBlocks && off);

  const hist = car.steerHist;
  if (p.driftEntry === 2) {
    // R81b C: entry by deflection, no flick. armTicks > 0 (model B, C only) = the drift ended during
    // this hold (R82 without release): no count until the hold breaks.
    if (!input.drift) car.armTicks = 0;
    const absS = steer < 0 ? -steer : steer;
    if (canEnter && car.armTicks === 0 && absS >= p.deflectEnter) {
      // A sign change restarts the run at 1 for the new sign.
      const same = car.deflectTicks > 0 && prevSteer * steer > 0;
      car.deflectTicks = same ? car.deflectTicks + 1 : 1;
      // Held for deflectTime: deflectTime/DT ticks have passed since the first qualifying tick.
      if (car.deflectTicks > Math.round(p.deflectTime / DT)) {
        enterDrift(car, steer > 0 ? 1 : -1, p.kickBase);
      }
    } else {
      car.deflectTicks = 0;
    }
    if (car.state !== 'GRIP') car.deflectTicks = 0;
  } else if (canEnter) {
    // R81: flick entry, compared with the recorded raw steer of the last flickWindow seconds.
    let kMax = Math.round(p.flickWindow / DT);
    if (kMax > car.steerHistCount) kMax = car.steerHistCount;
    let best = 0;
    for (let k = 1; k <= kMax; k++) {
      let j = car.steerHistHead - k;
      if (j < 0) j += STEER_HIST;
      const d = steer - hist[j]!;
      if ((d < 0 ? -d : d) > (best < 0 ? -best : best)) best = d;
    }
    // R81b B: threshold flickDelta*m from the road ahead; A: m = 1.
    let m = 1;
    if (p.driftEntry === 1 && best !== 0) m = flickMul(segments, seg, best, p);
    const thr = p.flickDelta * m;
    if (best >= thr || best <= -thr) {
      const abs = best < 0 ? -best : best;
      let over = abs - thr;
      if (over < 0) over = 0;
      enterDrift(car, best > 0 ? 1 : -1, p.kickBase + p.kickGain * over); // R81: rate of slip
    }
  }
  // R81: the current steer is recorded every held tick, in any state; a flick counts only within
  // one hold, so a tick without input.drift clears the buffer and records nothing.
  if (input.drift) {
    hist[car.steerHistHead] = steer;
    car.steerHistHead = car.steerHistHead + 1 >= STEER_HIST ? 0 : car.steerHistHead + 1;
    if (car.steerHistCount < STEER_HIST) car.steerHistCount++;
  } else {
    car.steerHistCount = 0;
  }

  // R83-R85: sp is the speed before R86 updates it; A = the road turning under the car (R83).
  const sp = car.speed / p.vmax;
  const A = curve * sp * p.kYaw;

  // R82: exit on release or low speed (H11 A: also too long off road). GRIP starts from its own
  // steady slip sG on this curve; the rest of the visible slip becomes carry. No snap.
  if (
    car.state === 'DRIFT' &&
    (!input.drift ||
      car.speed < p.driftExitSpeed * p.vmax ||
      (offroadBlocks && car.offTicks * DT > p.driftOffroadTime))
  ) {
    car.state = 'GRIP';
    car.dir = 0;
    // R81b C: an exit while still held blocks the deflection count until the hold breaks.
    if (p.driftEntry === 2 && input.drift) car.armTicks = 1;
    let sG = A / p.velGrip;
    if (sG > p.slipGripMax) sG = p.slipGripMax;
    if (sG < -p.slipGripMax) sG = -p.slipGripMax;
    car.carry = car.yaw - car.vel + car.carry - sG;
    car.yaw = car.vel + sG;
    car.yawRate = A;
  }
  const drift = car.state === 'DRIFT';

  // R82b: the carry decays every tick in any state.
  car.carry *= Math.exp(-p.carryDecay * DT);

  // R50-R52: slipstream of the player (shared with model A).
  let boosted = false;
  if (car.kind === 'player') boosted = slipstream(car, cars, p, drift);

  let slip: number;
  if (drift) {
    const dir = car.dir;
    const u = steer * dir;
    // R83 DRIFT: the finger sets the visible angle; critically damped chase of slipT.
    const uc = u < 0 ? 0 : u > 1 ? 1 : u;
    const slipT = dir * p.slipFull * uc;
    const w = p.slipResponse;
    slip = car.yaw - car.vel;
    car.yawRate += (w * w * (slipT - slip) - 2 * w * car.yawRate) * DT;
    slip += car.yawRate * DT;
    // R83: one-sided drift, slip never crosses to the other side of dir.
    if (slip * dir < 0) {
      slip = 0;
      car.yawRate = 0;
    }
    // R84 DRIFT: bounded lateral term from the angle (and counter-steer) minus the road push.
    // push: driftPush toward the drift side or straight (A*dir >= 0), wrongPush against it.
    const push = A * dir >= 0 ? p.driftPush : p.wrongPush;
    const velT =
      dir * p.driftLat * ((slip * dir) / p.slipFull + p.driftCounter * (u < 0 ? u : 0)) - push * A;
    car.vel += (velT - car.vel) * (1 - Math.exp(-p.velGripDrift * DT));
    car.yaw = car.vel + slip;
  } else {
    // R83 GRIP: body yaw rate chases the steer, aligns with the motion.
    let f = sp / p.yawFullSpeed;
    if (f > 1) f = 1;
    car.yawRate +=
      (steer * p.yawRateMax * f - p.yawAlign * car.yaw - car.yawRate) *
      (1 - Math.exp(-p.yawResponse * DT));
    car.yaw += (car.yawRate - A) * DT;
    // R84 GRIP: motion follows the body with a saturated force; off road g and smax are scaled
    // by offroadVelMul (model B's own, R15b untouched).
    let g = p.velGrip;
    let smax = p.slipGripMax;
    if (off) {
      g *= p.offroadVelMul;
      smax *= p.offroadVelMul;
    }
    let force = car.yaw - car.vel;
    if (force > smax) force = smax;
    if (force < -smax) force = -smax;
    car.vel += (g * force - A) * DT;
    // R84: geometric slip limit.
    const lim = p.slipGripLimit;
    slip = car.yaw - car.vel;
    if (slip > lim) {
      car.yaw = car.vel + lim;
      if (car.yawRate > A) car.yawRate = A;
    } else if (slip < -lim) {
      car.yaw = car.vel - lim;
      if (car.yawRate < A) car.yawRate = A;
    }
    slip = car.yaw - car.vel;
  }

  // R85: lateral shift; in DRIFT plus the lead dir*driftLead*e, e = the part of the finger the
  // body angle has not caught yet (0 in steady drift). The lead never feeds back into vel or yaw.
  let lead = 0;
  if (drift) {
    const dir = car.dir;
    const u = steer * dir;
    const uc = u < 0 ? 0 : u > 1 ? 1 : u;
    lead = dir * p.driftLead * (uc - (slip * dir) / p.slipFull) * sp * p.latScale;
  }
  // R18: walls zero vel toward the wall, vx follows the clamped vel.
  car.x += (car.vel * sp * p.latScale + lead) * DT;
  if (car.x > p.xLimit) {
    car.x = p.xLimit;
    if (car.vel > 0) car.vel = 0;
  } else if (car.x < -p.xLimit) {
    car.x = -p.xLimit;
    if (car.vel < 0) car.vel = 0;
  }
  // R84: in DRIFT yaw = vel + slip also holds after the wall (the slip keeps its side, R83).
  if (drift) car.yaw = car.vel + slip;
  car.vx = car.vel * sp * p.latScale + lead;

  // R86: R14 with the cap vmax*capMul (R52), vcap = vmax*pace*band (R62/R63); in DRIFT the cap also falls with the angle (as R22)
  // and the carry costs nothing; in GRIP the visible slip costs speed. Then R15.
  const capMul = boosted ? p.draftCapMul : 1;
  let cap = vcap * capMul;
  if (drift) {
    const a = 1 - (p.driftSpeedLoss * (slip < 0 ? -slip : slip)) / p.slipFull;
    if (a < capMul) cap = vcap * a;
  }
  const accel = boosted ? p.accel * p.draftAccelMul : p.accel;
  let speed = throttle(car.speed, input.brake, cap, accel, p);
  if (!drift) {
    const vis = car.yaw - car.vel + car.carry; // after R82b, R83, R84 and the R85 wall
    speed -= p.slipDrag * vis * vis * DT;
    if (speed < 0) speed = 0;
  }
  if (car.x > 1 || car.x < -1) speed *= Math.pow(p.offroadMul, 60 * DT); // R15
  car.speed = speed;

  car.angle = viewAngle(car, p); // R87
  return speed;
}

/** R50: a traffic car ahead with 0 < zT - z <= draftLength and |x - xT| <= draftWidth / 2. */
function inCone(car: Car, cars: readonly Car[], p: CarParams): boolean {
  const halfW = p.draftWidth / 2;
  for (let i = 0; i < cars.length; i++) {
    const t = cars[i]!;
    if (t.kind !== 'traffic') continue;
    const dz = t.z - car.z;
    const dx = car.x - t.x;
    if (dz > 0 && dz <= p.draftLength && dx <= halfW && dx >= -halfW) return true;
  }
  return false;
}

/** R51/R52: updates draft and boostTicks of the player for this step; returns whether it is boosted. */
function slipstream(car: Car, cars: readonly Car[], p: CarParams, drift: boolean): boolean {
  if (car.boostTicks > 0) car.boostTicks--; // R52 (H5 B): counts down from the step after it starts
  const cone = inCone(car, cars, p);
  if (car.draft >= 1 && !cone && p.draftBoost === 1) {
    // R52 (H5 B): leaving the cone with a full charge starts the boost (also in DRIFT).
    car.boostTicks = Math.round(p.boostTime / DT);
    car.draft = 0;
  } else if (!drift) {
    // R51: charge in the cone, decay outside, clamped to [0, 1]; frozen in DRIFT.
    let d = cone ? car.draft + DT / p.draftChargeTime : car.draft - DT / p.draftDecayTime;
    if (d > 1) d = 1;
    if (d < 0) d = 0;
    car.draft = d;
  }
  // R52: full charge in the cone (H5 A and B), or the H5 B boost counter.
  return car.boostTicks > 0 || (cone && car.draft >= 1);
}

/** R71: furthest z among traffic cars other than `skip`, -Infinity when there is none. */
function furthestTraffic(cars: readonly Car[], skip: Car): number {
  let far = -Infinity;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind === 'traffic' && c !== skip && c.z > far) far = c.z;
  }
  return far;
}

/** R71: places one traffic car beyond `furthest`, not closer than spawnAhead to the player. */
function spawnTraffic(
  state: RaceState,
  car: Car,
  cfg: TrafficConfig,
  furthest: number,
  playerZ: number,
  playerVmax: number,
): void {
  // R71: rng draws in fixed order: gap, lane, speed.
  const gap = cfg.trafficGapMin + (cfg.trafficGapMax - cfg.trafficGapMin) * nextRandom(state);
  const lane = Math.floor(nextRandom(state) * cfg.lanes);
  const sp = cfg.trafficSpeedMin + (cfg.trafficSpeedMax - cfg.trafficSpeedMin) * nextRandom(state);
  let z = furthest + gap;
  const minZ = playerZ + cfg.trafficSpawnAhead;
  if (!(z >= minZ)) z = minZ;
  car.z = z;
  car.x = -1 + ((lane + 0.5) * 2) / cfg.lanes; // R70: lane centre
  car.speed = sp * playerVmax;
}

/** R71: cars more than trafficDespawnBehind behind the player reappear ahead, in index order. */
function respawnTraffic(state: RaceState, cfg: TrafficConfig, playerZ: number, vmax: number): void {
  const cars = state.cars;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind !== 'traffic' || c.z >= playerZ - cfg.trafficDespawnBehind) continue;
    spawnTraffic(state, c, cfg, furthestTraffic(cars, c), playerZ, vmax);
  }
}

/** R40-R44 (R64: player and rivals): at most one contact per step, traffic in index order. */
function bumpTraffic(car: Car, cars: readonly Car[], p: CarParams): void {
  if (car.bumpTicks !== 0) return; // R43
  if (car.crashTicks > 0) return; // R48: no contacts during a crash
  const halfW = (p.carHitW + p.trafficHitW) / 2;
  for (let i = 0; i < cars.length; i++) {
    const t = cars[i]!;
    if (t.kind !== 'traffic') continue;
    const dz = car.z - t.z;
    const dx = car.x - t.x;
    if (!(dz < p.carLength && dz > -p.carLength && dx < halfW && dx > -halfW)) continue; // R40
    // R41: rear hit vs side contact; neither raises speed.
    const floor = p.bumpFloor * p.vmax;
    let target: number;
    if (car.z < t.z - p.carLength / 2) target = t.speed - p.bumpSpeedLoss * p.vmax;
    else target = car.speed - p.bumpSideLoss * p.vmax;
    if (target < floor) target = floor;
    if (target < car.speed) car.speed = target;
    // R42: lateral kick away from the traffic car; on a tie toward the road centre (right at 0).
    const side = dx > 0 ? 1 : dx < 0 ? -1 : t.x > 0 ? -1 : 1;
    kick(car, side, p);
    car.draft = 0; // R51: a contact zeroes the charge and the boost
    car.boostTicks = 0;
    return;
  }
}

/** R42 lateral kick (R88 in model B), R44 drift angle loss, R43 invulnerability. */
function kick(car: Car, side: number, p: CarParams): void {
  car.vx = side * p.bumpKick;
  if (p.model === 1) {
    // R88/R42: the same vx through vel, sp after R41; yaw is left alone. (sp = 0 cannot carry a kick.)
    const denom = (car.speed / p.vmax) * p.latScale;
    if (denom > 0) car.vel = car.vx / denom;
    // R88/R44: |slip| falls by bumpAngleLoss*slipFull, not below 0 (yaw moves toward vel, R42
    // has set vel already); the drift survives.
    if (car.state === 'DRIFT') {
      let s = (car.yaw - car.vel) * car.dir - p.bumpAngleLoss * p.slipFull;
      if (s < 0) s = 0;
      car.yaw = car.vel + car.dir * s;
    }
    car.angle = viewAngle(car, p); // R87
  } else if (car.state === 'DRIFT') {
    // R44: a drift survives; |angle| shrinks by bumpAngleLoss, not below 0.
    let abs = car.angle * car.dir - p.bumpAngleLoss;
    if (abs < 0) abs = 0;
    car.angle = car.dir * abs;
  }
  car.bumpTicks = Math.round(p.bumpInvulnTime / DT); // R43
}

/**
 * R63: target from the slot error (asymmetric bandBoost / bandSlow), scaled inside the view window
 * (0 < d < bandViewDist) by bandViewMul (nemesisViewMul for the nemesis), 0 while delayed; then
 * exponential smoothing with bandAttack when |target| > |band|, else bandRelease.
 * d = z - zPlayer at the start of the step.
 */
function updateBand(car: Car, cfg: RivalConfig, d: number, delayed: boolean): void {
  let target = 0;
  if (!delayed) {
    let raw = (car.slot - d) / cfg.bandRange;
    if (raw > 1) raw = 1;
    if (raw < -1) raw = -1;
    target = raw > 0 ? cfg.bandBoost * raw : cfg.bandSlow * raw;
    if (d > 0 && d < cfg.bandViewDist)
      target *= car.nemesis === 1 ? cfg.nemesisViewMul : cfg.bandViewMul;
  }
  const b = car.band;
  const k = (target < 0 ? -target : target) > (b < 0 ? -b : b) ? cfg.bandAttack : cfg.bandRelease;
  car.band = b + (target - b) * (1 - Math.exp(-k * DT));
}

/**
 * R62b: draws the slot from the range of the role (nemesisSlot for the nemesis) and restarts the
 * slot timer at slotTimeMin..slotTimeMax seconds. Draws: slot, timer.
 */
function drawSlot(state: RaceState, car: Car, cfg: RivalConfig): void {
  const r =
    car.nemesis === 1
      ? cfg.nemesisSlot
      : car.role === 0
        ? cfg.slotClose
        : car.role === 1
          ? cfg.slotAhead
          : cfg.slotBehind;
  car.slot = r[0] + (r[1] - r[0]) * nextRandom(state);
  car.slotTicks = Math.round(
    (cfg.slotTimeMin + (cfg.slotTimeMax - cfg.slotTimeMin) * nextRandom(state)) / DT,
  );
}

/**
 * R62: k-th name (k from the RNG) among the names no other race car holds and, when another free
 * name exists, other than `car`'s own; with no free name at all the car keeps its name.
 */
function drawName(state: RaceState, car: Car, cfg: RivalConfig): void {
  const cars = state.cars;
  let free = 0;
  for (let id = 0; id < cfg.rivalNameCount; id++) if (!nameUsed(cars, id)) free++;
  if (free === 0) return;
  let k = Math.floor(nextRandom(state) * free);
  for (let id = 0; id < cfg.rivalNameCount; id++) {
    if (nameUsed(cars, id)) continue;
    if (k === 0) {
      car.nameId = id;
      return;
    }
    k--;
  }
}

function nameUsed(cars: readonly Car[], id: number): boolean {
  for (let j = 0; j < cars.length; j++)
    if (cars[j]!.kind === 'rival' && cars[j]!.nameId === id) return true;
  return false;
}

/**
 * R63b: a rival with |z - zPlayer| > poolRadius (end of the step) is replaced on this tick: new
 * lane, skill, pace, name and slot of the same role (nemesis kept), z = zPlayer - poolSpawnBehind,
 * the player's speed, clean drive state, band 0, joinTicks = joinShowTime. Rivals in index order.
 * Draws per replaced rival: lane, skill, pace, name, slot, slot timer.
 */
function poolRivals(state: RaceState, cfg: RivalConfig, player: Car): void {
  const cars = state.cars;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind !== 'rival') continue;
    const d = c.z - player.z;
    if (!(d > cfg.poolRadius || d < -cfg.poolRadius)) continue;
    c.z = player.z - cfg.poolSpawnBehind;
    const lane = Math.floor(nextRandom(state) * cfg.lanes);
    c.x = -1 + ((lane + 0.5) * 2) / cfg.lanes; // R70 lane centre
    c.speed = player.speed;
    drawCharacter(state, c, cfg);
    drawName(state, c, cfg);
    drawSlot(state, c, cfg);
    c.vx = 0;
    c.steer = 0;
    c.state = 'GRIP';
    c.dir = 0;
    c.offTicks = 0;
    c.angle = 0;
    c.driftHeld = false;
    c.armTicks = 0;
    c.lowTicks = 0;
    c.bumpTicks = 0;
    c.draft = 0;
    c.boostTicks = 0;
    c.yaw = 0;
    c.yawRate = 0;
    c.vel = 0;
    c.carry = 0;
    c.steerHistHead = 0;
    c.steerHistCount = 0;
    c.deflectTicks = 0;
    c.crashTicks = 0;
    c.crashSpeed0 = 0;
    c.crashX0 = 0;
    c.band = 0;
    c.joinTicks = Math.round(cfg.joinShowTime / DT);
  }
}

/** R62: skill by rivalSkillWeights, pace in 1 +- rivalPaceSpread. Draws: skill, pace. */
function drawCharacter(state: RaceState, c: Car, cfg: RivalConfig): void {
  const w = cfg.rivalSkillWeights;
  const r = nextRandom(state) * (w[0] + w[1] + w[2]);
  c.skill = r < w[0] ? 0 : r < w[0] + w[1] ? 1 : 2;
  c.pace = 1 + cfg.rivalPaceSpread * (2 * nextRandom(state) - 1);
}

/** R65: race car pairs in index order; a contact sets bumpTicks, so each car touches at most once. */
function raceContacts(cars: readonly Car[], params: readonly CarParams[], cfg: RivalConfig): void {
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i]!;
    if (a.kind === 'traffic') continue;
    const pa = params[i]!;
    for (let j = i + 1; j < cars.length; j++) {
      if (a.bumpTicks !== 0 || a.crashTicks !== 0) break;
      const b = cars[j]!;
      if (b.kind === 'traffic' || b.bumpTicks !== 0 || b.crashTicks !== 0) continue;
      const dz = a.z - b.z;
      const dx = a.x - b.x;
      if (!(dz < pa.carLength && dz > -pa.carLength && dx < pa.carHitW && dx > -pa.carHitW))
        continue;
      const pb = params[j]!;
      // R65: the rear car (lower z, on a tie the larger index) slows; the front keeps its speed.
      const aRear = a.z < b.z;
      const rear = aRear ? a : b;
      const front = aRear ? b : a;
      const pr = aRear ? pa : pb;
      let target = front.speed - cfg.rivalBumpLoss * pr.vmax;
      const floor = pr.bumpFloor * pr.vmax;
      if (target < floor) target = floor;
      if (target < rear.speed) rear.speed = target;
      // R65/R42: both pushed away from each other; on equal x the smaller index goes left.
      const sideA = dx > 0 ? 1 : -1;
      kick(a, sideA, pa);
      kick(b, -sideA, pb);
    }
  }
}

/** R66: place = 1 + race cars with a larger z + race cars with an equal z and a smaller index. */
function updatePlaces(cars: readonly Car[]): void {
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind === 'traffic') continue;
    let place = 1;
    for (let j = 0; j < cars.length; j++) {
      const o = cars[j]!;
      if (o.kind === 'traffic') continue;
      if (o.z > c.z || (o.z === c.z && j < i)) place++;
    }
    c.place = place;
  }
}

/** R71: initial traffic placement with the seeded RNG, traffic cars in index order. */
export function placeTraffic(state: RaceState, traffic: TrafficConfig, playerVmax: number): void {
  const cars = state.cars;
  const playerZ = cars[0]!.z;
  let furthest = -Infinity;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind !== 'traffic') continue;
    spawnTraffic(state, c, traffic, furthest, playerZ, playerVmax);
    furthest = c.z;
  }
}

/**
 * R61/R62: start grid and character of the rivals cars[1..rivalCount], seeded RNG in index order.
 * Draws per rival: lane, skill, pace, name.
 */
export function placeRivals(state: RaceState, cfg: RivalConfig): void {
  const cars = state.cars;
  let prevLane = -1;
  let n = 0;
  for (let i = 1; i <= cfg.rivalCount && i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind !== 'rival') break;
    // R61: grid z, speed 0, a lane centre other than the lane of the previous rival (its
    // neighbour in z): draw among lanes - 1 lanes and skip the previous one.
    c.z = cfg.rivalGridGap * (i - cfg.rivalGridBehind - 0.5);
    c.speed = 0;
    let lane: number;
    if (prevLane < 0) lane = Math.floor(nextRandom(state) * cfg.lanes);
    else {
      lane = Math.floor(nextRandom(state) * (cfg.lanes - 1));
      if (lane >= prevLane) lane++;
    }
    prevLane = lane;
    c.x = -1 + ((lane + 0.5) * 2) / cfg.lanes; // R70 lane centre
    // R62: skill by the weights, pace in 1 +- spread, the k-th name not taken by an earlier rival.
    drawCharacter(state, c, cfg);
    let k = Math.floor(nextRandom(state) * (cfg.rivalNameCount - (i - 1)));
    let id = 0;
    for (;;) {
      let used = false;
      for (let j = 1; j < i; j++) if (cars[j]!.nameId === id) used = true;
      if (!used) {
        if (k === 0) break;
        k--;
      }
      id++;
    }
    c.nameId = id;
    n = i;
  }
  // R62b: roles by the rivalRoles counts (close, ahead, behind; past the counts cyclically), then a
  // seeded Fisher-Yates shuffle over the rivals. Draws: n - 1 swaps.
  const roles = cfg.rivalRoles;
  const listed = roles[0] + roles[1] + roles[2];
  for (let i = 1; i <= n; i++) {
    const r = i - 1;
    cars[i]!.role =
      r >= listed ? (r - listed) % 3 : r < roles[0] ? 0 : r < roles[0] + roles[1] ? 1 : 2;
  }
  for (let i = n; i > 1; i--) {
    const j = 1 + Math.floor(nextRandom(state) * i);
    const t = cars[i]!.role;
    cars[i]!.role = cars[j]!.role;
    cars[j]!.role = t;
  }
  // R62b: the first close rival by index is the nemesis; then slots and timers in index order.
  let hunter = false;
  for (let i = 1; i <= n; i++) {
    const c = cars[i]!;
    c.nemesis = !hunter && c.role === 0 ? 1 : 0;
    if (c.nemesis === 1) hunter = true;
    drawSlot(state, c, cfg);
  }
}

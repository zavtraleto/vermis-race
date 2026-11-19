import { DT, K_HEADING, SEG_PER_UNIT, STEER_HIST } from './constants';
import { nextRandom } from './rng';
import type { Car, CarParams, InputFrame, RaceState, Track, TrafficConfig } from './types';

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
      recover: 0,
      steerHist: new Array<number>(STEER_HIST).fill(0),
      steerHistHead: 0,
      steerHistCount: 0,
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
): void {
  const segments = track.segments;
  const segCount = segments.length;
  const cars = state.cars;
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

    // R11/R13: sp uses the speed before R14 updates it.
    const sp0 = car.speed / p.vmax;
    // R13/R17/R19: segment under the car, before z advances.
    let seg = Math.floor(car.z) % segCount;
    if (seg < 0) seg += segCount;
    const curve = segments[seg]!.curve;

    // R10: steer slews toward input at most steerRise per second.
    const rise = p.steerRise * DT;
    let dSteer = input.steer - car.steer;
    if (dSteer > rise) dSteer = rise;
    if (dSteer < -rise) dSteer = -rise;
    car.steer += dSteer;

    // R21: consecutive off-road ticks (|x| > 1 at the start of the step), reset on the asphalt.
    const off = car.x > 1 || car.x < -1;
    car.offTicks = off ? car.offTicks + 1 : 0;

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
    let cap = p.vmax;
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
      cap = p.vmax * (1 - p.driftSpeedLoss * absAngle);
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
    if (boosted && !drift) cap = p.vmax * p.draftCapMul;
    const accel = boosted ? p.accel * p.draftAccelMul : p.accel;
    let speed: number;
    if (input.brake) speed = car.speed - p.brake * DT;
    else if (car.speed > cap) {
      speed = car.speed - p.driftBrake * DT;
      if (speed < cap) speed = cap;
    } else {
      speed = car.speed + accel * DT;
      if (speed > cap) speed = cap;
    }
    if (speed < 0) speed = 0;
    // R15: offroad slowdown.
    if (car.x > 1 || car.x < -1) speed *= Math.pow(p.offroadMul, 60 * DT);
    car.speed = speed;

    // R17: heading from the curve of the segment under the car, with the final speed.
    car.heading += curve * speed * K_HEADING * DT;

    // R16: z advances by post-update speed.
    car.z += speed * DT * SEG_PER_UNIT;
  }
  const player = cars[0];
  if (player !== undefined && player.kind === 'player') {
    // R71: respawn after R16 of all cars, relative to the player.
    if (traffic !== undefined) respawnTraffic(state, traffic, player.z, params[0]!.vmax);
    // R40: contact check at the end of the step.
    bumpPlayer(player, cars, params[0]!);
  }
  // R1: one fixed step.
  state.tick++;
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

/** R40-R44: at most one contact per step, traffic in index order. */
function bumpPlayer(car: Car, cars: readonly Car[], p: CarParams): void {
  if (car.bumpTicks !== 0) return; // R43
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
    car.vx = side * p.bumpKick;
    // R44: a drift survives; |angle| shrinks by bumpAngleLoss, not below 0.
    if (car.state === 'DRIFT') {
      let abs = car.angle * car.dir - p.bumpAngleLoss;
      if (abs < 0) abs = 0;
      car.angle = car.dir * abs;
    }
    car.bumpTicks = Math.round(p.bumpInvulnTime / DT); // R43
    car.draft = 0; // R51: a contact zeroes the charge and the boost
    car.boostTicks = 0;
    return;
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

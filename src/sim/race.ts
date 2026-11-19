import { DT, K_HEADING, SEG_PER_UNIT } from './constants';
import type { Car, CarParams, InputFrame, RaceState, Track } from './types';

export function createRace(seed: number, carCount: number): RaceState {
  const cars: Car[] = [];
  for (let i = 0; i < carCount; i++) {
    cars.push({
      kind: i === 0 ? 'player' : 'rival',
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
): void {
  const segments = track.segments;
  const segCount = segments.length;
  const cars = state.cars;
  // R4: cars updated in index order, each with its own input and params.
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i]!;
    const input = inputs[i]!;
    const p = params[i]!;

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

    // R20/R21: GRIP <-> DRIFT transitions on the smoothed steer and the speed before R14.
    // R21b (H11 B, driftOffroad = 1): no off-road condition on entry or exit.
    const offroadBlocks = p.driftOffroad !== 1;
    if (car.state === 'GRIP') {
      if (
        rising &&
        car.speed > p.driftEnterSpeed * p.vmax &&
        (car.steer > p.driftEnterSteer || car.steer < -p.driftEnterSteer) &&
        !(offroadBlocks && off)
      ) {
        car.state = 'DRIFT';
        car.dir = car.steer > 0 ? 1 : -1;
        car.angle = car.dir * p.driftAngleStart; // R20
        car.lowTicks = 0;
      }
    } else if (
      !input.drift ||
      car.speed < p.driftExitSpeed * p.vmax ||
      car.lowTicks * DT > p.driftStraightTime || // R21 small angle for too long
      (offroadBlocks && car.offTicks * DT > p.driftOffroadTime)
    ) {
      car.state = 'GRIP';
      car.dir = 0;
      car.angle = 0;
      car.lowTicks = 0;
    }
    const drift = car.state === 'DRIFT';

    let target: number;
    let grip: number;
    let cm: number;
    let cap = p.vmax;
    if (drift) {
      // R22: the angle chases clamp(steer*dir, 0, 1) * dir (also in the entry tick).
      let aim = car.steer * car.dir;
      if (aim < 0) aim = 0;
      if (aim > 1) aim = 1;
      car.angle += (aim * car.dir - car.angle) * (1 - Math.exp(-p.driftAngleResponse * DT));
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

    // R14: automatic throttle, brake, speed in [0, vmax] (capMul = 1 until stage 4).
    // R22: in DRIFT, above the cap speed falls by driftBrake (not below the cap), below it the
    // normal R14 throttle runs up to the cap. Brake input is plain R14 in both states.
    let speed: number;
    if (input.brake) speed = car.speed - p.brake * DT;
    else if (drift && car.speed > cap) {
      speed = car.speed - p.driftBrake * DT;
      if (speed < cap) speed = cap;
    } else {
      speed = car.speed + p.accel * DT;
      if (speed > cap) speed = cap;
    }
    if (speed > p.vmax) speed = p.vmax;
    if (speed < 0) speed = 0;
    // R15: offroad slowdown.
    if (car.x > 1 || car.x < -1) speed *= Math.pow(p.offroadMul, 60 * DT);
    car.speed = speed;

    // R17: heading from the curve of the segment under the car, with the final speed.
    car.heading += curve * speed * K_HEADING * DT;

    // R16: z advances by post-update speed.
    car.z += speed * DT * SEG_PER_UNIT;
  }
  // R1: one fixed step.
  state.tick++;
}

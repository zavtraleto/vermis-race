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

    // R11/R12: grip lateral speed target, exponential catch-up (drift ignored, state stays GRIP).
    // R15b: off road (|x| > 1 at the start of the step) the target is scaled by offroadSteerMul
    // and the catch-up uses offroadGrip; variant A is offroadGrip = grip, offroadSteerMul = 1.
    const off = car.x > 1 || car.x < -1;
    let target = car.steer * p.steerRate * sp0 * (1 - 0.25 * sp0);
    if (off) target *= p.offroadSteerMul;
    car.vx += (target - car.vx) * (1 - Math.exp(-(off ? p.offroadGrip : p.grip) * DT));

    // R13/R19: lateral move plus centrifugal push outward (cm = 1 in GRIP).
    const cm = 1;
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
    let speed = input.brake ? car.speed - p.brake * DT : car.speed + p.accel * DT;
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

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

    // R14: automatic throttle, brake, speed in [0, vmax] (capMul = 1 until stage 4).
    let speed = input.brake ? car.speed - p.brake * DT : car.speed + p.accel * DT;
    if (speed > p.vmax) speed = p.vmax;
    if (speed < 0) speed = 0;
    car.speed = speed;

    // R17: heading from the curve of the segment under the car (before z advances).
    let seg = Math.floor(car.z) % segCount;
    if (seg < 0) seg += segCount;
    car.heading += segments[seg]!.curve * speed * K_HEADING * DT;

    // R16: z advances by post-update speed.
    car.z += speed * DT * SEG_PER_UNIT;
  }
  // R1: one fixed step.
  state.tick++;
}

import { baseCarA } from './baseCarA';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';

/**
 * Helpers for the R200 driving tests (slice 1). Written from docs/brief.md R200-R215.
 * Units (brief R200 paragraph): angles in src/data are degrees (rates deg/s), in the sim radians;
 * roadTurn is rad per segment at curve 1;
 * v = speed * vmaxKmh / 3.6 m/s; "share k per OR2 tick" -> 1 - (1 - k)^(60.2*DT) per our tick.
 */

/** Real car data (R47 lamps off), the parameters the brief names. */
export const P: CarParams = baseCarA;

/** Brief R200 units paragraph: g = 9.81 m/s^2. */
export const G = 9.81;

export const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Brief R200: per-OR2-tick share -> per-our-tick share. */
export const perTick = (k: number): number => 1 - Math.pow(1 - k, 60.2 * DT);

/** Brief R200: metres per second at a given speed share. */
export const vMs = (p: CarParams, speed: number): number => (speed * p.vmaxKmh) / 3.6;

export const slipOf = (c: Car): number => c.heading - c.travel;

export function frame(steer: number, gas = 1, brake = 0, driftTap = false): InputFrame {
  return { steer, gas, brake, driftTap };
}

/** Constant-curve track (every segment the same curve), long enough for these tests. */
export function curveTrack(curve: number, length = 4000): Track {
  const segments = [];
  for (let i = 0; i < length; i++) segments.push({ curve });
  return { segments };
}

export const STRAIGHT: Track = makeStraightTrack(4000);

/** One player car with driving fields overridden. */
export function race1(over: Partial<Car> = {}): RaceState {
  const s = createRace(1, 1);
  Object.assign(s.cars[0]!, over);
  return s;
}

export function car0(s: RaceState): Car {
  return s.cars[0]!;
}

/**
 * Steps n ticks with the same input. When `keepCentred` is set, x is put back to 0 before every
 * step: lateral position only matters for R15/R18/R211 and the drift-only edge of R209, so this
 * isolates the yaw balance from the road border. `each` runs after every step.
 */
export function stepN(
  s: RaceState,
  n: number,
  input: InputFrame | ((tick: number) => InputFrame),
  track: Track = STRAIGHT,
  p: CarParams = P,
  keepCentred = false,
  each?: (c: Car, i: number) => void,
): void {
  const params = [p];
  const inputs: InputFrame[] = [typeof input === 'function' ? input(0) : input];
  for (let i = 0; i < n; i++) {
    if (keepCentred) car0(s).x = 0;
    if (typeof input === 'function') inputs[0] = input(s.tick);
    step(s, inputs, track, params);
    if (each) each(car0(s), i);
  }
}

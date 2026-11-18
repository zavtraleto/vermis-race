import { baseCar } from '../../src/data/cars';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';

/** Hand-made track with a constant curve, independent of buildTrack. */
export function constTrack(curve: number, length = 2000): Track {
  const segments = [];
  for (let i = 0; i < length; i++) segments.push({ curve });
  return { segments };
}

export function mirrorTrack(t: Track): Track {
  return { segments: t.segments.map((s) => ({ curve: -s.curve })) };
}

/** One-car race with the given car fields overridden. */
export function oneCar(over: Partial<Car> = {}): RaceState {
  const s = createRace(1, 1);
  Object.assign(s.cars[0]!, over);
  return s;
}

export function stepN(
  s: RaceState,
  n: number,
  input: InputFrame,
  track: Track,
  p: CarParams = baseCar,
): void {
  for (let i = 0; i < n; i++) step(s, [input], track, [p]);
}

export function inp(steer: number, brake = false, drift = false): InputFrame {
  return { steer, brake, drift };
}

/** accel 0 keeps a manually set speed constant (R14). */
export const constSpeed: CarParams = { ...baseCar, accel: 0 };

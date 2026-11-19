import { baseCarA as baseCar } from './baseCarA';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';

export const GAS: InputFrame = { steer: 0, brake: false, drift: false };
export const BRAKE: InputFrame = { steer: 0, brake: true, drift: false };

/** Steps the race n times on a straight track; inputsAt gets the current tick. */
export function run(
  state: RaceState,
  n: number,
  inputsAt: (tick: number) => readonly InputFrame[],
  params?: readonly CarParams[],
  track?: Track,
): void {
  const t = track ?? makeStraightTrack(1000);
  const p = params ?? state.cars.map(() => baseCar);
  for (let i = 0; i < n; i++) step(state, inputsAt(state.tick), t, p);
}

export { createRace };

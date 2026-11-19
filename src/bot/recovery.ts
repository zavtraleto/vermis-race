// T16 feel check for R15b: after leaving the road on a corner, how long until the car is back on
// asphalt with full steer toward the centre, holding drift. Pure, deterministic.
import { DT } from '../sim/constants';
import { createRace, step } from '../sim/race';
import type { CarParams, InputFrame, Track } from '../sim/types';

export interface RecoveryScenario {
  curve: number; // constant curve of the corner (+ right)
  speed: number; // speed at the moment of the exit, fraction of vmax
  depth: number; // how far beyond the outer edge the car starts, half-widths
  maxSeconds: number; // give up after this long
}

/**
 * Car on a constant curve, `depth` beyond the OUTER edge (R19: a right curve pushes left),
 * steer already at full lock toward the centre, drift input held, vx = 0. Returns seconds until |x| <= 1,
 * or Infinity if it does not return within maxSeconds.
 */
export function recoverySeconds(sc: RecoveryScenario, p: CarParams): number {
  const n = 4000;
  const segments = [];
  for (let i = 0; i < n; i++) segments.push({ curve: sc.curve });
  const track: Track = { segments };
  const race = createRace(1, 1);
  const car = race.cars[0]!;
  const inward = sc.curve >= 0 ? 1 : -1; // inside of a right curve is +x
  car.x = -inward * (1 + sc.depth);
  car.speed = sc.speed * p.vmax;
  car.steer = inward;
  // Medium and hard are drift-only (R22b): the driver holds drift with full steer into the corner;
  // with H11 B (R21b) the drift starts and holds off road.
  const input: InputFrame = { steer: inward, brake: false, drift: true };
  const maxTicks = Math.ceil(sc.maxSeconds / DT);
  while (race.tick < maxTicks) {
    step(race, [input], track, [p]);
    if (car.x <= 1 && car.x >= -1) return race.tick * DT;
    if (car.z >= n - 1) car.z -= n / 2; // stay on the constant curve
  }
  return Infinity;
}

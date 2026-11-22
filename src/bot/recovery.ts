// T16 feel check of the offroad exit (R15, R210): after leaving the road on a corner, how long until
// the car is back on asphalt with full steer toward the centre. Pure, deterministic.
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
 * Car on a constant curve, `depth` beyond the OUTER edge (R210: on a right curve the road turns away to the right, the car drifts to -x),
 * steer already at full lock toward the centre, full gas. Returns seconds until |x| <= 1,
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
  const input: InputFrame = { steer: inward, gas: 1, brake: 0, driftTap: false };
  const maxTicks = Math.ceil(sc.maxSeconds / DT);
  while (race.tick < maxTicks) {
    step(race, [input], track, [p]);
    if (car.x <= 1 && car.x >= -1) return race.tick * DT;
    if (car.z >= n - 1) car.z -= n / 2; // stay on the constant curve
  }
  return Infinity;
}

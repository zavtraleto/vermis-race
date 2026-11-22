import { baseCarA } from './baseCarA';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type {
  Car,
  CarParams,
  InputFrame,
  RaceState,
  RivalConfig,
  Track,
} from '../../src/sim/types';

export const LANES = 8;
export const IDLE: InputFrame = { steer: 0, gas: 1, brake: 0, driftTap: false };
export const TRACK: Track = makeStraightTrack(2000);

/** Explicit rival config (same numbers as the data defaults, but not read from the file). */
export const RC: RivalConfig = {
  rivalCount: 7,
  rivalGridGap: 12,
  rivalGridBehind: 2,
  rivalSkillWeights: [0.3, 0.5, 0.2],
  rivalPaceSpread: 0.03,
  rivalNameCount: 24,
  rubberBand: 1,
  rivalRoles: [3, 2, 2],
  slotClose: [-150, 150],
  slotAhead: [200, 600],
  slotBehind: [-600, -200],
  nemesisSlot: [-90, 90],
  slotTimeMin: 25,
  slotTimeMax: 50,
  bandRange: 300,
  bandBoost: 0.06,
  bandSlow: 0.1,
  bandViewDist: 200,
  bandViewMul: 0,
  nemesisViewMul: 0.5,
  bandAttack: 2,
  bandRelease: 0.5,
  bandStartDelay: 15,
  poolRadius: 1800,
  poolSpawnBehind: 60,
  joinShowTime: 4,
  rivalBumpLoss: 0.1,
  lanes: LANES,
};

/** z advance per tick at speed s (R16): s * DT * SEG_PER_UNIT. */
export const dz = (s: number): number => s * DT * SEG_PER_UNIT;

/** R70 lane centre as traffic uses it. */
export const laneCentre = (lane: number, lanes = LANES): number => -1 + ((lane + 0.5) * 2) / lanes;

/** Lane index of an x that must be a lane centre, or NaN when it is not. */
export function laneOf(x: number, lanes = LANES): number {
  const l = ((x + 1) * lanes) / 2 - 0.5;
  return Math.abs(l - Math.round(l)) < 1e-9 ? Math.round(l) : NaN;
}

/**
 * Explicit contact / environment params, model A, accel 0 (speeds stay constant, every expected
 * number is hand-computable). Contact width R65: carHitW 0.2. Traffic hit width deliberately
 * different (0.6) so R40 (half width 0.4) and R65 (0.2) can be told apart.
 * bumpTicks = round(0.8 / DT) = 96.
 */
export const BP: CarParams = {
  ...baseCarA,
  accel: 0,
  carLength: 1.5,
  carHitW: 0.2,
  trafficHitW: 0.6,
  bumpSpeedLoss: 0.1,
  bumpSideLoss: 0.05,
  bumpFloor: 0.3,
  bumpPush: 0.1,
  bumpPushDecay: 0.25,
  bumpKick: 0.6,
  bumpInvulnTime: 0.8,
  xLimit: 2,
};
export const BUMP_TICKS = 96;

/** Hand-placed race. cars[0] = player, then `rivals` rivals, then `traffic` traffic cars. */
export function mkRace(
  rivals: number,
  traffic: number,
  place: readonly Partial<Car>[],
  seed = 7,
): RaceState {
  const s = createRace(seed, 1 + rivals, traffic);
  place.forEach((o, i) => {
    Object.assign(s.cars[i]!, o);
    // R41b: a hand-placed traffic car cruises at its own speed (no decay toward 0).
    if (s.cars[i]!.kind === 'traffic' && o.speed !== undefined) Object.assign(s.cars[i]!, { cruise: o.speed });
  });
  return s;
}

/** One step with the same params for every car, idle input unless given. */
export function stepAll(
  s: RaceState,
  p: CarParams = BP,
  rc?: RivalConfig,
  inputs?: readonly InputFrame[],
  track: Track = TRACK,
): void {
  step(
    s,
    inputs ?? s.cars.map(() => IDLE),
    track,
    s.cars.map(() => p),
    undefined,
    rc,
  );
}

/**
 * Positions are given as seen AFTER the first step: pre-step z = z - dz(speed). So the contact
 * check at the end of step 1 sees exactly the given geometry (speeds constant, accel 0).
 */
export function after1(c: { z: number; x: number; speed: number }): Partial<Car> {
  return { z: c.z - dz(c.speed), x: c.x, speed: c.speed };
}

/** Player parked far away and standing (speed 0, accel 0 keeps it there). */
export const FAR_PLAYER: Partial<Car> = { z: 900, x: 0, speed: 0 };

import { baseCarA as baseCar } from './baseCarA';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { CarParams, InputFrame, RaceState, Track, TrafficConfig } from '../../src/sim/types';

/** z advance of a car per tick at speed s (R16): s * DT * SEG_PER_UNIT = s * 0.5. */
export const dz = (s: number): number => s * DT * SEG_PER_UNIT;

export const LANES = 8;

/** Explicit traffic config for rule tests (not the data file). */
export const CFG: TrafficConfig = {
  trafficMax: 5,
  trafficSpawnAhead: 100,
  trafficDespawnBehind: 30,
  trafficGapMin: 20,
  trafficGapMax: 50,
  trafficSpeedMin: 0.4,
  trafficSpeedMax: 0.7,
  lanes: LANES,
};

/**
 * Explicit bump params. accel = 0 keeps player speed constant across a step, so every expected
 * number is hand-computable. Hit width: (0.2 + 0.2) / 2 = 0.2 half-widths.
 * bumpTicks = round(0.8 / DT) = round(0.8 * 120) = 96.
 */
export const BP: CarParams = {
  ...baseCar,
  accel: 0,
  carLength: 1.5,
  carHitW: 0.2,
  trafficHitW: 0.2,
  bumpSpeedLoss: 0.1,
  bumpSideLoss: 0.05,
  bumpFloor: 0.3,
  bumpPush: 0.1,
  bumpPushDecay: 0.25,
  bumpKick: 0.6,
  bumpInvulnTime: 0.8,
};
export const BUMP_TICKS = 96;

export const IDLE: InputFrame = { steer: 0, gas: 1, brake: 0, driftTap: false };
export const TRACK: Track = makeStraightTrack(1000);

export interface Spec {
  z: number;
  x: number;
  speed: number;
}

/**
 * Builds a race with cars[0] = player and one traffic car per spec. Positions are given as the
 * positions AFTER the first step: the pre-step z is back-computed (z - speed * 0.5), so the
 * contact (or non-contact) check at the end of step 1 sees exactly the given geometry.
 * Player speed must stay constant: use BP (accel 0), no brake.
 */
export function setup(player: Spec, traffic: readonly Spec[], seed = 7): RaceState {
  const s = createRace(seed, 1, traffic.length);
  const p = s.cars[0]!;
  p.z = player.z - dz(player.speed);
  p.x = player.x;
  p.speed = player.speed;
  traffic.forEach((t, i) => {
    const c = s.cars[i + 1]!;
    c.kind = 'traffic';
    c.z = t.z - dz(t.speed);
    c.x = t.x;
    c.speed = t.speed;
    // R41b: a hand-placed traffic car cruises at its own speed (no decay toward 0).
    Object.assign(c, { cruise: t.speed });
  });
  return s;
}

/** One step with every car on BP and idle input (traffic entries are ignored by the rules). */
export function stepOnce(s: RaceState, inputs?: readonly InputFrame[], traffic?: TrafficConfig): void {
  step(
    s,
    inputs ?? s.cars.map(() => IDLE),
    TRACK,
    s.cars.map(() => BP),
    traffic,
  );
}

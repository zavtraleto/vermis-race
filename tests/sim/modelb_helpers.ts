import { baseCar } from '../../src/data/cars';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';

/** Explicit model B parameter set (docs/research/calm-drift-spike.md section 3; brief R80-R89b). */
export const PB: CarParams = {
  ...baseCar,
  model: 1,
  vmax: 1,
  accel: 0.22,
  brake: 0.6,
  driftBrake: 0.3,
  offroadMul: 0.99,
  offroadSteerMul: 0.6,
  offroadVelMul: 1,
  xLimit: 1.5,
  driftEnterSpeed: 0.45,
  driftExitSpeed: 0.3,
  kYaw: 2.0,
  latScale: 1,
  yawFullSpeed: 0.3,
  yawRateMax: 15.75,
  yawAlign: 15,
  yawResponse: 60,
  velGrip: 22,
  slipGripMax: 0.75,
  slipGripLimit: 0.8,
  velGripDrift: 3,
  slipFull: 2.64,
  slipResponse: 8,
  driftLat: 0.46,
  driftPush: 0.0287,
  driftSpeedLoss: 0.15,
  slipDrag: 0.058,
  flickDelta: 0.5,
  flickWindow: 0.12,
  kickBase: 2,
  kickGain: 6,
  carryDecay: 8,
};

/** accel 0 and slipDrag 0: speed is constant, so every expected number is hand-computable. */
export const Q: CarParams = { ...PB, accel: 0, slipDrag: 0 };

export const STRAIGHT: Track = makeStraightTrack(4000);

export function constTrack(curve: number, length = 4000): Track {
  const segments = [];
  for (let i = 0; i < length; i++) segments.push({ curve });
  return { segments };
}

/** 1 - exp(-rate*DT): the chase factor of R83. */
export const chase = (rate: number): number => 1 - Math.exp(-rate * DT);

export function inp(steer: number, drift = false, brake = false): InputFrame {
  return { steer, brake, drift };
}

/** One-car race (model B fields default to 0), car fields overridden. */
export function mk(over: Partial<Car> = {}): RaceState {
  const s = createRace(1, 1);
  Object.assign(s.cars[0]!, over);
  return s;
}

export const car = (s: RaceState): Car => s.cars[0]!;

export function stepB(
  s: RaceState,
  input: InputFrame,
  p: CarParams = Q,
  track: Track = STRAIGHT,
): void {
  step(s, [input], track, [p]);
}

export function stepN(
  s: RaceState,
  n: number,
  input: InputFrame,
  p: CarParams = Q,
  track: Track = STRAIGHT,
): void {
  for (let i = 0; i < n; i++) step(s, [input], track, [p]);
}

/** Records raw steer values through real ticks (drift input as given), returns the state. */
export function withHistory(
  over: Partial<Car>,
  steers: readonly number[],
  drift: boolean,
  p: CarParams = Q,
): RaceState {
  const s = mk(over);
  for (const st of steers) stepB(s, inp(st, drift), p);
  return s;
}

/** slip = yaw - vel (not stored). */
export const slipOf = (c: Car): number => c.yaw - c.vel;

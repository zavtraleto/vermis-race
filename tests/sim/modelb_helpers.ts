import { baseCar } from '../../src/data/cars';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';

/** Explicit model B parameter set (spike table, docs/research/yaw-slip-spike.md section 2). */
export const PB: CarParams = {
  ...baseCar,
  model: 1,
  vmax: 1,
  accel: 0.22,
  brake: 0.6,
  driftBrake: 0.3,
  offroadMul: 0.99,
  offroadSteerMul: 0.6,
  xLimit: 1.5,
  driftEnterSpeed: 0.45,
  driftExitSpeed: 0.3,
  kYaw: 2.0,
  latScale: 1,
  yawFullSpeed: 0.3,
  yawRateMax: 15,
  yawAlign: 12.5,
  yawResponse: 50,
  velGrip: 22,
  slipGripMax: 0.42,
  slipGripLimit: 0.6,
  yawRateMaxDrift: 43.6,
  yawAlignDrift: 6,
  yawResponseDrift: 12,
  velGripDrift: 6.3,
  slipDriftMax: 3.0,
  slipHardMax: 3.5,
  slipDrag: 0.058,
  flickDelta: 0.5,
  flickWindow: 0.12,
  kickBase: 8,
  kickGain: 15,
  gripRecoverTime: 0.25,
  slipSnapMax: 1.2,
  snapLoss: 0.04,
  snapCatch: 0.5,
  slipViewFull: 2.47,
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

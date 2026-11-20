import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';

/**
 * T71 (docs/brief.md R81f, R83c, R86f; docs/balance.md T71) start numbers. Spread from a variable:
 * cornerCurve / cornerGap / cornerSpan / cornerMinU may not be in CarParams yet.
 */
export const V5 = {
  driftEntry: 5,
  cornerCurve: 0.5,
  cornerGap: 30,
  cornerSpan: 0.5,
  cornerMinU: 0.1,
};
/** Every number T71 changes in cars/base.json, for tests that build a car from base.json. */
export const T71 = { ...V5, driftSpeedLoss: 0, debtTime: 0, gripDodge: 0.1 };

/** The sim step all T71 tests go through (one place, so every test drives the real `step`). */
export function stepV(
  s: RaceState,
  inputs: readonly InputFrame[],
  track: Track,
  params: readonly CarParams[],
): void {
  step(s, inputs, track, params);
}

/** Straight track of n segments with curve c on [from, from + len) for each part. */
export function custom(n: number, parts: ReadonlyArray<readonly [number, number, number]>): Track {
  const segments = Array.from({ length: n }, () => ({ curve: 0 }));
  for (const [from, len, c] of parts)
    for (let i = from; i < from + len; i++) segments[i]!.curve = c;
  return { segments };
}

export function mirror(t: Track): Track {
  return { segments: t.segments.map((g) => ({ curve: g.curve === 0 ? 0 : -g.curve })) };
}

/** Deterministic LCG for seeded "random" steer (tests only; the sim has its own RNG). */
export class Lcg {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
}

/** A state change of the car, with the segment of the start of its tick. */
export interface Change {
  tick: number;
  seg: number; // floor(z) % n at the start of the tick
  to: 'GRIP' | 'DRIFT';
  dir: number; // dir after the tick
}

/** One car driven through stepV, recording every GRIP <-> DRIFT change. */
export class Rig {
  race: RaceState = createRace(1, 1);
  car: Car = this.race.cars[0]!;
  frame: InputFrame = { steer: 0, brake: false, drift: false };
  changes: Change[] = [];
  lastSeg = 0;
  constructor(
    public p: CarParams,
    speed: number,
    z: number,
    x = 0,
  ) {
    this.car.speed = speed * p.vmax;
    this.car.z = z;
    this.car.x = x;
  }
  tick(track: Track, steer: number, held: boolean, brake = false): void {
    const n = track.segments.length;
    let seg = Math.floor(this.car.z) % n;
    if (seg < 0) seg += n;
    this.lastSeg = seg;
    const was = this.car.state;
    this.frame.steer = steer;
    this.frame.drift = held;
    this.frame.brake = brake;
    stepV(this.race, [this.frame], track, [this.p]);
    if (this.car.state !== was)
      this.changes.push({ tick: this.race.tick, seg, to: this.car.state, dir: this.car.dir });
  }
}

import { DT } from '../sim/constants';
import { step } from '../sim/race';
import type { CarParams, InputFrame, RaceState, Track } from '../sim/types';

/** Hard cap on sim steps per advance() call (spiral-of-death guard). 8 ticks = 66.7 ms. */
export const MAX_STEPS_PER_FRAME = 8;

/** Fills `out` (preallocated, one InputFrame per car, mutate in place) for the tick about to be stepped. */
export type InputSource = (tick: number, out: InputFrame[]) => void;

export interface LoopOptions {
  track: Track;
  params: readonly CarParams[];
  readInput: InputSource;
  maxStepsPerFrame?: number;
}

export interface Loop {
  readonly prev: RaceState;
  readonly curr: RaceState;
  readonly alpha: number;
  advance(frameSeconds: number): number;
  stepTicks(n: number): void;
}

/**
 * In-place deep copy src -> dst (tick, rng, every field of every car). Same car count required.
 * No allocations. Update this when fields are added to Car (the JSON-equality test catches it).
 */
export function copyRaceState(src: RaceState, dst: RaceState): void {
  dst.tick = src.tick;
  dst.rng = src.rng;
  const sc = src.cars;
  const dc = dst.cars;
  for (let i = 0; i < sc.length; i++) {
    const s = sc[i]!;
    const d = dc[i]!;
    d.kind = s.kind;
    d.z = s.z;
    d.x = s.x;
    d.speed = s.speed;
    d.vx = s.vx;
    d.steer = s.steer;
    d.heading = s.heading;
    d.state = s.state;
    d.dir = s.dir;
    d.offTicks = s.offTicks;
    d.angle = s.angle;
    d.driftHeld = s.driftHeld;
    d.armTicks = s.armTicks;
    d.lowTicks = s.lowTicks;
  }
}

// Absorbs float error so that e.g. 1/60 s frames give exactly 2 ticks forever.
const TICK_EPS = 1e-6;

/** `initial` is deep-copied into two internal buffers; the caller's object is never mutated. */
export function createLoop(initial: RaceState, opts: LoopOptions): Loop {
  const prev = JSON.parse(JSON.stringify(initial)) as RaceState;
  const curr = JSON.parse(JSON.stringify(initial)) as RaceState;
  const inputs: InputFrame[] = [];
  for (let i = 0; i < initial.cars.length; i++)
    inputs.push({ steer: 0, brake: false, drift: false });
  const { track, params, readInput } = opts;
  const maxSteps = opts.maxStepsPerFrame ?? MAX_STEPS_PER_FRAME;
  let acc = 0;

  function tick(): void {
    readInput(curr.tick, inputs);
    copyRaceState(curr, prev);
    step(curr, inputs, track, params);
  }

  const loop = {
    prev,
    curr,
    alpha: 0,
    advance(frameSeconds: number): number {
      const f = Number.isFinite(frameSeconds) && frameSeconds > 0 ? frameSeconds : 0;
      acc += f / DT;
      let ran = 0;
      while (acc >= 1 - TICK_EPS && ran < maxSteps) {
        tick();
        acc -= 1;
        ran++;
      }
      if (acc >= 1 - TICK_EPS) acc = 0;
      // acc < 1 - TICK_EPS here; it can be a hair negative because of the epsilon.
      loop.alpha = acc > 0 ? acc : 0;
      return ran;
    },
    stepTicks(n: number): void {
      for (let i = 0; i < n; i++) tick();
    },
  };
  return loop;
}

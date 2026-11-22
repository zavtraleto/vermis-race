import { DT } from '../sim/constants';
import { step } from '../sim/race';
import type {
  CarParams,
  InputFrame,
  RaceState,
  RivalConfig,
  Track,
  TrafficConfig,
} from '../sim/types';

/** Hard cap on sim steps per advance() call (spiral-of-death guard). 8 ticks = 66.7 ms. */
export const MAX_STEPS_PER_FRAME = 8;

/** Fills `out` (preallocated, one InputFrame per car, mutate in place) for the tick about to be stepped. */
export type InputSource = (tick: number, out: InputFrame[]) => void;

export interface LoopOptions {
  track: Track;
  params: readonly CarParams[];
  readInput: InputSource;
  maxStepsPerFrame?: number;
  /** R71 traffic respawn config; absent = traffic cars (if any) never respawn. */
  traffic?: TrafficConfig | undefined;
  /** R60-R66 rivals config (read live each tick); absent = no slots, band, pool or car contacts. */
  rivals?: RivalConfig | undefined;
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
    d.bumpTicks = s.bumpTicks;
    d.draft = s.draft;
    d.boostTicks = s.boostTicks;
    // Model B (R80-R88): the ring buffer is copied element by element (no allocation).
    d.yaw = s.yaw;
    d.yawRate = s.yawRate;
    d.vel = s.vel;
    d.carry = s.carry;
    const sh = s.steerHist;
    const dh = d.steerHist;
    for (let j = 0; j < sh.length; j++) dh[j] = sh[j]!;
    d.steerHistHead = s.steerHistHead;
    d.steerHistCount = s.steerHistCount;
    d.deflectTicks = s.deflectTicks; // R81b C
    d.autoTicks = s.autoTicks; // R81e
    d.turbo = s.turbo; // R86c
    d.turboTicks = s.turboTicks;
    d.driftTicks = s.driftTicks;
    d.scrubDebt = s.scrubDebt;
    d.relSide = s.relSide; // R85f
    d.relV = s.relV;
    // R48 crash.
    d.crashTicks = s.crashTicks;
    d.crashSpeed0 = s.crashSpeed0;
    d.crashX0 = s.crashX0;
    d.cruise = s.cruise; // R41b
    // R62 character, R66 place.
    d.skill = s.skill;
    d.pace = s.pace;
    d.nameId = s.nameId;
    d.place = s.place;
    // R62b role and slot, R63 band, R63b join notice.
    d.role = s.role;
    d.slot = s.slot;
    d.slotTicks = s.slotTicks;
    d.nemesis = s.nemesis;
    d.band = s.band;
    d.joinTicks = s.joinTicks;
    // Model C (R152).
    d.beta = s.beta;
    d.betaI = s.betaI;
    d.refA = s.refA;
    d.winTicks = s.winTicks;
    d.winDir = s.winDir;
    d.wBeta = s.wBeta;
    d.liftArmed = s.liftArmed;
    d.endTicks = s.endTicks;
    d.exitTicks = s.exitTicks;
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
  const { track, params, readInput, traffic, rivals } = opts;
  const maxSteps = opts.maxStepsPerFrame ?? MAX_STEPS_PER_FRAME;
  let acc = 0;

  function tick(): void {
    readInput(curr.tick, inputs);
    copyRaceState(curr, prev);
    step(curr, inputs, track, params, traffic, rivals);
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

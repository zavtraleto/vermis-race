// R60/R63c rival drivers: one driver bot + one mistake generator per rival car, outside the sim.
// Shared by the game (src/app) and the headless tools (tools/botlib.ts). Setup allocates; the
// per-tick fill does not.
import { BOT_NAMES, botParams } from '../data/bots';
import type { CarParams, InputFrame, RaceState, Track } from '../sim/types';
import { botInput, createBot, type BotParams, type BotState } from './driver';
import { createMistakes, stepMistake, type MistakeConfig, type MistakeState } from './mistakes';
import { DT } from '../sim/constants';

// Keeps the mistake generator's sequence apart from the driver bot's noise (same base seed).
const MISTAKE_SALT = 0x5bd1e995;

export interface RivalDrivers {
  readonly seed: number;
  /** Bot level per skill (0 novice, 1 average, 2 expert), traffic avoidance on. */
  readonly levels: readonly BotParams[];
  /** Per car index (only rival slots are used). */
  readonly bots: BotState[];
  readonly mistakes: MistakeState[];
  /** Last seen nameId / joinTicks / respawn count per car index (R63b respawn detection). */
  readonly lastName: Int32Array;
  readonly lastJoin: Int32Array;
  readonly spawns: Int32Array;
}

/**
 * Rival bot levels: the skill's own parameters with traffic avoidance on. A level whose own
 * avoidance look-ahead is 0 (novice ignores traffic) takes the traffic fields of `average`.
 */
function rivalLevel(skill: number): BotParams {
  const own = botParams[BOT_NAMES[skill]!];
  const t = own.trafficLookaheadSeg > 0 ? own : botParams.average;
  return {
    ...own,
    traffic: 'avoid',
    trafficLookaheadSeg: t.trafficLookaheadSeg,
    trafficMargin: t.trafficMargin,
    trafficEdge: t.trafficEdge,
    trafficSteerTime: t.trafficSteerTime,
  };
}

/** Deterministic per-car, per-respawn seed for the bot and its mistake generator. */
function carSeed(seed: number, i: number, spawn: number): number {
  return (
    (Math.imul(seed | 0, 0x9e3779b1) ^
      Math.imul(i + 1, 0x85ebca6b) ^
      Math.imul(spawn, 0xc2b2ae35)) |
    0
  );
}

function resetBot(b: BotState, seed: number): void {
  b.rng = seed;
  b.noise = 0;
  b.steerQueue.fill(0);
  b.driftQueue.fill(0);
  b.head = 0;
  b.flick = 0;
  b.flickDir = 0;
}

function resetMistakes(m: MistakeState, seed: number): void {
  // Same fields as createMistakes(seed ^ MISTAKE_SALT), written in place (no allocation).
  m.rng = (seed ^ MISTAKE_SALT) | 0;
  m.wait = -1;
  m.left = 0;
  m.offset = 0;
}

export function createRivalDrivers(race: RaceState, seed: number): RivalDrivers {
  const n = race.cars.length;
  const d: RivalDrivers = {
    seed,
    levels: [rivalLevel(0), rivalLevel(1), rivalLevel(2)],
    bots: [],
    mistakes: [],
    lastName: new Int32Array(n),
    lastJoin: new Int32Array(n),
    spawns: new Int32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const s = carSeed(seed, i, 0);
    d.bots.push(createBot(s));
    d.mistakes.push(createMistakes(s ^ MISTAKE_SALT));
    d.lastName[i] = race.cars[i]!.nameId;
    d.lastJoin[i] = race.cars[i]!.joinTicks;
  }
  return d;
}

/**
 * Writes inputs[i] for every rival car of `race`: the driver bot of its skill (model by its
 * params) plus the R63c mistake steer offset. A rival replaced by the pool (R63b: new nameId or
 * a rising joinTicks) gets a fresh bot and mistake state first. Other cars' inputs are untouched.
 */
export function fillRivalInputs(
  d: RivalDrivers,
  race: RaceState,
  track: Track,
  params: readonly CarParams[],
  mcfg: MistakeConfig,
  inputs: InputFrame[],
): void {
  const cars = race.cars;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind !== 'rival') continue;
    if (c.nameId !== d.lastName[i] || c.joinTicks > d.lastJoin[i]!) {
      const sp = ++d.spawns[i]!;
      const s = carSeed(d.seed, i, sp);
      resetBot(d.bots[i]!, s);
      resetMistakes(d.mistakes[i]!, s);
    }
    d.lastName[i] = c.nameId;
    d.lastJoin[i] = c.joinTicks;
    const skill = c.skill < 0 ? 0 : c.skill > 2 ? 2 : c.skill;
    const out = inputs[i]!;
    botInput(d.bots[i]!, d.levels[skill]!, c, track, params[i]!, out, cars);
    let steer = out.steer + stepMistake(d.mistakes[i]!, skill, c.band, mcfg, DT);
    if (steer > 1) steer = 1;
    else if (steer < -1) steer = -1;
    out.steer = steer;
  }
}

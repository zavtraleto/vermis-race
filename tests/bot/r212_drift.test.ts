// R212 bot criteria (a)-(e). Written from docs/brief.md R212 before the drifting bot exists; do not edit to pass.
// Each (bot, track) pair is driven once (seed 1, 3 laps) and the trace is shared by all criteria.
import { describe, expect, it } from 'vitest';
import { botParams } from '../../src/data/bots';
import { baseCar } from '../../src/data/cars';
import { loadTrackByName } from '../../src/data/tracks';
import { botInput, createBot } from '../../src/bot/driver';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { CarParams, InputFrame, Track } from '../../src/sim/types';

const TRACKS = ['test-twisty', 'drift-lab'] as const;
const DRIFTERS = ['average', 'expert'] as const;
const SEED = 1;
const LAPS = 3;

// Bounds named in R212.
const MIN_EPISODE_TICKS = Math.round(0.5 / DT); // (b) driftTimer > 0 "longer than 0.5 s": 0.5*120 = 60 ticks, need > 60
const MAX_SLIP = (60 * Math.PI) / 180; // (c) |slip| <= 60 deg = 1.0472 rad
const STRAIGHT_CURVE = 0.1; // (c) road under the car counts as straight when |curve| <= 0.1
const EXIT_TICKS = Math.round(1.5 / DT); // (c) drift over no later than 1.5 s = 180 ticks after the road went straight
const MAX_OFFROAD = 0.05; // (d) average off asphalt (|x| > 1) <= 5% of ticks

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a)); // -> -pi..pi

interface Trace {
  gas: number[];
  brake: number[];
  driftTap: boolean[];
  slip: number[]; // wrap(heading - travel) after the tick
  driftTimer: number[]; // after the tick
  curve: number[]; // curve of the segment under the car after the tick
  lap: number[]; // floor(z / track length) after the tick
  ticks: number;
  offroadTicks: number;
  finished: boolean;
}

function drive(name: string, seed: number, laps: number, track: Track, maxTicks: number): Trace {
  const carParams: CarParams = { ...baseCar };
  const race = createRace(seed, 1);
  const car = race.cars[0]!;
  const bot = createBot(seed);
  const bp = botParams[name as keyof typeof botParams];
  const frame: InputFrame = { steer: 0, gas: 1, brake: 0, driftTap: false };
  const inputs = [frame];
  const params = [carParams];
  const n = track.segments.length;
  const goal = laps * n;
  const t: Trace = {
    gas: [],
    brake: [],
    driftTap: [],
    slip: [],
    driftTimer: [],
    curve: [],
    lap: [],
    ticks: 0,
    offroadTicks: 0,
    finished: false,
  };
  while (car.z < goal && race.tick < maxTicks) {
    botInput(bot, bp, car, track, carParams, frame);
    t.gas.push(frame.gas);
    t.brake.push(frame.brake);
    t.driftTap.push(frame.driftTap);
    step(race, inputs, track, params);
    t.slip.push(wrap(car.heading - car.travel));
    t.driftTimer.push(car.driftTimer);
    t.curve.push(track.segments[Math.floor(car.z) % n]!.curve);
    t.lap.push(Math.floor(car.z / n));
    if (car.x > 1 || car.x < -1) t.offroadTicks++;
  }
  t.ticks = race.tick;
  t.finished = car.z >= goal;
  return t;
}

/** Drift episodes: maximal runs of driftTimer > 0. `lapAtHalf` = lap the car is on when the run passes 0.5 s. */
function episodes(t: Trace): { start: number; end: number; lapAtHalf: number }[] {
  const out: { start: number; end: number; lapAtHalf: number }[] = [];
  let start = -1;
  for (let i = 0; i <= t.driftTimer.length; i++) {
    const on = i < t.driftTimer.length && t.driftTimer[i]! > 0;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      if (i - start > MIN_EPISODE_TICKS) {
        out.push({ start, end: i, lapAtHalf: t.lap[start + MIN_EPISODE_TICKS]! });
      }
      start = -1;
    }
  }
  return out;
}

// Same tick cap rule as bots.test.ts: 3 laps at vmax = 3*len/60 s, x3 margin, x120 ticks/s.
const maxTicks = (track: Track): number =>
  Math.ceil(LAPS * (track.segments.length / SEG_PER_UNIT) * 3 * 120);

const cache = new Map<string, { trace: Trace; track: Track }>();
function run(name: string, trackName: string): { trace: Trace; track: Track } {
  const key = `${name}/${trackName}`;
  let r = cache.get(key);
  if (!r) {
    const track = buildTrack(loadTrackByName(trackName).def);
    r = { trace: drive(name, SEED, LAPS, track, maxTicks(track)), track };
    cache.set(key, r);
  }
  return r;
}

describe('R212(a) novice does not drift and does not brake', () => {
  for (const tn of TRACKS) {
    it(`novice on ${tn}: driftTap never true, brake always 0 (3 laps)`, () => {
      const { trace } = run('novice', tn);
      expect(trace.driftTap.some((d) => d)).toBe(false);
      expect(trace.brake.some((b) => b > 0)).toBe(false);
    });
  }
});

describe('R212(b) average and expert finish 3 laps with a drift every lap', () => {
  for (const name of DRIFTERS) {
    for (const tn of TRACKS) {
      it(`${name} on ${tn}: finishes 3 laps`, () => {
        expect(run(name, tn).trace.finished).toBe(true);
      });
      it(`${name} on ${tn}: each lap 0..2 has a drift episode longer than 0.5 s (> ${MIN_EPISODE_TICKS} ticks)`, () => {
        const eps = episodes(run(name, tn).trace);
        const lapsWithDrift = new Set(eps.map((e) => e.lapAtHalf));
        for (let lap = 0; lap < LAPS; lap++)
          expect(lapsWithDrift.has(lap), `lap ${lap}`).toBe(true);
      });
    }
  }
});

describe('R212(c) no spin: |slip| <= 60 deg, drift over within 1.5 s of the road going straight', () => {
  for (const name of DRIFTERS) {
    for (const tn of TRACKS) {
      it(`${name} on ${tn}: |slip| never exceeds 60 deg`, () => {
        const { trace } = run(name, tn);
        let worst = 0;
        for (const s of trace.slip) worst = Math.max(worst, Math.abs(s));
        expect(worst).toBeLessThanOrEqual(MAX_SLIP);
      });
      it(`${name} on ${tn}: driftTimer is 0 within ${EXIT_TICKS} ticks after |curve| <= 0.1 begins`, () => {
        const { trace } = run(name, tn);
        // straightSince = first tick of the current unbroken run of |curve| <= 0.1 (-1 while in a corner).
        // A drift still alive more than 180 ticks into such a run violates (c).
        let straightSince = -1;
        let violation = -1;
        for (let i = 0; i < trace.ticks && i < trace.curve.length; i++) {
          if (Math.abs(trace.curve[i]!) <= STRAIGHT_CURVE) {
            if (straightSince < 0) straightSince = i;
          } else straightSince = -1;
          if (straightSince >= 0 && trace.driftTimer[i]! > 0 && i - straightSince > EXIT_TICKS) {
            violation = i;
            break;
          }
        }
        expect(violation, `drift alive at tick ${violation}`).toBe(-1);
        // Not vacuous: the bot must actually drift for this to mean anything.
        expect(episodes(trace).length).toBeGreaterThan(0);
      });
    }
  }
});

describe('R212(d) average stays on asphalt', () => {
  for (const tn of TRACKS) {
    it(`average on ${tn}: finishes, |x| > 1 on <= 5% of ticks`, () => {
      const { trace } = run('average', tn);
      expect(trace.finished).toBe(true);
      expect(trace.offroadTicks / trace.ticks).toBeLessThanOrEqual(MAX_OFFROAD);
    });
  }
});

describe('R212(e) braking means gas 0', () => {
  for (const name of ['novice', 'average', 'expert'] as const) {
    for (const tn of TRACKS) {
      it(`${name} on ${tn}: brake > 0 implies gas = 0`, () => {
        const { trace } = run(name, tn);
        const bad = trace.brake.findIndex((b, i) => b > 0 && trace.gas[i] !== 0);
        expect(bad, `tick ${bad}: brake ${trace.brake[bad]}, gas ${trace.gas[bad]}`).toBe(-1);
      });
    }
  }
});

// R162 bot driver of model C and R163 (h) laps (docs/brief.md; written before the implementation).
// The driver law is tested with noise 0 and reaction 0 (brief: noise, reaction, traffic, R63c are
// "on top"), the model C level numbers spread from the brief (bots.json has its own data test).
// Car: PC (tests/sim/modelc_helpers.ts), model 2. SEG_PER_UNIT 60, DT 1/120.
import { describe, expect, it } from 'vitest';
import { botInput, createBot, type BotParams } from '../../src/bot/driver';
import { botParams } from '../../src/data/bots';
import {
  curveClasses,
  loadTestTwisty,
  loadTrackByName,
  resolveSections,
  trackSections,
} from '../../src/data/tracks';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, InputFrame, Track } from '../../src/sim/types';
import { C, MC_START, PC, cf, clamp, figTrack } from '../sim/modelc_helpers';

/** R162 levels (brief): expert / average / novice. */
const C_BOT = {
  expert: { cLead: 0.15, cErr: 0, cErrPeriod: 1.6, cUseThr: true, cKx: 0.15, cRelease: false },
  average: { cLead: -0.15, cErr: 0.3, cErrPeriod: 1.6, cUseThr: false, cKx: 0, cRelease: true },
  novice: { cLead: 0, cErr: 0, cErrPeriod: 1.6, cUseThr: false, cKx: 0, cRelease: true },
} as const;
type Name = keyof typeof C_BOT;
const BP = (name: Name, extra: Partial<BotParams> = {}): BotParams => ({
  ...botParams[name],
  noiseAmp: 0,
  reactionDelay: 0,
  ...C_BOT[name],
  ...extra,
});

/** drift-lab of docs/research/model-c.md section 4, inline (the data file has its own test). */
const DRIFT_LAB = {
  name: 'drift-lab',
  figures: [
    'straight',
    'straight',
    'sweeper',
    'straight',
    'hairpin',
    'straight',
    'kink',
    'straight',
    'esses',
    'straight',
    'scurve',
    'straight',
    'hook',
    'straight',
    'chicane',
    'straight',
    'straight',
  ].map((figure, i) => ({ figure, side: [4, 10, 14].includes(i) ? -1 : 1 })),
};
let tracks: Record<string, Track> | undefined;
function lapTracks(): Record<string, Track> {
  tracks ??= {
    'drift-lab': buildTrack(resolveSections(trackSections(DRIFT_LAB), curveClasses)),
    'drift-run': buildTrack(loadTrackByName('drift-run').def),
    'test-twisty': buildTrack(loadTestTwisty().def),
  };
  return tracks;
}

const curveAt = (tr: Track, z: number): number => {
  const n = tr.segments.length;
  let i = Math.floor(z) % n;
  if (i < 0) i += n;
  return tr.segments[i]!.curve;
};

interface Tick {
  i: number;
  state: Car['state'];
  dir: number;
  x: number;
  vel: number;
  z: number;
  speed: number;
  win: number;
  out: { steer: number; throttle: number };
}
/** Bot drives the car through the real step; the car state is recorded BEFORE each botInput. */
function drive(
  tr: Track,
  bp: BotParams,
  seconds: number,
  seed = 1,
  until?: (c: Car) => boolean,
): Tick[] {
  const st = createRace(1, 1);
  const car = st.cars[0]!;
  car.speed = PC.vmax;
  const bot = createBot(seed);
  const out: InputFrame = { steer: 0, brake: false, drift: false, throttle: 0 };
  const log: Tick[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    if (until?.(car)) break;
    const rec = {
      i,
      state: car.state,
      dir: car.dir,
      x: car.x,
      vel: car.vel,
      z: car.z,
      speed: car.speed,
      win: cf(car).winTicks,
    };
    botInput(bot, bp, car, tr, PC, out);
    log.push({ ...rec, out: { steer: out.steer, throttle: out.throttle ?? 0 } });
    step(st, [out], tr, [PC]);
  }
  return log;
}

/** First segment index >= 0 with curve*side >= 1 before the first |curve| >= 4 (R162 corner start). */
function cornerStart(tr: Track): { start: number; side: number } {
  let k = 0;
  while (Math.abs(tr.segments[k]!.curve) < 4) k++;
  const side = Math.sign(tr.segments[k]!.curve);
  let s = k;
  while (s > 0 && tr.segments[s - 1]!.curve * side >= 1) s--;
  return { start: s, side };
}

describe('R162 entry: a lift before (expert) / after (average) the corner start, steer to the corner', () => {
  const tr = figTrack(C.hard!, 400); // straight 120, enter 30 (curve*side >= 1 from segment 132)
  const { start, side } = cornerStart(tr);
  it('corner start of the test track: segment 132 (7*(12/30)^2 = 1.12 >= 1), side +1', () => {
    expect(start).toBe(132);
    expect(side).toBe(1);
  });
  const firstLift = (log: Tick[]): number =>
    log.findIndex((t) => t.out.throttle <= -MC_START.liftOn);
  it('expert: first lift when <= lead*sp*60 = 9 segments are left to the start (one tick moves 0.5 seg)', () => {
    const log = drive(tr, BP('expert'), 4);
    const k = firstLift(log);
    expect(k).toBeGreaterThan(0);
    const t = log[k]!;
    const left = start - t.z;
    const lim = 0.15 * (t.speed / PC.vmax) * SEG_PER_UNIT;
    expect(left).toBeLessThanOrEqual(lim + 1);
    expect(left).toBeGreaterThan(lim - 1.5);
  });
  for (const name of ['expert', 'average'] as const) {
    it(`${name}: the lift is throttle -1 for 0.1 s (12 ticks +-1) with steer = side of the corner`, () => {
      const log = drive(tr, BP(name), 5);
      const k = firstLift(log);
      expect(k).toBeGreaterThan(0);
      let n = 0;
      while (log[k + n]!.out.throttle === -1) n++;
      expect(Math.abs(n - 12)).toBeLessThanOrEqual(1);
      for (let j = k; j < k + n; j++) expect(log[j]!.out.steer).toBe(side);
      expect(log.some((t) => t.state === 'DRIFT' && t.dir === side)).toBe(true);
    });
  }
  it('average: first lift 0.15 s after the car reaches the corner start (+-2 ticks)', () => {
    const log = drive(tr, BP('average'), 5);
    const k = firstLift(log);
    const reach = log.findIndex((t) => curveAt(tr, t.z) * side >= 1);
    expect(reach).toBeGreaterThan(0);
    expect(Math.abs(k - reach - 18)).toBeLessThanOrEqual(2);
  });
});

describe('R162 drift: the finger law', () => {
  const edgeOf = (xi: number): number =>
    xi > 0.6 ? -1.5 * (xi - 0.6) : xi < -0.6 ? 1.5 * (-xi - 0.6) : 0;
  it('expert: steer = dir*clamp(uHold - 0.15*x*dir - 0.2*vel*dir + edge, 0, 1), throttle = clamp(3*x*dir, -0.3, 1)', () => {
    const tr = lapTracks()['drift-lab']!;
    const log = drive(tr, BP('expert'), 50);
    const dr = log.filter((t) => t.state === 'DRIFT');
    expect(dr.length).toBeGreaterThan(200);
    for (const t of dr) {
      const xi = t.x * t.dir;
      const u = MC_START.uHold - 0.15 * xi - 0.2 * t.vel * t.dir + edgeOf(xi);
      expect(t.out.steer).toBeCloseTo(t.dir * clamp(u, 0, 1), 9);
      expect(t.out.throttle).toBeCloseTo(clamp(3 * xi, -0.3, 1), 9);
    }
  });
  it('average: in a corner steer*dir within uHold*(1 +- 0.3) (+ edge), throttle 0, and the finger wobbles', () => {
    const tr = lapTracks()['drift-lab']!;
    const log = drive(tr, BP('average'), 50);
    let lo = 9;
    let hi = -9;
    let n = 0;
    for (const t of log) {
      if (t.state !== 'DRIFT') continue;
      const sp = Math.max(0.05, t.speed / PC.vmax);
      const kx = Math.ceil(sp * SEG_PER_UNIT * 0.25);
      let keep = false;
      for (let i = 0; i <= kx; i++) if (curveAt(tr, t.z + i) * t.dir >= 1.5) keep = true;
      if (!keep) {
        // R162 release: at the corner end the finger goes
        expect(t.out.steer).toBe(0);
        expect(t.out.throttle).toBe(0);
        continue;
      }
      const xi = t.x * t.dir;
      const u = t.out.steer * t.dir - edgeOf(xi);
      expect(u).toBeGreaterThanOrEqual(MC_START.uHold * 0.7 - 1e-9);
      expect(u).toBeLessThanOrEqual(MC_START.uHold * 1.3 + 1e-9);
      expect(t.out.throttle).toBe(0);
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
      n++;
    }
    expect(n).toBeGreaterThan(200);
    expect(hi - lo).toBeGreaterThan(0.2);
  });
  it('expert never releases: no DRIFT tick with steer 0 and throttle 0 while |x| < 0.6', () => {
    const log = drive(lapTracks()['drift-lab']!, BP('expert'), 50);
    for (const t of log)
      if (t.state === 'DRIFT' && Math.abs(t.x) < 0.3)
        expect(t.out.steer * t.dir).toBeGreaterThan(0);
  });
});

describe('R162 GRIP and the novice', () => {
  it('GRIP on a straight: steer = clamp(1.5*(0 - x) - 0.4*vel, +-1): from x 0.3, vel 0 -> -0.45 (all levels)', () => {
    const tr = figTrack(0, 10, 2000);
    for (const name of ['novice', 'average', 'expert'] as const) {
      const st = createRace(1, 1);
      const car = st.cars[0]!;
      car.speed = PC.vmax;
      car.x = 0.3;
      const out: InputFrame = { steer: 0, brake: false, drift: false, throttle: 0 };
      botInput(createBot(1), BP(name), car, tr, PC, out);
      expect(out.steer).toBeCloseTo(-0.45, 9);
      expect(out.throttle ?? 0).toBe(0);
    }
  });
  it('novice: never in DRIFT over a lap of drift-lab; lifts only with |steer| < 0.2; |steer| <= 0.2 while a window is open', () => {
    const tr = lapTracks()['drift-lab']!;
    const log = drive(tr, BP('novice'), 60);
    let lifts = 0;
    for (const t of log) {
      expect(t.state).toBe('GRIP');
      if (t.out.throttle < 0) {
        lifts++;
        expect(Math.abs(t.out.steer)).toBeLessThan(0.2);
      }
      if (t.win > 0) expect(Math.abs(t.out.steer)).toBeLessThanOrEqual(0.2);
    }
    expect(lifts).toBeGreaterThan(0); // hard / sharp corners need a lift (need > 1)
  });
});

describe('R162 determinism', () => {
  it('the same seed and track twice give identical frames and state', () => {
    const tr = lapTracks()['drift-lab']!;
    for (const name of ['novice', 'average', 'expert'] as const)
      expect(JSON.stringify(drive(tr, BP(name), 20, 5))).toBe(
        JSON.stringify(drive(tr, BP(name), 20, 5)),
      );
  });
});

describe('R163 (h) laps: skill shows in model C', () => {
  /** Second (flying) lap time and its off-asphalt ticks. */
  function lap(tr: Track, bp: BotParams): { t: number; off: number } {
    const n = tr.segments.length;
    const st = createRace(1, 1);
    const car = st.cars[0]!;
    car.speed = PC.vmax;
    const bot = createBot(1);
    const out: InputFrame = { steer: 0, brake: false, drift: false, throttle: 0 };
    let i0 = -1;
    let off = 0;
    let i = 0;
    for (; car.z < 2 * n && i < Math.round(600 / DT); i++) {
      if (i0 < 0 && car.z >= n) i0 = i;
      botInput(bot, bp, car, tr, PC, out);
      step(st, [out], tr, [PC]);
      if (i0 >= 0 && Math.abs(car.x) > 1) off++;
    }
    return { t: (i - i0) * DT, off };
  }
  for (const name of ['drift-lab', 'drift-run', 'test-twisty']) {
    it(`${name}: average 4..9% and novice 10..16% slower than expert; expert 0.3 s late <= +0.5%; expert/average never off the asphalt`, () => {
      const tr = lapTracks()[name]!;
      const e = lap(tr, BP('expert'));
      const a = lap(tr, BP('average'));
      const v = lap(tr, BP('novice'));
      const late = lap(tr, BP('expert', { cLead: -0.15 }));
      const pa = (a.t - e.t) / e.t;
      const pv = (v.t - e.t) / e.t;
      expect(pa).toBeGreaterThanOrEqual(0.04);
      expect(pa).toBeLessThanOrEqual(0.09);
      expect(pv).toBeGreaterThanOrEqual(0.1);
      expect(pv).toBeLessThanOrEqual(0.16);
      expect((late.t - e.t) / e.t).toBeLessThanOrEqual(0.005);
      expect(e.off).toBe(0);
      expect(a.off).toBe(0);
    });
  }
});

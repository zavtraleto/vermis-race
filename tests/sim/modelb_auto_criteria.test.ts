import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { curveClasses } from '../../src/data/tracks';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, Segment, Track } from '../../src/sim/types';

// Spec: docs/brief.md R81e "Критерии" (a)-(f), measured by tools/spike/auto-drift.ts with the real
// step on variant 3 plus a wrapper; here the same runs go through the real step on variant 4.
// Parameters: the real base car (driftTurbo 0, as the spike) with the R81e start numbers spread in
// explicitly and driftEntry 4; the reference "zone stick" run is the same car with driftEntry 3.
// gripA = yawRateMax/(1 + yawAlign/velGrip) (R86b). Curves: easy 2, medium 4.5, hard 7, sharp 8.3.
// needAhead on easy = 2*sp*kYaw/gripA: sp 1 -> 0.43, sp 1.13 -> 0.48 (brief (a)).
// Entry after 12 counted ticks = tick 13 = 13/120 = 0.1083 s (brief: "0.108 с (13 тиков)").

const AUTO = { autoSteer: 0.7, autoHold: 0.1, autoLook: 0.25, autoNeed: 1.0 };
const P4: CarParams = { ...baseCar, driftTurbo: 0, ...AUTO, driftEntry: 4 };
const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  crashMinSpeed: 1e9,
});
const C = curveClasses as Record<string, number>;
const GRIP_A = P4.yawRateMax / (1 + P4.yawAlign / P4.velGrip);
const HOLD: Record<string, number> = { medium: 0.537, hard: 0.817, sharp: 0.956 };
const ENTRY_T = 13 * DT;

const cache = new Map<string, Track>();
/** Straight 0..start, curve for len segments, straight to 8000 (as the spike). */
function cornerTrack(curve: number, start: number, len: number): Track {
  const key = `${curve}/${start}/${len}`;
  let t = cache.get(key);
  if (!t) {
    const segments: Segment[] = [];
    for (let i = 0; i < 8000; i++)
      segments.push({ curve: i >= start && i < start + len ? curve : 0 });
    t = { segments };
    cache.set(key, t);
  }
  return t;
}

class Lcg {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
}

type Mode = 'auto' | 'zone' | 'grip';
interface Rig {
  race: ReturnType<typeof createRace>;
  car: Car;
  frame: InputFrame;
  p: CarParams;
  mode: Mode;
  entries: number;
  lastEntryTick: number;
  speedPin?: number;
}
/** auto = variant 4, drift = control held; zone = variant 3, drift = held; grip = drift never held. */
function rig(mode: Mode, p: CarParams, speed: number, z: number, x = 0): Rig {
  const race = createRace(1, 1);
  const car = race.cars[0]!;
  car.speed = speed * p.vmax;
  car.z = z;
  car.x = x;
  const q = mode === 'zone' ? { ...p, driftEntry: 3 } : { ...p, driftEntry: 4 };
  return {
    race,
    car,
    frame: { steer: 0, brake: false, drift: false },
    p: q,
    mode,
    entries: 0,
    lastEntryTick: -1,
  };
}
function stepR(r: Rig, track: Track, steer: number, held: boolean): void {
  if (r.speedPin !== undefined) r.car.speed = r.speedPin;
  const was = r.car.state;
  r.frame.steer = steer;
  r.frame.drift = r.mode === 'grip' ? false : held;
  step(r.race, [r.frame], track, [r.p]);
  if (was === 'GRIP' && r.car.state === 'DRIFT') {
    r.entries++;
    r.lastEntryTick = r.race.tick;
  }
}

interface Run {
  entryT: number; // s after corner start (negative = before), NaN = none
  cornerT: number;
  xStart: number; // x*side at corner start (+ = inside)
  speedAtEntry: number;
}
/** The spike's cornerRun: corner at 3000, full steer from `steerFrom` s, line controller in DRIFT. */
function cornerRun(
  mode: Mode,
  cls: string,
  side: number,
  len: number,
  v0: number,
  steerFrom = 0,
  x0 = 0,
): Run {
  const start = 3000;
  const lead = Math.max(0.6, -steerFrom + 0.3);
  const z0 = start - v0 * SEG_PER_UNIT * lead;
  const track = cornerTrack(side * C[cls]!, start, len);
  const r = rig(mode, P4, v0, z0, x0 * side);
  const out: Run = { entryT: NaN, cornerT: NaN, xStart: NaN, speedAtEntry: NaN };
  let tStart = NaN;
  const hold = HOLD[cls] ?? 0.8;
  for (let i = 0; i < 30 / DT; i++) {
    const c = r.car;
    const t = i * DT;
    const zRel = c.z - start;
    const tc = zRel / (v0 * SEG_PER_UNIT);
    if (tc < steerFrom && tc < 0) c.speed = v0 * P4.vmax;
    let s = 0;
    if (c.state === 'DRIFT') s = side * (hold + 0.8 * (0 - c.x * side) - 0.3 * c.vx * side);
    else if (tc >= steerFrom)
      s = mode === 'grip' && zRel >= 0 ? side * (1 + 0.8 * (0 - c.x * side)) : side;
    s = Math.max(-1, Math.min(1, s));
    if (c.z >= start + len) s = 0;
    const held = c.z < start + len;
    const v = c.speed;
    stepR(r, track, s, held);
    if (r.lastEntryTick === r.race.tick && Number.isNaN(out.entryT)) {
      out.entryT = Number.isNaN(tStart) ? -(start - c.z) / (c.speed * SEG_PER_UNIT) : t - tStart;
      out.speedAtEntry = v;
    }
    if (c.z >= start && Number.isNaN(tStart)) {
      tStart = t;
      out.xStart = c.x * side;
    }
    if (c.z >= start + len) {
      out.cornerT = t - tStart;
      break;
    }
  }
  return out;
}
const dT = (a: Run, b: Run): number => (100 * (a.cornerT - b.cornerT)) / b.cornerT;

describe('R81e criterion (a): no DRIFT on straights and in easy, whatever the input', () => {
  const pats: ReadonlyArray<readonly [string, (t: number) => number]> = [
    ['full lock +1 held', () => 1],
    ['full lock -1 held', () => -1],
    ['weave ±1, half period 0.2 s', (t) => (Math.floor(t / 0.2 + 1e-9) % 2 ? 1 : -1)],
    ['weave ±1, half period 0.6 s', (t) => (Math.floor(t / 0.6 + 1e-9) % 2 ? 1 : -1)],
    ['weave ±1, half period 2 s', (t) => (Math.floor(t / 2 + 1e-9) % 2 ? 1 : -1)],
    ['dodge 1 for 0.3 s every second', (t) => (t % 1 < 0.3 ? 1 : 0)],
  ];
  const runs = (
    track: Track,
    pin: number,
    fn: (t: number, rng: Lcg, st: { v: number; until: number }) => number,
    seed = 1,
  ): number => {
    const r = rig('auto', free(P4), pin, 10);
    r.speedPin = pin;
    const rng = new Lcg(seed);
    const st = { v: 0, until: 0 };
    for (let i = 0; i < 20 / DT; i++) stepR(r, track, fn(i * DT, rng, st), true);
    return r.entries;
  };
  const random = (t: number, rng: Lcg, st: { v: number; until: number }): number => {
    if (t >= st.until) {
      st.v = rng.next() < 0.5 ? -1 : 1;
      st.until = t + 0.05 + rng.next() * 1.45;
    }
    return st.v;
  };
  it('needAhead on easy is 0.43 at sp 1 and 0.48 at sp 1.13 (below autoNeed 1)', () => {
    expect((C.easy! * 1 * P4.kYaw) / GRIP_A).toBeCloseTo(0.43, 2);
    expect((C.easy! * 1.13 * P4.kYaw) / GRIP_A).toBeCloseTo(0.48, 2);
  });
  for (const [road, curve] of [
    ['straight', 0],
    ['easy right', C.easy!],
    ['easy left', -C.easy!],
  ] as const) {
    for (const pin of [1, 1.13]) {
      it(`${road}, sp ${pin}, 20 s, control held: 0 entries for every pattern and 20 random seeds`, () => {
        const track = cornerTrack(curve, 0, 8000);
        for (const [, fn] of pats) expect(runs(track, pin, fn)).toBe(0);
        for (let seed = 1; seed <= 20; seed++) expect(runs(track, pin, random, seed)).toBe(0);
      });
    }
  }
});

describe('R81e criterion (b): hard / sharp entry time and corner time vs variant 3; medium stays GRIP', () => {
  const figs: ReadonlyArray<readonly [string, number]> = [
    ['hard', 240],
    ['hard', 120],
    ['sharp', 120],
    ['sharp', 60],
  ];
  for (const [cls, len] of figs) {
    for (const side of [1, -1]) {
      it(`${cls} ${len} side ${side}: entry 0.108 s (13 ticks) after the corner start at sp 1, 0.9, 0.85, 0.8, 0.7`, () => {
        for (const v0 of [1, 0.9, 0.85, 0.8, 0.7]) {
          const au = cornerRun('auto', cls, side, len, v0);
          expect(au.entryT).toBeCloseTo(ENTRY_T, 9);
        }
      });
    }
    it(`${cls} ${len} at vmax: corner time within +1% of variant 3 entering on the corner-start tick`, () => {
      const au = cornerRun('auto', cls, 1, len, 1);
      const zo = cornerRun('zone', cls, 1, len, 1);
      expect(dT(au, zo)).toBeLessThanOrEqual(1);
    });
    it(`${cls} ${len} at vmax: GRIP (no drift) is 9-26% slower than variant 3`, () => {
      const gr = cornerRun('grip', cls, 1, len, 1);
      const zo = cornerRun('zone', cls, 1, len, 1);
      expect(dT(gr, zo)).toBeGreaterThanOrEqual(9);
      expect(dT(gr, zo)).toBeLessThanOrEqual(26);
    });
  }
  it('at 0.85-0.9 vmax (criterion not met, bounds as the brief states them): hard <= +0.78%, sharp 120 <= +1.16%, sharp 60 <= +2.29%', () => {
    const bound: Record<string, number> = {
      'hard 240': 0.78,
      'hard 120': 0.78,
      'sharp 120': 1.16,
      'sharp 60': 2.29,
    };
    for (const [cls, len] of figs) {
      for (const v0 of [0.9, 0.85]) {
        const d = dT(cornerRun('auto', cls, 1, len, v0), cornerRun('zone', cls, 1, len, v0));
        expect(d).toBeLessThanOrEqual(bound[`${cls} ${len}`]! + 0.01);
      }
    }
  });
  it('hard below sp 0.67: entry waits until needAhead reaches 1 (hard 240 at 0.55: entry 0.97 s, +2.7%)', () => {
    expect(GRIP_A / (C.hard! * P4.kYaw)).toBeCloseTo(0.67, 2);
    const au = cornerRun('auto', 'hard', 1, 240, 0.55);
    const zo = cornerRun('zone', 'hard', 1, 240, 0.55);
    expect(au.entryT).toBeGreaterThan(ENTRY_T);
    expect(au.entryT).toBeCloseTo(0.97, 1);
    expect(Math.abs(au.entryT - 0.97)).toBeLessThanOrEqual(0.01);
    expect((C.hard! * (au.speedAtEntry / P4.vmax) * P4.kYaw) / GRIP_A).toBeGreaterThanOrEqual(1);
    expect(dT(au, zo)).toBeLessThanOrEqual(2.7 + 0.05);
  });
  it('hard 120 at 0.55-0.6: +4.2...+5.0% against variant 3', () => {
    for (const v0 of [0.55, 0.6]) {
      const d = dT(cornerRun('auto', 'hard', 1, 120, v0), cornerRun('zone', 'hard', 1, 120, v0));
      expect(d).toBeGreaterThanOrEqual(4.2 - 0.05);
      expect(d).toBeLessThanOrEqual(5.0 + 0.05);
    }
  });
  it('sharp from sp 0.56: needAhead threshold', () => {
    expect(GRIP_A / (C.sharp! * P4.kYaw)).toBeCloseTo(0.56, 2);
  });
  it('medium 240 at vmax: no DRIFT; GRIP 4.008 s is about 4% faster than the held drift of variant 3 (4.175 s)', () => {
    expect((C.medium! * P4.kYaw) / GRIP_A).toBeCloseTo(0.96, 2);
    for (const side of [1, -1]) {
      const au = cornerRun('auto', 'medium', side, 240, 1);
      const zo = cornerRun('zone', 'medium', side, 240, 1);
      expect(Number.isNaN(au.entryT)).toBe(true);
      expect(au.cornerT).toBeCloseTo(4.008, 2);
      expect(zo.cornerT).toBeCloseTo(4.175, 2);
      expect(dT(au, zo)).toBeLessThanOrEqual(-3.5);
    }
  });
  it('medium below vmax (0.9, 0.8, 0.7, 0.55): no DRIFT either', () => {
    for (const v0 of [0.9, 0.8, 0.7, 0.55])
      expect(Number.isNaN(cornerRun('auto', 'medium', 1, 240, v0).entryT)).toBe(true);
  });
});

describe('R81e criterion (c): steer against, |steer| < autoSteer and pulses shorter than autoHold never enter', () => {
  const pats: ReadonlyArray<readonly [string, (i: number, rng: Lcg) => number]> = [
    ['-1 held', () => -1],
    ['-0.3 held', () => -0.3],
    ['0', () => 0],
    ['+0.69 held', () => 0.69],
    ['weave ±0.69, 0.3 s', (i) => (Math.floor(i / 36) % 2 ? 1 : -1) * 0.69],
    ['random in [-1, 0.7)', (_i, rng) => -1 + rng.next() * 1.699],
    ['+1 pulses of 10 ticks (0.083 s) after 12 ticks (0.1 s) of -1', (i) => (i % 22 < 10 ? 1 : -1)],
    ['+1 pulses of 12 ticks (= autoHold) after 12 ticks of -1', (i) => (i % 24 < 12 ? 1 : -1)],
  ];
  for (const cls of ['medium', 'hard', 'sharp']) {
    for (const side of [1, -1]) {
      it(`inside ${cls} (side ${side}) at vmax, 10 s: 0 entries; control +1 held ${cls === 'medium' ? 'does not enter' : 'enters after 0.108 s'}`, () => {
        const track = cornerTrack(side * C[cls]!, 0, 8000);
        for (const [, fn] of pats) {
          const r = rig('auto', free(P4), 1, 10);
          r.speedPin = 1;
          const rng = new Lcg(7);
          for (let i = 0; i < 10 / DT; i++) stepR(r, track, side * fn(i, rng), true);
          expect(r.entries).toBe(0);
        }
        const r = rig('auto', free(P4), 1, 10);
        r.speedPin = 1;
        let first = NaN;
        for (let i = 0; i < 10 / DT; i++) {
          stepR(r, track, side, true);
          if (r.entries === 1 && Number.isNaN(first)) first = (i + 1) * DT;
        }
        if (cls === 'medium') expect(r.entries).toBe(0);
        else {
          expect(r.entries).toBe(1);
          expect(first).toBeCloseTo(ENTRY_T, 9);
        }
      });
    }
  }
});

describe('R81e criterion (d): drop and re-touch', () => {
  const track = cornerTrack(C.hard!, 0, 8000);
  for (const gapTicks of [2, 6, 12, 24, 48, 96]) {
    it(`hard at vmax, steady drift, released ${gapTicks} ticks: GRIP at once; re-touch with full steer -> GRIP exactly 12 ticks, DRIFT on the 13th`, () => {
      const r = rig('auto', P4, 1, 10);
      const ctl = (c: Car): number => Math.min(1, 0.817 + 0.8 * (0 - c.x) - 0.3 * c.vx);
      for (let i = 0; i < 1.7 / DT; i++)
        stepR(r, track, r.car.state === 'DRIFT' ? ctl(r.car) : 1, true);
      expect(r.car.state).toBe('DRIFT');
      stepR(r, track, 0, false);
      expect(r.car.state).toBe('GRIP');
      for (let i = 1; i < gapTicks; i++) stepR(r, track, 0, false);
      for (let i = 1; i <= 12; i++) {
        stepR(r, track, 1, true);
        expect(r.car.state).toBe('GRIP');
      }
      stepR(r, track, 1, true);
      expect(r.car.state).toBe('DRIFT');
    });
  }
  it('release straightens: outward 0.30 / 0.38 / 0.42 half-widths in 0.3 s (medium / hard / sharp), held drift about 0.01', () => {
    const want: Record<string, [number, number]> = {
      medium: [0.301, 0.603],
      hard: [0.379, 0.73],
      sharp: [0.417, 0.773],
    };
    for (const cls of ['medium', 'hard', 'sharp']) {
      const tr = cornerTrack(C[cls]!, 0, 8000);
      const dx: number[][] = [];
      for (const rel of [false, true]) {
        const r = rig('auto', free(P4), 1, 10);
        const row: number[] = [];
        let x0 = 0;
        for (let i = 0; i < 3 / DT; i++) {
          const t = i * DT;
          const c = r.car;
          let s = c.state === 'DRIFT' ? HOLD[cls]! + 0.8 * (0 - c.x) - 0.3 * c.vx : 1;
          if (s > 1) s = 1;
          const held = !(rel && t >= 2);
          if (rel && t >= 2) s = 0;
          if (Math.abs(t - 2) < DT / 2) x0 = c.x;
          stepR(r, tr, s, held);
          if (Math.abs(t - 2.3) < DT / 2 || Math.abs(t - 2.6) < DT / 2) row.push(c.x - x0);
        }
        dx.push(row);
      }
      expect(Math.abs(dx[0]![0]!)).toBeLessThanOrEqual(0.02); // held drift
      expect(-dx[1]![0]!).toBeCloseTo(want[cls]![0], 1);
      expect(Math.abs(-dx[1]![0]! - want[cls]![0])).toBeLessThanOrEqual(0.02);
      expect(Math.abs(-dx[1]![1]! - want[cls]![1])).toBeLessThanOrEqual(0.02);
    }
  });
});

describe('R81e criterion (e): full steer from the approach straight enters no earlier than 0.13 s before the corner', () => {
  for (const [cls, len] of [
    ['hard', 240],
    ['sharp', 120],
  ] as const) {
    for (const side of [1, -1]) {
      it(`${cls} ${len} side ${side}, x0 -0.5: steer from -0.5/-0.3 s -> -0.13 s; -0.15 s -> -0.04 s; 0 -> +0.108 s`, () => {
        const want: ReadonlyArray<readonly [number, number]> = [
          [-0.5, -0.13],
          [-0.3, -0.13],
          [-0.15, -0.04],
          [0, ENTRY_T],
        ];
        for (const [from, e] of want) {
          const au = cornerRun('auto', cls, side, len, 1, from, -0.5);
          expect(au.entryT).toBeGreaterThanOrEqual(-0.13 - DT); // no earlier than the bound (one tick of slack)
          expect(Math.abs(au.entryT - e)).toBeLessThanOrEqual(0.01);
        }
      });
    }
    it(`${cls} ${len}: the drift does not take the car inside on the approach: x at corner start <= GRIP with the same steer`, () => {
      for (const x0 of [-0.5, 0, 0.3]) {
        for (const from of [-0.5, -0.3, -0.15]) {
          const au = cornerRun('auto', cls, 1, len, 1, from, x0);
          const gr = cornerRun('grip', cls, 1, len, 1, from, x0);
          expect(au.xStart).toBeLessThanOrEqual(gr.xStart + 1e-9);
        }
      }
    });
  }
  it('hard 240, steer from -0.5 s: x at the corner start 0.15 / 0.63 / 0.93 against GRIP 0.25 / 0.75 / 1.05 (x0 -0.5 / 0 / +0.3)', () => {
    const want: ReadonlyArray<readonly [number, number, number]> = [
      [-0.5, 0.15, 0.25],
      [0, 0.63, 0.75],
      [0.3, 0.93, 1.05],
    ];
    for (const [x0, a, g] of want) {
      expect(
        Math.abs(cornerRun('auto', 'hard', 1, 240, 1, -0.5, x0).xStart - a),
      ).toBeLessThanOrEqual(0.03);
      expect(
        Math.abs(cornerRun('grip', 'hard', 1, 240, 1, -0.5, x0).xStart - g),
      ).toBeLessThanOrEqual(0.03);
    }
  });
});

describe('R81e criterion (f): R86e holds under variant 4', () => {
  /** The spike's chain run: corner at 3000, approach 30 segments at vmax. Returns corner time. */
  const chainRun = (
    kind: 'grip' | 'held' | 'chain',
    cls: string,
    len: number,
    dTime: number,
    rTime: number,
  ): number => {
    const track = cornerTrack(C[cls]!, 3000, len);
    const r = rig(kind === 'grip' ? 'grip' : 'auto', P4, 1, 3000 - 30);
    let tStart = NaN;
    let phaseT = 0;
    let released = false;
    for (let i = 0; i < 20 / DT; i++) {
      const t = i * DT;
      const c = r.car;
      let s = 0;
      let held = true;
      if (c.z >= 3000) {
        if (Number.isNaN(tStart)) tStart = t;
        if (kind === 'chain') {
          if (c.state === 'DRIFT') {
            phaseT += DT;
            if (phaseT >= dTime) {
              released = true;
              phaseT = 0;
            }
          } else if (released) {
            phaseT += DT;
            if (phaseT >= rTime) {
              released = false;
              phaseT = 0;
            }
          }
        }
        held = !released;
        if (c.state === 'DRIFT') s = HOLD[cls]! + 0.8 * (0 - c.x) - 0.3 * c.vx;
        else s = held ? 1 + 0.8 * (0 - c.x) : 0;
        s = Math.max(-1, Math.min(1, s));
      }
      if (c.z >= 3000 + len) return t - tStart;
      stepR(r, track, s, held);
    }
    return NaN;
  };
  for (const [cls, len] of [
    ['hard', 240],
    ['hard', 120],
    ['sharp', 120],
  ] as const) {
    it(`${cls} ${len}: every chain "touch -> 0.1 s -> drift 0.1-0.45 s -> release 0.05-0.1 s" is slower than pure GRIP; the held drift is faster`, () => {
      const g = chainRun('grip', cls, len, 0, 0);
      const h = chainRun('held', cls, len, 0, 0);
      expect(h).toBeLessThan(g);
      for (const [d, rl] of [
        [0.1, 0.05],
        [0.2, 0.05],
        [0.3, 0.1],
        [0.45, 0.05],
      ] as const) {
        expect(chainRun('chain', cls, len, d, rl)).toBeGreaterThan(g);
      }
    });
  }
  it('hard 240: held drift 4.283 s against GRIP 4.908 s', () => {
    expect(chainRun('held', 'hard', 240, 0, 0)).toBeCloseTo(4.283, 2);
    expect(chainRun('grip', 'hard', 240, 0, 0)).toBeCloseTo(4.908, 2);
  });
});

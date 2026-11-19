// Driving model B (H14): R89b calibration on the REAL car data (src/data/cars/base.json, pinned
// `model: 1`), properties of the formulas, determinism, serialization, golden example.
// Scenarios follow docs/research/calm-drift-spike.md section 4 (T1-T14); where the brief compares
// with model A, model A runs through the same real `step` (`baseCarA`, model 0).
// No x-controller: holding steers are found by bisection on a constant steer, as in the spike.
// Walls and the off-road loss are removed (`free`) where only the steer response is measured.
import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import sprites from '../../src/data/sprites.json';
import curves from '../../src/data/tracks/curves.json';
import { DT, STEER_HIST } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { baseCarA } from './baseCarA';
import { GAS, run } from './helpers';
import { PB, Q, STRAIGHT, car, constTrack, inp, mk, slipOf, stepB, stepN } from './modelb_helpers';

const C = curves as { easy: number; medium: number; hard: number };
const SLIP_DEG = (sprites as { weight: { slipDeg: number } }).weight.slipDeg; // R89 degrees per unit of slip
/** Real data pinned to model B. */
const REAL: CarParams = { ...baseCar, model: 1 };
const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  offroadSteerMul: 1,
  offroadGrip: p.grip,
  crashMinSpeed: 1e9, // R47 lamps off: this test is about R89b
});
const FB = free(REAL); // model B without walls
const FA = free(baseCarA); // model A without walls
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** One player car on a constant curve, stepped through the real `step`. */
class Rig {
  race: RaceState = createRace(1, 1);
  car: Car = this.race.cars[0]!;
  frame: InputFrame = { steer: 0, brake: false, drift: false };
  lastDx = 0;
  constructor(
    public p: CarParams,
    public curve: number,
    speed: number,
  ) {
    this.car.speed = speed;
  }
  /** Steps once; `pin` forces the speed before and after the tick (spike: pinned vmax). */
  step(steer: number, drift: boolean, pin?: number): void {
    if (pin !== undefined) this.car.speed = pin;
    this.frame.steer = steer;
    this.frame.drift = drift;
    const x0 = this.car.x;
    step(this.race, [this.frame], constTrack(this.curve), [this.p]);
    this.lastDx = (this.car.x - x0) / DT;
    if (pin !== undefined) this.car.speed = pin;
  }
  /** Visible slip: model B yaw - vel + carry, model A angle. */
  get slip(): number {
    return this.p.model === 0 ? this.car.angle : this.car.yaw - this.car.vel + this.car.carry;
  }
  /** Puts a DRIFT dir +1 (or -1) state for steer s without a flick (spike enterDrift). */
  enterDrift(dir: 1 | -1, s: number): void {
    const c = this.car;
    c.state = 'DRIFT';
    c.dir = dir;
    c.driftHeld = true;
    if (this.p.model === 0) {
      c.angle = clamp(s * dir, 0, 1) * dir;
      c.steer = s;
      return;
    }
    const A = this.curve * (c.speed / this.p.vmax) * this.p.kYaw;
    const u = s * dir;
    const slip = dir * this.p.slipFull * clamp(u, 0, 1);
    c.vel =
      dir *
        this.p.driftLat *
        ((slip * dir) / this.p.slipFull + Math.min(0, u)) -
      this.p.driftPush * A;
    c.yaw = c.vel + slip;
    c.yawRate = 0;
  }
}

/** Mean lateral speed dx/dt (+ inward) over the last second of `secs` at held steer s, DRIFT dir +1. */
function driftLat(p: CarParams, curve: number, s: number, pin: number | null, secs: number) {
  const r = new Rig(p, curve, 1);
  r.enterDrift(1, s);
  let sum = 0;
  let sl = 0;
  let n = 0;
  const N = Math.round(secs / DT);
  for (let i = 0; i < N; i++) {
    r.step(s, true, pin ?? undefined);
    if (i * DT >= secs - 1) {
      sum += r.lastDx;
      sl += r.slip;
      n++;
    }
  }
  return { vx: sum / n, slip: sl / n, speed: r.car.speed };
}
/** Bisection on the steer for zero mean lateral speed in DRIFT (dir +1). */
function driftHold(p: CarParams, curve: number, pin: number | null, secs: number) {
  let lo = -1;
  let hi = 1;
  let res = { vx: 0, slip: 0, speed: 0 };
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    res = driftLat(p, curve, mid, pin, secs);
    if (res.vx > 0) hi = mid;
    else lo = mid;
  }
  return { steer: (lo + hi) / 2, slip: res.slip, speed: res.speed };
}
const memo = new Map<string, ReturnType<typeof driftHold>>();
/** Memoized hold: `free` = the car's own steady speed (8 s), `pinned` = vmax pinned (3 s). */
function hold(name: 'A' | 'B', curve: number, mode: 'free' | 'pinned') {
  const key = `${name}${curve}${mode}`;
  let h = memo.get(key);
  if (!h) {
    h = driftHold(name === 'A' ? FA : FB, curve, mode === 'free' ? null : 1, mode === 'free' ? 8 : 3);
    memo.set(key, h);
  }
  return h;
}
const lat = (name: 'A' | 'B', curve: number, s: number) =>
  driftLat(name === 'A' ? FA : FB, curve, s, 1, 3).vx;

/** GRIP hold steer at pinned vmax: bisection on a constant steer so that the mean vel is 0 (3 s). */
function gripHold(p: CarParams, curve: number): number {
  let lo = -1;
  let hi = 1;
  for (let i = 0; i < 26; i++) {
    const st = (lo + hi) / 2;
    const r = new Rig(p, curve, 1);
    const A = curve * p.kYaw;
    r.car.yawRate = A;
    r.car.yaw = A / p.velGrip;
    let sum = 0;
    let n = 0;
    for (let k = 0; k < 360; k++) {
      r.step(st, false, 1);
      if (k >= 240) {
        sum += r.car.vel;
        n++;
      }
    }
    if (sum / n > 0) hi = st;
    else lo = st;
  }
  return (lo + hi) / 2;
}
/** dx/dt (+ inward) in GRIP from x = 0 at pinned vmax with held steer, sampled at 0.5, 1, 2, 3 s. */
function gripOut(p: CarParams, curve: number, steer: number): number[] {
  const r = new Rig(p, curve, 1);
  const out: number[] = [];
  const marks = [60, 120, 240, 360];
  for (let i = 1; i <= 360; i++) {
    r.step(steer, false, 1);
    if (marks.includes(i)) out.push(r.lastDx);
  }
  return out;
}

describe('R89b calibration: GRIP on a straight (lane change, response)', () => {
  it('R89b full steer on a straight gives 1.0-1.1 half-widths per second at vmax', () => {
    // spike T8: Y/al = 15.75/15 = 1.05 (A: 1.05)
    const r = new Rig(FB, 0, 1);
    for (let i = 0; i < 240; i++) r.step(1, false, 1);
    expect(r.lastDx).toBeGreaterThanOrEqual(1.0);
    expect(r.lastDx).toBeLessThanOrEqual(1.1);
  });
  // straight, vmax, steer 0.5 for 0.4 s, then 0
  function pulse() {
    const s = mk({ speed: 1 });
    const xs: number[] = [];
    const yaws: number[] = [];
    const vxs: number[] = [];
    for (let i = 0; i < 1.6 / DT; i++) {
      stepB(s, inp(i * DT < 0.4 ? 0.5 : 0), REAL);
      xs.push(car(s).x);
      yaws.push(car(s).yaw);
      vxs.push(car(s).vx);
    }
    return { s, xs, yaws, vxs };
  }
  it('R89b a 0.5 pulse for 0.4 s shifts the car by 0.15-0.3 half-widths (spike: 0.210)', () => {
    const { s } = pulse();
    expect(car(s).x).toBeGreaterThanOrEqual(0.15);
    expect(car(s).x).toBeLessThanOrEqual(0.3);
  });
  it('R89b the pulse settles without oscillation (no sign change of vx, overshoot < 10%)', () => {
    const { s, xs, yaws, vxs } = pulse();
    const rel = Math.round(0.4 / DT);
    const peakYaw = Math.max(...yaws.map(Math.abs));
    const peakVx = Math.max(...vxs.map(Math.abs));
    let settle = NaN;
    let signChanges = 0;
    let last = 0;
    for (let i = rel; i < xs.length; i++) {
      if (Number.isNaN(settle) && Math.abs(yaws[i]!) < 0.02 * peakYaw && Math.abs(vxs[i]!) < 0.02 * peakVx)
        settle = (i - rel) * DT;
      const sg = Math.sign(vxs[i]!);
      if (sg !== 0 && last !== 0 && sg !== last && Math.abs(vxs[i]!) > 0.02 * peakVx) signChanges++;
      if (sg !== 0) last = sg;
    }
    expect(settle).toBeLessThanOrEqual(0.6);
    expect(signChanges).toBe(0);
    expect((Math.max(...xs) - car(s).x) / car(s).x).toBeLessThan(0.1);
  });
  /** 10-90% rise time of a series relative to its last value. */
  const rise = (series: number[]): number => {
    const fin = series[series.length - 1]!;
    let t10 = NaN;
    let t90 = NaN;
    for (let i = 0; i < series.length; i++) {
      const v = series[i]! / fin;
      if (Number.isNaN(t10) && v >= 0.1) t10 = i * DT;
      if (Number.isNaN(t90) && v >= 0.9) t90 = i * DT;
    }
    return t90 - t10;
  };
  it('R89b GRIP steer -> yaw 10-90% in 0.10-0.15 s (spike 0.108)', () => {
    const s = mk({ speed: 1 });
    const ys: number[] = [];
    for (let i = 0; i < 1.5 / DT; i++) {
      stepB(s, inp(0.5), REAL);
      ys.push(car(s).yaw);
    }
    const t = rise(ys);
    expect(t).toBeGreaterThanOrEqual(0.1);
    expect(t).toBeLessThanOrEqual(0.15);
  });
  it('R89b GRIP yaw -> vel 10-90% in 0.08-0.12 s (spike 0.092)', () => {
    // yaw is forced to a 0.5 step every tick, so only the yaw -> vel link is measured
    const s = mk({ speed: 1 });
    const vs: number[] = [];
    for (let i = 0; i < 1.5 / DT; i++) {
      car(s).yaw = 0.5;
      car(s).yawRate = 0;
      stepB(s, inp(0), REAL);
      car(s).yaw = 0.5;
      vs.push(car(s).vel);
    }
    const t = rise(vs);
    expect(t).toBeGreaterThanOrEqual(0.08);
    expect(t).toBeLessThanOrEqual(0.12);
  });
});

describe('R89b calibration: GRIP on constant curves at vmax', () => {
  it('R89b easy is held at steer 0.4-0.5 (spike 0.427)', () => {
    const h = gripHold(FB, C.easy);
    expect(h).toBeGreaterThanOrEqual(0.4);
    expect(h).toBeLessThanOrEqual(0.5);
  });
  it('R89b medium is held at steer 0.9-1.0, on the edge (spike 0.961)', () => {
    const h = gripHold(FB, C.medium);
    expect(h).toBeGreaterThanOrEqual(0.9);
    expect(h).toBeLessThanOrEqual(1.0);
  });
  it('R89b hard is not held even at full steer: the car runs outward', () => {
    const s = mk({ speed: 1 });
    stepN(s, 180, inp(1), FB, constTrack(C.hard)); // 1.5 s
    expect(car(s).vel).toBeLessThan(-0.05); // outward (left) on a right curve
    expect(car(s).x).toBeLessThan(-0.5);
  });
  it('R89b hold steer grows with the curve (easy < medium)', () => {
    expect(gripHold(FB, C.easy)).toBeLessThan(gripHold(FB, C.medium));
  });
});

describe('R89b calibration: GRIP forgiveness on hard and medium (spike T12)', () => {
  // x = 0, speed pinned at vmax, dx/dt (+ inward) at 0.5 / 1 / 2 / 3 s; outward = negative.
  const hardFull = gripOut(FB, C.hard, 1);
  const hardZero = gripOut(FB, C.hard, 0);
  const mediumZero = gripOut(FB, C.medium, 0);
  it('R89b hard, full steer inward: outward speed settles at 0.4-0.7 (spike 0.520) and does not grow', () => {
    expect(-hardFull[3]!).toBeGreaterThanOrEqual(0.4);
    expect(-hardFull[3]!).toBeLessThanOrEqual(0.7);
    // settled by 0.5 s (within 10%) and not growing afterwards
    expect(Math.abs(hardFull[0]! - hardFull[3]!)).toBeLessThanOrEqual(0.1 * Math.abs(hardFull[3]!));
    expect(Math.abs(hardFull[2]! - hardFull[3]!)).toBeLessThanOrEqual(0.01);
  });
  it('R89b hard, steer 0: outward speed 1.3-1.8 (spike 1.570) and does not grow', () => {
    expect(-hardZero[3]!).toBeGreaterThanOrEqual(1.3);
    expect(-hardZero[3]!).toBeLessThanOrEqual(1.8);
    expect(Math.abs(hardZero[2]! - hardZero[3]!)).toBeLessThanOrEqual(0.01);
  });
  it('R89b medium, steer 0: outward speed 0.9-1.1 (spike 1.009)', () => {
    expect(-mediumZero[3]!).toBeGreaterThanOrEqual(0.9);
    expect(-mediumZero[3]!).toBeLessThanOrEqual(1.1);
  });
  it('R89b the same cases in model A (real step) agree with model B within 0.1', () => {
    // brief: "GRIP in hard forgives like model A" (A: 0.525 / 1.575 / 1.012)
    expect(Math.abs(gripOut(FA, C.hard, 1)[3]! - hardFull[3]!)).toBeLessThan(0.1);
    expect(Math.abs(gripOut(FA, C.hard, 0)[3]! - hardZero[3]!)).toBeLessThan(0.1);
    expect(Math.abs(gripOut(FA, C.medium, 0)[3]! - mediumZero[3]!)).toBeLessThan(0.1);
  });
});

describe('R89b calibration: DRIFT on hard (spike T1, T6)', () => {
  // Hold steer and speed/angle at the car's own steady speed (free, 8 s). Lateral numbers at pinned
  // vmax (steer 0, steer 1, slope), as in the spike: see the report for the reading of "own speed".
  const hf = hold('B', C.hard, 'free');
  const hp = hold('B', C.hard, 'pinned');
  it('R89b hard: hold steer 0.70-0.85 (spike 0.772)', () => {
    expect(hf.steer).toBeGreaterThanOrEqual(0.7);
    expect(hf.steer).toBeLessThanOrEqual(0.85);
  });
  it('R89b hard: steer 0 -> outward 0.3-0.5 half-widths/s (spike 0.402, the same as model A)', () => {
    const v = lat('B', C.hard, 0);
    expect(-v).toBeGreaterThanOrEqual(0.3);
    expect(-v).toBeLessThanOrEqual(0.5);
  });
  it('R89b hard: full steer -> inward at most 0.2 (spike 0.058)', () => {
    expect(lat('B', C.hard, 1)).toBeLessThanOrEqual(0.2);
  });
  it('R89b hard: slope d(vx)/d(steer) at the hold point 0.4-0.8 (spike 0.46, model A 0.45)', () => {
    const e = 0.05;
    const slope = (lat('B', C.hard, hp.steer + e) - lat('B', C.hard, hp.steer - e)) / (2 * e);
    expect(slope).toBeGreaterThanOrEqual(0.4);
    expect(slope).toBeLessThanOrEqual(0.8);
  });
  it('R89b hard: steady speed >= 0.85 vmax (spike 0.884)', () => {
    expect(hf.speed).toBeGreaterThanOrEqual(0.85);
    expect(hf.speed).toBeLessThanOrEqual(1);
  });
  it('R89b hard: on-screen angle slip*slipDeg within 30-40 degrees (spike 34.7)', () => {
    expect(hf.slip * SLIP_DEG).toBeGreaterThanOrEqual(30);
    expect(hf.slip * SLIP_DEG).toBeLessThanOrEqual(40);
  });
  it('R89b hard: more steer moves the line inward (monotone in steer)', () => {
    expect(lat('B', C.hard, 0.25)).toBeLessThan(lat('B', C.hard, 0.55));
    expect(lat('B', C.hard, 0.55)).toBeLessThan(lat('B', C.hard, 0.85));
  });
  it('R89b hard: an extra 0.15 steer costs speed (the extra angle is not free, spike T6)', () => {
    const more = driftLat(FB, C.hard, Math.min(1, hf.steer + 0.15), null, 8);
    expect(more.speed).toBeLessThan(hf.speed);
  });
});

describe('R89b calibration: DRIFT on medium (spike T2, T6)', () => {
  const hf = hold('B', C.medium, 'free');
  it('R89b medium: hold steer 0.45-0.55 (spike 0.518)', () => {
    expect(hf.steer).toBeGreaterThanOrEqual(0.45);
    expect(hf.steer).toBeLessThanOrEqual(0.55);
  });
  it('R89b medium: steer 0 -> outward 0.2-0.35 (spike 0.258)', () => {
    const v = lat('B', C.medium, 0);
    expect(-v).toBeGreaterThanOrEqual(0.2);
    expect(-v).toBeLessThanOrEqual(0.35);
  });
  it('R89b medium: full steer -> inward 0.15-0.3 (spike 0.202)', () => {
    const v = lat('B', C.medium, 1);
    expect(v).toBeGreaterThanOrEqual(0.15);
    expect(v).toBeLessThanOrEqual(0.3);
  });
  it('R89b medium: steady speed >= 0.92 vmax (spike 0.922)', () => {
    expect(hf.speed).toBeGreaterThanOrEqual(0.92);
    expect(hf.speed).toBeLessThanOrEqual(1);
  });
  it('R89b medium: on-screen angle slip*slipDeg within 15-25 degrees (spike 23.2)', () => {
    expect(hf.slip * SLIP_DEG).toBeGreaterThanOrEqual(15);
    expect(hf.slip * SLIP_DEG).toBeLessThanOrEqual(25);
  });
});

describe('R89b calibration: DRIFT on a straight (spike T3)', () => {
  it('R89b straight: full steer -> at most 0.6 half-widths/s (spike 0.46, model A 0.45)', () => {
    const v = lat('B', 0, 1);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(0.6);
  });
  it('R89b straight: steer 0 -> at most 0.05 (spike 0.000)', () => {
    expect(Math.abs(lat('B', 0, 0))).toBeLessThanOrEqual(0.05);
  });
});

describe('R89b calibration: DRIFT entry (spike T5)', () => {
  // Setup: speed 1, 0.13 s of steer `from` in GRIP (straight), then the corner (or straight) starts and a
  // flick to steer 1 lasts 0.06 s with drift held, then the hold steer (free hold; 0.5 on the straight).
  // 300 ticks (2.5 s). Reference run = the same input with kickBase = kickGain = 0.
  const FLICKS = [
    ['weak', 0.45], // d = 0.55
    ['normal', 0], // d = 1.0
    ['strong', -1], // d = 2.0
  ] as const;
  const CASES = [
    ['straight', 0, 0.5],
    ['medium', C.medium, hold('B', C.medium, 'free').steer],
    ['hard', C.hard, hold('B', C.hard, 'free').steer],
  ] as const;
  function enter(p: CarParams, curve: number, from: number, holdSteer: number, drift: boolean) {
    const r = new Rig(p, 0, 1);
    for (let i = 0; i < Math.round(0.13 / DT); i++) r.step(from, true); // R81: history only counts inside a hold
    r.curve = curve;
    const xs: number[] = [];
    const vis: number[] = [];
    for (let i = 0; i < 300; i++) {
      r.step(i * DT < 0.06 ? 1 : holdSteer, drift);
      xs.push(r.car.x);
      vis.push(r.slip);
    }
    return { xs, vis, drifted: r.car.state === 'DRIFT' };
  }
  for (const [cn, curve, hs] of CASES) {
    for (const [fn, from] of FLICKS) {
      const a = enter(free(REAL), curve, from, hs, true);
      it(`R89b entry ${fn} flick on ${cn}: no lateral jump (<= 0.05 in 0.6 s vs the same input without the kick)`, () => {
        const ref = enter(free({ ...REAL, kickBase: 0, kickGain: 0 }), curve, from, hs, true);
        expect(a.drifted).toBe(true);
        let d = 0;
        for (let i = 0; i < Math.round(0.6 / DT); i++) d = Math.max(d, Math.abs(a.xs[i]! - ref.xs[i]!));
        expect(d).toBeLessThanOrEqual(0.05);
      });
      it(`R89b entry ${fn} flick on ${cn}: angle gets 90% in 0.15-0.45 s, overshoot <= 15%`, () => {
        const tail = a.vis.slice(180);
        const steady = tail.reduce((u, v) => u + v, 0) / tail.length;
        let t90 = NaN;
        for (let i = 0; i < a.vis.length; i++)
          if (Number.isNaN(t90) && a.vis[i]! >= 0.9 * steady) t90 = (i + 1) * DT;
        expect(steady).toBeGreaterThan(0);
        expect(t90).toBeGreaterThanOrEqual(0.15);
        expect(t90).toBeLessThanOrEqual(0.45);
        expect(Math.max(...a.vis) / steady - 1).toBeLessThanOrEqual(0.15);
      });
    }
  }
  it('R89b entry: a stronger flick builds the angle faster (angle at 0.1 s: weak < strong, straight)', () => {
    const w = enter(free(REAL), 0, 0.45, 0.5, true);
    const s = enter(free(REAL), 0, -1, 0.5, true);
    expect(s.vis[Math.round(0.1 / DT) - 1]!).toBeGreaterThan(w.vis[Math.round(0.1 / DT) - 1]!);
  });
});

describe('R89b calibration: DRIFT exit (spike T7, T13)', () => {
  // Steady DRIFT (2 s at the hold steer, pinned-vmax hold, free speed), then release. Reference = a GRIP car
  // with the same x, vel and speed and its own GRIP slip on this curve (yaw = vel + clamp(A/velGrip), yawRate = A),
  // given the same steer. Jump = max |x - x_ref| in 0.3 s.
  const CASES = [
    ['straight', 0, 0.5],
    ['medium', C.medium, hold('B', C.medium, 'pinned').steer],
    ['hard', C.hard, hold('B', C.hard, 'pinned').steer],
  ] as const;
  for (const [cn, curve, hs] of CASES) {
    for (const after of [0, hs]) {
      it(`R89b exit on ${cn} (steer after release ${after === 0 ? '0' : 'hold'}): jump <= 0.1 in 0.3 s`, () => {
        const r = new Rig(FB, curve, 1);
        r.enterDrift(1, hs);
        for (let i = 0; i < 240; i++) r.step(hs, true);
        const ref = new Rig(FB, curve, r.car.speed);
        const A = curve * (r.car.speed / FB.vmax) * FB.kYaw;
        ref.car.x = r.car.x;
        ref.car.vel = r.car.vel;
        ref.car.yaw = r.car.vel + clamp(A / FB.velGrip, -FB.slipGripMax, FB.slipGripMax);
        ref.car.yawRate = A;
        let jump = 0;
        for (let i = 0; i < Math.round(0.3 / DT); i++) {
          r.step(after, false);
          ref.step(after, false);
          jump = Math.max(jump, Math.abs(r.car.x - ref.car.x));
        }
        expect(r.car.state).toBe('GRIP');
        expect(jump).toBeLessThanOrEqual(0.1);
      });
    }
  }
  it('R89b exit mid-hard with full steer inward: carried out at most 0.9 in 1 s (spike -0.396; model A -0.511)', () => {
    const out = (name: 'A' | 'B') => {
      const p = name === 'A' ? FA : FB;
      const h = hold(name, C.hard, 'free').steer;
      const r = new Rig(p, C.hard, 1);
      r.enterDrift(1, h);
      for (let i = 0; i < 480; i++) r.step(h, true);
      const x0 = r.car.x;
      for (let i = 0; i < 120; i++) r.step(1, false);
      return r.car.x - x0;
    };
    const b = out('B');
    expect(-b).toBeLessThanOrEqual(0.9);
    expect(Math.abs(out('A') + 0.51)).toBeLessThan(0.05); // the model A reference of the brief
    expect(Math.abs(b)).toBeLessThan(1); // sanity: finite, not a runaway
  });
});

describe('R89b calibration: closeness to model A (spike T9)', () => {
  // Hard from vmax: 0.3 s straight in GRIP; at t = 0 the corner starts and the steer jumps to model A's own free hold
  // steer with drift held (a flick from 0); +0.2 on 2.0-2.5 s, -0.2 on 2.5-3.0 s; trajectories up to the release
  // at 3.0 s. The same input for both models.
  it('R89b the A-vs-B trace on the same input diverges by at most 0.15 half-widths', () => {
    const h = hold('A', C.hard, 'free').steer;
    const seq = (t: number) => (t < 2 ? h : t < 2.5 ? h + 0.2 : h - 0.2);
    const a = new Rig(FA, 0, 1);
    const b = new Rig({ ...FB, driftLead: 0 }, 0, 1); // brief: closeness is measured with driftLead = 0
    for (let i = 0; i < 30; i++) {
      a.step(0, false);
      b.step(0, false);
    }
    // R81: the hold starts on the straight at steer 0, so the flick has history of the current hold
    for (let i = 0; i < 6; i++) {
      a.step(0, true);
      b.step(0, true);
    }
    a.curve = C.hard;
    b.curve = C.hard;
    let maxD = 0;
    for (let i = 0; i < 360; i++) {
      const st = seq(i * DT);
      a.step(st, true);
      b.step(st, true);
      maxD = Math.max(maxD, Math.abs(b.car.x - a.car.x));
    }
    expect(a.car.state).toBe('DRIFT');
    expect(b.car.state).toBe('DRIFT');
    expect(maxD).toBeLessThanOrEqual(0.15);
  });
});

describe('R89b calibration: shaky steer on hard (spike T10)', () => {
  // From the steady drift on hard (6 s at the free hold steer), uniform noise +-0.1 around the hold steer, new value
  // every 0.05 s (20 Hz), 10 s: |x - x0| < 0.6. Three seeds, own LCG (no Math.random).
  for (const seed of [1, 2, 3]) {
    it(`R89b noisy steer +-0.1 at 20 Hz keeps |x| < 0.6 for 10 s on hard (seed ${seed})`, () => {
      let rng = seed * 7919;
      const rnd = (): number => {
        rng = (Math.imul(rng, 1103515245) + 12345) | 0;
        return ((rng >>> 8) & 0xffff) / 0xffff;
      };
      const h = hold('B', C.hard, 'free').steer;
      const r = new Rig(FB, C.hard, 1);
      r.enterDrift(1, h);
      for (let i = 0; i < 720; i++) r.step(h, true);
      const x0 = r.car.x;
      let noise = 0;
      let maxX = 0;
      for (let i = 0; i < 1200; i++) {
        if (i % 6 === 0) noise = (rnd() * 2 - 1) * 0.1;
        r.step(h + noise, true);
        maxX = Math.max(maxX, Math.abs(r.car.x - x0));
      }
      expect(r.car.state).toBe('DRIFT');
      expect(maxX).toBeLessThan(0.6);
    });
  }
});

describe('model B properties', () => {
  const fr: CarParams = { ...Q, xLimit: 1e9, offroadMul: 1, offroadSteerMul: 1 };
  for (const drift of [false, true]) {
    const label = drift ? 'DRIFT' : 'GRIP';
    const base = { speed: 1, ...(drift ? { state: 'DRIFT' as const, dir: 1 as const } : {}) };
    it(`on a straight with steer 0 any initial yaw/vel decays to 0 (${label})`, () => {
      for (const [yaw, vel] of [
        [0.5, -0.4],
        [-0.8, 0.3],
        [1.0, 1.0],
      ] as const) {
        const s = mk({ ...base, yaw, vel });
        stepN(s, 720, inp(0, drift), fr); // 6 s
        expect(Math.abs(car(s).yaw)).toBeLessThan(1e-3);
        expect(Math.abs(car(s).vel)).toBeLessThan(1e-3);
        expect(Math.abs(car(s).yawRate)).toBeLessThan(1e-2);
      }
    });
  }
  it('GRIP: steady yaw on a straight is steer*Y*f/al = 0.3*15.75/15 = 0.315 (mirrored for -0.3)', () => {
    const s = mk({ speed: 1 });
    stepN(s, 720, inp(0.3), fr);
    expect(car(s).yaw).toBeCloseTo(0.315, 3);
    const m = mk({ speed: 1 });
    stepN(m, 720, inp(-0.3), fr);
    expect(car(m).yaw).toBeCloseTo(-0.315, 3);
  });
  it('DRIFT: steady slip on a straight is dir*slipFull*steer*dir = 2.64*0.3 = 0.792 (both directions)', () => {
    for (const dir of [1, -1] as const) {
      const s = mk({ speed: 1, state: 'DRIFT', dir });
      stepN(s, 720, inp(0.3 * dir, true), fr);
      expect(slipOf(car(s))).toBeCloseTo(0.792 * dir, 3);
    }
  });
});

/** Deterministic scripted input: flicks, ramps, releases (no RNG). */
function scripted(i: number): InputFrame {
  const steer = Math.max(-1, Math.min(1, 1.3 * Math.sin(i / 17) + 0.6 * Math.sin(i / 5)));
  return { steer, brake: i % 700 > 650, drift: i % 300 > 60 };
}
const wavy = (sign: number): Track => {
  const segments = [];
  for (let i = 0; i < 3000; i++) segments.push({ curve: sign * 6 * Math.sin(i / 60) });
  return { segments };
};
function playB(n: number, sign = 1): RaceState {
  const s = createRace(3, 1);
  car(s).speed = 0.8;
  const t = wavy(sign);
  for (let i = 0; i < n; i++) {
    const f = scripted(i);
    step(s, [{ steer: f.steer * sign, brake: f.brake, drift: f.drift }], t, [PB]);
  }
  return s;
}

describe('model B determinism, symmetry, bounds, serialization (R2, R3)', () => {
  it('R2 same inputs twice give an identical state (steerHist and carry included)', () => {
    expect(JSON.stringify(playB(2000))).toBe(JSON.stringify(playB(2000)));
  });
  it('R3 JSON round trip mid-run continues identically', () => {
    const t = wavy(1);
    const a = playB(500);
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    for (let i = 500; i < 1500; i++) {
      const f = scripted(i);
      step(a, [f], t, [PB]);
      step(b, [f], t, [PB]);
    }
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it('the script really drifts and carries (guard against vacuous symmetry tests)', () => {
    const s = createRace(3, 1);
    car(s).speed = 0.8;
    let drifts = 0;
    let carried = 0;
    for (let i = 0; i < 2000; i++) {
      step(s, [scripted(i)], wavy(1), [PB]);
      if (car(s).state === 'DRIFT') drifts++;
      if (Math.abs(car(s).carry) > 0.01) carried++;
    }
    expect(drifts).toBeGreaterThan(100);
    expect(drifts).toBeLessThan(1900);
    expect(carried).toBeGreaterThan(10);
  });
  it('left/right symmetry: mirrored track and steer give the mirrored state', () => {
    for (const n of [300, 1000, 2000]) {
      const r = car(playB(n, 1));
      const l = car(playB(n, -1));
      for (const k of ['x', 'vx', 'yaw', 'yawRate', 'vel', 'carry', 'steer', 'angle', 'heading'] as const)
        expect(l[k]).toBeCloseTo(-r[k], 9);
      expect(l.speed).toBeCloseTo(r.speed, 9);
      expect(l.z).toBeCloseTo(r.z, 9);
      expect(l.state).toBe(r.state);
      expect(l.dir + r.dir).toBe(0);
    }
  });
  it('bounds: everything finite, |x| <= xLimit, 0 <= speed <= vmax, |angle| <= 1, DRIFT keeps slip*dir >= 0', () => {
    const s = createRace(3, 1);
    car(s).speed = 0.8;
    const t = wavy(1);
    for (let i = 0; i < 4000; i++) {
      step(s, [scripted(i)], t, [PB]);
      const c = car(s);
      for (const k of ['x', 'z', 'speed', 'vx', 'yaw', 'yawRate', 'vel', 'angle', 'carry'] as const)
        expect(Number.isFinite(c[k])).toBe(true);
      expect(Math.abs(c.x)).toBeLessThanOrEqual(PB.xLimit + 1e-12);
      expect(c.speed).toBeGreaterThanOrEqual(0);
      expect(c.speed).toBeLessThanOrEqual(PB.vmax + 1e-12);
      expect(Math.abs(c.angle)).toBeLessThanOrEqual(1 + 1e-9);
      if (c.state === 'DRIFT') expect((c.yaw - c.vel) * c.dir).toBeGreaterThanOrEqual(-1e-9);
      expect(c.steerHist).toHaveLength(STEER_HIST);
    }
  });
});

describe('golden example in model B (brief section 5)', () => {
  it('straight track, 120 steps, steer 0: speed 0.22, z 6.655, x = vx = heading = 0', () => {
    for (const p of [PB, REAL]) {
      const s = createRace(1, 1);
      run(s, 120, () => [GAS], [p], STRAIGHT);
      const c = car(s);
      // z = 0.22 * (120*121/2) / 120^2 * 60 = 0.22 * 7260 / 14400 * 60 = 6.655
      expect(Math.abs(c.speed - 0.22)).toBeLessThan(1e-9);
      expect(Math.abs(c.z - 6.655)).toBeLessThan(1e-6);
      expect(Math.abs(c.x)).toBe(0);
      expect(Math.abs(c.vx)).toBe(0);
      expect(Math.abs(c.heading)).toBe(0);
      expect(s.tick).toBe(120);
    }
  });
});

describe('model B createRace fields', () => {
  it('new fields start at 0 and steerHist is a preallocated zero array of STEER_HIST', () => {
    const c = createRace(1, 1).cars[0]!;
    expect(c.yaw).toBe(0);
    expect(c.yawRate).toBe(0);
    expect(c.vel).toBe(0);
    expect(c.carry).toBe(0);
    expect(c.steerHist).toEqual(new Array<number>(STEER_HIST).fill(0));
    expect(c.steerHistHead).toBe(0);
    expect(c.steerHistCount).toBe(0);
  });
});

describe('R89b calibration: agility (lane = 0.25 half-widths, targets named in advance)', () => {
  const LANE = 0.25;
  /** Steer moves toward `target` at 1/rampS per second, never past it. */
  const approach = (cur: number, target: number, rampS: number): number => {
    const d = DT / rampS;
    return cur < target ? Math.min(target, cur + d) : Math.max(target, cur - d);
  };

  it('R89b straight, smooth steer 0 -> 1 in 250 ms (no drift): one lane in at most 0.46 s', () => {
    const r = new Rig(FB, 0, 1);
    let st = 0;
    let t1 = NaN;
    for (let i = 1; i <= 360 && Number.isNaN(t1); i++) {
      st = approach(st, 1, 0.25);
      r.step(st, false, 1);
      if (r.car.x >= LANE) t1 = i * DT;
    }
    expect(r.car.state).toBe('GRIP');
    expect(t1).toBeLessThanOrEqual(0.46);
  });

  /** Straight, finger held at steer 0 (history of the hold), then steer 0 -> 1 in 80 ms. */
  function sharp(rampBack: boolean) {
    const r = new Rig(FB, 0, 1);
    for (let i = 0; i < 36; i++) r.step(0, true); // 0.3 s of hold at steer 0, no flick
    let st = 0;
    let t1 = NaN;
    let drifted = false;
    let xStop = NaN;
    let maxAfter = -Infinity;
    for (let i = 1; i <= 480; i++) {
      const back = !Number.isNaN(t1) && rampBack;
      st = approach(st, back ? 0 : 1, 0.08);
      r.step(st, true);
      if (r.car.state === 'DRIFT') drifted = true;
      if (Number.isNaN(t1) && r.car.x >= LANE) t1 = i * DT;
      if (back) {
        if (Number.isNaN(xStop) && st === 0) xStop = r.car.x;
        if (!Number.isNaN(xStop)) maxAfter = Math.max(maxAfter, r.car.x);
      }
      if (!rampBack && !Number.isNaN(t1)) break;
    }
    return { t1, drifted, coast: maxAfter - xStop };
  }
  it('R89b straight, sharp steer 0 -> 1 in 80 ms with the finger held (becomes a drift): one lane in at most 0.45 s', () => {
    const m = sharp(false);
    expect(m.drifted).toBe(true);
    expect(m.t1).toBeLessThanOrEqual(0.45);
  });
  it('R89b the same, finger returned to the centre (steer back to 0 in 80 ms, finger kept): coasts at most 0.06 further', () => {
    const m = sharp(true);
    expect(m.drifted).toBe(true);
    expect(Number.isNaN(m.coast)).toBe(false);
    expect(m.coast).toBeLessThanOrEqual(0.06);
  });

  it('R89b steady DRIFT on hard, steer 0.5 outward from the hold steer: one lane outward in at most 1.0 s', () => {
    const h = hold('B', C.hard, 'free').steer;
    const r = new Rig(FB, C.hard, 1);
    r.enterDrift(1, h);
    for (let i = 0; i < 720; i++) r.step(h, true); // 6 s to the own steady state
    const x0 = r.car.x;
    let t1 = NaN;
    for (let i = 1; i <= 360 && Number.isNaN(t1); i++) {
      r.step(h - 0.5, true); // outward = against dir (+1 is inward, +x)
      if (x0 - r.car.x >= LANE) t1 = i * DT;
    }
    expect(r.car.state).toBe('DRIFT');
    expect(t1).toBeLessThanOrEqual(1.0);
  });
});

// R84 revision (variant H, docs/research/drift-band-spike.md): a drift against the turn with the finger
// fully toward the turn must leave the road no later than GRIP with steer 0 on the same corner + 10%.
describe('R84 criterion: drift against the turn leaves the road (driftCounter 0, wrongPush 0.13)', () => {
  const REVISED: CarParams = { ...FB, driftCounter: 0, wrongPush: 0.13 };
  const LIMIT = 20; // seconds searched

  /** Seconds until |x| > 1 (Infinity if never). Speed pinned at vmax as in the spike. */
  function leave(r: Rig, steer: number, drift: boolean): number {
    for (let i = 1; i <= LIMIT / DT; i++) {
      r.step(steer, drift, 1);
      if (Math.abs(r.car.x) > 1) return i * DT;
    }
    return Infinity;
  }
  /** Steady drift to side dir on a straight (finger toward dir, 2 s), then the corner turns to -dir. */
  function driftIntoCorner(p: CarParams, dir: 1 | -1, mag: number): Rig {
    const r = new Rig(p, 0, 1);
    r.enterDrift(dir, dir * 0.5);
    for (let i = 0; i < 240; i++) r.step(dir * 0.5, true, 1);
    r.car.x = 0;
    r.curve = -dir * mag;
    return r;
  }
  const criterion = (p: CarParams, dir: 1 | -1, name: 'medium' | 'hard') => {
    const tDrift = leave(driftIntoCorner(p, dir, C[name]), -dir, true);
    const tGrip = leave(new Rig(p, -dir * C[name], 1), 0, false);
    expect(tGrip).toBeLessThan(Infinity); // the reference itself runs off
    expect(tDrift).toBeLessThanOrEqual(tGrip * 1.1);
  };
  /** Outward speed (half-widths/s) over 2 s after 1 s of settling; the corner turns to -dir, so outside is the dir side. */
  const easyOut = (p: CarParams, dir: 1 | -1): number => {
    const r = driftIntoCorner(p, dir, C.easy);
    for (let i = 0; i < 120; i++) r.step(-dir, true, 1);
    const x1 = r.car.x;
    for (let i = 0; i < 240; i++) r.step(-dir, true, 1);
    return ((r.car.x - x1) * dir) / 2;
  };

  for (const name of ['medium', 'hard'] as const) {
    it(`left drift into a right ${name} corner, finger fully right: off the road no later than GRIP steer 0 + 10%`, () => {
      criterion(REVISED, -1, name);
    });
    it(`right drift into a left ${name} corner (mirror): off the road no later than GRIP steer 0 + 10%`, () => {
      criterion(REVISED, 1, name);
    });
  }
  it('left drift into a right easy corner, finger fully right: drifts outward at least 0.3 half-widths/s', () => {
    expect(easyOut(REVISED, -1)).toBeGreaterThanOrEqual(0.3);
  });
  it('right drift into a left easy corner (mirror): drifts outward at least 0.3 half-widths/s', () => {
    expect(easyOut(REVISED, 1)).toBeGreaterThanOrEqual(0.3);
  });
  it('mirror: left and right cases agree in time to leave (hard)', () => {
    const a = leave(driftIntoCorner(REVISED, -1, C.hard), 1, true);
    const b = leave(driftIntoCorner(REVISED, 1, C.hard), -1, true);
    expect(Math.abs(a - b)).toBeLessThan(1e-9);
  });
  it('base.json itself has driftCounter 0, wrongPush 0.13 and passes the criterion', () => {
    expect(baseCar.driftCounter).toBe(0);
    expect(baseCar.wrongPush).toBeCloseTo(0.13, 12);
    for (const dir of [-1, 1] as const) {
      for (const name of ['medium', 'hard'] as const) criterion(FB, dir, name);
      expect(easyOut(FB, dir)).toBeGreaterThanOrEqual(0.3);
    }
  });
});

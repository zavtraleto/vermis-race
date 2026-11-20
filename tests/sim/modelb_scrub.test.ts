// H17 / R86b: GRIP speed scrub on a turn that needs more than scrubStart of the grip limit.
// Written from docs/brief.md R86b, not from the implementation. New CarParams fields (gripScrub,
// scrubStart, scrubRate) are passed explicitly here and not yet in the CarParams type, hence casts.
//
// Hand formulas (PB: vmax 1, yawRateMax 15.75, yawAlign 15, velGrip 22, kYaw 2):
//   A      = curve * sp * kYaw                       (R83, sp = speed / vmax at the start of the step)
//   gripA  = yawRateMax / (1 + yawAlign/velGrip) = 15.75 / (1 + 0.681818...) = 9.36486486...
//   need   = |A| / gripA
//   loss   = scrubRate * (need - scrubStart) * vmax * DT     only for need > scrubStart, speed >= 0
// With accel 0 and slipDrag 0 (Q) speed is otherwise constant, so loss = speed_off - speed_on.
import { describe, expect, it } from 'vitest';
import base from '../../src/data/cars/base.json';
import hypotheses from '../../src/data/hypotheses.json';
import { DT } from '../../src/sim/constants';
import type { Car, CarParams } from '../../src/sim/types';
import { PB, Q, STRAIGHT, car, constTrack, inp, mk, stepB, stepN } from './modelb_helpers';

const H = (p: CarParams, over: Record<string, number>): CarParams =>
  ({ ...p, ...over }) as CarParams;
const SCRUB = H(Q, { gripScrub: 1, scrubStart: 0.8, scrubRate: 0.6 });
const OFF = (p: CarParams): CarParams => H(p, { gripScrub: 0 });
const mkS = (over: Record<string, unknown>) => mk(over as Partial<Car>);

const gripA = (p: CarParams): number => p.yawRateMax / (1 + p.yawAlign / p.velGrip);
/** Constant curve that makes `need` exactly the given value at speed ratio sp. */
const curveFor = (need: number, sp: number, p: CarParams): number =>
  (need * gripA(p)) / (sp * p.kYaw);

/** Speed after one GRIP step at constant curve, zero steer. */
function speedAfter(p: CarParams, curve: number, speed: number, steer = 0): number {
  const s = mkS({ speed });
  stepB(s, inp(steer), p, constTrack(curve));
  return car(s).speed;
}
/** Per-step speed loss caused by R86b alone. */
const scrubLoss = (p: CarParams, curve: number, speed: number, steer = 0): number =>
  speedAfter(OFF(p), curve, speed, steer) - speedAfter(p, curve, speed, steer);
const expected = (p: CarParams, need: number): number => {
  const q = p as unknown as { scrubRate: number; scrubStart: number };
  return Math.max(0, q.scrubRate * (need - q.scrubStart)) * p.vmax * DT;
};

describe('R86b data (H17)', () => {
  it('base.json has gripScrub 1, scrubStart 0.8, scrubRate 0.6', () => {
    const b = base as unknown as Record<string, number>;
    expect(b.gripScrub).toBe(1);
    expect(b.scrubStart).toBe(0.8);
    expect(b.scrubRate).toBe(0.6);
  });
  it('hypotheses.json has H17_gripScrub "B"', () => {
    expect((hypotheses as Record<string, string>).H17_gripScrub).toBe('B');
  });
});

describe('R86b gripScrub off (0): identical to the rule-less step', () => {
  it('no loss at need 1.5, speed stays exactly constant (Q: accel 0, slipDrag 0)', () => {
    const p = OFF(SCRUB);
    expect(speedAfter(p, curveFor(1.5, 0.9, p), 0.9)).toBe(0.9);
  });
  it('whole state identical for any scrubStart/scrubRate while gripScrub is 0 (300 ticks, real accel)', () => {
    const a = H(PB, { gripScrub: 0, scrubStart: 0, scrubRate: 50 });
    const b = H(PB, { gripScrub: 0, scrubStart: 0.8, scrubRate: 0.6 });
    const sa = mkS({ speed: 0.9 });
    const sb = mkS({ speed: 0.9 });
    const tr = constTrack(curveFor(1.4, 0.9, PB));
    for (let i = 0; i < 300; i++) {
      stepB(sa, inp(Math.sin(i / 20)), a, tr);
      stepB(sb, inp(Math.sin(i / 20)), b, tr);
    }
    expect(sa).toEqual(sb);
  });
});

describe('R86b no loss while need <= scrubStart', () => {
  it.each([0, 0.3, 0.79, 0.8])(
    'need %f: speed unchanged (tolerance 1e-12 for the boundary)',
    (need) => {
      const sp = 0.9;
      expect(speedAfter(SCRUB, curveFor(need, sp, SCRUB), sp)).toBeCloseTo(sp, 12);
    },
  );
  it('straight road: nothing is lost', () => {
    const s = mkS({ speed: 0.9 });
    stepN(s, 50, inp(0), SCRUB, STRAIGHT);
    expect(car(s).speed).toBe(0.9);
  });
});

describe('R86b loss for need > scrubStart', () => {
  // need 1.0: 0.6 * (1.0 - 0.8) * 1 * DT = 0.12 * DT = 0.002 (DT = 1/60)
  // need 1.5: 0.6 * 0.7 * DT = 0.42 * DT
  it.each([0.9, 1.0, 1.5, 2.2])(
    'need %f: loss = scrubRate*(need-scrubStart)*vmax*DT, 1e-12',
    (need) => {
      const sp = 0.9;
      const loss = scrubLoss(SCRUB, curveFor(need, sp, SCRUB), sp);
      expect(loss).toBeCloseTo(expected(SCRUB, need), 12);
      expect(loss).toBeGreaterThan(0);
    },
  );
  it('hand numbers: need 1.0, loss 0.12*DT', () => {
    const sp = 0.9;
    expect(scrubLoss(SCRUB, curveFor(1.0, sp, SCRUB), sp)).toBeCloseTo(0.12 * DT, 12);
  });
  it('other scrubStart / scrubRate: start 0.5, rate 1.2, need 1.1 -> 1.2*0.6*DT', () => {
    const p = H(Q, { gripScrub: 1, scrubStart: 0.5, scrubRate: 1.2 });
    const sp = 0.7;
    expect(scrubLoss(p, curveFor(1.1, sp, p), sp)).toBeCloseTo(1.2 * 0.6 * DT, 12);
  });
  it('is monotonic in need (strictly more loss for a tighter turn)', () => {
    const sp = 0.9;
    const losses = [0.85, 1, 1.2, 1.6, 2.4].map((n) =>
      scrubLoss(SCRUB, curveFor(n, sp, SCRUB), sp),
    );
    for (let i = 1; i < losses.length; i++) expect(losses[i]!).toBeGreaterThan(losses[i - 1]!);
  });
  it('is added on top of the R86 terms: slipDrag and accel (difference on/off is still the formula)', () => {
    // PB has accel 0.22 and slipDrag 0.058; carry gives visible slip so slipDrag acts too.
    const on = H(PB, { gripScrub: 1, scrubStart: 0.8, scrubRate: 0.6 });
    const sp = 0.9;
    const curve = curveFor(1.3, sp, on);
    const run = (p: CarParams): number => {
      const s = mkS({ speed: sp, carry: 0.5 });
      stepB(s, inp(0.3), p, constTrack(curve));
      return car(s).speed;
    };
    const slipDragOnly = run(OFF(on));
    expect(slipDragOnly).not.toBe(sp); // the other R86 terms really act in this setup
    expect(slipDragOnly - run(on)).toBeCloseTo(expected(on, 1.3), 12);
  });
  it('never below 0', () => {
    const p = H(Q, { gripScrub: 1, scrubStart: 0.8, scrubRate: 100 });
    // speed 0.01: A = 5.2*0.01*2, huge curve 1000 -> need = 1000*0.01*2/9.36 = 2.14; loss 100*1.34*DT >> 0.01
    const s = mkS({ speed: 0.01 });
    stepN(s, 5, inp(0), p, constTrack(1000));
    expect(car(s).speed).toBeGreaterThanOrEqual(0);
    expect(car(s).speed).toBe(0);
  });
});

describe('R86b symmetry and scale', () => {
  it('left and right turns lose exactly the same speed', () => {
    for (const need of [0.9, 1.4, 2]) {
      const c = curveFor(need, 0.9, SCRUB);
      expect(speedAfter(SCRUB, -c, 0.9, 0.5)).toBeCloseTo(speedAfter(SCRUB, c, 0.9, -0.5), 14);
      expect(speedAfter(SCRUB, c, 0.9)).toBeCloseTo(speedAfter(SCRUB, -c, 0.9), 14);
    }
  });
  it('scales with vmax: same sp and need, vmax 2 loses twice as much', () => {
    const p2 = H(SCRUB, { vmax: 2 });
    const c = curveFor(1.4, 0.9, SCRUB);
    const l1 = scrubLoss(SCRUB, c, 0.9);
    const l2 = scrubLoss(p2, c, 1.8);
    expect(l2).toBeCloseTo(2 * l1, 12);
    expect(l2).toBeCloseTo(0.6 * 0.6 * 2 * DT, 12); // 0.6*(1.4-0.8)*vmax*DT
  });
});

describe('R86b does not act in DRIFT or in a crash', () => {
  it('DRIFT: identical speed with gripScrub on and off (10 ticks, tight road)', () => {
    const c = curveFor(2, 0.9, SCRUB);
    const mkD = () => mkS({ state: 'DRIFT', dir: 1, speed: 0.9, yaw: 0.6, vel: 0, carry: 0 });
    const a = mkD();
    const b = mkD();
    for (let i = 0; i < 10; i++) {
      stepB(a, inp(0.4, true), SCRUB, constTrack(c));
      stepB(b, inp(0.4, true), OFF(SCRUB), constTrack(c));
      expect(car(a).state).toBe('DRIFT');
      expect(car(a).speed).toBe(car(b).speed);
    }
  });
  it('crash: identical state with gripScrub on and off', () => {
    const c = curveFor(2, 0.9, SCRUB);
    const over = { crashTicks: 40, crashSpeed0: 0.9, crashX0: 0.5, x: 0.5, speed: 0.9 };
    const a = mkS(over);
    const b = mkS(over);
    for (let i = 0; i < 10; i++) {
      stepB(a, inp(0, false), H(SCRUB, { crashTime: 1 }), constTrack(c));
      stepB(b, inp(0, false), H(OFF(SCRUB), { crashTime: 1 }), constTrack(c));
    }
    expect(car(a).crashTicks).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });
});

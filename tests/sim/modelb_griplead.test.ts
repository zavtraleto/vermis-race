// R85b GRIP lead: in GRIP vx += gripLead*(vStar - vel)*sp*latScale,
// vStar = (steer*yawRateMax*f - A)/yawAlign - clamp(A/velGrip, -slipGripMax, slipGripMax), f and A from R83
// (A = curve*sp*kYaw, f = min(1, sp/yawFullSpeed)). Not fed back into vel/yaw; not in DRIFT nor in a crash.
// Explicit params (Q: accel 0, slipDrag 0, H17/H18 off) so speed is constant and hand-computable.
// Q numbers used below: yawRateMax 15.75, yawAlign 15, yawResponse 60, velGrip 22, slipGripMax 0.75,
// slipGripLimit 0.8, kYaw 2, yawFullSpeed 0.3, DT = 1/120. All cases stay on the road (|x| <= 1).
import { describe, expect, it } from 'vitest';
import base from '../../src/data/cars/base.json';
import { DT } from '../../src/sim/constants';
import type { CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { PB, Q, STRAIGHT, car, constTrack, inp, mk, slipOf, stepB } from './modelb_helpers';

const L = 0.9;
const SP = 0.5;
const LS = 1.3;
// Spread from variables: `gripLead` may not exist in CarParams yet.
const lead = (l: number) => ({ gripLead: l });
const OPEN: CarParams = {
  ...Q,
  latScale: LS,
  xLimit: 1e9,
  offroadMul: 1,
  offroadSteerMul: 1,
  offroadVelMul: 1,
};
const WITH: CarParams = { ...OPEN, ...lead(L) };
const NONE: CarParams = { ...OPEN, ...lead(0) };
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** vStar of R85b from the brief formula (on road). */
function vStar(p: CarParams, steer: number, curve: number, sp: number): number {
  const A = curve * sp * p.kYaw;
  const f = Math.min(1, sp / p.yawFullSpeed);
  return (
    (steer * p.yawRateMax * f - A) / p.yawAlign -
    clamp(A / p.velGrip, -p.slipGripMax, p.slipGripMax)
  );
}

/** Scripted wobbly steer, GRIP only (drift never held). */
const wobble = (i: number, sign = 1): InputFrame => ({
  steer: sign * clamp(1.2 * Math.sin(i / 23) + 0.5 * Math.sin(i / 7), -1, 1),
  brake: false,
  drift: false,
});

describe('R85b GRIP lead: hand-computed first tick from rest (straight, sp 0.5)', () => {
  for (const s of [1, -1] as const) {
    it(`steer ${s}: vx = (vel + 0.9*(1.05*s - vel))*0.5*1.3, x = vx*DT`, () => {
      const a = mk({ speed: SP });
      const b = mk({ speed: SP });
      stepB(a, inp(s), WITH);
      stepB(b, inp(s), NONE);
      // R83 GRIP, A = 0, f = min(1, 0.5/0.3) = 1:
      //   chase = 1 - exp(-60/120) = 0.39346934
      //   yawRate = s*15.75*0.39346934 = s*6.19714211; yaw = yawRate/120 = s*0.05164285
      // R84 GRIP: vel = 22*clamp(yaw, +-0.75)/120 = s*0.00946786 (yaw - vel = 0.042 < slipGripLimit 0.8)
      // R85b: vStar = s*15.75*1/15 - 0 = s*1.05
      //   vx = (s*0.00946786 + 0.9*(s*1.05 - s*0.00946786))*0.65 = s*0.94594679*0.65 = s*0.61486541
      //   x  = vx/120 = s*0.00512388
      const yawRate = s * 15.75 * (1 - Math.exp(-0.5));
      const vel = 22 * (yawRate * DT) * DT;
      expect(car(a).vel).toBeCloseTo(vel, 12);
      expect(car(a).vel).toBeCloseTo(s * 0.00946786, 7);
      expect(car(a).vx).toBeCloseTo((vel + L * (s * 1.05 - vel)) * SP * LS, 12);
      expect(car(a).vx).toBeCloseTo(s * 0.61486541, 7);
      expect(car(a).x).toBeCloseTo(s * 0.00512388, 7);
      // gripLead 0: vx = vel*sp*latScale = s*0.00946786*0.65 = s*0.00615411 (today's rule)
      expect(car(b).vx).toBeCloseTo(s * 0.00615411, 7);
      expect(car(a).vel).toBe(car(b).vel);
      expect(car(a).yaw).toBe(car(b).yaw);
      expect(car(a).yawRate).toBe(car(b).yawRate);
    });
  }
});

describe('R85b GRIP lead: exact term on curves, low speed and the clamp, vs gripLead 0', () => {
  // [curve, steer, sp, vStar by hand]
  const CASES: [number, number, number, number][] = [
    // A = 2*0.5*2 = 2, f = 1: (0.6*15.75 - 2)/15 - 2/22 = 0.49666667 - 0.09090909 = 0.40575758
    [2, 0.6, 0.5, 0.40575758],
    // A = 20*0.5*2 = 20, A/velGrip = 0.909 -> clamp 0.75: (15.75 - 20)/15 - 0.75 = -1.03333333
    [20, 1, 0.5, -1.03333333],
    // A = 2*0.15*2 = 0.6, f = 0.15/0.3 = 0.5: (15.75*0.5 - 0.6)/15 - 0.6/22 = 0.485 - 0.02727273 = 0.45772727
    [2, 1, 0.15, 0.45772727],
    // A = -2*0.5*2 = -2, steer 0: (0 + 2)/15 + 2/22 = 0.13333333 + 0.09090909 = 0.22424242
    [-2, 0, 0.5, 0.22424242],
  ];
  for (const sign of [1, -1] as const) {
    for (const [curve, steer, sp, want] of CASES) {
      it(`mirror ${sign}, curve ${curve}, steer ${steer}, sp ${sp}: x diff = 0.9*(vStar - vel)*sp*1.3*DT`, () => {
        const start = { speed: sp, vel: sign * 0.1, yaw: sign * 0.15, yawRate: sign * 0.3 };
        const a = mk(start);
        const b = mk(start);
        const t: Track = constTrack(sign * curve);
        stepB(a, inp(sign * steer), WITH, t);
        stepB(b, inp(sign * steer), NONE, t);
        const vs = vStar(WITH, sign * steer, sign * curve, sp);
        expect(vs).toBeCloseTo(sign * want, 7);
        const c = car(a);
        expect(c.state).toBe('GRIP');
        expect(c.vel).toBe(car(b).vel); // the lead is not fed back
        expect(c.yaw).toBe(car(b).yaw);
        expect(c.yawRate).toBe(car(b).yawRate);
        expect(c.vx).toBeCloseTo((c.vel + L * (vs - c.vel)) * sp * LS, 12);
        expect(car(b).vx).toBeCloseTo(car(b).vel * sp * LS, 12);
        expect(c.x).toBeCloseTo(c.vx * DT, 12); // x started at 0
        expect(c.x - car(b).x).toBeCloseTo(L * (vs - c.vel) * sp * LS * DT, 12);
      });
    }
  }
  it('linear in gripLead: the x shift for 1.8 is twice the one for 0.9', () => {
    const run = (l: number): number => {
      const s = mk({ speed: SP, vel: 0.1, yaw: 0.15 });
      stepB(s, inp(0.7), { ...OPEN, ...lead(l) }, constTrack(1));
      return car(s).x;
    };
    const x0 = run(0);
    expect(run(0.9) - x0).not.toBeCloseTo(0, 6);
    expect(run(1.8) - x0).toBeCloseTo(2 * (run(0.9) - x0), 12);
  });
});

describe('R85b GRIP lead: gripLead 0 is the rule of today', () => {
  it('every GRIP tick of a scripted run moves x by vel*sp*latScale*DT (vx = vel*sp*latScale)', () => {
    const s = mk({ speed: SP });
    for (let i = 0; i < 1200; i++) {
      const x0 = car(s).x;
      stepB(s, wobble(i), NONE, constTrack(1.5));
      expect(car(s).state).toBe('GRIP');
      expect(car(s).vx).toBeCloseTo(car(s).vel * SP * LS, 12);
      expect(car(s).x - x0).toBeCloseTo(car(s).vel * SP * LS * DT, 12);
    }
  });
});

describe('R85b GRIP lead: no feedback into the body', () => {
  // PB keeps accel and slipDrag on: speed varies, but identically with and without the lead.
  const P = {
    ...PB,
    latScale: LS,
    xLimit: 1e9,
    offroadMul: 1,
    offroadSteerMul: 1,
    offroadVelMul: 1,
  };
  it('vel, yaw, yawRate, carry, speed, angle identical over 5 s; only x (and vx) differ', () => {
    const a = mk({ speed: SP });
    const b = mk({ speed: SP });
    const t = constTrack(2);
    for (let i = 0; i < 600; i++) {
      stepB(a, wobble(i), { ...P, ...lead(L) }, t);
      stepB(b, wobble(i), { ...P, ...lead(0) }, t);
      for (const k of ['vel', 'yaw', 'yawRate', 'carry', 'speed', 'angle', 'z'] as const)
        expect(car(a)[k]).toBe(car(b)[k]);
      expect(car(a).state).toBe('GRIP');
    }
    expect(car(a).x).not.toBe(car(b).x);
  });
});

describe('R85b GRIP lead: not applied in DRIFT nor in a crash', () => {
  it('DRIFT (both dirs, curved road): the whole state is identical with gripLead 0.9 and 0', () => {
    for (const dir of [1, -1] as const) {
      const mkD = (): RaceState =>
        mk({ speed: SP, state: 'DRIFT', dir, driftHeld: true, vel: dir * 0.1, yaw: dir * 0.6 });
      const a = mkD();
      const b = mkD();
      const t = constTrack(dir * 3);
      for (let i = 0; i < 240; i++) {
        const f = inp(dir * clamp(0.6 + 0.4 * Math.sin(i / 11), -1, 1), true);
        stepB(a, f, WITH, t);
        stepB(b, f, NONE, t);
        expect(car(a).state).toBe('DRIFT');
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }
      expect(slipOf(car(a)) * dir).toBeGreaterThan(0);
    }
  });
  it('crash (R48): every crash tick is identical with gripLead 0.9 and 0, steer held', () => {
    const n = Math.round(Q.crashTime / DT);
    expect(n).toBeGreaterThan(1);
    for (const side of [1, -1] as const) {
      const mkC = (): RaceState =>
        mk({ speed: SP, x: side * 1.3, crashTicks: n, crashSpeed0: SP, crashX0: side * 1.3 });
      const a = mkC();
      const b = mkC();
      for (let i = 0; i < n; i++) {
        stepB(a, inp(side), WITH, constTrack(2));
        stepB(b, inp(side), NONE, constTrack(2));
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }
    }
  });
});

describe('R85b GRIP lead: wall R18 still holds', () => {
  const WALL: CarParams = { ...Q, latScale: LS, offroadMul: 1, ...lead(L) }; // xLimit 1.5
  it('full steer at the wall: x stays at xLimit, never beyond (both sides)', () => {
    for (const side of [1, -1] as const) {
      const s = mk({ speed: SP, x: side * (WALL.xLimit - 1e-4), vel: side * 0.5, yaw: side * 0.5 });
      for (let i = 0; i < 240; i++) {
        stepB(s, inp(side), WALL);
        expect(Math.abs(car(s).x)).toBeLessThanOrEqual(WALL.xLimit + 1e-12);
      }
      expect(car(s).x * side).toBeCloseTo(WALL.xLimit, 9);
    }
  });
});

describe('R85b GRIP lead: properties', () => {
  const play = (sign: number, p: CarParams = WITH): RaceState => {
    const s = mk({ speed: SP });
    const t = constTrack(sign * 2);
    for (let i = 0; i < 900; i++) stepB(s, wobble(i, sign), p, t);
    return s;
  };
  it('left/right mirror: mirrored input and track give the mirrored state', () => {
    const r = car(play(1));
    const l = car(play(-1));
    for (const k of ['x', 'vx', 'yaw', 'yawRate', 'vel', 'carry'] as const)
      expect(l[k]).toBeCloseTo(-r[k], 9);
    expect(l.state).toBe(r.state);
    expect(r.x).not.toBeCloseTo(car(play(1, NONE)).x, 6); // the lead is really on in this run
  });
  it('deterministic and serializable: same run twice is identical; JSON round-trip mid-run continues identically', () => {
    expect(JSON.stringify(play(1))).toBe(JSON.stringify(play(1)));
    const a = mk({ speed: SP });
    const t = constTrack(2);
    for (let i = 0; i < 300; i++) stepB(a, wobble(i), WITH, t);
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    for (let i = 300; i < 600; i++) {
      stepB(a, wobble(i), WITH, t);
      stepB(b, wobble(i), WITH, t);
    }
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it('the lead is bounded: |vx| <= (|vel| + L*|vStar - vel|)*sp*latScale every tick (straight)', () => {
    const s = mk({ speed: SP });
    for (let i = 0; i < 600; i++) {
      const f = wobble(i);
      stepB(s, f, WITH, STRAIGHT);
      const c = car(s);
      const vs = vStar(WITH, f.steer, 0, SP);
      expect(Math.abs(c.vx)).toBeLessThanOrEqual(
        (Math.abs(c.vel) + L * Math.abs(vs - c.vel)) * SP * LS + 1e-12,
      );
    }
  });
});

describe('R85b data', () => {
  it('base.json has gripLead 0.9', () => {
    expect((base as Record<string, unknown>).gripLead).toBe(0.9);
  });
  it('the older-test helper PB pins gripLead 0', () => {
    expect((PB as unknown as Record<string, unknown>).gripLead).toBe(0);
  });
});

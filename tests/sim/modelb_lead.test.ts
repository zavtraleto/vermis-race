// R85 DRIFT lead term: vx += dir*driftLead*e*sp*latScale, e = clamp(u,0,1) - slip*dir/slipFull,
// u = steer*dir. Explicit params (Q: accel 0, slipDrag 0, so speed is constant and hand-computable).
// Speed 0.5 is far under the DRIFT cap (>= 0.85 vmax), so R86 leaves it untouched.
import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/constants';
import type { CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { Q, STRAIGHT, car, constTrack, inp, mk, slipOf, stepB, stepN } from './modelb_helpers';

const L = 1.5;
const SP = 0.5;
const LS = 1.3;
const OPEN: CarParams = { ...Q, latScale: LS, xLimit: 1e9, offroadMul: 1, offroadSteerMul: 1 };
const WITH = { ...OPEN, driftLead: L };
const NONE = { ...OPEN, driftLead: 0 };
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** A DRIFT state with an explicit body angle, not in steady state. */
function drifting(dir: 1 | -1, vel: number, slip: number, yawRate = 0): RaceState {
  return mk({ speed: SP, state: 'DRIFT', dir, driftHeld: true, vel, yaw: vel + slip, yawRate });
}

describe('R85 lead term: exact formula in DRIFT', () => {
  const CASES: [number, number, number, number][] = [
    // dir, steer, vel, slip(dir-signed magnitude applied below)
    [1, 1, 0.1, 0.5],
    [1, 0.3, 0.05, 1.5],
    [1, 0.0, 0.2, 1.0],
    [1, 0.6, -0.1, 0.0],
  ];
  for (const dir of [1, -1] as const) {
    for (const [, steer, vel, slipMag] of CASES) {
      it(`dir ${dir}, steer ${steer}: x step = (vel + dir*L*e)*sp*latScale*DT and car.vx includes the term`, () => {
        const a = drifting(dir, dir * vel, dir * slipMag);
        const b = drifting(dir, dir * vel, dir * slipMag);
        stepB(a, inp(steer * dir, true), WITH);
        stepB(b, inp(steer * dir, true), NONE);
        const c = car(a);
        const u = steer * dir * dir; // input steer is steer*dir, u = input*dir
        const slipAfter = slipOf(c) * dir; // R83/R84 are not affected by the lead
        const e = clamp(u, 0, 1) - slipAfter / WITH.slipFull;
        // hand: dx = (vel_after + dir*1.5*e) * 0.5 * 1.3 * DT
        expect(c.vx).toBeCloseTo((c.vel + dir * L * e) * SP * LS, 12);
        expect(c.x).toBeCloseTo(c.vx * DT, 12); // x started at 0
        // the lead alone: difference to driftLead 0 (same body, same vel)
        expect(c.vel).toBe(car(b).vel);
        expect(c.yaw).toBe(car(b).yaw);
        expect(c.x - car(b).x).toBeCloseTo(dir * L * e * SP * LS * DT, 12);
        expect(car(b).vx).toBeCloseTo(car(b).vel * SP * LS, 12);
      });
    }
  }
  it('the lead does not feed back into the body: yaw, vel, slip, speed identical over 2 s (free of walls)', () => {
    const a = mk({ speed: SP });
    const b = mk({ speed: SP });
    const script = (i: number): InputFrame => ({
      steer: clamp(1.2 * Math.sin(i / 23) + 0.5 * Math.sin(i / 7), -1, 1),
      brake: false,
      drift: i > 20,
    });
    for (let i = 0; i < 240; i++) {
      stepB(a, script(i), WITH, constTrack(1));
      stepB(b, script(i), NONE, constTrack(1));
    }
    expect(car(a).state).toBe('DRIFT');
    for (const k of ['yaw', 'vel', 'yawRate', 'carry', 'speed', 'angle'] as const)
      expect(car(a)[k]).toBe(car(b)[k]);
    expect(car(a).x).not.toBe(car(b).x);
  });
});

describe('R85 lead term: zero where it must be zero', () => {
  it('steady DRIFT (e = 0): lead changes nothing (slip = 2.64*0.3 = 0.792, vel = 0.46*0.3 = 0.138)', () => {
    for (const dir of [1, -1] as const) {
      const mk2 = (): RaceState => drifting(dir, dir * 0.46 * 0.3, dir * 2.64 * 0.3);
      const a = mk2();
      const b = mk2();
      // slip*dir/slipFull = 0.792/2.64 = 0.3 = clamp(u, 0, 1) -> e = 0
      stepB(a, inp(0.3 * dir, true), WITH);
      stepB(b, inp(0.3 * dir, true), NONE);
      expect(car(a).x).toBeCloseTo(car(b).x, 12);
      expect(car(a).vx).toBeCloseTo(car(b).vx, 12);
      expect(car(a).vx).toBeCloseTo(dir * 0.138 * SP * LS, 6);
    }
  });
  it('steady DRIFT stays steady over time: x moves identically with and without the lead', () => {
    const a = drifting(1, 0.138, 0.792);
    const b = drifting(1, 0.138, 0.792);
    stepN(a, 600, inp(0.3, true), WITH);
    stepN(b, 600, inp(0.3, true), NONE);
    expect(car(a).x).toBeCloseTo(car(b).x, 9);
  });
  it('GRIP: driftLead has no effect (vx = vel*sp*latScale exactly)', () => {
    for (const steer of [1, -0.4, 0]) {
      const a = mk({ speed: SP });
      const b = mk({ speed: SP });
      stepN(a, 60, inp(steer), WITH);
      stepN(b, 60, inp(steer), NONE);
      expect(car(a).x).toBe(car(b).x);
      expect(car(a).vx).toBe(car(b).vx);
      expect(car(a).vx).toBeCloseTo(car(a).vel * SP * LS, 12);
    }
  });
  it('driftLead 0: every tick of a scripted run (flicks, releases) moves x by vel*sp*latScale*DT', () => {
    const s = mk({ speed: SP });
    for (let i = 0; i < 1500; i++) {
      const f: InputFrame = {
        steer: clamp(1.3 * Math.sin(i / 17) + 0.6 * Math.sin(i / 5), -1, 1),
        brake: false,
        drift: i % 300 > 60,
      };
      const x0 = car(s).x;
      stepB(s, f, NONE, constTrack(2));
      expect(car(s).x - x0).toBeCloseTo(car(s).vel * SP * LS * DT, 12);
    }
  });
});

describe('R85 lead term: counter-steer and sign', () => {
  it('u < 0: e = -slip*dir/slipFull <= 0, so the lead pulls outward (both dirs)', () => {
    for (const dir of [1, -1] as const) {
      const a = drifting(dir, dir * 0.1, dir * 1.0);
      const b = drifting(dir, dir * 0.1, dir * 1.0);
      stepB(a, inp(-0.5 * dir, true), WITH);
      stepB(b, inp(-0.5 * dir, true), NONE);
      const slipAfter = slipOf(car(a)) * dir;
      expect(slipAfter).toBeGreaterThan(0);
      const e = -slipAfter / WITH.slipFull; // clamp(u,0,1) = 0
      expect(e).toBeLessThan(0);
      // hand: slip ~ 1.0 -> e ~ -0.38; dx diff = dir*1.5*e*0.5*1.3*DT (outward = -dir)
      expect((car(a).x - car(b).x) * dir).toBeCloseTo(L * e * SP * LS * DT, 12);
      expect((car(a).x - car(b).x) * dir).toBeLessThan(0);
    }
  });
  it('slip 0 and counter-steer: e = 0 (the one-sided rule keeps slip at 0), no lead', () => {
    const a = drifting(1, 0.1, 0);
    const b = drifting(1, 0.1, 0);
    stepB(a, inp(-0.5, true), WITH);
    stepB(b, inp(-0.5, true), NONE);
    expect(slipOf(car(a))).toBeCloseTo(0, 12);
    expect(car(a).x).toBeCloseTo(car(b).x, 12);
  });
  it('finger ahead of the body (u = 1, slip small): lead pushes inward, scaling with L', () => {
    const run1 = (l: number): number => {
      const s = drifting(1, 0, 0);
      stepB(s, inp(1, true), { ...OPEN, driftLead: l });
      return car(s).x;
    };
    const x0 = run1(0);
    expect(run1(1)).toBeGreaterThan(x0);
    expect(run1(2) - x0).toBeCloseTo(2 * (run1(1) - x0), 12); // linear in driftLead
  });
});

describe('R85 lead term: wall clamp R18 still holds', () => {
  const WALL: CarParams = { ...Q, latScale: LS, driftLead: 5, offroadMul: 1 }; // xLimit 1.5; offroadMul 1: R15 must not drop speed under driftExitSpeed
  it('the lead cannot push x past xLimit; vel toward the wall is zeroed; angle is kept (yaw = vel + slip)', () => {
    for (const dir of [1, -1] as const) {
      const s = drifting(dir, dir * 0.3, dir * 0.5);
      car(s).x = dir * (WALL.xLimit - 1e-4);
      const free = drifting(dir, dir * 0.3, dir * 0.5);
      stepB(free, inp(dir, true), { ...WALL, xLimit: 1e9 });
      const slipFree = slipOf(car(free)) * dir;
      stepB(s, inp(dir, true), WALL);
      expect(Math.abs(car(s).x)).toBeLessThanOrEqual(WALL.xLimit + 1e-12);
      expect(car(s).x * dir).toBeCloseTo(WALL.xLimit, 12);
      expect(car(s).vel * dir).toBeLessThanOrEqual(0);
      expect(slipOf(car(s)) * dir).toBeCloseTo(slipFree, 12);
    }
  });
  it('a long hold against the wall with the lead stays inside and never flips the slip side', () => {
    const s = drifting(1, 0.3, 0.5);
    for (let i = 0; i < 300; i++) {
      stepB(s, inp(1, true), WALL, constTrack(0));
      expect(car(s).state).toBe('DRIFT'); // still held (0.5 speed, no loss), so the check is about the slip
      expect(car(s).x).toBeLessThanOrEqual(WALL.xLimit + 1e-12);
      expect(slipOf(car(s))).toBeGreaterThanOrEqual(-1e-12);
    }
  });
});

describe('R85 lead term: left/right mirror', () => {
  it('mirrored input and track give the mirrored state with the lead on', () => {
    const play = (sign: number): RaceState => {
      const s = mk({ speed: SP });
      const t: Track = constTrack(sign * 2);
      for (let i = 0; i < 900; i++) {
        const st = clamp(1.3 * Math.sin(i / 17) + 0.6 * Math.sin(i / 5), -1, 1);
        stepB(s, { steer: sign * st, brake: false, drift: i % 300 > 60 }, WITH, t);
      }
      return s;
    };
    const r = car(play(1));
    const l = car(play(-1));
    for (const k of ['x', 'vx', 'yaw', 'yawRate', 'vel', 'carry', 'angle'] as const)
      expect(l[k]).toBeCloseTo(-r[k], 9);
    expect(l.state).toBe(r.state);
    expect(STRAIGHT.segments.length).toBeGreaterThan(0);
  });
});

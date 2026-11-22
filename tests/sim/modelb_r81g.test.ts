import { describe, expect, it } from 'vitest';
import { driftEntryOf } from '../../src/app/driftEntryProbe';
import { baseCar } from '../../src/data/cars';
import hypotheses from '../../src/data/hypotheses.json';
import rivalsJson from '../../src/data/rivals.json';
import { curveClasses } from '../../src/data/tracks';
import { DT } from '../../src/sim/constants';
import type { Car, CarParams, RaceState, Track } from '../../src/sim/types';
import { Rig, custom, mirror, stepV } from './corner_helpers';
import { STRAIGHT, car, constTrack, inp, mk, slipOf } from './modelb_helpers';

// Spec: docs/brief.md R81g (T73, drift by the finger: the player enters and leaves), with R82, R83b,
// R86f as they stand. Every car here is the DEFAULT car (cars/base.json), lamps off; FREE also has
// walls and off-road loss removed so speed changes only by R86 (accel 0.22 up to vcap*capMul = vmax).
//
// Base numbers: vmax 1, driftEnterSpeed 0.45, driftExitSpeed 0.3, kickBase 2, slipFull 2.64,
// slipResponse 8, driftMinU 0.5, DT = 1/120.
// R81g / R81c variant 3 entry from rest (yaw = vel = carry = yawRate = 0): yawRate = dir*kickBase = 2*dir,
// then R83 DRIFT: u = steer*dir, uc = max(0.5, clamp(u, 0, 1)) (R83b), slipT = dir*2.64*uc,
//   yawRate += (8^2*(slipT - 0) - 2*8*yawRate)*DT; slip = yawRate*DT.
//   steer 1:   uc 1   -> yawRate = 2 + (64*2.64 - 32)/120 = 2 + 136.96/120 = 3.141333...; slip = 0.0261778
//   steer 0.2: uc 0.5 -> yawRate = 2 + (64*1.32 - 32)/120 = 2 +  52.48/120 = 2.437333...; slip = 0.0203111
// Steady drift (R83 critically damped to slipT): angle = slip/slipFull = dir*uc.

const C = curveClasses as Record<'easy' | 'medium' | 'hard' | 'sharp', number>;
const P: CarParams = { ...baseCar, model: 1, crashMinSpeed: 1e9 }; // H14 pin [2026-11-22]: model B explicitly (data default is model C, R150)
const FREE: CarParams = { ...P, xLimit: 1e9, offroadMul: 1, offroadSteerMul: 1 };
const ucB = (u: number): number => Math.max(0.5, Math.min(1, Math.max(0, u)));

const st1 = (s: RaceState, steer: number, drift: boolean, t: Track = STRAIGHT, p = FREE): void =>
  stepV(s, [inp(steer, drift)], t, [p]);
const segOf = (c: Car, t: Track): number => {
  const n = t.segments.length;
  return ((Math.floor(c.z) % n) + n) % n;
};
const phys = (c: Car) => ({
  state: c.state,
  dir: c.dir,
  x: c.x,
  z: c.z,
  speed: c.speed,
  vx: c.vx,
  angle: c.angle,
  yaw: c.yaw,
  yawRate: c.yawRate,
  vel: c.vel,
  carry: c.carry,
});

// ------------------------------------------------------------------------------------------------
describe('R81g data: variant 3 is the default again (player, rivals, bots)', () => {
  it('hypotheses.json H16_driftEntry is "D" and maps to driftEntry 3', () => {
    const f = (hypotheses as Record<string, string>).H16_driftEntry;
    expect(f).toBe('D');
    expect(driftEntryOf(f!)).toBe(3);
  });
  it('cars/base.json driftEntry 3; rivals.json rivalDriftEntry 3', () => {
    expect(baseCar.driftEntry).toBe(3);
    expect((rivalsJson as Record<string, unknown>).rivalDriftEntry).toBe(3);
  });
  it('R86f / R86e / R85c numbers stay: driftSpeedLoss 0, debtTime 0, gripDodge 0.1, driftMinU 0.5', () => {
    expect(baseCar.driftSpeedLoss).toBe(0);
    expect(baseCar.debtTime).toBe(0);
    expect(baseCar.gripDodge).toBe(0.1);
    expect(baseCar.driftMinU).toBe(0.5);
  });
});

// ------------------------------------------------------------------------------------------------
describe('R81g entry: GRIP + input.drift + steer != 0 + speed -> DRIFT, dir = sign(steer), also on a straight', () => {
  it.each([1, -1])(
    'straight, vmax, finger + steer %i: DRIFT on the first tick with dir = sign(steer)',
    (sg) => {
      const s = mk({ speed: 1, z: 10 });
      st1(s, sg, true);
      expect(car(s).state).toBe('DRIFT');
      expect(car(s).dir).toBe(sg);
    },
  );
  it('entry tick numbers (hand-computed above): steer 1 -> yawRate 3.141333, slip 0.0261778', () => {
    const s = mk({ speed: 1, z: 10 });
    st1(s, 1, true);
    expect(car(s).yawRate).toBeCloseTo(2 + 136.96 / 120, 9);
    expect(slipOf(car(s))).toBeCloseTo((2 + 136.96 / 120) / 120, 9);
  });
  it('entry tick numbers: steer -0.2 -> uc = driftMinU 0.5 -> yawRate -2.437333, slip -0.0203111', () => {
    const s = mk({ speed: 1, z: 10 });
    st1(s, -0.2, true);
    expect(car(s).dir).toBe(-1);
    expect(car(s).yawRate).toBeCloseTo(-(2 + 52.48 / 120), 9);
    expect(slipOf(car(s))).toBeCloseTo(-(2 + 52.48 / 120) / 120, 9);
  });
  it('finger held with steer 0: entry waits (GRIP for 1 s); the first tick with steer -0.05 enters with dir -1', () => {
    const s = mk({ speed: 1, z: 10 });
    for (let i = 0; i < 120; i++) {
      st1(s, 0, true);
      expect(car(s).state).toBe('GRIP');
    }
    st1(s, -0.05, true);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(-1);
  });
  it('steer without the finger never drifts (straight, 1 s of full steer)', () => {
    const s = mk({ speed: 1, z: 10 });
    for (let i = 0; i < 120; i++) {
      st1(s, 1, false);
      expect(car(s).state).toBe('GRIP');
    }
  });
  it('below driftEnterSpeed (0.44 < 0.45 vmax at the start of the step): no entry', () => {
    const s = mk({ speed: 0.44, z: 10 });
    st1(s, 1, true);
    expect(car(s).state).toBe('GRIP');
  });
});

// ------------------------------------------------------------------------------------------------
describe('R81g exit: only by release (R82) or speed; no automatic exit at the corner end', () => {
  // Track: straight, hard corner on [400, 640), straight to 8000. The finger goes down inside the
  // corner (seg >= 410) with steer toward the corner, then steer 0 with the finger held.
  for (const sg of [1, -1]) {
    it(`side ${sg}: drift entered in hard stays DRIFT through the corner end and 2 s of straight after`, () => {
      const t = custom(8000, [[400, 240, C.hard * sg]]);
      const r = new Rig(FREE, 1, 300);
      let guard = 0;
      while (segOf(r.car, t) < 410 && guard++ < 2000) r.tick(t, 0, false);
      expect(r.car.state).toBe('GRIP');
      r.tick(t, sg, true);
      expect(r.car.state).toBe('DRIFT');
      expect(r.car.dir).toBe(sg);
      guard = 0;
      while (segOf(r.car, t) < 640 && guard++ < 4000) {
        r.tick(t, 0, true);
        expect(r.car.state).toBe('DRIFT');
      }
      expect(segOf(r.car, t)).toBeGreaterThanOrEqual(640); // reached the straight after the corner
      for (let i = 0; i < 240; i++) {
        r.tick(t, 0, true);
        expect(r.car.state).toBe('DRIFT');
        expect(r.car.dir).toBe(sg);
      }
      expect(t.segments[segOf(r.car, t)]!.curve).toBe(0); // still drifting on a straight
      // release: GRIP on that tick (R82), dir 0
      r.tick(t, 0, false);
      expect(r.car.state).toBe('GRIP');
      expect(r.car.dir).toBe(0);
      // finger down again with steer on the straight: DRIFT again on the next tick (no armTicks block)
      r.tick(t, -sg, true);
      expect(r.car.state).toBe('DRIFT');
      expect(r.car.dir).toBe(-sg);
    });
  }
  it('straight: 3 s of held drift with any steer never exits; release exits on that tick', () => {
    const s = mk({ speed: 1, z: 10 });
    st1(s, 1, true);
    for (let i = 0; i < 360; i++) {
      st1(s, Math.sin(i / 9), true);
      expect(car(s).state).toBe('DRIFT');
      expect(car(s).dir).toBe(1);
    }
    st1(s, 1, false);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
  });
  it('speed exit with the finger held blocks a new entry until the finger is released (as R81c)', () => {
    const s = mk({ speed: 1, z: 10 });
    st1(s, 1, true);
    expect(car(s).state).toBe('DRIFT');
    let guard = 0;
    while (car(s).state === 'DRIFT' && guard++ < 1200)
      stepV(s, [inp(1, true, true)], STRAIGHT, [FREE]); // brake in drift
    expect(car(s).state).toBe('GRIP');
    expect(car(s).speed).toBeLessThan(0.3 + 0.6 * DT + 1e-9);
    for (let i = 0; i < 240; i++) {
      st1(s, 1, true);
      expect(car(s).state).toBe('GRIP');
    }
    expect(car(s).speed).toBeGreaterThan(0.45);
    st1(s, 1, false);
    st1(s, 1, true);
    expect(car(s).state).toBe('DRIFT');
  });
});

// ------------------------------------------------------------------------------------------------
describe('R86f under R81g: speed in DRIFT never below the entry speed (straight and every corner class)', () => {
  const classes: Array<[string, number]> = [
    ['straight', 0],
    ['easy', C.easy],
    ['medium', C.medium],
    ['hard', C.hard],
    ['sharp', C.sharp],
  ];
  for (const [name, curve] of classes)
    for (const sp0 of [0.6, 1.0])
      for (const sg of [1, -1])
        it(`${name}, ${sp0} vmax, side ${sg}: 2 s of DRIFT with steer +1 / 0 / -1 toward dir, speed >= entry speed`, () => {
          for (const hold of [1, 0, -1]) {
            const t = constTrack(curve * sg);
            const s = mk({ speed: sp0, z: 10 });
            st1(s, sg, true, t);
            expect(car(s).state).toBe('DRIFT');
            for (let i = 0; i < 240; i++) {
              st1(s, sg * hold, true, t);
              expect(car(s).state).toBe('DRIFT');
              expect(car(s).speed).toBeGreaterThanOrEqual(sp0 - 1e-12);
            }
          }
        });
});

// ------------------------------------------------------------------------------------------------
describe('R83b floor under R81g (variant 3): steady angle = dir*max(driftMinU, clamp(steer*dir, 0, 1))', () => {
  const tracks: Array<[string, number]> = [
    ['straight', 0],
    ['easy', C.easy],
    ['medium', C.medium],
    ['hard', C.hard],
    ['sharp', C.sharp],
  ];
  for (const [name, curve] of tracks)
    it(`${name}: steer -1 / 0 / 0.3 / 0.5 -> angle 0.5, 0.8 -> 0.8, 1 -> 1 (both sides, 3 s)`, () => {
      for (const sg of [1, -1])
        for (const u of [-1, 0, 0.3, 0.5, 0.8, 1]) {
          const t = constTrack(curve * sg);
          const s = mk({ speed: 1, z: 10 });
          st1(s, sg, true, t);
          for (let i = 0; i < 360; i++) st1(s, sg * u, true, t);
          expect(car(s).state).toBe('DRIFT');
          expect(car(s).angle).toBeCloseTo(sg * ucB(u), 4);
        }
    });
  it('straight, steady drift, steer -1 / -0.5 / 0 for 3 s: vx*dir >= 0.20 half-widths/s (R83b criterion)', () => {
    for (const sg of [1, -1])
      for (const u of [-1, -0.5, 0]) {
        const s = mk({ speed: 1, z: 10 });
        st1(s, sg, true);
        for (let i = 0; i < 120; i++) st1(s, sg, true);
        for (let i = 0; i < 360; i++) st1(s, sg * u, true);
        expect(car(s).state).toBe('DRIFT');
        expect(car(s).vx * sg).toBeGreaterThanOrEqual(0.2);
      }
  });
});

// ------------------------------------------------------------------------------------------------
describe('R83c is variant 5 only: under R81g (variant 3) cornerSpan / cornerMinU change nothing', () => {
  const run = (p: CarParams, curve: number, u: number) => {
    const t = constTrack(curve);
    const s = mk({ speed: 1, z: 10 });
    st1(s, 1, true, t, p);
    for (let i = 0; i < 360; i++) st1(s, u, true, t, p);
    return phys(car(s));
  };
  for (const [name, curve] of [
    ['straight', 0],
    ['easy', C.easy],
    ['hard', C.hard],
    ['hard against', -C.hard],
  ] as const)
    it(`${name}: cornerSpan 0.5 / cornerMinU 0.1 and cornerSpan 0.9 / cornerMinU 0.4 give the same state`, () => {
      for (const u of [-1, 0, 0.2, 1]) {
        const a = run(FREE, curve, u);
        const b = run({ ...FREE, cornerSpan: 0.9, cornerMinU: 0.4 }, curve, u);
        expect(b).toEqual(a);
      }
    });
  it('hard, steer 0.2: steady angle 0.5 (R83b), not the R83c share h + 0.5*0.2 = 0.873 + 0.1 = 0.973', () => {
    expect(run(FREE, C.hard, 0.2).angle).toBeCloseTo(0.5, 4);
  });
  it('the floor is driftMinU: hard, steer 0 -> angle 0.5 with driftMinU 0.5, 0.3 with driftMinU 0.3', () => {
    expect(run(FREE, C.hard, 0).angle).toBeCloseTo(0.5, 4);
    expect(run({ ...FREE, driftMinU: 0.3 }, C.hard, 0).angle).toBeCloseTo(0.3, 4);
  });
});

// ------------------------------------------------------------------------------------------------
describe('R81g properties: left/right symmetry, determinism, JSON round-trip', () => {
  const T = custom(8000, [
    [300, 240, C.hard],
    [900, 200, -C.medium],
    [1500, 120, C.sharp],
  ]);
  // a program: approach, finger down in the corner, steer changes, release, re-touch on a straight
  const prog = (i: number): [number, boolean] => {
    if (i < 100) return [0.3 * Math.sin(i / 10), false];
    if (i < 400) return [i < 110 ? 1 : 0.6 * Math.sin(i / 17), true];
    if (i < 460) return [0, false];
    if (i < 800) return [-1 + 0.5 * Math.sin(i / 13), true];
    return [0.4, i % 300 < 200];
  };
  const drive = (s: RaceState, t: Track, from: number, to: number, sg = 1): void => {
    for (let i = from; i < to; i++) {
      const [steer, drift] = prog(i);
      stepV(s, [inp(sg * steer, drift)], t, [FREE]);
    }
  };
  it('mirror track + mirrored steer: x, vx, yaw, vel, angle, dir negated; z, speed, state equal (every tick)', () => {
    const a = mk({ speed: 1, z: 200 });
    const b = mk({ speed: 1, z: 200 });
    const M = mirror(T);
    let drifted = 0;
    for (let i = 0; i < 1200; i++) {
      drive(a, T, i, i + 1);
      drive(b, M, i, i + 1, -1);
      const ca = car(a);
      const cb = car(b);
      expect(cb.state).toBe(ca.state);
      expect(cb.dir).toBe(-ca.dir || 0);
      expect(cb.z).toBeCloseTo(ca.z, 9);
      expect(cb.speed).toBeCloseTo(ca.speed, 9);
      expect(cb.x).toBeCloseTo(-ca.x, 9);
      expect(cb.vx).toBeCloseTo(-ca.vx, 9);
      expect(cb.yaw).toBeCloseTo(-ca.yaw, 9);
      expect(cb.vel).toBeCloseTo(-ca.vel, 9);
      expect(cb.angle).toBeCloseTo(-ca.angle, 9);
      if (ca.state === 'DRIFT') drifted++;
    }
    expect(drifted).toBeGreaterThan(300);
  });
  it('determinism: the same inputs twice give identical state', () => {
    const a = mk({ speed: 1, z: 200 });
    const b = mk({ speed: 1, z: 200 });
    drive(a, T, 0, 1200);
    drive(b, T, 0, 1200);
    expect(b).toEqual(a);
  });
  it('JSON round-trip mid-drift: the restored state continues identically', () => {
    const a = mk({ speed: 1, z: 200 });
    drive(a, T, 0, 300);
    expect(car(a).state).toBe('DRIFT');
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    drive(a, T, 300, 1200);
    drive(b, T, 300, 1200);
    expect(b).toEqual(a);
  });
});

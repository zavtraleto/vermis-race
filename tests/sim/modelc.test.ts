// Driving model C, "drift by angle" (docs/brief.md R150-R159, R161, R163, R164; written before the
// implementation). Runs repeat the spike's (tools/spike/model-c.ts, docs/research/model-c.md) on the
// real `step`: car PC (base car, variant 3, turbo off, model 2, brief start numbers), speed vmax at
// the start. Curves (curves.json): easy 2, medium 4.5, hard 7, sharp 8.3; kYaw 2, vmax 1, DT 1/120,
// SEG_PER_UNIT 60. Curve > 0 = right corner = drift dir +1; "inward" = toward dir, "outward" = away.
// Tolerances (R163): +-0.01 half-width, +-0.005 vmax, +-1 tick, +-0.5 deg unless the brief says else.
import { describe, expect, it } from 'vitest';
import { copyRaceState } from '../../src/app/loop';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { Lcg } from './corner_helpers';
import {
  C,
  C_FIELDS,
  GRIPL,
  IDEAL,
  MC_START as M,
  PB1,
  PC,
  SLIP_DEG,
  Sim,
  cf,
  clamp,
  cornerSides,
  figTrack,
  figTrackOf,
  figureRun,
  gripSteer,
  mirrorTrack,
  steadyDrift,
  tapRun,
} from './modelc_helpers';
import { traceHash, twistyTrack } from './t77_helpers';

const CL = [
  ['medium', C.medium!],
  ['hard', C.hard!],
  ['sharp', C.sharp!],
] as const;
const ticks = (s: number): number => Math.round(s / DT);
/** a = exp(-DT/winTau) = exp(-(1/120)/0.06) = exp(-0.138889) = 0.870325 (R154 window filter). */
const A_WIN = Math.exp(-DT / M.winTau);

function constTrack(c: number, n = 12000): Track {
  return { segments: Array.from({ length: n }, () => ({ curve: c })) };
}

// ------------------------------------------------------------------------------------------ R150
describe('R150 model C is model 2 of one step; input.drift and input.brake are not read', () => {
  it('a model 2 car steps without throwing and stays finite', () => {
    const s = new Sim(figTrack(C.hard!, 400), PC, 1);
    for (let i = 0; i < ticks(3); i++) s.tick(i < 200 ? 0 : 1, i >= 200 && i < 212 ? -1 : 0);
    for (const k of ['x', 'z', 'speed', 'vx', 'vel', 'yaw'] as const)
      expect(Number.isFinite(s.car[k])).toBe(true);
  });
  it('drift and brake flags change nothing: random drift/brake vs both false give an identical state', () => {
    const run = (flags: boolean): string => {
      const st = createRace(1, 1);
      st.cars[0]!.speed = PC.vmax;
      const g = new Lcg(3);
      const fr: InputFrame = { steer: 0, brake: false, drift: false, throttle: 0 };
      const tr = twistyTrack();
      for (let i = 0; i < ticks(20); i++) {
        if (i % 30 === 0) {
          fr.steer = 2 * g.next() - 1;
          fr.throttle = g.next() < 0.2 ? -1 : g.next() < 0.5 ? 0 : 1;
          const b = g.next() < 0.5;
          const d = g.next() < 0.5;
          fr.brake = flags && b;
          fr.drift = flags && d;
        }
        step(st, [fr], tr, [PC]);
      }
      return JSON.stringify(st);
    };
    expect(run(true)).toBe(run(false));
  });
});

// ------------------------------------------------------------------------------------------ R151
describe('R151 throttle is optional: absent = 0 [директор 2026-11-22]', () => {
  it('frames without `throttle` give the same state as throttle 0, in GRIP and through a lift-free run', () => {
    const run = (withField: boolean): string => {
      const st = createRace(1, 1);
      st.cars[0]!.speed = PC.vmax;
      const fr: InputFrame = withField
        ? { steer: 0, brake: false, drift: false, throttle: 0 }
        : { steer: 0, brake: false, drift: false };
      const tr = figTrack(C.hard!, 300);
      for (let i = 0; i < ticks(8); i++) {
        fr.steer = Math.sin(i * 0.01);
        step(st, [fr], tr, [PC]);
      }
      return JSON.stringify(st);
    };
    expect(run(false)).toBe(run(true));
  });
  it('throttle 0 is full auto-gas: from rest on a straight speed grows by accel*DT per tick (R14)', () => {
    const s = new Sim(constTrack(0), PC, 0);
    s.tick(0, 0);
    expect(s.car.speed).toBeCloseTo(PC.accel * DT, 12); // 0.22/120 = 0.0018333
  });
});

// ------------------------------------------------------------------------------------------ R152
describe('R152 new Car fields', () => {
  it('createRace: beta, betaI, refA, winTicks, winDir, wBeta, endTicks 0; liftArmed 1; all are numbers', () => {
    const car = cf(createRace(1, 1).cars[0]!);
    for (const k of C_FIELDS) expect(typeof car[k]).toBe('number');
    for (const k of ['beta', 'betaI', 'refA', 'winTicks', 'winDir', 'wBeta', 'endTicks'] as const)
      expect(car[k]).toBe(0);
    expect(car.liftArmed).toBe(1);
  });
  it('the exit ramp is full from the start: exitTicks >= round(exitRamp/DT) = 36 after the first model C tick', () => {
    const s = new Sim(constTrack(0), PC, 1);
    s.tick(0, 0);
    expect(cf(s.car).exitTicks).toBeGreaterThanOrEqual(36);
  });
});

// ------------------------------------------------------------------------------------------ R153
describe('R153 reference angle: mean curve of the road ahead, smoothed', () => {
  // One tick from refA 0: refA = cMean*sp*kYaw*(1 - exp(-DT/refTau)); 1 - exp(-(1/120)/0.12) =
  // 1 - exp(-0.069444) = 0.067087. k = max(1, ceil(sp*60*0.3)) = 18 segments at sp 1.
  const g = 1 - Math.exp(-DT / M.refTau);
  it('uniform curve 4.5: refA after one tick = 4.5*1*2*0.067087 = 0.60378', () => {
    const s = new Sim(constTrack(4.5), PC, 1, 0, 100);
    s.tick(0, 0);
    expect(cf(s.car).refA).toBeCloseTo(4.5 * 2 * g, 9);
  });
  it('curve 6 on 8 of the 18 segments z..z+17: cMean = 6*8/18 = 2.6667, refA = 2.6667*2*0.067087 = 0.35780', () => {
    const segs = Array.from({ length: 400 }, (_, i) => ({ curve: i >= 110 ? 6 : 0 }));
    const s = new Sim({ segments: segs }, PC, 1, 0, 100);
    s.tick(0, 0);
    expect(cf(s.car).refA).toBeCloseTo(((6 * 8) / 18) * 2 * g, 9);
  });
  it('the window wraps over the lap: z 190 of 200, curve 3 on segments 0..9: cMean = 3*8/18', () => {
    const segs = Array.from({ length: 200 }, (_, i) => ({ curve: i < 10 ? 3 : 0 }));
    const s = new Sim({ segments: segs }, PC, 1, 0, 190);
    s.tick(0, 0);
    expect(cf(s.car).refA).toBeCloseTo(((3 * 8) / 18) * 2 * g, 9);
  });
  it('at half speed the window is ceil(0.5*60*0.3) = 9 segments: curve 6 on z+8 only -> cMean 6/9, sp 0.5', () => {
    const segs = Array.from({ length: 400 }, (_, i) => ({ curve: i === 108 ? 6 : 0 }));
    const s = new Sim({ segments: segs }, PC, 0.5, 0, 100);
    s.tick(0, 0);
    expect(cf(s.car).refA).toBeCloseTo((6 / 9) * 0.5 * 2 * g, 9);
  });
  it('hold angles at vmax (betaPerA*curve*kYaw): easy 13.6, medium 30.6, hard 47.6, sharp 56.44 deg', () => {
    expect(M.betaPerA * C.easy! * PC.kYaw).toBeCloseTo(13.6, 9);
    expect(M.betaPerA * C.medium! * PC.kYaw).toBeCloseTo(30.6, 9);
    expect(M.betaPerA * C.hard! * PC.kYaw).toBeCloseTo(47.6, 9);
    expect(M.betaPerA * C.sharp! * PC.kYaw).toBeCloseTo(56.44, 9);
  });
});

// ------------------------------------------------------------------------------------------ R154
describe('R154 lift edge, hysteresis, entry window', () => {
  it('lift edge: throttle -0.5 opens the window (60 ticks, minus this tick = 59); -0.3 keeps it disarmed', () => {
    const s = new Sim(constTrack(0), PC, 1);
    s.tick(0, -0.5); // -0.5 <= -liftOn 0.4: edge; round(0.5/DT) = 60, GRIP counts 1 down
    expect(cf(s.car).winTicks).toBe(59);
    expect(cf(s.car).liftArmed).toBe(0);
    expect(cf(s.car).winDir).toBe(0);
    s.tick(0, -0.3); // -0.3 is not > -liftOff (-0.2): still disarmed
    expect(cf(s.car).liftArmed).toBe(0);
    s.tick(0, -0.5); // no new edge while disarmed: the window just counts down
    expect(cf(s.car).winTicks).toBe(56);
    s.tick(0, -0.1); // > -0.2: re-armed
    expect(cf(s.car).liftArmed).toBe(1);
    s.tick(0, -1); // new edge: a fresh window
    expect(cf(s.car).winTicks).toBe(59);
  });
  it('the window lasts 60 ticks: full steer from window tick 58 latches (2 ticks), from tick 59 not', () => {
    // wBeta after n ticks of steer 1 from 0: 40*(1 - a^n); n = 1: 5.19 < 8.4; n = 2: 9.70 >= 8.4.
    const go = (k: number): boolean => {
      const s = new Sim(constTrack(0), PC, 1);
      for (let i = 0; i < 70; i++) s.tick(i >= k ? 1 : 0, i === 0 ? -1 : 0);
      return s.entries > 0;
    };
    expect(40 * (1 - A_WIN)).toBeLessThan(M.betaOn);
    expect(40 * (1 - A_WIN ** 2)).toBeGreaterThanOrEqual(M.betaOn);
    expect(go(58)).toBe(true);
    expect(go(59)).toBe(false);
  });
  it('wBeta follows steer*betaEntry through winTau: steer 0.5, 3 window ticks -> 20*(1 - a^3) = 6.81 (no drift yet)', () => {
    const s = new Sim(constTrack(0), PC, 1);
    for (let i = 0; i < 3; i++) s.tick(0.5, i === 0 ? -1 : 0);
    expect(cf(s.car).wBeta).toBeCloseTo(20 * (1 - A_WIN ** 3), 9);
    expect(s.car.state).toBe('GRIP');
  });
  it('the latch: DRIFT in the same tick, dir = sign(steer), x / vel / speed continuous, relSide = relV = 0', () => {
    for (const sd of [1, -1]) {
      const s = new Sim(constTrack(0), PC, 1);
      let prev = { x: 0, vel: 0, speed: 0 };
      for (let i = 0; i < 20 && !s.drift; i++) {
        prev = { x: s.car.x, vel: s.car.vel, speed: s.car.speed };
        s.tick(sd, -1);
      }
      expect(s.car.state).toBe('DRIFT');
      expect(s.car.dir).toBe(sd);
      expect(Math.abs(s.car.x - prev.x)).toBeLessThan(0.01);
      expect(Math.abs(s.car.vel - prev.vel)).toBeLessThan(0.02);
      expect(Math.abs(s.car.speed - prev.speed)).toBeLessThan(0.01);
      expect(s.car.relSide).toBe(0);
      expect(s.car.relV).toBe(0);
    }
  });
  it('no entry below driftEnterSpeed*vmax (0.45): speed 0.4, lift + full steer -> no DRIFT', () => {
    const s = new Sim(constTrack(0), PC, 0.4);
    for (let i = 0; i < 60; i++) s.tick(1, i < 12 ? -1 : 0);
    expect(s.entries).toBe(0);
  });
  it('no entry without a lift: full steer at vmax for 3 s on every class, throttle 0 and +1', () => {
    for (const c of [0, C.medium!, C.hard!, C.sharp!])
      for (const thr of [0, 1]) {
        const s = new Sim(figTrack(c, 4000, 0), PC, 1, 0, 60);
        for (let i = 0; i < ticks(3); i++) s.tick(1, thr);
        expect(s.entries).toBe(0);
      }
  });
});

// ------------------------------------------------------------------------------------------ R163 (a)
describe('R163 (a) entry: lift (throttle -1 for 0.1 s) with the steer held, vmax', () => {
  // Spike partEntry: figTrack(c, 4000, 0) from z 60 (in the hold), steer held 0.5 s first (GRIP).
  // Hand: latch after n window ticks with 1 - a^n >= 0.21/s: s 1 -> n = ceil(1.697) = 2 (17 ms);
  // s 0.5 -> 1 - a^n >= 0.42, n = ceil(3.922) = 4 (33 ms); s 0.3 -> 0.7, n = ceil(8.668) = 9 (75 ms).
  const entry = (c: number, st: number) => {
    const s = new Sim(figTrack(c, 4000, 0), PC, 1, 0, 60);
    for (let i = 0; i < ticks(0.5); i++) s.tick(st, 0);
    const v0 = s.car.speed;
    let vmin = v0;
    let latch = -1;
    for (let i = 0; i < ticks(0.8); i++) {
      s.tick(st, i < 12 ? -1 : 0);
      vmin = Math.min(vmin, s.car.speed);
      if (s.drift && latch < 0) latch = i + 1;
    }
    return { latch, v0, vmin, entries: s.entries };
  };
  for (const [name, c] of [
    ['straight', 0],
    ['medium', C.medium!],
    ['hard', C.hard!],
  ] as const) {
    for (const [st, n] of [
      [1, 2],
      [0.5, 4],
      [0.3, 9],
    ] as const) {
      it(`${name}, steer ${st}: DRIFT after ${n} ticks (+-1)`, () => {
        const r = entry(c, st);
        expect(Math.abs(r.latch - n)).toBeLessThanOrEqual(1);
      });
    }
    for (const st of [0, 0.2]) {
      it(`${name}, steer ${st}: no DRIFT (40*${st} = ${40 * st} deg < 8.4)`, () => {
        expect(entry(c, st).entries).toBe(0);
      });
    }
  }
  it('straight, steer 0: the lift only slows: 12 ticks * 0.35/120 = 0.035 vmax, exactly (R159 (1))', () => {
    const r = entry(0, 0);
    expect(r.vmin).toBeCloseTo(r.v0 - 12 * M.liftDecel * PC.vmax * DT, 9);
  });
  it('hard, steer 0 + lift: no drift, speed falls by more than the lift alone (lift + scrub R86b)', () => {
    const r = entry(C.hard!, 0);
    expect(r.entries).toBe(0);
    expect(r.vmin).toBeLessThan(r.v0 - 0.035 * PC.vmax);
  });
  it('symmetry: the mirrored corner with the mirrored steer latches on the same tick with dir -1', () => {
    for (const st of [1, 0.5, 0.3]) {
      const a = new Sim(figTrack(C.medium!, 4000, 0), PC, 1, 0, 60);
      const b = new Sim(mirrorTrack(figTrack(C.medium!, 4000, 0)), PC, 1, 0, 60);
      for (let i = 0; i < ticks(1.3); i++) {
        const thr = i >= 60 && i < 72 ? -1 : 0;
        a.tick(st, thr);
        b.tick(-st, thr);
        expect(b.car.state).toBe(a.car.state);
        expect(b.car.x).toBeCloseTo(-a.car.x, 12);
      }
      expect(b.entryDirs).toEqual(a.entryDirs.map((d) => -d));
    }
  });
});

// ------------------------------------------------------------------------------------------ R155
describe('R155 angle in DRIFT', () => {
  it('0 <= beta <= betaMax 70 and DRIFT <=> dir != 0 on every tick of a seeded run', () => {
    const s = new Sim(twistyTrack(), PC, 1);
    const g = new Lcg(9);
    let st = 0;
    let thr = 0;
    let drifted = 0;
    for (let i = 0; i < ticks(60); i++) {
      if (i % 24 === 0) {
        st = 2 * g.next() - 1;
        thr = g.next() < 0.25 ? -1 : 2 * g.next() - 1;
      }
      s.tick(st, thr);
      const b = cf(s.car).beta;
      if (s.drift) {
        drifted++;
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(M.betaMax);
        expect(s.car.dir).not.toBe(0);
      } else expect(s.car.dir).toBe(0);
    }
    expect(drifted).toBeGreaterThan(0);
  });
  it('spin guard: full steer in sharp holds beta at betaMax 70 (target 2*56.4 = 112.8 clamped)', () => {
    const s = steadyDrift(C.sharp!);
    for (let i = 0; i < ticks(1); i++) s.tick(1, 0);
    expect(s.drift).toBe(true);
    expect(cf(s.car).beta).toBeLessThanOrEqual(70);
    expect(cf(s.car).beta).toBeGreaterThan(69.5);
  });
  it('betaTau: from the hold angle in hard, steer 1 -> target 70; after 14 ticks beta = 70 - (70 - b0)*exp(-14*DT/0.12)', () => {
    // bT = clamp(bRef*1/0.5, +-70) = 70 while bRef >= 35 (bRef = 47.6*sp, sp >= 0.93 here).
    const s = steadyDrift(C.hard!);
    const b0 = cf(s.car).beta;
    for (let i = 0; i < 14; i++) s.tick(1, 0);
    expect(cf(s.car).beta).toBeCloseTo(70 - (70 - b0) * Math.exp((-14 * DT) / M.betaTau), 6);
    // R161: 63% of the step within betaTau: 1 - exp(-14/120/0.12) = 0.622, 15 ticks 0.648
  });
});

// ------------------------------------------------------------------------------------------ R163 (b)
describe('R163 (b) steady drift: line by two axes', () => {
  // Spike partSteady: steadyDrift(c) (1.5 s at the exact finger), then (u, throttle) for 1 s.
  const after = (c: number, u: number, thr: number) => {
    const s = steadyDrift(c);
    const dir = s.car.dir;
    const x0 = s.car.x;
    let endT = NaN;
    for (let i = 0; i < ticks(1); i++) {
      s.tick(dir * u, thr);
      if (!s.drift && Number.isNaN(endT)) endT = (i + 1) * DT;
    }
    return { s, dir, inward: (s.car.x - x0) * dir, speed: s.car.speed / PC.vmax, endT };
  };
  it('hold angles with the exact finger, 2.5 s: easy 13.6, medium 30.6, hard 47.6, sharp 56.4 deg (+-0.5); speed >= 0.999; |x| <= 0.012', () => {
    for (const [c, b] of [
      [C.easy!, 13.6],
      [C.medium!, 30.6],
      [C.hard!, 47.6],
      [C.sharp!, 56.44],
    ] as const) {
      const s = steadyDrift(c, 2.5);
      expect(s.drift).toBe(true);
      expect(Math.abs(cf(s.car).beta - b)).toBeLessThanOrEqual(0.5);
      expect(s.car.speed / PC.vmax).toBeGreaterThanOrEqual(0.999);
      expect(Math.abs(s.car.x)).toBeLessThanOrEqual(0.012);
    }
  });
  for (const [name, c] of CL) {
    it(`${name}: exact finger (u 0.5, gas 0): beta = hold, |dx| in 1 s <= 0.01, speed >= 0.999`, () => {
      const r = after(c, 0.5, 0);
      expect(r.s.drift).toBe(true);
      expect(Math.abs(cf(r.s.car).beta - M.betaPerA * c * PC.kYaw)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(r.inward)).toBeLessThanOrEqual(0.01);
      expect(r.speed).toBeGreaterThanOrEqual(0.999);
    });
    it(`${name}: u 1 (deeper) -> inward 0.13..0.17 in 1 s and slower: speed 0.766 (cap 1 - 0.018*(15 - 2))`, () => {
      const r = after(c, 1, 0);
      expect(r.inward).toBeGreaterThanOrEqual(0.13 - 0.01);
      expect(r.inward).toBeLessThanOrEqual(0.17 + 0.01);
      expect(Math.abs(r.speed - (1 - 0.018 * (15 - 2)))).toBeLessThanOrEqual(0.005);
    });
    it(`${name}: gas +1 at u 0.5 -> wider (outward 0.11..0.14) without loss: speed 1.000`, () => {
      const r = after(c, 0.5, 1);
      expect(-r.inward).toBeGreaterThanOrEqual(0.11 - 0.01);
      expect(-r.inward).toBeLessThanOrEqual(0.14 + 0.01);
      expect(Math.abs(r.speed - 1)).toBeLessThanOrEqual(0.005);
    });
    it(`${name}: gas -1 at u 0.5 -> tighter (inward 0.12..0.15) with loss: speed 0.919 (~1 - 0.08*1 s)`, () => {
      const r = after(c, 0.5, -1);
      expect(r.inward).toBeGreaterThanOrEqual(0.12 - 0.01);
      expect(r.inward).toBeLessThanOrEqual(0.15 + 0.01);
      expect(Math.abs(r.speed - 0.919)).toBeLessThanOrEqual(0.005);
    });
    it(`${name}: u <= 0 (0, -0.5, -1) ends the drift within 0.22..0.43 s`, () => {
      for (const u of [0, -0.5, -1]) {
        const r = after(c, u, 0);
        expect(r.endT).toBeGreaterThanOrEqual(0.22 - DT);
        expect(r.endT).toBeLessThanOrEqual(0.43 + DT);
      }
    });
    it(`${name}: monotone in the finger: inward(u 1) > inward(u 0.5) > inward(u 0); speed(u 1) < speed(u 0.5)`, () => {
      const a = after(c, 1, 0);
      const b = after(c, 0.5, 0);
      const z = after(c, 0, 0);
      expect(a.inward).toBeGreaterThan(b.inward);
      expect(b.inward).toBeGreaterThan(z.inward);
      expect(a.speed).toBeLessThan(b.speed);
    });
  }
});

// ------------------------------------------------------------------------------------------ R156
describe('R156 course and shift in DRIFT', () => {
  it('every DRIFT tick: yaw = vel + dir*beta/slipDeg, angle = dir*beta/(slipDeg*slipFull), vx = vel*sp*latScale (sp of the tick start)', () => {
    const s = steadyDrift(C.hard!, 0.5);
    for (let i = 0; i < ticks(1.5); i++) {
      s.tick(i < 90 ? 0.7 : -0.2, i % 40 < 20 ? 0.5 : -0.5);
      if (!s.drift) continue;
      const b = cf(s.car).beta;
      expect(s.car.yaw).toBeCloseTo(s.car.vel + (s.car.dir * b) / SLIP_DEG, 9);
      expect(s.car.angle).toBeCloseTo((s.car.dir * b) / (SLIP_DEG * PC.slipFull), 9);
      expect(s.car.vx).toBeCloseTo(s.car.vel * s.sp0 * PC.latScale, 9);
    }
  });
  it('the course turns outward by at most outSlide*DT per tick: (vel - vel0)*dir >= -0.5/120', () => {
    for (const [, c] of CL)
      for (const u of [0, -1, -0.3]) {
        const s = steadyDrift(c);
        for (let i = 0; i < ticks(0.5); i++) {
          const v0 = s.car.vel;
          const dir = s.car.dir;
          const was = s.drift;
          s.tick(dir * u, 0);
          if (was && s.drift)
            expect((s.car.vel - v0) * dir).toBeGreaterThanOrEqual(-M.outSlide * DT - 1e-12);
        }
      }
  });
  it('R18 in DRIFT: |x| <= xLimit and vel toward the wall is 0 at the wall', () => {
    const p: CarParams = { ...PC, xLimit: 0.3 };
    const s = steadyDrift(C.hard!, 0.3, p);
    for (let i = 0; i < ticks(2); i++) {
      s.tick(s.car.dir * 1, -1); // deeper and tighter: inward to the wall
      expect(Math.abs(s.car.x)).toBeLessThanOrEqual(0.3);
      if (s.drift && Math.abs(s.car.x) === 0.3)
        expect(s.car.vel * Math.sign(s.car.x)).toBeLessThanOrEqual(0);
    }
  });
});

// ------------------------------------------------------------------------------------------ R157
describe('R157 speed in DRIFT: the angle miss lowers the cap', () => {
  it('cap floor: missCap 15 -> speed never below vmax*(1 - 0.018*13) = 0.766 from the miss alone (gas 0)', () => {
    for (const [, c] of CL) {
      const s = steadyDrift(c);
      let vmin = 9;
      for (let i = 0; i < ticks(2); i++) {
        s.tick(s.car.dir, 0);
        if (s.drift) vmin = Math.min(vmin, s.car.speed / PC.vmax);
      }
      expect(vmin).toBeGreaterThanOrEqual(0.766 - 0.005);
    }
  });
});

// ------------------------------------------------------------------------------------------ R158
describe('R158 drift end', () => {
  const endTick = (c: number, u: number) => {
    const s = steadyDrift(c);
    const dir = s.car.dir;
    for (let i = 0; i < ticks(1); i++) {
      s.tick(dir * u, 0);
      if (!s.drift) return { s, dir };
    }
    throw new Error('no drift end');
  };
  it('on the end tick: GRIP, dir 0, R82 effects (carry, yaw, yawRate), switch window to the other side, exitTicks 0', () => {
    for (const [, c] of CL)
      for (const u of [0, -1]) {
        const { s, dir } = endTick(c, u);
        const p = PC;
        const A = s.curve0 * s.sp0 * p.kYaw;
        const sG = clamp(A / p.velGrip, -p.slipGripMax, p.slipGripMax);
        const k = cf(s.car);
        expect(s.car.state).toBe('GRIP');
        expect(s.car.dir).toBe(0);
        expect(k.winTicks).toBe(ticks(M.switchWindow)); // 36
        expect(k.winDir).toBe(-dir);
        expect(Math.abs(k.wBeta)).toBeLessThan(M.betaOn);
        expect(k.wBeta * dir).toBeGreaterThanOrEqual(0); // wBeta = dir*beta
        expect(s.car.carry).toBeCloseTo(k.wBeta / SLIP_DEG - sG, 9);
        expect(s.car.yaw).toBeCloseTo(s.car.vel + sG, 9);
        expect(s.car.yawRate).toBeCloseTo(A, 9);
        expect(k.exitTicks).toBe(0);
      }
  });
  it('release (steer 0) on the end tick starts the R85f memory: relSide = sign(vInf), relV = vel if vel*vInf > 0 else 0', () => {
    for (const [, c] of CL) {
      const { s } = endTick(c, 0);
      const p = PC;
      const A = s.curve0 * s.sp0 * p.kYaw;
      const sG = clamp(A / p.velGrip, -p.slipGripMax, p.slipGripMax);
      const vInf = -A / p.yawAlign - sG;
      expect(s.car.relSide).toBe(Math.sign(vInf));
      expect(s.car.relV).toBe(s.car.vel * vInf > 0 ? s.car.vel : 0);
    }
  });
  it('release end times (beta -> 0 through betaTau, then 0.2 s below 8.4): medium 0.35, hard 0.40, sharp 0.43 s (+-0.02)', () => {
    // Hand: 0.12*ln(b0/8.4) + 0.2: medium 0.12*ln(30.6/8.4) + 0.2 = 0.355; hard 0.408; sharp 0.429.
    for (const [c, t] of [
      [C.medium!, 0.35],
      [C.hard!, 0.4],
      [C.sharp!, 0.43],
    ] as const) {
      const s = steadyDrift(c);
      let n = 0;
      while (s.drift && n < 240) {
        s.tick(0, 0);
        n++;
      }
      expect(Math.abs(n * DT - t)).toBeLessThanOrEqual(0.02);
    }
  });
  it('switch window: counter-steer -1 after the end latches the other side without a lift; the same side does not', () => {
    for (const [, c] of CL) {
      const a = steadyDrift(c);
      const dir = a.car.dir;
      for (let i = 0; i < ticks(0.6); i++) a.tick(-dir, 0);
      expect(a.entryDirs.slice(1)).toContain(-dir);
      const b = steadyDrift(c);
      let ended = false;
      for (let i = 0; i < ticks(0.6); i++) {
        if (!b.drift) ended = true;
        b.tick(ended ? dir : 0, 0); // release, then full steer back to the old side, no lift
      }
      expect(b.entries).toBe(1);
    }
  });
  it('exitTicks counts GRIP ticks after the end and the ramp is full after exitRamp: 1, 2, ... then >= 36', () => {
    const { s } = endTick(C.hard!, 0);
    for (let k = 1; k <= 50; k++) {
      s.tick(0, 0);
      if (k <= 36) expect(cf(s.car).exitTicks).toBe(k);
      else expect(cf(s.car).exitTicks).toBeGreaterThanOrEqual(36);
    }
  });
  it('drift end by speed: below driftExitSpeed*vmax (0.3) the drift ends', () => {
    const s = steadyDrift(C.hard!);
    let n = 0;
    while (s.drift && n < ticks(30)) {
      s.tick(s.car.dir, -1);
      if (s.drift) expect(s.car.speed).toBeGreaterThanOrEqual(PC.driftExitSpeed * PC.vmax - 1e-9);
      n++;
    }
    expect(s.drift).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------ R163 (c)
describe('R163 (c) exit in the corner: release and counter-steer', () => {
  // Spike partExit; "outward" = -(x - x0)*dir; rise = growth of max(0, outward vx) per tick, 0.3 s.
  const exit = (c: number, u: number) => {
    const s = steadyDrift(c);
    const dir = s.car.dir;
    const x0 = s.car.x;
    const out: Record<string, number> = {};
    let end = NaN;
    let rise = 0;
    let prev = s.car.vx;
    for (let i = 0; i < ticks(1); i++) {
      s.tick(dir * u, 0);
      if (!s.drift && Number.isNaN(end)) end = (i + 1) * DT;
      if (i < ticks(0.3))
        rise = Math.max(rise, Math.max(0, -s.car.vx * dir) - Math.max(0, -prev * dir));
      prev = s.car.vx;
      for (const m of [0.3, 0.6, 1.0])
        if (i + 1 === ticks(m)) out[String(m)] = -(s.car.x - x0) * dir;
    }
    return { out, end, rise };
  };
  for (const [name, c, tEnd] of [
    ['medium', C.medium!, 0.35],
    ['hard', C.hard!, 0.4],
    ['sharp', C.sharp!, 0.43],
  ] as const) {
    it(`${name}, release: outward <= 0.03 / 0.08 / 0.18 at 0.3 / 0.6 / 1.0 s; rise <= 0.01; end ${tEnd} s +-0.02`, () => {
      const r = exit(c, 0);
      expect(r.out['0.3']!).toBeLessThanOrEqual(0.03);
      expect(r.out['0.6']!).toBeLessThanOrEqual(0.08);
      expect(r.out['1']!).toBeLessThanOrEqual(0.18);
      expect(r.rise).toBeLessThanOrEqual(0.01);
      expect(Math.abs(r.end - tEnd)).toBeLessThanOrEqual(0.02);
    });
    it(`${name}, counter-steer -1: end 0.22..0.25 s, outward <= 0.03 at 0.3 s, rise <= 0.03`, () => {
      const r = exit(c, -1);
      expect(r.end).toBeGreaterThanOrEqual(0.22 - DT);
      expect(r.end).toBeLessThanOrEqual(0.25 + DT);
      expect(r.out['0.3']!).toBeLessThanOrEqual(0.03);
      expect(r.rise).toBeLessThanOrEqual(0.03);
    });
  }
});

// ------------------------------------------------------------------------------------------ R163 (d)
describe('R163 (d) drift on a straight slows and dies by itself', () => {
  for (const st of [1, 0.5]) {
    it(`lift + steer ${st} from the same tick: min speed 0.826 +-0.01, end <= 0.75 s, speed 1.000 at 1.5 s`, () => {
      const s = new Sim(figTrack(0, 4000, 0), PC, 1, 0, 60);
      let vmin = 9;
      let latched = false;
      let end = NaN;
      for (let i = 0; i < ticks(1.5); i++) {
        s.tick(st, i < 12 ? -1 : 0);
        vmin = Math.min(vmin, s.car.speed / PC.vmax);
        if (s.drift) latched = true;
        if (latched && !s.drift && Number.isNaN(end)) end = (i + 1) * DT;
      }
      expect(latched).toBe(true);
      expect(Math.abs(vmin - 0.826)).toBeLessThanOrEqual(0.01);
      expect(end).toBeLessThanOrEqual(0.75);
      expect(Math.abs(s.car.speed / PC.vmax - 1)).toBeLessThanOrEqual(0.005);
    });
  }
});

// ------------------------------------------------------------------------------------------ R163 (e)
describe('R163 (e) no input in a corner: honest slide outward, the car does not turn by itself', () => {
  for (const [name, c, edge] of [
    ['medium', C.medium!, 1.06],
    ['hard', C.hard!, 0.81],
    ['sharp', C.sharp!, 0.76],
  ] as const) {
    it(`${name}: steer 0, gas 0 from x 0 at vmax: 0 drifts, x only outward, |x| = 1 at ${edge} s +-0.03`, () => {
      const s = new Sim(figTrack(c, 4000, 0), PC, 1, 0, 30);
      let tEdge = NaN;
      let prevX = 0;
      for (let i = 0; i < ticks(2); i++) {
        s.tick(0, 0);
        expect(s.car.x).toBeLessThanOrEqual(prevX + 1e-12); // right corner: outward = -x
        prevX = s.car.x;
        if (Math.abs(s.car.x) >= 1 && Number.isNaN(tEdge)) tEdge = (i + 1) * DT;
      }
      expect(s.entries).toBe(0);
      expect(Math.abs(tEdge - edge)).toBeLessThanOrEqual(0.03);
    });
  }
  it('easy: the edge is not reached within 2 s', () => {
    const s = new Sim(figTrack(C.easy!, 4000, 0), PC, 1, 0, 30);
    for (let i = 0; i < ticks(2); i++) s.tick(0, 0);
    expect(Math.abs(s.car.x)).toBeLessThan(1);
    expect(s.entries).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------ R159
describe('R159 GRIP of model C = GRIP of model B; lift slows; no R85f start on a GRIP steer release', () => {
  it('on a straight with throttle >= 0, C = B bit for bit (B fields, every tick, seeded steer; C also gets random drift flags)', () => {
    const tr = constTrack(0);
    const a = createRace(1, 1);
    const b = createRace(1, 1);
    a.cars[0]!.speed = b.cars[0]!.speed = PC.vmax;
    const fa: InputFrame = { steer: 0, brake: false, drift: false, throttle: 0 };
    const fb: InputFrame = { steer: 0, brake: false, drift: false };
    const g = new Lcg(21);
    const keys = [
      'z',
      'x',
      'speed',
      'vx',
      'steer',
      'yaw',
      'yawRate',
      'vel',
      'carry',
      'angle',
      'state',
      'dir',
    ] as const;
    for (let i = 0; i < ticks(15); i++) {
      if (i % 20 === 0) {
        fa.steer = fb.steer = g.next() < 0.3 ? 0 : 2 * g.next() - 1;
        fa.throttle = g.next() < 0.5 ? 0 : g.next();
        fa.drift = g.next() < 0.5;
      }
      step(a, [fa], tr, [PC]);
      step(b, [fb], tr, [PB1]);
      for (const k of keys) expect(a.cars[0]![k]).toBe(b.cars[0]![k]);
    }
  });
  it('lift in GRIP replaces the acceleration: thr -0.5 for 12 ticks from vmax: 1 - 12*0.175/120 = 0.9825', () => {
    const s = new Sim(constTrack(0), PC, 1);
    for (let i = 0; i < 12; i++) s.tick(0, -0.5);
    expect(s.car.speed).toBeCloseTo(PC.vmax * (1 - (12 * 0.5 * M.liftDecel) / 120), 12);
  });
  it('lift never takes the speed below 0', () => {
    const s = new Sim(constTrack(0), PC, 0.01);
    for (let i = 0; i < 120; i++) {
      s.tick(0, -1);
      expect(s.car.speed).toBeGreaterThanOrEqual(0);
    }
    expect(s.car.speed).toBe(0);
  });
  it('a GRIP steer release in a corner does not start the R85f memory (relSide stays 0)', () => {
    const s = new Sim(figTrack(C.medium!, 4000, 0), PC, 1, 0, 60);
    for (let i = 0; i < ticks(1); i++) s.tick(gripSteer(s, 0), 0);
    for (let i = 0; i < ticks(0.5); i++) {
      s.tick(0, 0);
      expect(s.car.relSide).toBe(0);
    }
    expect(s.entries).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------ R163 (g)
describe('R163 (g) tap-drifts are slower than a held drift by at least 5%', () => {
  for (const fig of ['hairpin', 'hook', 'sweeper']) {
    it(`${fig}: cycles 0.15/0.15, 0.25/0.25, 0.4/0.2 are >= 5% slower than the ideal held drift`, () => {
      const { track, len } = figTrackOf(fig);
      const held = figureRun(track, IDEAL, len).t;
      for (const [on, off] of [
        [0.15, 0.15],
        [0.25, 0.25],
        [0.4, 0.2],
      ] as const) {
        const t = tapRun(track, len, on, off);
        expect((t - held) / held).toBeGreaterThanOrEqual(0.05);
      }
    });
  }
});

// ------------------------------------------------------------------------------------------ R163 (i)
describe('R163 (i) S-bends: one entry per corner, a tight line, no big speed loss', () => {
  for (const fig of ['chicane', 'scurve', 'flick', 'esses', 'switchback']) {
    it(`${fig}: the ideal driver enters once per corner on its side, |x| <= 0.12, min speed >= 0.9`, () => {
      const { track, len } = figTrackOf(fig);
      const r = figureRun(track, IDEAL, len);
      expect(r.entryDirs).toEqual(cornerSides(track, len));
      expect(Math.max(-r.xmin, r.xmax)).toBeLessThanOrEqual(0.12);
      expect(r.vmin).toBeGreaterThanOrEqual(0.9);
    });
  }
  it('grip-only is never in DRIFT on the S-bends', () => {
    for (const fig of ['chicane', 'scurve']) {
      const { track, len } = figTrackOf(fig);
      expect(figureRun(track, GRIPL, len).entries).toBe(0);
    }
  });
});

// ------------------------------------------------------------------------------------------ properties
describe('R150-R159 properties: symmetry, determinism, JSON round trip, copyRaceState, no allocations', () => {
  /** Seeded two-axis script on test-twisty (lifts included). */
  function play(
    sign: number,
    n: number,
    s = createRace(1, 1),
    from = 0,
    tr: Track = twistyTrack(),
  ): RaceState {
    const c = s.cars[0]!;
    if (from === 0) c.speed = PC.vmax;
    const g = new Lcg(77);
    const fr: InputFrame = { steer: 0, brake: false, drift: false, throttle: 0 };
    let st = 0;
    let thr = 0;
    for (let i = 0; i < n; i++) {
      if (i % 30 === 0) {
        st = g.next() < 0.2 ? 0 : 2 * g.next() - 1;
        thr = g.next() < 0.3 ? -1 : 2 * g.next() - 1;
      }
      if (i < from) continue;
      fr.steer = sign * st;
      fr.throttle = thr;
      step(s, [fr], tr, [PC]);
    }
    return s;
  }
  it('left/right: the mirrored track and steer give mirrored x, vx, vel, yaw, wBeta, refA and the same beta', () => {
    const tr = twistyTrack();
    const mt = mirrorTrack(tr);
    for (let n = 60; n <= 2400; n += 60) {
      const a = play(1, n, createRace(1, 1), 0, tr).cars[0]!;
      const b = play(-1, n, createRace(1, 1), 0, mt).cars[0]!;
      for (const k of ['x', 'vx', 'vel', 'yaw'] as const) expect(b[k]).toBeCloseTo(-a[k], 9);
      expect(b.dir).toBe((-a.dir as number) || 0);
      expect(cf(b).beta).toBeCloseTo(cf(a).beta, 9);
      expect(cf(b).wBeta).toBeCloseTo(-cf(a).wBeta, 9);
      expect(cf(b).refA).toBeCloseTo(-cf(a).refA, 9);
      expect(b.speed).toBeCloseTo(a.speed, 9);
    }
  });
  it('determinism: the same inputs twice give an identical state', () => {
    expect(JSON.stringify(play(1, 3000))).toBe(JSON.stringify(play(1, 3000)));
  });
  it('JSON round trip in the middle (state with the new fields) changes nothing', () => {
    const a = play(1, 1200);
    const half = play(1, 600);
    for (const k of C_FIELDS) expect(typeof cf(half.cars[0]!)[k]).toBe('number');
    const b = JSON.parse(JSON.stringify(half)) as RaceState;
    play(1, 1200, b, 600);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it('copyRaceState copies every model C field: a copy mid-drift continues identically', () => {
    const src = steadyDrift(C.hard!, 0.6);
    expect(src.drift).toBe(true);
    const dst = createRace(5, 1);
    copyRaceState(src.st, dst);
    expect(JSON.stringify(dst)).toBe(JSON.stringify(src.st));
    const fr: InputFrame = { steer: 0.3, brake: false, drift: false, throttle: -0.2 };
    for (let i = 0; i < 120; i++) {
      step(src.st, [fr], src.track, [PC]);
      step(dst, [fr], src.track, [PC]);
    }
    expect(JSON.stringify(dst)).toBe(JSON.stringify(src.st));
  });
  it('step allocates nothing: same car objects and key set over 10000 ticks; keys include the R152 fields', () => {
    const s = createRace(7, 1);
    const cars = s.cars;
    const car = cars[0]!;
    const keys = Object.keys(car).sort();
    for (const k of C_FIELDS) expect(keys).toContain(k);
    play(1, 10000, s);
    expect(s.cars).toBe(cars);
    expect(s.cars[0]).toBe(car);
    expect(Object.keys(car).sort()).toEqual(keys);
  });
});

// ------------------------------------------------------------------------------------------ H14 = B pins
describe('R150 H14 = B: model 1 stays bit for bit as before model C, and ignores throttle', () => {
  // Hashes recorded on the code before model C (commit 89681fd + type stubs). Scripts set throttle;
  // model 1 must not read it (same hash as without throttle).
  const withThr =
    (seed: number, drift: boolean) =>
    (t: number, _c: unknown, fr: InputFrame): void => {
      const g = new Lcg(seed * 7919 + Math.floor(Math.round(t / DT) / 30));
      fr.steer = g.next() < 0.25 ? 0 : 2 * g.next() - 1;
      fr.drift = drift && g.next() < 0.5;
      fr.throttle = 2 * g.next() - 1;
    };
  const noThr =
    (seed: number, drift: boolean) =>
    (t: number, c: unknown, fr: InputFrame): void => {
      withThr(seed, drift)(t, c, fr);
      delete fr.throttle;
    };
  const P_SHIPPED: CarParams = { ...PB1 }; // base car B numbers, variant 3, turbo off
  it('test-twisty, seeded steer + drift + throttle, 30 s: hash pinned', () => {
    expect(traceHash(P_SHIPPED, twistyTrack(), 30, withThr(1, true))).toBe(PIN_B_DRIFT);
  });
  it('test-twisty, seeded steer, no drift, throttle, 30 s: hash pinned', () => {
    expect(traceHash(P_SHIPPED, twistyTrack(), 30, withThr(2, false))).toBe(PIN_B_GRIP);
  });
  it('throttle is not read by model 1: the same hashes without the field', () => {
    expect(traceHash(P_SHIPPED, twistyTrack(), 30, noThr(1, true))).toBe(PIN_B_DRIFT);
    expect(traceHash(P_SHIPPED, twistyTrack(), 30, noThr(2, false))).toBe(PIN_B_GRIP);
  });
});
const PIN_B_DRIFT = '04aa829a:0.67031249999999998';
const PIN_B_GRIP = '7acecf1c:0.97058232428159341';

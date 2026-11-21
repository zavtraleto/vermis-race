// T68 (docs/brief.md, 2026-11-20): R85c grip dodge, R83b drift steer floor, R84b inward dive knee,
// R85d drift lead ramp, R86e scrub debt, R87 driftTicks, R86c postponed (data).
// Written from the brief, not from the implementation. New CarParams fields (gripDodge, dodgeFadeA,
// driftMinU, driftDive, driftKnee, leadRamp, debtTime) and Car fields (driftTicks, scrubDebt) may not be
// in the types yet, hence the casts. DT = 1/120.
//
// Unit tests use the explicit model B set Q (accel 0, slipDrag 0, H17/H18 off, T68 off) plus the one
// rule under test, so every number is hand-computable. Criteria use the REAL car data (base.json,
// model 1, lamps off, driftTurbo 0 as R86c now says).
import { describe, expect, it } from 'vitest';
import base from '../../src/data/cars/base.json';
import { baseCar } from '../../src/data/cars';
import sprites from '../../src/data/sprites.json';
import curves from '../../src/data/tracks/curves.json';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { Q, STRAIGHT, car, constTrack, inp, mk, stepB, stepN } from './modelb_helpers';
import { ENTRY_D } from './pinT70';
import { NO_T77 } from './pinT77';

const C = curves as { easy: number; medium: number; hard: number; sharp: number };
const B = base as unknown as Record<string, number>;
const W = (sprites as unknown as { weight: Record<string, number> }).weight;
const H = (p: CarParams, over: Record<string, number>): CarParams =>
  ({ ...p, ...over }) as CarParams;
type T68Car = { driftTicks: number; scrubDebt: number };
const t68 = (c: Car): T68Car => c as unknown as T68Car;
const num = (p: CarParams, k: string): number => (p as unknown as Record<string, number>)[k]!;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Real data, model B, lamps off, driftTurbo 0 (R86c postponed), walls and off-road loss removed. */
// T71: T68 criteria (R83b, R85d on a straight) are variant 3 drifts: driftEntry 3 pinned (brief R81f).
// T77: H20 / H21 off: brief R84c, the R83b hold steers 0.537 / 0.817 "do not change" only at driftRail 0.
const REAL: CarParams = H(baseCar, {
  model: 1,
  crashMinSpeed: 1e9,
  driftTurbo: 0,
  ...ENTRY_D,
  ...NO_T77,
});
const FREE: CarParams = H(REAL, { xLimit: 1e9, offroadMul: 1, offroadSteerMul: 1 });

// ------------------------------------------------------------------------------------------------
describe('T68 data (cars/base.json, hypotheses.json)', () => {
  it('R85c: gripDodge 0.1 (T71, author; was 0.45), dodgeFadeA 4', () => {
    expect(B.gripDodge).toBe(0.1);
    expect(B.dodgeFadeA).toBe(4);
  });
  it('R83b: driftMinU 0.5 (T69, author: keep the floor, slightly stronger; was 0.4)', () =>
    expect(B.driftMinU).toBe(0.5));
  it('R84b withdrawn by the author (T69): driftDive 0 = dive off (was 1.5)', () => {
    expect(B.driftDive).toBe(0);
    // the code path may stay (default off); its knee, if still in the data, stays a valid fraction
    if (B.driftKnee !== undefined) expect(B.driftKnee).toBeLessThan(1);
  });
  it('R85d: leadRamp 0.4 s', () => expect(B.leadRamp).toBe(0.4));
  it('R86e withdrawn (T71, with R86f): debtTime 0 = off (was 0.5 s)', () =>
    expect(B.debtTime).toBe(0));
  // R86c postponed (driftTurbo 0, H18 A): asserted in modelb_turbo.test.ts 'R86c data (H18)'.
});

// ------------------------------------------------------------------------------------------------
describe('R85c grip dodge on straights (GRIP vx term, not fed back into vel/yaw)', () => {
  // vx += gripDodge*steer*sp*latScale*max(0, 1 - |A|/dodgeFadeA), A = curve*sp*kYaw (kYaw 2), latScale 1.
  const DODGE = H(Q, { gripDodge: 0.45, dodgeFadeA: 4 });
  const OFF = H(Q, { gripDodge: 0, dodgeFadeA: 4 });
  // [curve, speed, steer, expected vx difference]
  const CASES: [number, number, number, number][] = [
    [0, 1, 1, 0.45 * 1 * 1 * 1], // straight: fade 1 -> 0.45
    [0, 1, -0.5, 0.45 * -0.5 * 1 * 1], // -0.225
    [0, 0.6, 1, 0.45 * 1 * 0.6 * 1], // sp 0.6 -> 0.27
    [1, 1, 1, 0.45 * 1 * 1 * (1 - 2 / 4)], // A = 1*1*2 = 2 -> fade 0.5 -> 0.225
    [-1, 1, 1, 0.45 * 1 * 1 * (1 - 2 / 4)], // |A| = 2 (left curve): same fade 0.5
    [1, 0.6, 0.3, 0.45 * 0.3 * 0.6 * (1 - 1.2 / 4)], // A = 1*0.6*2 = 1.2 -> fade 0.7 -> 0.0567
    [2, 1, 1, 0], // A = 4 = dodgeFadeA (easy at vmax) -> 0
    [C.hard, 1, 1, 0], // A = 14 > 4 -> max(0, ...) = 0
  ];
  it.each(CASES)(
    'curve %f, speed %f, steer %f: vx(dodge) - vx(no dodge) = %f every tick',
    (cv, sp, st, d) => {
      const a = mk({ speed: sp });
      const b = mk({ speed: sp });
      const tr = constTrack(cv);
      for (let i = 0; i < 60; i++) {
        stepB(a, inp(st), DODGE, tr);
        stepB(b, inp(st), OFF, tr);
        expect(car(a).state).toBe('GRIP');
        expect(car(a).vel).toBe(car(b).vel); // not fed back into the course
        expect(car(a).yaw).toBe(car(b).yaw);
        expect(car(a).vx - car(b).vx).toBeCloseTo(d, 12);
      }
      // x integrates the extra vx: 60 ticks * DT * d
      expect(car(a).x - car(b).x).toBeCloseTo(60 * DT * d, 9);
    },
  );
  it('steer 0: no dodge at all (the released finger stops the car as before)', () => {
    const a = mk({ speed: 1, yaw: 0.4, vel: 0.6, yawRate: 1 });
    const b = mk({ speed: 1, yaw: 0.4, vel: 0.6, yawRate: 1 });
    for (let i = 0; i < 60; i++) {
      stepB(a, inp(0), DODGE);
      stepB(b, inp(0), OFF);
      expect(car(a).vx).toBe(car(b).vx);
      expect(car(a).x).toBe(car(b).x);
    }
  });
  it('DRIFT: no dodge (identical drift with gripDodge 0.45 and 0)', () => {
    const over = {
      state: 'DRIFT' as const,
      dir: 1 as const,
      driftHeld: true,
      speed: 1,
      yaw: 1,
      vel: 0.2,
    };
    const a = mk(over);
    const b = mk(over);
    for (let i = 0; i < 60; i++) {
      stepB(a, inp(0.7, true), DODGE);
      stepB(b, inp(0.7, true), OFF);
    }
    expect(car(a).state).toBe('DRIFT');
    expect(JSON.stringify(car(a))).toBe(JSON.stringify(car(b)));
  });
  it('left/right symmetry: mirrored steer gives mirrored vx and x', () => {
    const r = mk({ speed: 1 });
    const l = mk({ speed: 1 });
    for (let i = 0; i < 40; i++) {
      stepB(r, inp(0.8), DODGE);
      stepB(l, inp(-0.8), DODGE);
      expect(car(l).vx).toBeCloseTo(-car(r).vx, 12);
      expect(car(l).x).toBeCloseTo(-car(r).x, 12);
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe('R83b drift steer floor (uc = max(driftMinU, clamp(u, 0, 1)))', () => {
  // driftCounter 0 (base.json): the raw u is then used nowhere else, so every steer below the floor
  // must give exactly the state of steer = driftMinU (only the raw input differs: the `steer` field and
  // the R81 flick buffer `steerHist`, which records the raw steer every tick in any state).
  const FLOOR = H(Q, { driftCounter: 0, driftMinU: 0.4 });
  const NOFLOOR = H(Q, { driftCounter: 0, driftMinU: 0 });
  const run = (p: CarParams, dir: 1 | -1, steer: number) => {
    const s = mk({ state: 'DRIFT', dir, driftHeld: true, speed: 1, yaw: dir * 1, vel: dir * 0.2 });
    stepN(s, 90, inp(steer, true), p);
    const c = { ...car(s) } as Record<string, unknown>;
    delete c.steer;
    delete c.steerHist; // R81: raw steer history, legitimately differs
    return { c, state: car(s).state, d: car(s).dir };
  };
  for (const dir of [1, -1] as const) {
    it.each([-1, -0.5, 0, 0.2, 0.4])(
      `dir ${dir}: steer %f*dir gives the same state as steer 0.4*dir`,
      (u) => {
        const a = run(FLOOR, dir, u * dir);
        const ref = run(FLOOR, dir, 0.4 * dir);
        expect(a.state).toBe('DRIFT');
        expect(a.d).toBe(dir); // dir only changes by release (R82) and a new entry
        expect(JSON.stringify(a.c)).toBe(JSON.stringify(ref.c));
      },
    );
  }
  it('above the floor the steer still matters (0.6 differs from 0.4)', () => {
    expect(JSON.stringify(run(FLOOR, 1, 0.6).c)).not.toBe(JSON.stringify(run(FLOOR, 1, 0.4).c));
  });
  it('driftMinU 0 is the old rule: steer 0 differs from steer 0.4', () => {
    expect(JSON.stringify(run(NOFLOOR, 1, 0).c)).not.toBe(JSON.stringify(run(NOFLOOR, 1, 0.4).c));
  });
  it('left/right symmetry with the floor: steer -1 for dir +1 mirrors steer +1 for dir -1', () => {
    const r = run(FLOOR, 1, -1).c;
    const l = run(FLOOR, -1, 1).c;
    for (const k of ['x', 'vx', 'yaw', 'vel', 'yawRate', 'angle'] as const)
      expect(l[k] as number).toBeCloseTo(-(r[k] as number), 12);
  });
});

// ------------------------------------------------------------------------------------------------
describe('R84b inward dive (withdrawn T69; off by default; mechanism kept under an explicit override)', () => {
  // R84b is withdrawn by the author (driftDive 0 in the data). The code path may stay: these unit tests
  // switch it on explicitly (driftDive 1.5, driftKnee 0.9) and pin the formula as it was written.
  // velT += dir*driftDive*max(0, min(a, uc) - driftKnee)/(1 - driftKnee), a = slip*dir/slipFull after R83,
  // before vel += (velT - vel)*(1 - exp(-velGripDrift*DT)). Straight (A = 0), driftCounter 0, velGripDrift 8.
  const P = H(Q, {
    driftCounter: 0,
    driftMinU: 0,
    driftDive: 1.5,
    driftKnee: 0.9,
    velGripDrift: 8,
  });
  const NODIVE = H(P, { driftDive: 0 });
  const k8 = 1 - Math.exp(-8 * DT); // 1 - exp(-0.0666667) = 0.064493
  const SF = Q.slipFull; // 2.64
  const LAT = Q.driftLat; // 0.46
  const knee = (v: number) => Math.max(0, v - 0.9) / (1 - 0.9);

  it('full angle, full steer: velT = 0.46*1 + 1.5*(1 - 0.9)/0.1 = 1.96, vel = 1.96*0.064493 = 0.126406', () => {
    for (const dir of [1, -1] as const) {
      // slip = slipFull*dir already at the target slipT = dir*slipFull*1, yawRate 0 -> R83 keeps a = 1
      const s = mk({ state: 'DRIFT', dir, driftHeld: true, speed: 1, yaw: dir * SF, vel: 0 });
      stepB(s, inp(dir, true), P);
      expect(car(s).state).toBe('DRIFT');
      expect(car(s).vel).toBeCloseTo(dir * (LAT * 1 + 1.5 * knee(1)) * k8, 12);
      expect(car(s).vel).toBeCloseTo(dir * 0.126406, 5);
    }
  });
  it('min(a, uc): full angle but steer 0.95 -> the dive counts uc = 0.95 (term 0.75)', () => {
    const s = mk({ state: 'DRIFT', dir: 1, driftHeld: true, speed: 1, yaw: SF, vel: 0 });
    stepB(s, inp(0.95, true), P);
    // R83 this tick: yawRate = 64*(0.95*2.64 - 2.64)*DT = -0.0704, slip = 2.64 - 0.0704*DT
    const yr = 8 * 8 * (0.95 * SF - SF) * DT;
    const a = (SF + yr * DT) / SF; // 0.999778
    const velT = LAT * a + 1.5 * knee(Math.min(a, 0.95)); // 0.459898 + 0.75
    expect(car(s).vel).toBeCloseTo(velT * k8, 9);
  });
  it('below the knee nothing changes: steady drift at steer 0.85 is identical with driftDive 1.5 and 0', () => {
    const over = {
      state: 'DRIFT' as const,
      dir: 1 as const,
      driftHeld: true,
      speed: 1,
      yaw: 0.85 * SF,
      vel: 0,
    };
    const a = mk(over);
    const b = mk(over);
    for (let i = 0; i < 120; i++) {
      stepB(a, inp(0.85, true), P);
      stepB(b, inp(0.85, true), NODIVE);
    }
    expect(JSON.stringify(car(a))).toBe(JSON.stringify(car(b)));
  });
  it('the dive has weight: vel approaches velT through velGripDrift (not a jump), monotone', () => {
    const s = mk({ state: 'DRIFT', dir: 1, driftHeld: true, speed: 1, yaw: SF, vel: 0 });
    let last = 0;
    for (let i = 0; i < 30; i++) {
      stepB(s, inp(1, true), H(P, { driftSpeedLoss: 0 }));
      expect(car(s).vel).toBeGreaterThan(last);
      expect(car(s).vel).toBeLessThan(1.96);
      last = car(s).vel;
    }
  });
  it('counted on the gained angle, not the finger: on the R81c entry tick (angle ~ 0) vel is the same as without the dive', () => {
    const E = H(P, { driftEntry: 3 });
    const a = mk({ speed: 1 });
    const b = mk({ speed: 1 });
    stepB(a, inp(1, true), E);
    stepB(b, inp(1, true), H(E, { driftDive: 0 }));
    expect(car(a).state).toBe('DRIFT');
    expect(car(a).vel).toBe(car(b).vel);
  });
});

// ------------------------------------------------------------------------------------------------
describe('R85d drift lead ramp (ramp = min(1, driftTicks*DT/leadRamp); 0 on the entry tick)', () => {
  // R85: vx = vel*sp*latScale + dir*driftLead*ramp*e*sp*latScale, e = uc - slip*dir/slipFull.
  // driftTicks is read in R85 before R87 adds 1, so after a step ramp = min(1, (driftTicks - 1)*DT/leadRamp).
  // Speed constant 1 (accel 0, driftSpeedLoss 0), sp = 1, latScale 1, straight, driftEntry 3 (R81c).
  const P = H(Q, {
    driftEntry: 3,
    driftLead: 1.25,
    leadRamp: 0.4,
    driftSpeedLoss: 0,
    driftMinU: 0,
    driftDive: 0,
    driftCounter: 0,
  });
  const leadOf = (c: Car): number => c.vx - c.vel; // sp = latScale = 1
  const expected = (c: Car, steer: number, leadRamp: number): number => {
    const dt = t68(c).driftTicks - 1;
    const ramp = leadRamp === 0 ? 1 : Math.min(1, (dt * DT) / leadRamp);
    const e = clamp(steer * c.dir, 0, 1) - ((c.yaw - c.vel) * c.dir) / Q.slipFull;
    return c.dir * 1.25 * ramp * e;
  };
  for (const dir of [1, -1] as const) {
    it(`dir ${dir}: entry tick has no lead (ramp 0), then lead = driftLead*ramp*e every tick for 0.6 s`, () => {
      const s = mk({ speed: 1 });
      stepB(s, inp(dir, true), P);
      expect(car(s).state).toBe('DRIFT');
      expect(t68(car(s)).driftTicks).toBe(1);
      expect(leadOf(car(s))).toBe(0);
      for (let i = 0; i < 72; i++) {
        stepB(s, inp(dir, true), P);
        expect(leadOf(car(s))).toBeCloseTo(expected(car(s), dir, 0.4), 12);
      }
    });
  }
  it('leadRamp 0 is the old rule: ramp = 1 from the entry tick', () => {
    const p0 = H(P, { leadRamp: 0 });
    const s = mk({ speed: 1 });
    stepB(s, inp(1, true), p0);
    expect(car(s).state).toBe('DRIFT');
    expect(leadOf(car(s))).toBeGreaterThan(0); // e > 0: the body has not caught the finger yet
    for (let i = 0; i < 30; i++) {
      stepB(s, inp(1, true), p0);
      expect(leadOf(car(s))).toBeCloseTo(expected(car(s), 1, 0), 12);
    }
  });
  it('steady drift is unchanged (e = 0): after 3 s the lead is ~0 with and without the ramp', () => {
    const s = mk({ speed: 1 });
    stepN(s, 360, inp(0.6, true), P);
    expect(Math.abs(leadOf(car(s)))).toBeLessThan(1e-6);
  });

  it('criterion: straight, vmax, entry from full GRIP steer: |vx| in the first 0.4 s of DRIFT <= max |vx| of the 0.4 s of GRIP before', () => {
    for (const side of [1, -1] as const) {
      const s = createRace(1, 1);
      const c = s.cars[0]!;
      const f: InputFrame = { steer: side, brake: false, drift: false };
      const tick = () => {
        c.speed = REAL.vmax;
        step(s, [f], STRAIGHT, [FREE]);
        c.speed = REAL.vmax;
      };
      let gripMax = 0;
      for (let i = 0; i < 120; i++) {
        tick();
        if (i >= 120 - 48) gripMax = Math.max(gripMax, Math.abs(c.vx)); // last 0.4 s
      }
      expect(c.state).toBe('GRIP');
      f.drift = true;
      let driftMax = 0;
      for (let i = 0; i < 48; i++) {
        tick();
        expect(c.state).toBe('DRIFT');
        driftMax = Math.max(driftMax, Math.abs(c.vx));
      }
      expect(driftMax).toBeLessThanOrEqual(gripMax);
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe('R87 driftTicks (ticks of the current drift; 0 in GRIP)', () => {
  const P = H(Q, { driftEntry: 3 });
  it('createRace: driftTicks 0 and scrubDebt 0 on every car', () => {
    const s = createRace(3, 1);
    for (const c of s.cars) {
      expect(t68(c).driftTicks).toBe(0);
      expect(t68(c).scrubDebt).toBe(0);
    }
  });
  it('GRIP 0; entry tick 1; k drift ticks -> k; the exit tick -> 0', () => {
    const s = mk({ speed: 1 });
    stepN(s, 20, inp(0.5), P);
    expect(t68(car(s)).driftTicks).toBe(0);
    stepB(s, inp(1, true), P);
    expect(car(s).state).toBe('DRIFT');
    expect(t68(car(s)).driftTicks).toBe(1);
    stepN(s, 99, inp(1, true), P);
    expect(t68(car(s)).driftTicks).toBe(100);
    stepB(s, inp(1, false), P);
    expect(car(s).state).toBe('GRIP');
    expect(t68(car(s)).driftTicks).toBe(0);
    stepN(s, 10, inp(1, false), P);
    expect(t68(car(s)).driftTicks).toBe(0);
  });
  it('a new entry restarts from 0', () => {
    const s = mk({ speed: 1 });
    stepN(s, 50, inp(1, true), P);
    stepB(s, inp(1, false), P);
    stepB(s, inp(-1, true), P);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(-1);
    expect(t68(car(s)).driftTicks).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
describe('R86e scrub debt (drift is a commitment)', () => {
  // need = |A|/gripA, A = curve*sp*kYaw, gripA = yawRateMax/(1 + yawAlign/velGrip) = 15.75/(1 + 15/22) = 9.364865.
  // curve 6 at sp 1: A = 12, need = 1.281385; debt per tick = scrubRate*(need - 0.8)*vmax*DT
  //   = 0.6*0.481385/120 = 0.00240693. Speed constant 1 in DRIFT: accel 0, driftSpeedLoss 0 (cap = vmax).
  const CURVE = 6;
  const gripA = 15.75 / (1 + 15 / 22);
  const PER = (0.6 * (12 / gripA - 0.8) * 1) / 120;
  const P = H(Q, {
    driftEntry: 3,
    gripScrub: 1,
    scrubStart: 0.8,
    scrubRate: 0.6,
    debtTime: 0.5,
    driftSpeedLoss: 0,
  });
  const NODEBT = H(P, { debtTime: 0 });
  const TR = constTrack(CURVE);

  it('hand number: debt per tick on curve 6 at vmax = 0.0024069', () => {
    expect(PER).toBeCloseTo(0.0024069, 6);
  });
  for (const dir of [1, -1] as const) {
    it(`dir ${dir}: debt grows by the scrub of each of the first ticks, speed is not taken in DRIFT`, () => {
      const tr = constTrack(CURVE * dir);
      const a = mk({ speed: 1 });
      const b = mk({ speed: 1 });
      for (let i = 1; i <= 30; i++) {
        stepB(a, inp(dir, true), P, tr);
        stepB(b, inp(dir, true), H(P, { gripScrub: 0 }), tr);
        expect(car(a).state).toBe('DRIFT');
        expect(t68(car(a)).scrubDebt).toBeCloseTo(i * PER, 10);
        expect(car(a).speed).toBe(car(b).speed); // no speed taken while drifting
      }
      expect(t68(car(a)).scrubDebt).toBeCloseTo(0.0722078, 6); // 30 * 0.00240693
    });
  }
  it('early release (30 ticks = 0.25 s < debtTime): the debt is paid in speed on the exit tick, then both fields 0', () => {
    const a = mk({ speed: 1 });
    const b = mk({ speed: 1 });
    stepN(a, 30, inp(1, true), P, TR);
    stepN(b, 30, inp(1, true), NODEBT, TR);
    const D = t68(car(a)).scrubDebt;
    expect(car(a).speed).toBe(car(b).speed);
    stepB(a, inp(1, false), P, TR);
    stepB(b, inp(1, false), NODEBT, TR);
    expect(car(a).state).toBe('GRIP');
    // both cars then pay the same GRIP scrub R86b of this tick (sp differs by D: second order, < 0.001)
    expect(Math.abs(car(b).speed - car(a).speed - D)).toBeLessThan(1e-3);
    expect(t68(car(a)).scrubDebt).toBe(0);
    expect(t68(car(a)).driftTicks).toBe(0);
  });
  it('held past debtTime (80 ticks): the debt is forgiven (0) and the release costs nothing extra', () => {
    const a = mk({ speed: 1 });
    const b = mk({ speed: 1 });
    stepN(a, 80, inp(1, true), P, TR);
    stepN(b, 80, inp(1, true), NODEBT, TR);
    expect(t68(car(a)).scrubDebt).toBe(0);
    stepB(a, inp(1, false), P, TR);
    stepB(b, inp(1, false), NODEBT, TR);
    expect(car(a).speed).toBe(car(b).speed);
  });
  it('exit by speed (R82, speed < driftExitSpeed) also pays: speed = max(0, speed - debt)', () => {
    const a = mk({ speed: 1 });
    stepN(a, 30, inp(1, true), P, TR);
    const D = t68(car(a)).scrubDebt;
    car(a).speed = 0.29; // below driftExitSpeed 0.3: exit on the next tick; at sp 0.29 need = 3.48/9.36 < 0.8
    stepB(a, inp(1, true), P, TR);
    expect(car(a).state).toBe('GRIP');
    expect(car(a).speed).toBeCloseTo(0.29 - D, 9); // 0.2177922
    const z = mk({ speed: 1 });
    stepN(z, 30, inp(1, true), P, TR);
    car(z).speed = 0.05;
    stepB(z, inp(1, true), P, TR);
    expect(car(z).speed).toBe(0); // max(0, 0.05 - 0.072)
  });
  it('debtTime 0: no debt ever (as before); gripScrub 0: no debt either', () => {
    for (const p of [NODEBT, H(P, { gripScrub: 0 })]) {
      const s = mk({ speed: 1 });
      for (let i = 0; i < 40; i++) {
        stepB(s, inp(1, true), p, TR);
        expect(t68(car(s)).scrubDebt).toBe(0);
      }
    }
  });
  it('no debt where need <= scrubStart (straight)', () => {
    const s = mk({ speed: 1 });
    stepN(s, 30, inp(1, true), P);
    expect(car(s).state).toBe('DRIFT');
    expect(t68(car(s)).scrubDebt).toBe(0);
  });
  it('GRIP: both fields stay 0 while the GRIP scrub R86b works', () => {
    const s = mk({ speed: 1 });
    for (let i = 0; i < 60; i++) {
      stepB(s, inp(1), P, TR);
      expect(t68(car(s)).scrubDebt).toBe(0);
      expect(t68(car(s)).driftTicks).toBe(0);
    }
    expect(car(s).speed).toBeLessThan(1); // the R86b scrub is really on here
  });
  it('a new drift starts with a fresh debt', () => {
    const s = mk({ speed: 1 });
    stepN(s, 30, inp(1, true), P, TR);
    stepB(s, inp(1, false), P, TR);
    stepB(s, inp(1, true), P, TR);
    expect(car(s).state).toBe('DRIFT');
    expect(t68(car(s)).driftTicks).toBe(1);
    expect(t68(car(s)).scrubDebt).toBeLessThan(PER * 1.01); // only the entry tick's scrub
  });
  it('R2/R3: determinism and JSON round trip mid-debt continue identically', () => {
    const script = (s: RaceState, from: number, to: number) => {
      for (let i = from; i < to; i++) stepB(s, inp(i < 40 ? 1 : 0.5, i < 40 || i > 50), P, TR);
    };
    const a = mk({ speed: 1 });
    const b = mk({ speed: 1 });
    script(a, 0, 20);
    script(b, 0, 20);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = JSON.parse(JSON.stringify(a)) as RaceState;
    expect(t68(c.cars[0]!).scrubDebt).toBeGreaterThan(0);
    script(a, 20, 90);
    script(c, 20, 90);
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });
});

// ------------------------------------------------------------------------------------------------
// Criteria of R83b on the real data (T69 numbers, driftMinU 0.5, driftDive 0); R84b withdrawn. "Steady drift toward dir = +1, 3 s at the steer, speed free"
// from vmax: the drift state is put directly (as modelb_calibration.test.ts enterDrift), then 3 s of the
// held steer; numbers are the mean dx/dt (+ = toward the drift side / inward on a right curve) over the last 1 s.
function driftRun(p: CarParams, curve: number, s: number, secs = 3, track?: Track) {
  const race = createRace(1, 1);
  const c = race.cars[0]!;
  c.speed = p.vmax;
  const A = curve * p.kYaw;
  const slip = p.slipFull * clamp(s, 0, 1);
  c.state = 'DRIFT';
  c.dir = 1;
  c.driftHeld = true;
  c.vel = p.driftLat * (slip / p.slipFull) - p.driftPush * A;
  c.yaw = c.vel + slip;
  const tr = track ?? constTrack(curve);
  const f: InputFrame = { steer: s, brake: false, drift: true };
  let sum = 0;
  let n = 0;
  const N = Math.round(secs / DT);
  for (let i = 0; i < N; i++) {
    const x0 = c.x;
    step(race, [f], tr, [p]);
    if (i * DT >= secs - 1) {
      sum += (c.x - x0) / DT;
      n++;
    }
  }
  return { vx: sum / n, car: c, race };
}
/** R89 body angle (degrees) from sim fields; lead term with leadDeg (8 if the data has none yet). */
function bodyDeg(c: Car, p: CarParams): number {
  const sp = c.speed / p.vmax;
  const lead = sp < W.minSpeed! ? 0 : c.vx / (sp * p.latScale) - c.vel;
  return (c.yaw - c.vel + c.carry) * W.slipDeg! + c.vel * W.velDeg! + (W.leadDeg ?? 8) * lead;
}
function holdSteer(p: CarParams, curve: number): number {
  let lo = -1;
  let hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (driftRun(p, curve, mid, 8).vx > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

describe('R83b criterion (real data, steady drift dir +1, 3 s, free speed from vmax)', () => {
  // T69 bounds (driftMinU 0.5): measured with base.json + driftMinU 0.5 + driftDive 0 through `step`:
  // straight 0.221 / 23.6 deg, medium outward 0.017, hard outward 0.149, full -> -1 shift +0.376.
  it.each([-1, -0.5, 0])('straight, steer %f: vx*dir >= 0.20 and body angle R89 >= 20 deg', (s) => {
    const r = driftRun(FREE, 0, s);
    expect(r.car.state).toBe('DRIFT');
    expect(r.car.dir).toBe(1);
    expect(r.vx).toBeGreaterThanOrEqual(0.2);
    expect(bodyDeg(r.car, FREE)).toBeGreaterThanOrEqual(20);
  });
  it.each([-1, -0.5, 0])('medium, steer %f: outward at most 0.05', (s) => {
    expect(-driftRun(FREE, C.medium, s).vx).toBeLessThanOrEqual(0.05);
  });
  it.each([-1, -0.5, 0])('hard, steer %f: outward at most 0.20', (s) => {
    expect(-driftRun(FREE, C.hard, s).vx).toBeLessThanOrEqual(0.2);
  });
  it('hold steers on medium and hard change by at most 0.01 against driftMinU 0', () => {
    for (const cv of [C.medium, C.hard]) {
      const a = holdSteer(FREE, cv);
      const b = holdSteer(H(FREE, { driftMinU: 0 }), cv);
      expect(Math.abs(a - b)).toBeLessThanOrEqual(0.01);
    }
  });
  it('straight: full steer, then steer -1 for 2 s moves the car toward the drift side by at least +0.3', () => {
    const r = driftRun(FREE, 0, 1);
    const x0 = r.car.x;
    const f: InputFrame = { steer: -1, brake: false, drift: true };
    for (let i = 0; i < 240; i++) step(r.race, [f], STRAIGHT, [FREE]);
    expect(r.car.state).toBe('DRIFT');
    expect(r.car.x - x0).toBeGreaterThanOrEqual(0.3);
  });
  it('the floor uses the data: driftMinU of the real car is 0.5', () => {
    expect(num(REAL, 'driftMinU')).toBe(0.5);
  });
});

describe('R84b withdrawn (T69): the real car has no dive', () => {
  // With driftDive 0 in the data the real car must behave exactly as with an explicit driftDive 0,
  // whatever the knee; full steer inward is bounded again by the pre-T68 R89b numbers
  // (modelb_calibration.test.ts).
  it.each([
    ['straight', 0],
    ['medium', C.medium],
    ['hard', C.hard],
  ] as [string, number][])('%s, full steer: identical to an explicit driftDive 0', (_n, cv) => {
    const a = driftRun(FREE, cv, 1);
    const b = driftRun(H(FREE, { driftDive: 0 }), cv, 1);
    expect(JSON.stringify(a.race)).toBe(JSON.stringify(b.race));
  });
  it('straight, full steer: toward the drift side at most 0.6 (no dive; T68 dive gave 1.80)', () => {
    expect(driftRun(FREE, 0, 1).vx).toBeLessThanOrEqual(0.6);
  });
});

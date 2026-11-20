// H18 / R86c: drift charge and the turbo on the exit from the drift.
// Written from docs/brief.md R86c (and R41, R48, R52, R65, R82, R87), not from the implementation.
// New CarParams fields (driftTurbo, turboChargeTime, turboTime, turboCap, turboAccelMul, turboMin) and
// new Car fields (turbo, turboTicks) are not in the types yet, hence the casts.
//
// DT = 1/120 (brief §3, src/sim/constants). Hand numbers:
//   charge per drift tick   = min(1, |angle|) * DT / turboChargeTime
//   turboTicks on exit      = round(turboTime * turbo / DT): turbo 0.5 -> round(2*0.5*120) = 120,
//                             turbo 1 -> 240, turbo 0.3 -> 72
//   ceiling while boosted   = vmax * max(capMul, 1 + turboCap) = 1.13 (capMul 1 without draft)
//   acceleration below it   = accel * max(turboAccelMul, draftAccelMul) = 0.22 * 1.6 = 0.352 per second
import { describe, expect, it } from 'vitest';
import base from '../../src/data/cars/base.json';
import hypotheses from '../../src/data/hypotheses.json';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState } from '../../src/sim/types';
import { PB, Q, STRAIGHT, car, constTrack, inp, mk, stepB, stepN } from './modelb_helpers';
import { IDLE, RC, TRACK, dz } from './rivals_helpers';

type Tb = { turbo: number; turboTicks: number };
const tb = (c: Car): Tb => c as unknown as Tb;
const H = (p: CarParams, over: Record<string, number>): CarParams =>
  ({ ...p, ...over }) as CarParams;
const mkT = (over: Record<string, unknown>) => mk(over as Partial<Car>);

const TURBO = {
  gripScrub: 0,
  driftTurbo: 1,
  turboChargeTime: 1,
  turboTime: 2,
  turboCap: 0.13,
  turboAccelMul: 1.6,
  turboMin: 0.3,
};
/** Constant speed unless said otherwise: accel 0, slipDrag 0, no flick-related surprises. */
const TQ = H(Q, TURBO);
/** Real throttle (accel 0.22, brake 0.6, driftBrake 0.3 from PB), still no slipDrag. */
const TA = H(PB, { ...TURBO, slipDrag: 0 });
const OFF = (p: CarParams): CarParams => H(p, { driftTurbo: 0 });

/** A steady DRIFT to the right: slip s0, finger full right, dir +1. */
const drifting = (over: Record<string, unknown> = {}) =>
  mkT({ state: 'DRIFT', dir: 1, speed: 0.9, yaw: 1, vel: 0, yawRate: 0, ...over });
/** Releasing the drift button (R82) moves DRIFT to GRIP. */
const release = inp(1, false);
const hold = inp(1, true);

describe('R86c data (H18)', () => {
  it('base.json has the start numbers (R86c postponed 2026-11-20: driftTurbo 0, the rest keep the old start)', () => {
    const b = base as unknown as Record<string, number>;
    expect(b.driftTurbo).toBe(0);
    expect(b.turboChargeTime).toBe(1);
    expect(b.turboTime).toBe(2);
    expect(b.turboCap).toBe(0.13);
    expect(b.turboAccelMul).toBe(1.6);
    expect(b.turboMin).toBe(0.3);
  });
  it('hypotheses.json has H18_driftTurbo "A" (R86c postponed)', () => {
    expect((hypotheses as Record<string, string>).H18_driftTurbo).toBe('A');
  });
});

describe('R86c off (driftTurbo 0)', () => {
  it('fields stay 0 through a drift and its release, and the car behaves as without the rule', () => {
    const a = drifting();
    const b = drifting();
    const scaled = H(OFF(TA), {
      turboTime: 99,
      turboCap: 5,
      turboAccelMul: 9,
      turboChargeTime: 0.01,
    });
    for (let i = 0; i < 200; i++) {
      const i1 = i < 120 ? hold : release;
      stepB(a, i1, OFF(TA));
      stepB(b, i1, scaled);
      expect(tb(car(a)).turbo).toBe(0);
      expect(tb(car(a)).turboTicks).toBe(0);
    }
    expect(a).toEqual(b);
  });
});

describe('R86c charge', () => {
  it('grows each DRIFT tick by min(1,|angle|)*DT/turboChargeTime (angle after R87), cap 1', () => {
    for (const T of [1, 0.5]) {
      const p = H(TQ, { turboChargeTime: T });
      const s = drifting({ yaw: 1 });
      let prev = 0;
      for (let i = 0; i < 150; i++) {
        stepB(s, hold, p);
        const want = Math.min(1, prev + (Math.min(1, Math.abs(car(s).angle)) * DT) / T);
        expect(tb(car(s)).turbo, `T ${T} tick ${i}`).toBeCloseTo(want, 12);
        expect(car(s).state).toBe('DRIFT');
        prev = tb(car(s)).turbo;
      }
      expect(prev).toBeGreaterThan(0.2);
    }
  });
  it('reaches exactly 1 and never exceeds it (T = 0.5, full angle for 100 ticks)', () => {
    const p = H(TQ, { turboChargeTime: 0.5 });
    const s = drifting({ yaw: 2.64 });
    for (let i = 0; i < 100; i++) {
      stepB(s, hold, p);
      expect(tb(car(s)).turbo).toBeLessThanOrEqual(1);
    }
    expect(tb(car(s)).turbo).toBe(1);
  });
  it('angle above 1 (after a bump, 1.2) counts as 1: increment DT/T', () => {
    const s = drifting({ yaw: 3.0 }); // slip 3.0 / slipFull 2.64 = 1.136
    stepB(s, hold, TQ);
    expect(Math.abs(car(s).angle)).toBeGreaterThan(1);
    expect(tb(car(s)).turbo).toBeCloseTo(DT / 1, 12);
  });
  it('is left/right symmetric (dir -1 uses |angle|)', () => {
    const r = drifting({ yaw: 1 });
    const l = mkT({ state: 'DRIFT', dir: -1, speed: 0.9, yaw: -1, vel: 0, yawRate: 0 });
    for (let i = 0; i < 60; i++) {
      stepB(r, hold, TQ);
      stepB(l, inp(-1, true), TQ);
    }
    expect(tb(car(l)).turbo).toBeCloseTo(tb(car(r)).turbo, 12);
    expect(tb(car(r)).turbo).toBeGreaterThan(0);
  });
  it('does not grow in GRIP (any steer), and is not reset there while turboTicks runs', () => {
    const s = mkT({ speed: 0.9, turbo: 0.4 });
    for (let i = 0; i < 60; i++) stepB(s, inp(Math.sin(i / 5)), TQ);
    expect(tb(car(s)).turbo).toBe(0.4);
  });
  it('stays within [0, 1] and monotonic non-decreasing while the drift lasts', () => {
    const s = drifting({ yaw: 0.3 });
    let prev = 0;
    for (let i = 0; i < 300; i++) {
      stepB(s, inp(0.3 + 0.7 * Math.abs(Math.sin(i / 30)), true), TQ);
      const t = tb(car(s)).turbo;
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t).toBeLessThanOrEqual(1);
      prev = t;
    }
  });
});

describe('R86c exit from the drift (DRIFT -> GRIP step of R82)', () => {
  // R86c: turboTicks is not decremented in the exit step that sets it.
  const exitWith = (turbo: number, over: Record<string, unknown> = {}, input = release) => {
    const s = drifting({ turbo, ...over });
    stepB(s, input, TQ);
    expect(car(s).state).toBe('GRIP');
    return s;
  };
  // Expected ticks derived from DT (1/120 per brief §3); the hand values are checked against it.
  it('hand values match round(turboTime*turbo/DT) at DT = 1/120', () => {
    expect(DT).toBe(1 / 120);
    expect(Math.round((2 * 0.4083) / DT)).toBe(98);
  });
  it.each([
    [0.5, Math.round((2 * 0.5) / DT)], // 2*0.5*120 = 120
    [1, Math.round((2 * 1) / DT)], // 240
    [0.3, Math.round((2 * 0.3) / DT)], // 72; turbo == turboMin counts (>=)
    [0.4083, Math.round((2 * 0.4083) / DT)], // 2*0.4083*120 = 97.992 -> 98
  ])('turbo %f: turboTicks = round(turboTime*turbo/DT) = %i, turbo reset to 0', (turbo, ticks) => {
    const s = exitWith(turbo);
    // R86c: no decrement in the exit step where turboTicks is set -> exactly N.
    expect(tb(car(s)).turboTicks).toBe(ticks);
    expect(tb(car(s)).turbo).toBe(0);
  });
  it('turbo below turboMin: no boost, but turbo is reset to 0', () => {
    for (const turbo of [0.29, 0.1, 0]) {
      const s = exitWith(turbo);
      expect(tb(car(s)).turboTicks).toBe(0);
      expect(tb(car(s)).turbo).toBe(0);
    }
  });
  it('also when R82 exits by low speed (speed < driftExitSpeed*vmax) with the button held', () => {
    const s = drifting({ turbo: 0.5, speed: 0.25 });
    stepB(s, hold, TQ);
    expect(car(s).state).toBe('GRIP');
    expect(tb(car(s)).turboTicks).toBe(Math.round((2 * 0.5) / DT)); // 120
    expect(tb(car(s)).turbo).toBe(0);
  });
  it('a turbo charged by real ticks: hold 60 ticks, release -> boost proportional to the charge', () => {
    const s = drifting({ yaw: 2.64 });
    stepN(s, 60, hold, TQ);
    const charge = tb(car(s)).turbo;
    expect(charge).toBeGreaterThan(0.3);
    stepB(s, release, TQ);
    const want = Math.round((2 * charge) / DT);
    expect(tb(car(s)).turboTicks).toBe(want);
  });
});

describe('R86c boost: ceiling and acceleration', () => {
  it('ticks count down by exactly 1 per step to 0 and stay at 0', () => {
    const s = mkT({ speed: 0.5, turboTicks: 4 });
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      stepB(s, inp(0), TA);
      seen.push(tb(car(s)).turboTicks);
    }
    expect(seen).toEqual([3, 2, 1, 0, 0, 0]);
  });
  it('acceleration below the ceiling is accel*turboAccelMul: 0.5 -> 0.5 + 0.22*1.6*DT', () => {
    const s = mkT({ speed: 0.5, turboTicks: 50 });
    stepB(s, inp(0), TA);
    expect(car(s).speed).toBeCloseTo(0.5 + 0.22 * 1.6 * DT, 12);
    const ref = mkT({ speed: 0.5 });
    stepB(ref, inp(0), TA);
    expect(car(ref).speed).toBeCloseTo(0.5 + 0.22 * DT, 12);
  });
  it('speed above vmax is allowed up to vmax*(1+turboCap) = 1.13 and no further', () => {
    const s = mkT({ speed: 1.0, turboTicks: 300 });
    stepN(s, 60, inp(0), TA);
    expect(car(s).speed).toBeLessThanOrEqual(1.13 + 1e-9);
    expect(car(s).speed).toBeCloseTo(1.13, 9);
  });
  it('without turbo the same car stays at vmax', () => {
    const s = mkT({ speed: 1.0 });
    stepN(s, 60, inp(0), TA);
    expect(car(s).speed).toBeCloseTo(1.0, 9);
  });
  it('after the ticks run out, speed above the ceiling falls by driftBrake*DT per step (R52 rule)', () => {
    const s = mkT({ speed: 1.12, turboTicks: 5 });
    let guard = 0;
    while (tb(car(s)).turboTicks > 0 && guard++ < 20) stepB(s, inp(0), TA);
    expect(tb(car(s)).turboTicks).toBe(0);
    for (let i = 0; i < 5; i++) {
      const before = car(s).speed;
      stepB(s, inp(0), TA);
      expect(before - car(s).speed).toBeCloseTo(0.3 * DT, 12);
    }
  });
  it('is not a product with the draft boost: the greater accel multiplier and the greater cap win', () => {
    // draft boost active through boostTicks (H5 B). draftAccelMul 2.5 > turboAccelMul 1.6, cap 1.05 < 1.13.
    const d1 = H(TA, { draftBoost: 1, draftCapMul: 1.05, draftAccelMul: 2.5 });
    const a = mkT({ speed: 0.5, boostTicks: 300, turboTicks: 300 });
    const b = mkT({ speed: 0.5, boostTicks: 300 });
    stepB(a, inp(0), d1);
    stepB(b, inp(0), d1);
    expect(car(b).speed).toBeCloseTo(0.5 + 0.22 * 2.5 * DT, 12); // draft alone (control)
    expect(car(a).speed).toBeCloseTo(0.5 + 0.22 * 2.5 * DT, 12); // max(2.5, 1.6), not 4.0, not 4.1
    const c = mkT({ speed: 1.0, boostTicks: 300, turboTicks: 300 });
    stepN(c, 80, inp(0), d1);
    expect(car(c).speed).toBeCloseTo(1.13, 9); // max(1.05, 1.13), not 1.05*1.13, not 1.18
    // turbo wins accel: draftAccelMul 1.3 < 1.6, cap 1.2 > 1.13
    const d2 = H(TA, { draftBoost: 1, draftCapMul: 1.2, draftAccelMul: 1.3 });
    const e = mkT({ speed: 0.5, boostTicks: 300, turboTicks: 300 });
    stepB(e, inp(0), d2);
    expect(car(e).speed).toBeCloseTo(0.5 + 0.22 * 1.6 * DT, 12);
    const f = mkT({ speed: 1.0, boostTicks: 300, turboTicks: 300 });
    stepN(f, 80, inp(0), d2);
    expect(car(f).speed).toBeCloseTo(1.2, 9);
  });
  it('a new drift does not cancel a running boost; the angle ceiling of the drift still applies', () => {
    // flick entry (R81): steer -0.3 x5 then +0.3 with the button held, straight road.
    const s = mkT({ speed: 0.9, turboTicks: 40 });
    for (let i = 0; i < 5; i++) stepB(s, inp(-0.3, true), TA);
    stepB(s, inp(0.3, true), TA);
    expect(car(s).state).toBe('DRIFT');
    expect(tb(car(s)).turboTicks).toBe(40 - 6);
    // ceiling from the angle: slip 2.64 -> cap = 1 - 0.15 = 0.85 < speed 0.95 -> falls by driftBrake*DT
    const d = drifting({ speed: 0.95, yaw: 2.64, turboTicks: 100 });
    stepB(d, hold, TA);
    expect(car(d).speed).toBeCloseTo(0.95 - 0.3 * DT, 9);
    // the charge of the new drift runs while the old boost is still counting
    expect(tb(car(d)).turbo).toBeGreaterThan(0);
    expect(tb(car(d)).turboTicks).toBe(99);
  });
});

describe('R86c reset on contact and crash', () => {
  const CONTACT = {
    carLength: 1.5,
    carHitW: 0.2,
    trafficHitW: 0.2,
    bumpSpeedLoss: 0.1,
    bumpSideLoss: 0.05,
    bumpFloor: 0.3,
    bumpPush: 0.1,
    bumpPushDecay: 0.25,
    bumpKick: 0.6,
    bumpInvulnTime: 0.8,
    bumpAngleLoss: 0.3,
    xLimit: 2,
  };
  const PC = H(TQ, CONTACT);
  const tstep = (s: RaceState, p: CarParams = PC, inputs?: readonly InputFrame[]): void =>
    step(
      s,
      inputs ?? s.cars.map(() => IDLE),
      TRACK,
      s.cars.map(() => p),
    );
  const boosted = { turbo: 0.7, turboTicks: 50 };

  function trafficRace(tz: number): RaceState {
    // positions after the first step; speed 0.5 constant -> dz 0.25
    const s = createRace(7, 1, 1);
    Object.assign(s.cars[0]!, { z: 100 - dz(0.5), x: 0, speed: 0.5, ...boosted });
    const t = s.cars[1]!;
    Object.assign(t, { kind: 'traffic', z: tz - dz(0.3), x: 0, speed: 0.3, cruise: 0.3 });
    return s;
  }
  it('control: without contact the counter just counts down', () => {
    const s = trafficRace(300);
    tstep(s);
    expect(tb(s.cars[0]!).turboTicks).toBe(49);
    expect(tb(s.cars[0]!).turbo).toBe(0.7);
  });
  it('R41 rear hit on traffic zeroes turbo and turboTicks', () => {
    const s = trafficRace(101.2); // player 100 < 101.2 - 0.75: rear hit
    tstep(s);
    expect(s.cars[0]!.bumpTicks).toBeGreaterThan(0);
    expect(tb(s.cars[0]!).turbo).toBe(0);
    expect(tb(s.cars[0]!).turboTicks).toBe(0);
  });
  it('R41 side contact zeroes them too', () => {
    const s = trafficRace(100.3); // 100 >= 100.3 - 0.75 = 99.55: side
    tstep(s);
    expect(s.cars[0]!.bumpTicks).toBeGreaterThan(0);
    expect(tb(s.cars[0]!).turbo).toBe(0);
    expect(tb(s.cars[0]!).turboTicks).toBe(0);
  });
  it('R65 race-car contact zeroes both cars (rivals, player parked)', () => {
    const s = createRace(7, 3, 0);
    Object.assign(s.cars[0]!, { z: 900, x: 0, speed: 0 });
    Object.assign(s.cars[1]!, { kind: 'rival', z: 10 - dz(0.8), x: 0, speed: 0.8, ...boosted });
    Object.assign(s.cars[2]!, { kind: 'rival', z: 11 - dz(0.6), x: 0.1, speed: 0.6, ...boosted });
    // R65 runs with the rival config (rivalBumpLoss lives there), as in rivals_contact.test.ts.
    step(
      s,
      s.cars.map(() => IDLE),
      TRACK,
      s.cars.map(() => PC),
      undefined,
      RC,
    );
    expect(s.cars[1]!.bumpTicks).toBeGreaterThan(0);
    expect(s.cars[2]!.bumpTicks).toBeGreaterThan(0);
    for (const i of [1, 2]) {
      expect(tb(s.cars[i]!).turbo, `car ${i}`).toBe(0);
      expect(tb(s.cars[i]!).turboTicks, `car ${i}`).toBe(0);
    }
  });
  it('R48 crash (lamp post) zeroes them and they stay 0 during the crash', () => {
    const LAMP = {
      lampEvery: 16,
      lampOffset: 1.4,
      lampHitW: 0.08,
      crashMinSpeed: 0.3,
      crashTime: 1.6,
      crashReturnX: 0.6,
      offroadMul: 1,
    };
    const s = mkT({ z: 15.75, x: 1.4, speed: 0.5, ...boosted });
    stepB(s, inp(0), H(PC, LAMP));
    expect(car(s).crashTicks).toBeGreaterThan(0);
    expect(tb(car(s)).turbo).toBe(0);
    expect(tb(car(s)).turboTicks).toBe(0);
    stepN(s, 20, inp(0), H(PC, LAMP));
    expect(tb(car(s)).turboTicks).toBe(0);
  });
  it('a drift charge is lost by a crash too', () => {
    const LAMP = {
      lampEvery: 16,
      lampOffset: 1.4,
      lampHitW: 0.08,
      crashMinSpeed: 0.3,
      crashTime: 1.6,
      crashReturnX: 0.6,
      offroadMul: 1,
    };
    const s = drifting({ z: 15.75, x: 1.4, speed: 0.5, turbo: 0.8 });
    stepB(s, hold, H(PC, LAMP));
    expect(car(s).crashTicks).toBeGreaterThan(0);
    expect(tb(car(s)).turbo).toBe(0);
  });
});

describe('R86c applies to rivals the same way', () => {
  it('a rival in DRIFT charges, exits and gets turboTicks like the player', () => {
    const s = createRace(7, 2, 0);
    Object.assign(s.cars[0]!, { z: 900, x: 0, speed: 0 });
    Object.assign(s.cars[1]!, {
      kind: 'rival',
      state: 'DRIFT',
      dir: 1,
      speed: 0.9,
      yaw: 1,
      vel: 0,
      yawRate: 0,
      turbo: 0.5,
    });
    const p = (): CarParams[] => s.cars.map(() => TQ);
    step(s, [IDLE, hold], TRACK, p());
    const charge = tb(s.cars[1]!).turbo;
    expect(charge).toBeGreaterThan(0.5);
    step(s, [IDLE, release], TRACK, p());
    expect(s.cars[1]!.state).toBe('GRIP');
    expect(tb(s.cars[1]!).turbo).toBe(0);
    // round(turboTime*turbo/DT) with turboTime 2, no decrement on the exit step
    expect(tb(s.cars[1]!).turboTicks).toBe(Math.round((2 * charge) / DT));
  });
});

describe('R86c determinism and serialization', () => {
  function script(): { s: RaceState; sawBoost: boolean } {
    const s = createRace(3, 1);
    Object.assign(s.cars[0]!, { speed: 0.9 });
    let sawBoost = false;
    for (let t = 0; t < 900; t++) {
      const ph = t % 300;
      const f: InputFrame = { steer: ph < 5 ? -0.3 : 0.3, brake: false, drift: ph < 170 };
      step(s, [f], constTrack(0.5), [H(TA, { gripScrub: 1, scrubStart: 0.8, scrubRate: 0.6 })]);
      const c = tb(s.cars[0]!);
      expect(c.turbo).toBeGreaterThanOrEqual(0);
      expect(c.turbo).toBeLessThanOrEqual(1);
      expect(Number.isInteger(c.turboTicks)).toBe(true);
      expect(c.turboTicks).toBeGreaterThanOrEqual(0);
      if (c.turboTicks > 0) sawBoost = true;
    }
    return { s, sawBoost };
  }
  it('same inputs twice give identical state; the scenario really boosts', () => {
    const a = script();
    const b = script();
    expect(a.sawBoost).toBe(true);
    expect(a.s).toEqual(b.s);
  });
  it('state is JSON-serializable and round-trips with the new fields present', () => {
    const { s } = script();
    expect(typeof tb(s.cars[0]!).turbo).toBe('number');
    expect(typeof tb(s.cars[0]!).turboTicks).toBe('number');
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

void STRAIGHT;

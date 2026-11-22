import { describe, expect, it } from 'vitest';
import { driftEntryOf } from '../../src/app/driftEntryProbe';
import { baseCar } from '../../src/data/cars';
import hypotheses from '../../src/data/hypotheses.json';
import rivalsJson from '../../src/data/rivals.json';
import tunables from '../../src/data/tunables.json';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { Q, car, constTrack, inp, mk, slipOf, stepB, stepN } from './modelb_helpers';
import { BP, RC, mkRace, stepAll } from './rivals_helpers';
import { T70_NUMBERS } from './pinT70';

// Spec: docs/brief.md R81e (auto drift, driftEntry 4, H16 = E) with R82 exit, R81b C entry effects,
// R48 crash and R63b replacement resets. Rule tests use Q (model B, accel 0, slipDrag 0, H17/H18 off,
// T68 off, lamps off): speed stays constant in GRIP, so needAhead is hand-computable.
//
// Q numbers: yawRateMax 15.75, yawAlign 15, velGrip 22, kYaw 2, vmax 1, driftEnterSpeed 0.45,
// kickBase 2, slipFull 2.64, slipResponse 8, driftMinU 0 (NO_T68).
// R86b: gripA = yawRateMax/(1 + yawAlign/velGrip) = 15.75/(37/22) = 346.5/37 = 9.364864...
// needAhead = |cA|*sp*kYaw/gripA = |cA|*sp*0.2135642...
//   curve 7 (hard) sp 1:   7*2/9.364864 = 1.494949...
//   curve 7 sp 0.5:        0.747474...
//   curve 4.5 sp 1.03:     0.98988 (< 1),  sp 1.05: 1.00908 (>= 1)
//   curve 20 sp 0.45:      1.92208
// autoHold/DT = 0.1*120 = 12 -> entry on the first tick after 12 full counted ticks = tick 13.
// Look-ahead: k = ceil(sp*SEG_PER_UNIT*autoLook): sp 1 -> ceil(60*0.25) = 15; sp 0.9 -> ceil(13.5) = 14.

/** R81e car parameters (T70 start). Spread from a variable: the fields may not be in CarParams yet. */
const AUTO = { autoSteer: 0.7, autoHold: 0.1, autoLook: 0.25, autoNeed: 1.0 };
const P4: CarParams = { ...Q, ...AUTO, driftEntry: 4 };
const P3: CarParams = { ...Q, ...AUTO, driftEntry: 3 };
const E2: CarParams = { ...Q, ...AUTO, driftEntry: 2, deflectEnter: 0.8, deflectTime: 0.15 };
const GRIP_A = 15.75 / (1 + 15 / 22);
const needOf = (curve: number, sp: number): number => (Math.abs(curve) * sp * 2) / GRIP_A;

/** autoTicks of a car (new flat field of R81e). */
const at = (c: Car): number | undefined => (c as Car & { autoTicks?: number }).autoTicks;
const withAuto = (over: Partial<Car>, autoTicks: number): Partial<Car> =>
  ({ ...over, autoTicks }) as Partial<Car>;

const HARD = constTrack(7);
const LEFT = constTrack(-7);
const TURN = constTrack(10); // needAhead >= 1 down to sp 0.468: speed changes in DRIFT cannot drop it

/** Straight track with curve `curve` on segments [start, start + len). */
function corner(curve: number, start: number, len: number, n = 4000): Track {
  const segments = [];
  for (let i = 0; i < n; i++) segments.push({ curve: i >= start && i < start + len ? curve : 0 });
  return { segments };
}
function custom(n: number, parts: ReadonlyArray<readonly [number, number, number]>): Track {
  const segments = Array.from({ length: n }, () => ({ curve: 0 }));
  for (const [from, len, c] of parts)
    for (let i = from; i < from + len; i++) segments[i]!.curve = c;
  return { segments };
}

/** autoTicks after exactly one step from the given car. */
function once(
  over: Partial<Car>,
  input: InputFrame,
  p: CarParams = P4,
  track: Track = HARD,
): number | undefined {
  const s = mk({ speed: 1, z: 10, ...over });
  stepB(s, input, p, track);
  return at(car(s));
}

const phys = (c: Car) => ({
  state: c.state,
  dir: c.dir,
  x: c.x,
  z: c.z,
  speed: c.speed,
  vx: c.vx,
  steer: c.steer,
  heading: c.heading,
  angle: c.angle,
  yaw: c.yaw,
  yawRate: c.yawRate,
  vel: c.vel,
  carry: c.carry,
  driftTicks: c.driftTicks,
  scrubDebt: c.scrubDebt,
});

describe('R81e data: rejected by the author (T71), variant 4 stays in code; T73 (R81g): H16 = D, base.json and rivals 3', () => {
  it('hypotheses.json H16_driftEntry is "D" (T73, R81g; was "F" in T71, "E" in T70)', () => {
    expect((hypotheses as Record<string, string>).H16_driftEntry).toBe('D');
  });
  it('driftEntryOf maps E -> 4; D stays 3, A/B/C stay 0/1/2', () => {
    expect(driftEntryOf('E')).toBe(4);
    expect(driftEntryOf('D')).toBe(3);
    expect(driftEntryOf('A')).toBe(0);
    expect(driftEntryOf('B')).toBe(1);
    expect(driftEntryOf('C')).toBe(2);
  });
  it('cars/base.json: driftEntry 3 (T73, R81g; was 5 in T71), autoSteer 0.7, autoHold 0.1, autoLook 0.25, autoNeed 1.0 kept', () => {
    const b = baseCar as CarParams & Partial<typeof AUTO>;
    expect(b.driftEntry).toBe(3);
    expect(b.autoSteer).toBe(0.7);
    expect(b.autoHold).toBe(0.1);
    expect(b.autoLook).toBe(0.25);
    expect(b.autoNeed).toBe(1.0);
  });
  it('rivals.json: rivalDriftEntry 3 (T73, R81g; was 5 in T71)', () => {
    expect((rivalsJson as Record<string, unknown>).rivalDriftEntry).toBe(3);
  });
  it('dev panel: H16 offers E (every hypothesis is a runtime flag)', () => {
    const flags = (tunables as { flags: Record<string, string[]> }).flags;
    expect(flags['hypotheses.H16_driftEntry']).toContain('E');
  });
  it('a new car starts with autoTicks 0 and the field survives a JSON round-trip', () => {
    const s = createRace(1, 3, 2);
    for (const c of s.cars) expect(at(c)).toBe(0);
    const t = JSON.parse(JSON.stringify(s)) as RaceState;
    for (const c of t.cars) expect(at(c)).toBe(0);
  });
});

describe('R81e needAhead: largest |curve| over seg..seg+k, k = ceil(sp*SEG_PER_UNIT*autoLook)', () => {
  it('needAhead = |cA|*sp*kYaw/gripA: hard sp 1 = 1.49495 (autoNeed 1.49 counts, 1.50 does not)', () => {
    expect(needOf(7, 1)).toBeCloseTo(1.494949, 5);
    expect(once({}, inp(1, true), { ...P4, autoNeed: 1.49 } as CarParams)).toBe(1);
    expect(once({}, inp(1, true), { ...P4, autoNeed: 1.5 } as CarParams)).toBe(0);
  });
  it('scales with sp of the start of the step: hard sp 0.5 = 0.74747 (0.74 counts, 0.75 does not)', () => {
    expect(needOf(7, 0.5)).toBeCloseTo(0.747474, 5);
    expect(once({ speed: 0.5 }, inp(1, true), { ...P4, autoNeed: 0.74 } as CarParams)).toBe(1);
    expect(once({ speed: 0.5 }, inp(1, true), { ...P4, autoNeed: 0.75 } as CarParams)).toBe(0);
  });
  it('scales with kYaw and gripA: kYaw 4 -> 2.98990; velGrip 15 (gripA 7.875) -> 14/7.875 = 1.77778', () => {
    expect(once({}, inp(1, true), { ...P4, kYaw: 4, autoNeed: 2.98 } as CarParams)).toBe(1);
    expect(once({}, inp(1, true), { ...P4, kYaw: 4, autoNeed: 3.0 } as CarParams)).toBe(0);
    expect(once({}, inp(1, true), { ...P4, velGrip: 15, autoNeed: 1.77 } as CarParams)).toBe(1);
    expect(once({}, inp(1, true), { ...P4, velGrip: 15, autoNeed: 1.78 } as CarParams)).toBe(0);
  });
  it('medium: sp 1 gives 0.961 < 1 (no count); sp 1.03 0.990 no; sp 1.05 1.009 counts', () => {
    const MED = constTrack(4.5);
    expect(needOf(4.5, 1)).toBeCloseTo(0.961, 3);
    expect(once({ speed: 1 }, inp(1, true), P4, MED)).toBe(0);
    expect(once({ speed: 1.03 }, inp(1, true), P4, MED)).toBe(0);
    expect(once({ speed: 1.05 }, inp(1, true), P4, MED)).toBe(1);
  });
  it('window at sp 1 is 15 segments ahead (current included): corner at 100 seen from z 85, not from 84.9', () => {
    const T = corner(7, 100, 50);
    expect(once({ z: 85 }, inp(1, true), P4, T)).toBe(1); // floor 85, 85..100
    expect(once({ z: 84.9 }, inp(1, true), P4, T)).toBe(0); // floor 84, 84..99: all straight
  });
  it('window at sp 0.9 is ceil(13.5) = 14: corner at 100 seen from z 86, not from 85.99', () => {
    const T = corner(7, 100, 50);
    expect(needOf(7, 0.9)).toBeGreaterThan(1);
    expect(once({ z: 86, speed: 0.9 }, inp(1, true), P4, T)).toBe(1);
    expect(once({ z: 85.99, speed: 0.9 }, inp(1, true), P4, T)).toBe(0);
  });
  it('autoLook scales the window: autoLook 0.5 at sp 1 is 30 segments (z 70 sees 100, 69.9 does not)', () => {
    const T = corner(7, 100, 50);
    const p = { ...P4, autoLook: 0.5 } as CarParams;
    expect(once({ z: 70 }, inp(1, true), p, T)).toBe(1);
    expect(once({ z: 69.9 }, inp(1, true), p, T)).toBe(0);
  });
  it('the current segment counts: a 1-segment corner under the car is seen', () => {
    expect(once({ z: 100.5 }, inp(1, true), P4, corner(7, 100, 1))).toBe(1);
    expect(once({ z: 101 }, inp(1, true), P4, corner(7, 100, 1))).toBe(0); // behind the car
  });
  it('the window wraps over the lap: track of 400, corner on 0..9, car at z 390', () => {
    const T = custom(400, [[0, 10, 7]]);
    expect(once({ z: 390 }, inp(1, true), P4, T)).toBe(1); // 390..399, 0..5
    expect(once({ z: 380 }, inp(1, true), P4, T)).toBe(0); // 380..395: straight
  });
  it('side = sign of the largest |curve|: easy +2 near, hard -7 further -> side -1, need from 7', () => {
    const T = custom(4000, [
      [100, 3, 2],
      [105, 3, -7],
    ]);
    expect(once({ z: 100 }, inp(-1, true), P4, T)).toBe(1);
    expect(once({ z: 100 }, inp(1, true), P4, T)).toBe(0);
    // need from |cA| = 7 (1.495), not from 2 (0.427)
    expect(once({ z: 100 }, inp(-1, true), { ...P4, autoNeed: 1.49 } as CarParams, T)).toBe(1);
  });
  it('tie of |curve|: the nearer one decides the side (both orders)', () => {
    const a = custom(4000, [
      [102, 2, -7],
      [108, 2, 7],
    ]);
    expect(once({ z: 100 }, inp(-1, true), P4, a)).toBe(1);
    expect(once({ z: 100 }, inp(1, true), P4, a)).toBe(0);
    const b = custom(4000, [
      [102, 2, 7],
      [108, 2, -7],
    ]);
    expect(once({ z: 100 }, inp(1, true), P4, b)).toBe(1);
    expect(once({ z: 100 }, inp(-1, true), P4, b)).toBe(0);
  });
  it('straight (side 0) never counts, even with full steer', () => {
    expect(once({}, inp(1, true), P4, constTrack(0))).toBe(0);
    expect(once({}, inp(-1, true), P4, constTrack(0))).toBe(0);
  });
});

describe('R81e counted tick: every condition (one step each, hard at sp 1)', () => {
  it('steer*side >= autoSteer: 0.7 counts, 0.69 does not; mirrored on a left corner', () => {
    expect(once({}, inp(0.7, true))).toBe(1);
    expect(once({}, inp(0.69, true))).toBe(0);
    expect(once({}, inp(-0.7, true), P4, LEFT)).toBe(1);
    expect(once({}, inp(-0.69, true), P4, LEFT)).toBe(0);
  });
  it('steer against the corner never counts', () => {
    expect(once({}, inp(-1, true))).toBe(0);
    expect(once({}, inp(1, true), P4, LEFT)).toBe(0);
  });
  it('autoSteer is a parameter: autoSteer 0.5 -> 0.5 counts, 0.49 does not', () => {
    const p = { ...P4, autoSteer: 0.5 } as CarParams;
    expect(once({}, inp(0.5, true), p)).toBe(1);
    expect(once({}, inp(0.49, true), p)).toBe(0);
  });
  it('the raw steer of this tick (R80) counts, not the previous car.steer', () => {
    expect(once({ steer: -1 }, inp(1, true))).toBe(1);
    expect(once({ steer: 1 }, inp(0, true))).toBe(0);
  });
  it('input.drift (control held) is required', () => {
    expect(once({}, inp(1, false))).toBe(0);
  });
  it('speed > driftEnterSpeed*vmax strictly: curve 20, sp 0.45 no, 0.46 yes', () => {
    const T = constTrack(20);
    expect(needOf(20, 0.45)).toBeGreaterThan(1);
    expect(once({ speed: 0.45 }, inp(1, true), P4, T)).toBe(0);
    expect(once({ speed: 0.46 }, inp(1, true), P4, T)).toBe(1);
  });
  it('blocked (armTicks != 0) does not count', () => {
    expect(once({ armTicks: 1 }, inp(1, true))).toBe(0);
  });
  it('H11 A (driftOffroad 0): off the asphalt (|x| > 1) does not count; H11 B does', () => {
    const a = { ...P4, driftOffroad: 0 } as CarParams;
    const b = { ...P4, driftOffroad: 1 } as CarParams;
    expect(once({ x: 0.9 }, inp(1, true), a)).toBe(1);
    expect(once({ x: 1.2 }, inp(1, true), a)).toBe(0);
    expect(once({ x: 1.2 }, inp(1, true), b)).toBe(1);
  });
  it('in a crash (crashTicks > 0) nothing counts and the counter is 0', () => {
    expect(once(withAuto({ crashTicks: 50, crashSpeed0: 1 }, 5), inp(1, true))).toBe(0);
  });
  it('in DRIFT at the start of the step the counter is 0', () => {
    const s = mk(
      withAuto({ speed: 1, z: 10, state: 'DRIFT', dir: 1, driftHeld: true, yaw: 0.5 }, 5),
    );
    stepB(s, inp(1, true), P4, HARD);
    expect(car(s).state).toBe('DRIFT');
    expect(at(car(s))).toBe(0);
  });
});

describe('R81e entry: DRIFT on the tick after round(autoHold/DT) = 12 counted ticks', () => {
  for (const side of [1, -1] as const) {
    it(`ticks 1..12 GRIP with autoTicks 1..12; tick 13 DRIFT, dir = side = ${side}, autoTicks 0`, () => {
      const T = constTrack(7 * side);
      const s = mk({ speed: 1, z: 10 });
      for (let i = 1; i <= 12; i++) {
        stepB(s, inp(side, true), P4, T);
        expect(car(s).state).toBe('GRIP');
        expect(at(car(s))).toBe(i);
      }
      stepB(s, inp(side, true), P4, T);
      expect(car(s).state).toBe('DRIFT');
      expect(car(s).dir).toBe(side);
      expect(at(car(s))).toBe(0);
    });
  }
  it.each([
    [0.05, 7], // round(6) = 6 -> 7th tick
    [0.2, 25], // round(24) = 24 -> 25th tick
    [0, 1], // round(0) = 0 -> the first counted tick enters
  ])('autoHold %f s -> entry on tick %i', (hold, n) => {
    const p = { ...P4, autoHold: hold } as CarParams;
    const s = mk({ speed: 1, z: 10 });
    for (let i = 1; i < n; i++) {
      stepB(s, inp(1, true), p, HARD);
      expect(car(s).state).toBe('GRIP');
    }
    stepB(s, inp(1, true), p, HARD);
    expect(car(s).state).toBe('DRIFT');
  });
  it('entry tick from rest (hand-computed): yawRate = dir*kickBase, then R83 DRIFT', () => {
    // slip0 = 0 (yaw = vel = carry = 0), yawRate = 2. R83 DRIFT (driftMinU 0, u = 1, uc = 1):
    // slipT = 2.64; yawRate += (64*2.64 - 2*8*2)*DT = 2 + 136.96/120 = 3.141333...; slip = yawRate*DT.
    const yr = 2 + (64 * 2.64 - 32) / 120;
    for (const side of [1, -1] as const) {
      const s = mk(withAuto({ speed: 1, z: 10 }, 12));
      stepB(s, inp(side, true), P4, constTrack(7 * side));
      expect(car(s).state).toBe('DRIFT');
      expect(car(s).dir).toBe(side);
      expect(car(s).yawRate).toBeCloseTo(side * yr, 9);
      expect(slipOf(car(s))).toBeCloseTo(side * yr * DT, 9);
    }
    expect(yr).toBeCloseTo(3.1413333, 6);
  });
  const starts: Partial<Car>[] = [
    {},
    { yaw: 0.3, vel: 0.1, carry: 0.05, yawRate: 0.4 },
    { yaw: -0.2, vel: 0.05, carry: 0.02, yawRate: -0.3 },
    { x: 0.4, yaw: 0.1, vel: 0.2, carry: -0.04 },
  ];
  for (const [i, over] of starts.entries()) {
    for (const side of [1, -1] as const) {
      it(`entry effects equal R81b C (start ${i}, side ${side}): same state on the entry tick and 30 ticks after`, () => {
        const T = constTrack(7 * side);
        const st = 0.9 * side; // >= deflectEnter 0.8 and >= autoSteer 0.7
        const base = { ...over, speed: 1, z: 10, driftHeld: true, steer: st };
        const c = mk({ ...base, deflectTicks: 18 });
        stepB(c, inp(st, true), E2, T);
        expect(car(c).state).toBe('DRIFT'); // precondition: C enters on this tick
        const d = mk(withAuto(base, 12));
        stepB(d, inp(st, true), P4, T);
        expect(phys(car(d))).toEqual(phys(car(c)));
        stepN(c, 30, inp(st, true), E2, T);
        stepN(d, 30, inp(st, true), P4, T);
        expect(phys(car(d))).toEqual(phys(car(c)));
      });
    }
  }
  it('the steer buffer is not written in variant 4 (as in variant 3)', () => {
    const s = mk({ speed: 1, z: 10 });
    stepN(s, 40, inp(1, true), P4, HARD);
    expect(car(s).steerHistCount).toBe(0);
  });
  it('input.drift false never enters (240 ticks of full steer in a hard corner)', () => {
    const s = mk({ speed: 1, z: 10 });
    for (let i = 0; i < 240; i++) {
      stepB(s, inp(1, false), P4, HARD);
      expect(car(s).state).toBe('GRIP');
    }
  });
});

describe('R81e autoTicks reset: any tick that does not count sets it to 0', () => {
  const six = (): RaceState => {
    const s = mk({ speed: 1, z: 10 });
    stepN(s, 6, inp(1, true), P4, HARD);
    expect(at(car(s))).toBe(6);
    return s;
  };
  const cases: ReadonlyArray<readonly [string, InputFrame, CarParams]> = [
    ['release (drift false)', inp(1, false), P4],
    ['steer below autoSteer (0.69)', inp(0.69, true), P4],
    ['steer 0', inp(0, true), P4],
    ['wrong side (-1)', inp(-1, true), P4],
    [
      'needAhead below autoNeed (autoNeed 2 for one tick)',
      inp(1, true),
      { ...P4, autoNeed: 2 } as CarParams,
    ],
  ];
  for (const [name, f, p] of cases) {
    it(`${name}: 0, then a full autoHold again (12 GRIP ticks, DRIFT on the 13th)`, () => {
      const s = six();
      stepB(s, f, p, HARD);
      expect(car(s).state).toBe('GRIP');
      expect(at(car(s))).toBe(0);
      for (let i = 1; i <= 12; i++) {
        stepB(s, inp(1, true), P4, HARD);
        expect(car(s).state).toBe('GRIP');
        expect(at(car(s))).toBe(i);
      }
      stepB(s, inp(1, true), P4, HARD);
      expect(car(s).state).toBe('DRIFT');
    });
  }
  it('crash in progress: counter 0 while crashTicks > 0', () => {
    const s = six();
    Object.assign(car(s), { crashTicks: 20, crashSpeed0: 1, crashX0: 0.2 });
    for (let i = 0; i < 10; i++) {
      stepB(s, inp(1, true), P4, HARD);
      expect(at(car(s))).toBe(0);
      expect(car(s).state).toBe('GRIP');
    }
  });
  it('R48: the crash hit zeroes the counter on the hit tick (the tick itself would count)', () => {
    // Lamps from tests/sim/crash.test.ts: lampEvery 16, lampOffset 1.4, z 15.75 -> 16.0 at speed 0.5.
    const LAMP = {
      lampEvery: 16,
      lampOffset: 1.4,
      lampHitW: 0.08,
      crashMinSpeed: 0.3,
      crashTime: 1.6,
      crashReturnX: 0.6,
      carHitW: 0.16,
      bumpInvulnTime: 0.8,
      offroadMul: 1,
      xLimit: 2,
      vmax: 1,
      driftOffroad: 1,
    };
    const T = constTrack(20); // need at sp 0.5 = 2.14 >= 1
    const pre = withAuto({ z: 15.75, x: 1.4, speed: 0.5 }, 5);
    // control: without lamps the same tick counts (5 -> 6)
    const ctl = mk(pre);
    stepB(ctl, inp(1, true), { ...P4, ...LAMP, crashMinSpeed: 1e9 } as CarParams, T);
    expect(at(car(ctl))).toBe(6);
    const s = mk(pre);
    stepB(s, inp(1, true), { ...P4, ...LAMP } as CarParams, T);
    expect(car(s).crashTicks).toBe(192);
    expect(at(car(s))).toBe(0);
  });
  it('R63b: a replaced rival starts with autoTicks 0', () => {
    // Same pool layout as tests/sim/rivals_pool.test.ts: rival 4 (role ahead) 1900 ahead is replaced.
    const PZ = 5000;
    const gaps = [-100, 60, -200, 1900, 500, -300, -500];
    const roles = [0, 0, 0, 1, 1, 2, 2];
    const slots = [0, 50, -50, 300, 500, -300, -500];
    const place: Partial<Car>[] = [{ z: PZ, x: 0, speed: 0.5 }];
    gaps.forEach((g, i) =>
      place.push({
        z: PZ + g,
        x: -0.9 + 0.2 * i,
        speed: 0.5,
        nameId: i,
        role: roles[i]!,
        slot: slots[i]!,
        slotTicks: 1e6,
        nemesis: i === 0 ? 1 : 0,
        skill: 1,
        pace: 1,
      }),
    );
    const s = mkRace(7, 0, place);
    s.tick = 5000;
    Object.assign(s.cars[4]!, { autoTicks: 7 });
    stepAll(s, BP, RC);
    expect(s.cars[4]!.joinTicks).toBeGreaterThan(0); // precondition: replaced on this tick
    expect(at(s.cars[4]!)).toBe(0);
  });
});

describe('R81e exit (R82 unchanged) and re-entry', () => {
  /** Steady drift: 13 held ticks to enter, then 120 more ticks. */
  const drifting = (): RaceState => {
    const s = mk({ speed: 1, z: 10 });
    stepN(s, 133, inp(1, true), P4, TURN);
    expect(car(s).state).toBe('DRIFT');
    return s;
  };
  for (const gap of [1, 6, 48, 96]) {
    it(`release ${gap} tick(s): GRIP on the first release tick; re-touch enters on the 13th held tick`, () => {
      const s = drifting();
      stepB(s, inp(0, false), P4, TURN);
      expect(car(s).state).toBe('GRIP');
      expect(at(car(s))).toBe(0);
      stepN(s, gap - 1, inp(0, false), P4, TURN);
      expect(needOf(10, car(s).speed)).toBeGreaterThan(1); // precondition
      for (let i = 1; i <= 12; i++) {
        stepB(s, inp(1, true), P4, TURN);
        expect(car(s).state).toBe('GRIP');
      }
      stepB(s, inp(1, true), P4, TURN);
      expect(car(s).state).toBe('DRIFT');
    });
  }
  it('steer against (-1) or 0 while held does not exit; dir does not change', () => {
    const s = drifting();
    for (const st of [-1, 0]) {
      for (let i = 0; i < 60; i++) {
        stepB(s, inp(st, true), P4, TURN);
        expect(car(s).state).toBe('DRIFT');
        expect(car(s).dir).toBe(1);
      }
    }
  });
  const lowExit = (): RaceState => {
    const s = mk({ state: 'DRIFT', dir: 1, yaw: 0.5, speed: 0.2, z: 10, driftHeld: true }); // 0.2 < 0.3
    stepB(s, inp(1, true), P4, TURN);
    expect(car(s).state).toBe('GRIP'); // R82 by speed, control still held
    car(s).speed = 1;
    return s;
  };
  it('exit by speed while held sets armTicks = 1', () => {
    expect(lowExit().cars[0]!.armTicks).toBe(1);
  });
  it('after an exit by speed while held: no counting and no entry until input.drift is false', () => {
    const s = lowExit();
    for (let i = 0; i < 120; i++) {
      stepB(s, inp(1, true), P4, TURN);
      expect(car(s).state).toBe('GRIP');
      expect(at(car(s))).toBe(0);
    }
    stepB(s, inp(1, false), P4, TURN);
    for (let i = 1; i <= 12; i++) {
      stepB(s, inp(1, true), P4, TURN);
      expect(car(s).state).toBe('GRIP');
      expect(at(car(s))).toBe(i);
    }
    stepB(s, inp(1, true), P4, TURN);
    expect(car(s).state).toBe('DRIFT');
  });
  it('the block survives a JSON round-trip', () => {
    const s = lowExit();
    stepN(s, 3, inp(1, true), P4, TURN);
    const t = JSON.parse(JSON.stringify(s)) as RaceState;
    stepN(t, 30, inp(1, true), P4, TURN);
    expect(car(t).state).toBe('GRIP');
    stepB(t, inp(1, false), P4, TURN);
    stepN(t, 13, inp(1, true), P4, TURN);
    expect(car(t).state).toBe('DRIFT');
  });
});

describe('R81e tick order: R80 -> R81e (start-of-step speed, z, state) -> R82', () => {
  it('release tick in DRIFT: R81e sees DRIFT (counter 0), R82 exits; the next held tick counts 1', () => {
    const s = mk(
      withAuto({ speed: 1, z: 10, state: 'DRIFT', dir: 1, driftHeld: true, yaw: 0.5 }, 0),
    );
    stepB(s, inp(1, false), P4, HARD);
    expect(car(s).state).toBe('GRIP');
    expect(at(car(s))).toBe(0);
    stepB(s, inp(1, true), P4, HARD);
    expect(at(car(s))).toBe(1);
  });
  it('a car that crosses into the window during the step is not counted (start-of-step z)', () => {
    // z 84.75 -> 85.25 at sp 1 (dz 0.5): start floor 84 sees 84..99, the corner at 100 is not in it.
    expect(once({ z: 84.75 }, inp(1, true), P4, corner(7, 100, 50))).toBe(0);
  });
});

describe('R81e properties', () => {
  const RP: CarParams = {
    ...baseCar,
    model: 1, // H14 pin [2026-11-22]: model B explicitly (data default is model C, R150)
    ...T70_NUMBERS, // T71: variant 4 keeps the numbers it was written with
    ...AUTO,
    driftTurbo: 0,
    driftEntry: 4,
    crashMinSpeed: 1e9,
  };
  const parts = (sg: number): ReadonlyArray<readonly [number, number, number]> => [
    [200, 300, 7 * sg],
    [700, 200, -8.3 * sg],
    [1100, 300, 4.5 * sg],
    [1600, 250, -7 * sg],
    [2100, 150, 8.3 * sg],
  ];
  const TR = custom(4000, parts(1));
  const TL = custom(4000, parts(-1));
  const script = (i: number, sg: number): InputFrame =>
    inp(sg * Math.max(-1, Math.min(1, 1.4 * Math.sin(i / 37))), i % 300 > 25);
  it('left/right symmetry of a whole run through mirrored corners; drift happens; 0 <= autoTicks <= 12', () => {
    const r = mk({ speed: 1, z: 100 });
    const l = mk({ speed: 1, z: 100 });
    let drifted = false;
    for (let i = 0; i < 1800; i++) {
      stepB(r, script(i, 1), RP, TR);
      stepB(l, script(i, -1), RP, TL);
      const a = car(r);
      const b = car(l);
      if (a.state === 'DRIFT') drifted = true;
      expect(b.state).toBe(a.state);
      expect(b.dir + a.dir).toBe(0);
      expect(at(b)).toBe(at(a));
      expect(b.x).toBeCloseTo(-a.x, 9);
      expect(b.speed).toBeCloseTo(a.speed, 12);
      const n = at(a)!;
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(12);
    }
    expect(drifted).toBe(true);
  });
  it('deterministic: same inputs twice give identical state', () => {
    const play = (): string => {
      const s = mk({ speed: 1, z: 100 });
      for (let i = 0; i < 1500; i++) stepB(s, script(i, 1), RP, TR);
      return JSON.stringify(s);
    };
    expect(play()).toBe(play());
  });
  it('JSON round-trip in the middle of a count continues identically', () => {
    const a = mk({ speed: 1, z: 10 });
    stepN(a, 7, inp(1, true), P4, HARD);
    expect(at(car(a))).toBe(7);
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    for (let i = 0; i < 40; i++) {
      stepB(a, inp(1, true), P4, HARD);
      stepB(b, inp(1, true), P4, HARD);
    }
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(car(b).state).toBe('DRIFT');
  });
  it('the variant is per car: variant 3 enters on the first held tick, variant 4 on the 13th', () => {
    const s = createRace(3, 2);
    s.cars.forEach((c, i) => Object.assign(c, { speed: 1, z: 10 + 150 * i, x: 0 }));
    const f: InputFrame[] = [inp(0.9, true), inp(0.9, true)];
    step(s, f, HARD, [P3, P4]);
    expect(s.cars.map((c) => c.state)).toEqual(['DRIFT', 'GRIP']);
    for (let i = 0; i < 11; i++) step(s, f, HARD, [P3, P4]);
    expect(s.cars[1]!.state).toBe('GRIP');
    step(s, f, HARD, [P3, P4]);
    expect(s.cars[1]!.state).toBe('DRIFT');
  });
});

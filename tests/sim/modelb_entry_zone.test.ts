import { describe, expect, it } from 'vitest';
import { driftEntryOf } from '../../src/app/driftEntryProbe';
import { baseCar } from '../../src/data/cars';
import hypotheses from '../../src/data/hypotheses.json';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState } from '../../src/sim/types';
import { Q, car, inp, mk, slipOf, stepB, stepN } from './modelb_helpers';

// Spec: docs/brief.md R81c (stick with a zone, driftEntry 3; replaced for the player by R81e, kept for
// bots, rivals and model tests, so every test below is pinned to driftEntry 3), R81 speed condition, R81b C entry
// effects, R82 exit, R82b. Explicit params (Q: accel 0, slipDrag 0, H17/H18 off, lamps off), straight road.
// Q numbers used below: driftEnterSpeed 0.45, driftExitSpeed 0.3, kickBase 2, slipFull 2.64,
// slipResponse 8, carryDecay 8.

const E3: CarParams = { ...Q, driftEntry: 3 };
const E2: CarParams = { ...Q, driftEntry: 2, deflectEnter: 0.8, deflectTime: 0.15 };
const E0: CarParams = { ...Q, driftEntry: 0 };
const SPEED = 0.5; // > 0.45, constant under Q
const enters = (s: RaceState): boolean => car(s).state === 'DRIFT';
const fresh = (over: Partial<Car> = {}): RaceState => mk({ speed: SPEED, ...over });
const hold = (s: RaceState, n: number, steer: number, drift = true, p: CarParams = E3): void =>
  stepN(s, n, inp(steer, drift), p);

/** Physical fields of a car (steer buffer, C counter and internal block flag left out on purpose). */
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
  turbo: c.turbo,
  turboTicks: c.turboTicks,
});

describe('R81c data: T73 (R81g) makes variant 3 the default again (driftEntry 3, H16 D)', () => {
  it('hypotheses.json H16_driftEntry is "D" (R81g, T73; was "F" in T71)', () => {
    expect((hypotheses as Record<string, string>).H16_driftEntry).toBe('D');
  });
  it('base.json driftEntry is 3 (R81g: bots, gate, rivals and player; was 5 in T71)', () => {
    expect(baseCar.driftEntry).toBe(3);
  });
  it('the H16 flag maps D -> 3 (A, B, C stay 0, 1, 2)', () => {
    expect(driftEntryOf('D')).toBe(3);
    expect(driftEntryOf('A')).toBe(0);
    expect(driftEntryOf('B')).toBe(1);
    expect(driftEntryOf('C')).toBe(2);
  });
});

describe('R81c driftEntry 3: entry on the tick drift is held with steer != 0', () => {
  it('enters on the very first held tick, no history needed; dir = sign(steer)', () => {
    for (const [st, dir] of [
      [1, 1],
      [0.3, 1],
      [0.01, 1],
      [-0.3, -1],
      [-1, -1],
    ] as const) {
      const s = fresh();
      stepB(s, inp(st, true), E3);
      expect(enters(s)).toBe(true);
      expect(car(s).dir).toBe(dir);
    }
  });
  it('steer 0 with drift held never enters; the first tick with steer != 0 enters', () => {
    const s = fresh();
    for (let i = 0; i < 60; i++) {
      stepB(s, inp(0, true), E3);
      expect(enters(s)).toBe(false);
    }
    stepB(s, inp(-0.2, true), E3);
    expect(enters(s)).toBe(true);
    expect(car(s).dir).toBe(-1);
  });
  it('speed condition of R81: speed > driftEnterSpeed*vmax = 0.45 strictly', () => {
    const a = fresh({ speed: 0.45 });
    hold(a, 30, 1);
    expect(enters(a)).toBe(false);
    const b = fresh({ speed: 0.46 });
    stepB(b, inp(1, true), E3);
    expect(enters(b)).toBe(true);
  });
  it('drift false never enters, however fast the steer changes (flick plays no role)', () => {
    const s = fresh();
    for (let i = 0; i < 120; i++) {
      stepB(s, inp(i % 2 === 0 ? 1 : -1, false), E3); // |d| = 2 every tick
      expect(enters(s)).toBe(false);
    }
  });
  it('the steer history plays no role: entry after a long held history = entry from scratch', () => {
    // Held below the entry speed with steer -1 for 30 ticks (buffer full of -1), then speed is
    // raised and steer +0.3 is held: same physics as a fresh car entering with +0.3.
    const a = fresh({ speed: 0.4 });
    hold(a, 30, -1);
    expect(enters(a)).toBe(false);
    const b = fresh({ speed: 0.4 });
    hold(b, 30, 0.3);
    expect(enters(b)).toBe(false);
    // align everything but the history and put both at speed 0.5, steer state as a fresh car
    for (const s of [a, b]) {
      const c = car(s);
      Object.assign(c, {
        speed: SPEED,
        x: 0,
        z: 10,
        vx: 0,
        yaw: 0,
        vel: 0,
        yawRate: 0,
        carry: 0,
        heading: 0,
        steer: 0,
      });
    }
    const f = fresh({ z: 10 });
    for (const s of [a, b, f]) stepB(s, inp(0.3, true), E3);
    expect(enters(f)).toBe(true);
    expect(phys(car(a))).toEqual(phys(car(f)));
    expect(phys(car(b))).toEqual(phys(car(f)));
  });
  it('entry kick is kickBase regardless of the steer change (hand-computed first tick)', () => {
    // Entry tick from rest (yaw = vel = carry = 0): slip0 = 0, yawRate = dir*kickBase = 2.
    // Same tick R83 DRIFT: yawRate += (W^2*(slipT - slip) - 2*W*yawRate)*DT, W = 8, then slip += yawRate*DT.
    // steer 1:   slipT = 2.64: yawRate = 2 + (64*2.64 - 32)/120 = 2 + 136.96/120 = 3.1413333...
    //            slip = 3.1413333/120 = 0.0261777...
    // steer 0.5: slipT = 1.32: yawRate = 2 + (84.48 - 32)/120 = 2.4373333..., slip = 0.0203111...
    const cases = [
      [1, 2 + (64 * 2.64 - 32) / 120],
      [0.5, 2 + (64 * 1.32 - 32) / 120],
    ] as const;
    for (const [st, yr] of cases) {
      const r = fresh();
      stepB(r, inp(st, true), E3);
      expect(car(r).yawRate).toBeCloseTo(yr, 9);
      expect(slipOf(car(r))).toBeCloseTo(yr * DT, 9);
      const l = fresh();
      stepB(l, inp(-st, true), E3);
      expect(car(l).yawRate).toBeCloseTo(-yr, 9);
      expect(slipOf(car(l))).toBeCloseTo(-yr * DT, 9);
    }
    expect(3.1413333).toBeCloseTo(cases[0][1], 6);
  });
});

describe('R81c driftEntry 3: entry effects equal variant C (R81b)', () => {
  // C enters on the first tick after deflectTime/DT = 18 full qualifying ticks: a car with
  // deflectTicks 18, previous steer of the same sign and the drift held enters on this tick.
  const starts: Partial<Car>[] = [
    {},
    { yaw: 0.3, vel: 0.1, carry: 0.05, yawRate: 0.4 }, // vis = 0.25 toward dir +1: slip0 = 0.25
    { yaw: -0.2, vel: 0.05, carry: 0.02, yawRate: -0.3 }, // vis = -0.23 against dir +1: slip0 = 0, carry = vis
    { x: 0.4, yaw: 0.1, vel: 0.2, carry: -0.04 },
  ];
  for (const [i, over] of starts.entries()) {
    for (const st of [0.9, -0.9]) {
      it(`start ${i}, steer ${st}: same state after the entry tick as C`, () => {
        const pre: Partial<Car> = { ...over, driftHeld: true, steer: st, deflectTicks: 18, z: 10 };
        const c = fresh(pre);
        stepB(c, inp(st, true), E2);
        expect(enters(c)).toBe(true); // precondition: C enters on this tick
        const d = fresh(pre);
        stepB(d, inp(st, true), E3);
        expect(phys(car(d))).toEqual(phys(car(c)));
        // and the following ticks of the drift agree too
        hold(c, 30, st, true, E2);
        hold(d, 30, st, true, E3);
        expect(phys(car(d))).toEqual(phys(car(c)));
      });
    }
  }
});

describe('R81c driftEntry 3: block after a drift ended by speed while held', () => {
  const lowExit = (): RaceState => {
    const s = fresh({ state: 'DRIFT', dir: 1, yaw: 0.5, speed: 0.2, driftHeld: true }); // 0.2 < 0.3
    hold(s, 1, 1);
    expect(car(s).state).toBe('GRIP'); // R82 low-speed exit with the drift still held
    car(s).speed = 0.6; // back above the entry speed, finger still down
    return s;
  };
  it('no re-entry while input.drift stays true, whatever the steer does', () => {
    const s = lowExit();
    for (let i = 0; i < 40; i++) {
      stepB(s, inp(i < 20 ? 1 : -1, true), E3);
      expect(enters(s)).toBe(false);
    }
  });
  it('one tick with drift false unblocks: the next held tick with steer != 0 enters', () => {
    const s = lowExit();
    hold(s, 10, 1);
    hold(s, 1, 1, false);
    expect(enters(s)).toBe(false);
    hold(s, 1, -1);
    expect(enters(s)).toBe(true);
    expect(car(s).dir).toBe(-1);
  });
  it('the block survives a JSON round-trip (flat state)', () => {
    const s = lowExit();
    hold(s, 3, 1);
    const t = JSON.parse(JSON.stringify(s)) as RaceState;
    hold(t, 20, 1);
    expect(enters(t)).toBe(false);
    hold(t, 1, 0, false);
    hold(t, 1, 1);
    expect(enters(t)).toBe(true);
  });
  it('an exit by release is not a block: pressing again with steer enters at once', () => {
    const s = fresh();
    hold(s, 20, 1);
    expect(enters(s)).toBe(true);
    hold(s, 1, 1, false);
    expect(enters(s)).toBe(false);
    hold(s, 1, 1);
    expect(enters(s)).toBe(true);
  });
});

describe('R81c driftEntry 3: exit by R82', () => {
  it('release exits to GRIP on that tick: dir 0, angle 0, carry = vis*exp(-carryDecay*DT) (straight: sG = 0)', () => {
    const s = fresh();
    hold(s, 30, 1);
    expect(enters(s)).toBe(true);
    const c0 = { ...car(s) };
    const vis = c0.yaw - c0.vel + c0.carry;
    expect(Math.abs(vis)).toBeGreaterThan(0.1); // a real angle is carried over
    hold(s, 1, 1, false);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).angle).toBe(0);
    // R82: A = 0 on a straight, sG = 0, carry = vis; R82b: carry *= exp(-8/120)
    expect(car(s).carry).toBeCloseTo(vis * Math.exp(-8 * DT), 12);
  });
  it('steer back to 0 with the drift held does not exit (only release or speed)', () => {
    const s = fresh();
    hold(s, 10, 1);
    hold(s, 60, 0);
    expect(enters(s)).toBe(true);
    expect(car(s).dir).toBe(1);
  });
});

describe('R81c driftEntry 3: properties', () => {
  const script = (i: number, sign: number): InputFrame =>
    inp(sign * Math.max(-1, Math.min(1, 1.3 * Math.sin(i / 11))), i % 150 > 20);
  const play = (sign: number, n = 600): RaceState => {
    const s = fresh();
    for (let i = 0; i < n; i++) stepB(s, script(i, sign), E3);
    return s;
  };
  it('left/right symmetry of the whole run', () => {
    const r = fresh();
    const l = fresh();
    let drifted = false;
    for (let i = 0; i < 600; i++) {
      stepB(r, script(i, 1), E3);
      stepB(l, script(i, -1), E3);
      const a = car(r);
      const b = car(l);
      if (a.state === 'DRIFT') drifted = true;
      expect(b.state).toBe(a.state);
      expect(b.dir + a.dir).toBe(0);
      expect(b.x).toBeCloseTo(-a.x, 9);
      expect(b.yaw).toBeCloseTo(-a.yaw, 9);
      expect(b.vel).toBeCloseTo(-a.vel, 9);
      expect(b.speed).toBeCloseTo(a.speed, 12);
    }
    expect(drifted).toBe(true);
  });
  it('deterministic: same inputs twice give identical state', () => {
    expect(JSON.stringify(play(1))).toBe(JSON.stringify(play(1)));
  });
  it('JSON round-trip mid-run continues identically', () => {
    const a = fresh();
    for (let i = 0; i < 200; i++) stepB(a, script(i, 1), E3);
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    for (let i = 200; i < 500; i++) {
      stepB(a, script(i, 1), E3);
      stepB(b, script(i, 1), E3);
    }
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('R81c driftEntry 3 is per car: cars with other variants are unaffected', () => {
  const STR = { segments: Array.from({ length: 2000 }, () => ({ curve: 0 })) };
  /** Three cars far apart (no contact), same held input steer 0.9 + drift for 5 ticks. */
  const run = (params: CarParams[]): RaceState => {
    const s = createRace(3, 3);
    s.cars.forEach((c, i) =>
      Object.assign(c, { speed: SPEED, z: 10 + 150 * i, x: -0.6 + 0.6 * i }),
    );
    const f: InputFrame[] = params.map(() => ({ steer: 0.9, brake: false, drift: true }));
    for (let i = 0; i < 5; i++) step(s, f, STR, params);
    return s;
  };
  it('variant 3 enters at once; variant 0 (no flick in a constant hold) and 2 (before deflectTime) do not', () => {
    const s = run([E3, E0, E2]);
    expect(s.cars.map((c) => c.state)).toEqual(['DRIFT', 'GRIP', 'GRIP']);
  });
  it('the variant is read per car, whatever the index', () => {
    expect(run([E0, E3, E2]).cars.map((c) => c.state)).toEqual(['GRIP', 'DRIFT', 'GRIP']);
    expect(run([E2, E0, E3]).cars.map((c) => c.state)).toEqual(['GRIP', 'GRIP', 'DRIFT']);
  });
});

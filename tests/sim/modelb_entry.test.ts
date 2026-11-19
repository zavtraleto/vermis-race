import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { PB, Q, STRAIGHT, car, inp, mk, stepB, stepN } from './modelb_helpers';

// Spec: docs/brief.md R81, R81b (H16), R82, R83. Explicit params, lamps off (Q from the helpers).
// Segment under the car = floor(z) mod segCount. "Ahead" = that segment .. +flickLook segments.

const NEW = {
  flickLook: 40,
  flickCornerMin: 2, // = `easy` in src/data/tracks/curves.json
  flickCornerMul: 0.6,
  flickStraightMul: 1.6,
  deflectEnter: 0.8,
  deflectTime: 0.15,
};
const E0: CarParams = { ...Q, ...NEW, driftEntry: 0 };
const E1: CarParams = { ...Q, ...NEW, driftEntry: 1 };
const E2: CarParams = { ...Q, ...NEW, driftEntry: 2 };

const SPEED = 0.5; // > driftEnterSpeed 0.45, constant (Q: accel 0, slipDrag 0)
const Z0 = 10; // car starts on segment 10; 0.25 segment per tick at speed 0.5, so it stays there
const CORNER = 4.5; // > flickCornerMin

function trackWith(len: number, at: Record<number, number>): Track {
  const segments = [];
  for (let i = 0; i < len; i++) segments.push({ curve: at[i] ?? 0 });
  return { segments };
}

/** Two held ticks: steer 0, then `d`. The flick is exactly d (history holds a single 0). */
function flick(p: CarParams, track: Track, d: number, over: Partial<Car> = {}): RaceState {
  const s = mk({ speed: SPEED, z: Z0, ...over });
  stepB(s, inp(0, true), p, track);
  stepB(s, inp(d, true), p, track);
  return s;
}
const enters = (s: RaceState): boolean => car(s).state === 'DRIFT';

describe('R81b driftEntry 0 (A) = R81 as before', () => {
  // flickDelta 0.5: d = 0.49 no, d = 0.5 yes, on a straight and in front of a corner alike.
  const cornerAhead = trackWith(200, { 30: CORNER });
  it('constant threshold flickDelta, with or without a corner ahead', () => {
    for (const tr of [STRAIGHT, cornerAhead]) {
      expect(enters(flick(E0, tr, 0.49))).toBe(false);
      expect(enters(flick(E0, tr, 0.5))).toBe(true);
      expect(enters(flick(E0, tr, -0.5))).toBe(true);
    }
  });
  it('the new params do not matter: scripted run is bit-for-bit identical', () => {
    const other: CarParams = {
      ...PB,
      driftEntry: 0,
      flickLook: 3,
      flickCornerMin: 0.1,
      flickCornerMul: 0.1,
      flickStraightMul: 9,
      deflectEnter: 0.1,
      deflectTime: 0.01,
    };
    const base: CarParams = { ...PB, driftEntry: 0, ...NEW };
    const tr = trackWith(400, { 20: 4.5, 21: 4.5, 22: 4.5, 60: -4.5, 61: -4.5 });
    const run = (p: CarParams): string[] => {
      const s = createRace(7, 1);
      car(s).speed = 0.8;
      const out: string[] = [];
      const f: InputFrame[] = [{ steer: 0, brake: false, drift: false }];
      for (let t = 0; t < 900; t++) {
        f[0]!.steer = Math.max(-1, Math.min(1, 1.3 * Math.sin(t / 9)));
        f[0]!.drift = t % 200 > 30;
        step(s, f, tr, [p]);
        const c = car(s);
        out.push(JSON.stringify({ ...c, deflectTicks: 0 })); // counter is only defined in C
      }
      return out;
    };
    expect(run(other)).toEqual(run(base));
  });
  it('the scripted run actually drifts (the comparison above is not vacuous)', () => {
    const s = mk({ speed: 0.8 });
    const tr = trackWith(400, {});
    let drifted = false;
    for (let t = 0; t < 900; t++) {
      step(
        s,
        [
          {
            steer: Math.max(-1, Math.min(1, 1.3 * Math.sin(t / 9))),
            brake: false,
            drift: t % 200 > 30,
          },
        ],
        tr,
        [{ ...PB, driftEntry: 0, ...NEW }],
      );
      if (car(s).state === 'DRIFT') drifted = true;
    }
    expect(drifted).toBe(true);
  });
});

describe('R81b driftEntry 1 (B) road-dependent threshold', () => {
  const corner = (idx: number, c = CORNER): Track => trackWith(200, { [idx]: c });

  it('toward a corner within flickLook: threshold 0.5*0.6 = 0.3 (0.3 enters, 0.29 does not)', () => {
    const tr = corner(30);
    expect(enters(flick(E1, tr, 0.35))).toBe(true);
    expect(car(flick(E1, tr, 0.35)).dir).toBe(1);
    expect(enters(flick(E1, tr, 0.3))).toBe(true);
    expect(enters(flick(E1, tr, 0.29))).toBe(false);
  });
  it('the same flick on a straight does not enter', () => {
    expect(enters(flick(E1, STRAIGHT, 0.35))).toBe(false);
    expect(car(flick(E1, STRAIGHT, 0.35)).state).toBe('GRIP');
  });
  it('straight: threshold 0.5*1.6 = 0.8: 0.7 no, 0.79 no, 0.8 yes, 0.85 yes', () => {
    expect(enters(flick(E1, STRAIGHT, 0.7))).toBe(false);
    expect(enters(flick(E1, STRAIGHT, 0.79))).toBe(false);
    expect(enters(flick(E1, STRAIGHT, 0.8))).toBe(true);
    expect(enters(flick(E1, STRAIGHT, 0.85))).toBe(true);
    expect(car(flick(E1, STRAIGHT, 0.85)).dir).toBe(1);
  });
  it('a flick against the corner ahead uses the straight multiplier', () => {
    const tr = corner(30); // right corner
    expect(enters(flick(E1, tr, -0.35))).toBe(false);
    expect(enters(flick(E1, tr, -0.7))).toBe(false);
    expect(enters(flick(E1, tr, -0.85))).toBe(true);
    expect(car(flick(E1, tr, -0.85)).dir).toBe(-1);
  });
  it('mirror: left corner, left flick 0.35 enters dir -1; right flick 0.35 does not', () => {
    const tr = corner(30, -CORNER);
    const l = flick(E1, tr, -0.35);
    expect(enters(l)).toBe(true);
    expect(car(l).dir).toBe(-1);
    expect(enters(flick(E1, tr, 0.35))).toBe(false);
    expect(enters(flick(E1, tr, 0.85))).toBe(true);
  });
  it('corner exactly flickLook segments ahead counts; one segment further does not', () => {
    expect(enters(flick(E1, corner(Z0 + 40), 0.35))).toBe(true);
    expect(enters(flick(E1, corner(Z0 + 41), 0.35))).toBe(false);
  });
  it('the corner on the current segment counts', () => {
    expect(enters(flick(E1, corner(Z0), 0.35))).toBe(true);
  });
  it('a corner behind the car does not count', () => {
    expect(enters(flick(E1, corner(Z0 - 1), 0.35))).toBe(false);
  });
  it('flickLook is read from the params', () => {
    const p: CarParams = { ...E1, flickLook: 10 };
    expect(enters(flick(p, corner(Z0 + 10), 0.35))).toBe(true);
    expect(enters(flick(p, corner(Z0 + 11), 0.35))).toBe(false);
  });
  it('corner weaker than flickCornerMin counts as a straight; exactly flickCornerMin counts', () => {
    expect(enters(flick(E1, corner(30, 1.99), 0.35))).toBe(false);
    expect(enters(flick(E1, corner(30, 1.99), 0.85))).toBe(true);
    expect(enters(flick(E1, corner(30, 2), 0.35))).toBe(true);
    expect(enters(flick(E1, corner(30, -1.99), -0.35))).toBe(false);
  });
  it('the largest |curvature| ahead decides when two corners are in range', () => {
    const tr = trackWith(200, { 20: 2.5, 30: -CORNER }); // weak right, strong left
    expect(enters(flick(E1, tr, -0.35))).toBe(true); // toward the left (dominant) corner
    expect(enters(flick(E1, tr, 0.35))).toBe(false); // toward the weaker right one: straight mul
    const tr2 = trackWith(200, { 20: -CORNER, 30: 2.5 }); // order does not matter
    expect(enters(flick(E1, tr2, -0.35))).toBe(true);
    expect(enters(flick(E1, tr2, 0.35))).toBe(false);
    // the strong corner outside the range is ignored; the weak one inside decides
    const tr3 = trackWith(200, { 20: 2.5, [Z0 + 41]: -CORNER });
    expect(enters(flick(E1, tr3, 0.35))).toBe(true);
    expect(enters(flick(E1, tr3, -0.35))).toBe(false);
  });
  it('lap wrap: a corner just after the end of the track is seen from the last segments', () => {
    const len = 100;
    const z = 95; // looks at 95..99 and 0..35
    expect(enters(flick(E1, trackWith(len, { 35: CORNER }), 0.35, { z }))).toBe(true);
    expect(enters(flick(E1, trackWith(len, { 36: CORNER }), 0.35, { z }))).toBe(false);
    expect(enters(flick(E1, trackWith(len, { 5: -CORNER }), -0.35, { z }))).toBe(true);
    expect(enters(flick(E1, trackWith(len, { 5: -CORNER }), 0.35, { z }))).toBe(false);
  });
  it('largest |d| in the window gives the sign for choosing m', () => {
    // right corner; history 0 then -0.1 then +0.3: d candidates +0.3 (vs 0) and +0.4 (vs -0.1).
    // largest |d| = +0.4 toward the corner: m = 0.6, threshold 0.3: enters dir +1.
    const tr = corner(30);
    const s = mk({ speed: SPEED, z: Z0 });
    stepB(s, inp(0, true), E1, tr);
    stepB(s, inp(-0.1, true), E1, tr);
    expect(enters(s)).toBe(false); // d = -0.1: no
    stepB(s, inp(0.3, true), E1, tr);
    expect(enters(s)).toBe(true);
    expect(car(s).dir).toBe(1);
  });
  it('everything else of R81 unchanged: hold, speed threshold, one hold, kick, vel kept', () => {
    const tr = corner(30);
    // no hold
    const a = mk({ speed: SPEED, z: Z0 });
    stepB(a, inp(0, false), E1, tr);
    stepB(a, inp(0.85, false), E1, tr);
    expect(enters(a)).toBe(false);
    // speed threshold: speed > driftEnterSpeed*vmax = 0.45 strictly
    expect(enters(flick(E1, tr, 0.35, { speed: 0.45 }))).toBe(false);
    expect(enters(flick(E1, tr, 0.35, { speed: 0.46 }))).toBe(true);
    // the flick must be inside one hold: release between the two taps clears the history
    const b = mk({ speed: SPEED, z: Z0 });
    stepB(b, inp(0, true), E1, tr);
    stepB(b, inp(0, false), E1, tr);
    stepB(b, inp(0.35, true), E1, tr);
    expect(enters(b)).toBe(false);
    // window: a flick older than flickWindow (0.12 s = 14 ticks) is forgotten
    const c = mk({ speed: SPEED, z: Z0 });
    stepB(c, inp(0, true), E1, tr);
    stepN(c, 20, inp(0.1, true), E1, tr);
    stepB(c, inp(0.35, true), E1, tr); // d vs the last 14 ticks = 0.25 < 0.3
    expect(enters(c)).toBe(false);
    // entry state: dir, yawRate has the sign of dir, vel unchanged by the entry
    const d = flick(E1, tr, 0.35);
    expect(car(d).dir).toBe(1);
    expect(car(d).yawRate).toBeGreaterThan(0);
    const e = flick(E1, trackWith(200, { 30: -CORNER }), -0.35);
    expect(car(e).dir).toBe(-1);
    expect(car(e).yawRate).toBeLessThan(0);
  });
  it('B on a straight with both multipliers 1 equals A (counter aside)', () => {
    const pb: CarParams = { ...E1, flickCornerMul: 1, flickStraightMul: 1 };
    const run = (p: CarParams): string => {
      const s = mk({ speed: 0.8 });
      for (let t = 0; t < 600; t++) {
        stepB(s, inp(Math.max(-1, Math.min(1, 1.3 * Math.sin(t / 9))), t % 200 > 30), p, STRAIGHT);
      }
      return JSON.stringify({ ...car(s), deflectTicks: 0 });
    };
    expect(run(pb)).toBe(run(E0));
  });
});

describe('R81b driftEntry 2 (C) entry by deflection', () => {
  const N = Math.round(NEW.deflectTime / DT); // 18 ticks
  const hold = (s: RaceState, n: number, steer: number, drift = true): void =>
    stepN(s, n, inp(steer, drift), E2);
  const fresh = (over: Partial<Car> = {}): RaceState => mk({ speed: SPEED, ...over });

  it('deflectTime 0.15 s is 18 ticks', () => {
    expect(N).toBe(18);
  });
  it('counts one per qualifying tick', () => {
    const s = fresh();
    hold(s, 10, 1);
    expect(car(s).deflectTicks).toBe(10);
    expect(car(s).state).toBe('GRIP');
  });
  it('not before deflectTime, entered after it (dir = sign steer, yawRate sign of dir)', () => {
    const s = fresh();
    hold(s, N - 1, 1);
    expect(enters(s)).toBe(false);
    hold(s, 2, 1); // 19 ticks: entered whether the 18th or the 19th tick counts
    expect(enters(s)).toBe(true);
    expect(car(s).dir).toBe(1);
    // yawRate = kickBase = 2 at entry, then one R83 tick: 2 + (W^2*(slipT - slip0) - 2*W*2)*DT,
    // W = 8, slipT = 2.64 (steer 1), slip0 in [0, 0.75]: 2 + (64*(2.64 - slip0) - 32)/120
    // lies in [2.74, 3.15]. Entry tick itself may be one tick earlier; allow a wide band.
    expect(car(s).yawRate).toBeGreaterThan(1.7);
    expect(car(s).yawRate).toBeLessThan(3.2);
  });
  it('mirror: negative steer enters dir -1 with negative yawRate', () => {
    const s = fresh();
    hold(s, N + 1, -1);
    expect(enters(s)).toBe(true);
    expect(car(s).dir).toBe(-1);
    expect(car(s).yawRate).toBeLessThan(-1.7);
    expect(car(s).yawRate).toBeGreaterThan(-3.2);
  });
  it('left/right symmetry of the whole state at entry', () => {
    const r = fresh();
    const l = fresh();
    hold(r, 25, 0.9);
    hold(l, 25, -0.9);
    const a = car(r);
    const b = car(l);
    expect(b.state).toBe(a.state);
    expect(a.dir).toBe(1); // entered (guards against a vacuous 0 = -0 symmetry)
    expect(b.dir).toBe(-1);
    expect(b.yawRate).toBeCloseTo(-a.yawRate, 12);
    expect(b.yaw).toBeCloseTo(-a.yaw, 12);
    expect(b.vel).toBeCloseTo(-a.vel, 12);
    expect(b.x).toBeCloseTo(-a.x, 12);
    expect(b.deflectTicks).toBe(a.deflectTicks);
  });
  it('exactly deflectEnter counts; just below never enters', () => {
    const s = fresh();
    hold(s, N + 1, 0.8);
    expect(enters(s)).toBe(true);
    const t = fresh();
    hold(t, 60, 0.79);
    expect(enters(t)).toBe(false);
    expect(car(t).deflectTicks).toBe(0);
  });
  it('resets on a sign change: the run starts again from the change', () => {
    const s = fresh();
    hold(s, 10, 1);
    hold(s, N - 1, -1); // at most 17 ticks of the new sign
    expect(enters(s)).toBe(false);
    hold(s, 2, -1);
    expect(enters(s)).toBe(true);
    expect(car(s).dir).toBe(-1);
  });
  it('resets on dropping below deflectEnter', () => {
    const s = fresh();
    hold(s, 10, 1);
    hold(s, 1, 0.79);
    expect(car(s).deflectTicks).toBe(0);
    hold(s, N - 1, 1);
    expect(enters(s)).toBe(false);
    hold(s, 2, 1);
    expect(enters(s)).toBe(true);
  });
  it('resets on release (no hold): counter 0, then the full time again', () => {
    const s = fresh();
    hold(s, 10, 1);
    hold(s, 1, 1, false);
    expect(car(s).deflectTicks).toBe(0);
    hold(s, N - 1, 1);
    expect(enters(s)).toBe(false);
    hold(s, 2, 1);
    expect(enters(s)).toBe(true);
  });
  it('the counter stays 0 outside GRIP', () => {
    const s = fresh({ state: 'DRIFT', dir: 1, yaw: 0.5, vel: 0, yawRate: 0 });
    hold(s, 5, 1);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).deflectTicks).toBe(0);
  });
  it('the counter does not grow below the entry speed', () => {
    const s = fresh({ speed: 0.4 }); // <= driftEnterSpeed 0.45
    hold(s, 40, 1);
    expect(enters(s)).toBe(false);
    expect(enters(s) || car(s).deflectTicks === 0).toBe(true);
  });
  it('a flick of any size does not enter in C', () => {
    for (const d of [0.5, 0.79, 1, 2]) {
      const s = fresh();
      hold(s, 1, d > 1 ? -1 : 0);
      hold(s, 5, d > 1 ? 1 : d);
      expect(enters(s)).toBe(false);
    }
    // jittering across the threshold never accumulates
    const j = fresh();
    for (let i = 0; i < 20; i++) {
      hold(j, 5, 1);
      hold(j, 1, 0);
    }
    expect(enters(j)).toBe(false);
  });
  it('after a low-speed exit while still held the counter does not grow until the hold breaks', () => {
    const s = fresh({ state: 'DRIFT', dir: 1, yaw: 0.5, speed: 0.2 }); // 0.2 < driftExitSpeed 0.3
    hold(s, 1, 1);
    expect(car(s).state).toBe('GRIP'); // R82 low-speed exit
    car(s).speed = 0.6; // speed is back above the entry threshold, finger still down
    hold(s, 40, 1);
    expect(enters(s)).toBe(false);
    expect(car(s).deflectTicks).toBe(0);
    hold(s, 1, 1, false); // the hold is interrupted
    hold(s, N + 1, 1);
    expect(enters(s)).toBe(true);
  });
  it('deterministic: same inputs twice give identical state', () => {
    const run = (): string => {
      const s = fresh();
      hold(s, 7, 0.3);
      hold(s, 12, 1);
      hold(s, 9, -0.9);
      hold(s, 30, -0.9);
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
  });
  it('JSON round-trip in the middle of a count does not change the result', () => {
    const a = fresh();
    hold(a, 10, 1);
    expect(car(a).deflectTicks).toBe(10);
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    expect(car(b).deflectTicks).toBe(10);
    hold(a, 12, 1);
    hold(b, 12, 1);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(enters(a)).toBe(true);
  });
  it('R82/R83 unchanged: release exits to GRIP and the counter is 0', () => {
    const s = fresh();
    hold(s, N + 1, 1);
    expect(enters(s)).toBe(true);
    hold(s, 1, 1, false);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).deflectTicks).toBe(0);
  });
});

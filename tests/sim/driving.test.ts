import { describe, expect, it } from 'vitest';
import { baseCar as dataCar } from '../../src/data/cars';
import { loadTestTwisty } from '../../src/data/tracks';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack, makeStraightTrack } from '../../src/sim/track';
import type { CarParams, InputFrame, RaceState } from '../../src/sim/types';
import { constTrack, inp, mirrorTrack, oneCar, stepN as stepNHelper } from './driving_helpers';

// R22c halved steerRate/centrifugal and xLimit in the data (lateral world speeds kept on a road twice
// as wide). These unit tests derive their numbers from the rules with the pre-R22c values, pinned here
// explicitly; the real data are covered by calibration.test.ts and the R22c describe in drift_calibration.
const baseCar: CarParams = { ...dataCar, steerRate: 2.0, centrifugal: 0.3, xLimit: 2 };

// Pin made effective: the helper's default params and constSpeed are rebuilt from the pinned baseCar.
const constSpeed: CarParams = { ...baseCar, accel: 0 };
const stepN = (
  s: RaceState,
  n: number,
  input: InputFrame,
  track: Parameters<typeof stepNHelper>[3],
  p: CarParams = baseCar,
): void => stepNHelper(s, n, input, track, p);

const straight = makeStraightTrack(2000);
const A = 1 - Math.exp(-baseCar.grip * DT); // per-step catch-up factor of R12

describe('R10 steer slew', () => {
  const rise = baseCar.steerRise * DT; // 10/120 = 0.08333 per step
  it('first step moves steer by exactly steerRise*DT', () => {
    const s = oneCar();
    stepN(s, 1, inp(1), straight);
    expect(s.cars[0]!.steer).toBeCloseTo(rise, 12);
  });
  it('never moves faster than the slew rate, and reaches the target and stops there', () => {
    const s = oneCar();
    let prev = 0;
    for (let i = 0; i < 40; i++) {
      stepN(s, 1, inp(0.5), straight);
      const st = s.cars[0]!.steer;
      expect(Math.abs(st - prev)).toBeLessThanOrEqual(rise + 1e-12);
      expect(st).toBeLessThanOrEqual(0.5 + 1e-12);
      prev = st;
    }
    // 0.5 / 0.08333 = 6 steps
    expect(prev).toBeCloseTo(0.5, 12);
  });
  it('is symmetric for negative input', () => {
    const a = oneCar();
    const b = oneCar();
    for (let i = 0; i < 30; i++) {
      stepN(a, 1, inp(0.7), straight);
      stepN(b, 1, inp(-0.7), straight);
      expect(b.cars[0]!.steer).toBeCloseTo(-a.cars[0]!.steer, 12);
    }
  });
  it('step response 0 -> 1 takes ceil(1/(steerRise*DT)) = 12 steps', () => {
    const s = oneCar();
    let n = 0;
    while (s.cars[0]!.steer < 1 - 1e-9 && n < 100) {
      stepN(s, 1, inp(1), straight);
      n++;
    }
    expect(n).toBe(Math.ceil(1 / rise - 1e-9));
  });
  it('slews back down at the same rate', () => {
    const s = oneCar({ steer: 1 });
    stepN(s, 1, inp(0), straight);
    expect(s.cars[0]!.steer).toBeCloseTo(1 - rise, 12);
  });
});

describe('R11/R12 lateral speed target and catch-up', () => {
  it('first step by hand (sp 0.5, steer 0.5)', () => {
    // target = 0.5*2*0.5*(1-0.125) = 0.4375; vx = 0.4375*(1-exp(-0.1))
    const s = oneCar({ speed: 0.5, steer: 0.5 });
    stepN(s, 1, inp(0.5), straight, constSpeed);
    expect(s.cars[0]!.vx).toBeCloseTo(0.4375 * A, 12);
  });
  it('steady state vx = target', () => {
    const s = oneCar({ speed: 0.5, steer: 0.5 });
    stepN(s, 120, inp(0.5), straight, constSpeed);
    expect(s.cars[0]!.vx).toBeCloseTo(0.4375, 4);
  });
  it('time constant: after 1/grip s (10 steps) vx = target*(1-exp(-1))', () => {
    const s = oneCar({ speed: 0.5, steer: 0.5 });
    stepN(s, 10, inp(0.5), straight, constSpeed);
    expect(s.cars[0]!.vx).toBeCloseTo(0.4375 * (1 - Math.exp(-1)), 9);
  });
  it('at sp=1 full steer gives 1.5 half-widths/s (2*1*0.75)', () => {
    const s = oneCar({ speed: 1, steer: 1, vx: 1.5 });
    stepN(s, 1, inp(1), straight, constSpeed);
    expect(s.cars[0]!.vx).toBeCloseTo(1.5, 12);
  });
  it('is symmetric for negative steer and zero at zero steer', () => {
    const a = oneCar({ speed: 0.8, steer: 0.6 });
    const b = oneCar({ speed: 0.8, steer: -0.6 });
    stepN(a, 20, inp(0.6), straight, constSpeed);
    stepN(b, 20, inp(-0.6), straight, constSpeed);
    expect(b.cars[0]!.vx).toBeCloseTo(-a.cars[0]!.vx, 12);
    const z = oneCar({ speed: 0.8 });
    stepN(z, 20, inp(0), straight, constSpeed);
    expect(z.cars[0]!.vx).toBe(0);
  });
});

describe('R13 centrifugal push', () => {
  const push = (curve: number, sp: number): number => {
    const s = oneCar({ speed: sp });
    stepN(s, 1, inp(0), constTrack(curve), constSpeed);
    return s.cars[0]!.x;
  };
  it('single step by hand: curve 2, sp 0.5', () => {
    // dx = -2 * 0.25 * 0.3 * 1.5 * (1/120) = -0.225/120 = -0.001875
    expect(push(2, 0.5)).toBeCloseTo(-0.001875, 12);
    expect(push(2, 0.5)).toBeCloseTo(-2 * 0.25 * baseCar.centrifugal * baseCar.kCurve * DT, 12);
  });
  it('doubling speed quadruples the push, doubling curve doubles it', () => {
    expect(push(2, 1) / push(2, 0.5)).toBeCloseTo(4, 9);
    expect(push(4, 0.5) / push(2, 0.5)).toBeCloseTo(2, 9);
  });
  it('right curve pushes left, left curve pushes right, straight no push', () => {
    expect(push(2, 0.5)).toBeLessThan(0);
    expect(push(-2, 0.5)).toBeGreaterThan(0);
    expect(push(0, 0.5)).toBe(0);
  });
  it('scales with kCurve', () => {
    const s = oneCar({ speed: 0.5 });
    stepN(s, 1, inp(0), constTrack(2), { ...constSpeed, kCurve: 3 });
    expect(s.cars[0]!.x).toBeCloseTo(-2 * 0.25 * 0.3 * 3 * DT, 12);
  });
});

describe('R15 offroad slowdown', () => {
  const mul = Math.pow(baseCar.offroadMul, 60 * DT); // 0.99^0.5
  it('|x| > 1: speed is multiplied by offroadMul^(60*DT)', () => {
    const s = oneCar({ speed: 0.5, x: 1.5 });
    stepN(s, 1, inp(0), straight, constSpeed);
    expect(s.cars[0]!.speed).toBeCloseTo(0.5 * mul, 12);
    const m = oneCar({ speed: 0.5, x: -1.5 });
    stepN(m, 1, inp(0), straight, constSpeed);
    expect(m.cars[0]!.speed).toBeCloseTo(0.5 * mul, 12);
  });
  it('applies after R14 (accel on)', () => {
    const s = oneCar({ speed: 0.5, x: 1.5 });
    stepN(s, 1, inp(0), straight);
    expect(s.cars[0]!.speed).toBeCloseTo((0.5 + baseCar.accel * DT) * mul, 12);
  });
  it('on road, including exactly |x| = 1, speed is untouched', () => {
    for (const x of [0, 0.99, 1, -1]) {
      const s = oneCar({ speed: 0.5, x });
      stepN(s, 1, inp(0), straight, constSpeed);
      expect(s.cars[0]!.speed).toBe(0.5);
    }
  });
});

describe('R18 lateral limit', () => {
  it('clamps x to xLimit and zeroes vx toward the wall', () => {
    // vx = 3*exp(-0.1) = 2.714, x = 1.999 + 0.0226 > 2
    const s = oneCar({ speed: 0.5, x: 1.999, vx: 3 });
    stepN(s, 1, inp(0), straight, constSpeed);
    expect(s.cars[0]!.x).toBe(baseCar.xLimit);
    expect(s.cars[0]!.vx).toBe(0);
  });
  it('mirrored: -xLimit and vx zeroed', () => {
    const s = oneCar({ speed: 0.5, x: -1.999, vx: -3 });
    stepN(s, 1, inp(0), straight, constSpeed);
    expect(s.cars[0]!.x).toBe(-baseCar.xLimit);
    expect(s.cars[0]!.vx).toBe(0);
  });
  it('vx away from the wall is kept (curve pushes car into the wall)', () => {
    // at x = 2 with a left curve (pushes right) and vx<0 moving inward
    const s = oneCar({ speed: 1, x: 2, vx: -0.5 });
    stepN(s, 1, inp(0), constTrack(-4.5), constSpeed);
    expect(s.cars[0]!.x).toBe(2);
    expect(s.cars[0]!.vx).toBeLessThan(0);
    const m = oneCar({ speed: 1, x: -2, vx: 0.5 });
    stepN(m, 1, inp(0), constTrack(4.5), constSpeed);
    expect(m.cars[0]!.x).toBe(-2);
    expect(m.cars[0]!.vx).toBeGreaterThan(0);
  });
  it('respects a custom xLimit', () => {
    const s = oneCar({ speed: 0.5, x: 1.19, vx: 3 });
    stepN(s, 1, inp(0), straight, { ...constSpeed, xLimit: 1.2 });
    expect(s.cars[0]!.x).toBe(1.2);
    expect(s.cars[0]!.vx).toBe(0);
  });
  it('|x| never exceeds xLimit under hard abuse', () => {
    const s = oneCar({ speed: 1 });
    for (let i = 0; i < 1500; i++) {
      stepN(s, 1, inp(1), constTrack(-4.5), constSpeed);
      expect(Math.abs(s.cars[0]!.x)).toBeLessThanOrEqual(baseCar.xLimit);
    }
  });
});

describe('R19 order and signs', () => {
  it('single step from a hand-set state, uses pre-update speed and new vx', () => {
    // accel 30 -> speed 0.5 + 30/120 = 0.75 after R14, but sp for R11/R13 is 0.5.
    // steer 0.4 == input, so unchanged. target = 0.4*2*0.5*(1-0.125) = 0.35
    // vx = 0.1 + (0.35-0.1)*(1-exp(-0.1)); x = vx*DT - 1*0.25*0.3*1.5*DT
    const s = oneCar({ speed: 0.5, steer: 0.4, vx: 0.1 });
    stepN(s, 1, inp(0.4), constTrack(1), { ...baseCar, accel: 30 });
    const vx = 0.1 + (0.35 - 0.1) * A;
    expect(s.cars[0]!.speed).toBeCloseTo(0.75, 12);
    expect(s.cars[0]!.vx).toBeCloseTo(vx, 12);
    expect(s.cars[0]!.x).toBeCloseTo(vx * DT - 0.25 * 0.3 * 1.5 * DT, 12);
  });
  it('steer > 0 moves x right, curve > 0 moves x left', () => {
    const a = oneCar({ speed: 0.5, steer: 0.5 });
    stepN(a, 1, inp(0.5), straight, constSpeed);
    expect(a.cars[0]!.x).toBeGreaterThan(0);
    const b = oneCar({ speed: 0.5 });
    stepN(b, 1, inp(0), constTrack(3), constSpeed);
    expect(b.cars[0]!.x).toBeLessThan(0);
  });
  it('uses the segment under the car before z advances', () => {
    const t = constTrack(0, 10);
    t.segments[3] = { curve: 2 };
    const s = oneCar({ speed: 0.5, z: 3.5 });
    stepN(s, 1, inp(0), t, constSpeed);
    expect(s.cars[0]!.x).toBeCloseTo(-2 * 0.25 * 0.3 * 1.5 * DT, 12);
  });
});

function varied(tick: number, sign: number): InputFrame {
  return {
    steer:
      sign * Math.max(-1, Math.min(1, 1.4 * Math.sin(tick * 0.013) + 0.3 * Math.sin(tick * 0.071))),
    brake: tick % 500 >= 300 && tick % 500 < 330,
    drift: false,
  };
}

describe('mirror symmetry of the driving model', () => {
  it('mirrored track and inputs give mirrored x, vx, steer, heading', () => {
    const track = buildTrack(loadTestTwisty().def);
    const mt = mirrorTrack(track);
    const a = createRace(1, 1);
    const b = createRace(1, 1);
    for (let i = 0; i < 2000; i++) {
      step(a, [varied(i, 1)], track, [baseCar]);
      step(b, [varied(i, -1)], mt, [baseCar]);
      if (i % 100 === 99 || i === 1999) {
        const ca = a.cars[0]!;
        const cb = b.cars[0]!;
        expect(cb.x).toBeCloseTo(-ca.x, 9);
        expect(cb.vx).toBeCloseTo(-ca.vx, 9);
        expect(cb.steer).toBeCloseTo(-ca.steer, 9);
        expect(cb.heading).toBeCloseTo(-ca.heading, 9);
        expect(cb.z).toBeCloseTo(ca.z, 9);
        expect(cb.speed).toBeCloseTo(ca.speed, 9);
      }
    }
  });
});

describe('determinism, serialization, drift ignored', () => {
  const runTwisty = (s: RaceState, from: number, to: number, drift = false): void => {
    const track = buildTrack(loadTestTwisty().def);
    for (let i = from; i < to; i++) step(s, [{ ...varied(i, 1), drift }], track, [baseCar]);
  };
  it('same inputs twice give deep-equal state', () => {
    const a = createRace(7, 1);
    const b = createRace(7, 1);
    runTwisty(a, 0, 1500);
    runTwisty(b, 0, 1500);
    expect(a).toEqual(b);
  });
  it('JSON round-trip mid-run continues identically', () => {
    const a = createRace(7, 1);
    runTwisty(a, 0, 800);
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    runTwisty(a, 800, 1600);
    runTwisty(b, 800, 1600);
    expect(b).toEqual(a);
  });
  it('without drift input the run never leaves GRIP and dir stays 0 (R20)', () => {
    const s = createRace(7, 1);
    const track = buildTrack(loadTestTwisty().def);
    for (let i = 0; i < 1500; i++) {
      step(s, [{ ...varied(i, 1), drift: false }], track, [baseCar]);
      expect(s.cars[0]!.state).toBe('GRIP');
      expect(s.cars[0]!.dir).toBe(0);
    }
  });
  it('drift input below driftEnterSpeed*vmax changes nothing (R20)', () => {
    // accel 0.22 from standstill: after 200 ticks (1.67 s) speed ~0.37 < 0.45.
    const a = createRace(7, 1);
    const b = createRace(7, 1);
    runTwisty(a, 0, 200, false);
    runTwisty(b, 0, 200, true);
    expect(a.cars[0]!.speed).toBeLessThan(0.45 * baseCar.vmax);
    // R20: driftHeld records the previous tick's drift input and legitimately differs.
    expect(a.cars[0]!.driftHeld).toBe(false);
    expect(b.cars[0]!.driftHeld).toBe(true);
    const strip = (r: RaceState): unknown => {
      const c = JSON.parse(JSON.stringify(r)) as RaceState;
      for (const car of c.cars) (car as { driftHeld?: boolean }).driftHeld = false;
      return c;
    };
    expect(strip(b)).toEqual(strip(a));
    expect(b.cars[0]!.state).toBe('GRIP');
    expect(b.cars[0]!.dir).toBe(0);
  });
  it('step allocates nothing (no new objects in the tick)', () => {
    const s = createRace(7, 1);
    const cars = s.cars;
    const car = cars[0]!;
    const keys = Object.keys(car).sort();
    const track = buildTrack(loadTestTwisty().def);
    const input = inp(0.3);
    const params = [baseCar];
    for (let i = 0; i < 10000; i++) step(s, [input], track, params);
    expect(s.cars).toBe(cars);
    expect(s.cars[0]).toBe(car);
    expect(Object.keys(car).sort()).toEqual(keys);
  });
});

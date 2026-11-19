import { describe, expect, it } from 'vitest';
import { baseCarA as baseCar } from './baseCarA';
import { curveClasses } from '../../src/data/tracks';
import { createRace, step } from '../../src/sim/race';
import { constSpeed, constTrack } from './driving_helpers';

/**
 * R22d: GRIP calibration on the real data (curveClasses, base.json), at vmax (sp = 1).
 * Steady GRIP state: vx = s * steerRate * sp * (1 - 0.25 sp) = 0.75 * steerRate * s (R11, R12);
 * push = c * sp^2 * centrifugal * kCurve (R13, cm = 1). The line is held (dx/dt = 0) when
 *   s* = c * centrifugal * kCurve / (0.75 * steerRate).
 * Required: easy s* in [0.4, 0.5], medium s* in [0.9, 1.0], hard s* > 1.
 * (The window R22b angles of the drift are in drift_calibration.test.ts and are unchanged.)
 */
const P = baseCar;
const sStar = (c: number): number => (c * P.centrifugal * P.kCurve) / (0.75 * P.steerRate);

/** x after `seconds` at vmax holding steer s from x = 0 with vx already at the steady value. */
function track(c: number, s: number, seconds: number): { maxAbsX: number; x: number } {
  const race = createRace(1, 1);
  const car = race.cars[0]!;
  car.speed = P.vmax;
  car.steer = s;
  car.vx = s * P.steerRate * 0.75;
  const tr = constTrack(c, 4000);
  let maxAbsX = 0;
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    step(race, [{ steer: s, brake: false, drift: false }], tr, [constSpeed]);
    maxAbsX = Math.max(maxAbsX, Math.abs(car.x));
  }
  return { maxAbsX, x: car.x };
}

describe('R22d analytic equilibrium steer at vmax (from base.json and curves.json)', () => {
  it('R22d easy needs 0.4-0.5 of the steer', () => {
    expect(sStar(curveClasses.easy)).toBeGreaterThanOrEqual(0.4);
    expect(sStar(curveClasses.easy)).toBeLessThanOrEqual(0.5);
  });
  it('R22d medium needs 0.9-1.0 of the steer (the edge)', () => {
    expect(sStar(curveClasses.medium)).toBeGreaterThanOrEqual(0.9);
    expect(sStar(curveClasses.medium)).toBeLessThanOrEqual(1.0);
  });
  it('R22d hard needs more than full steer', () => {
    expect(sStar(curveClasses.hard)).toBeGreaterThan(1);
  });
  it('R22d monotonic in the curve class: easy < medium < hard', () => {
    expect(sStar(curveClasses.easy)).toBeLessThan(sStar(curveClasses.medium));
    expect(sStar(curveClasses.medium)).toBeLessThan(sStar(curveClasses.hard));
  });
});

describe('R22d simulation at vmax in GRIP (speed held at vmax, accel 0)', () => {
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'right' : 'left';
    it(`R22d medium ${tag}: holding the derived steer holds the line (|x| < 0.02 over 10 s)`, () => {
      const s = sStar(curveClasses.medium);
      expect(track(side * curveClasses.medium, side * s, 10).maxAbsX).toBeLessThan(0.02);
    });
    it(`R22d medium ${tag}: full steer from x = 0 keeps |x| <= 1 for 10 s (inward drift at most 0.1 * 0.75 per s)`, () => {
      // Setup: x = 0, speed = vmax constant, steer 1 and vx at its steady value 0.75 at the start.
      expect(track(side * curveClasses.medium, side * 1, 10).maxAbsX).toBeLessThanOrEqual(1);
    });
    it(`R22d medium ${tag}: 0.2 less steer than the derived one loses the line outward (> 0.15 in 2 s)`, () => {
      const s = sStar(curveClasses.medium) - 0.2;
      expect(side * track(side * curveClasses.medium, side * s, 2).x).toBeLessThan(-0.15);
    });
    it(`R22d hard ${tag}: even full steer cannot hold it, the car leaves the road (|x| > 1 within 10 s)`, () => {
      const r = track(side * curveClasses.hard, side * 1, 10);
      expect(r.maxAbsX).toBeGreaterThan(1);
      expect(side * r.x).toBeLessThan(0); // outward
    });
    it(`R22d easy ${tag}: the derived steer holds the line (|x| < 0.02 over 10 s)`, () => {
      expect(
        track(side * curveClasses.easy, side * sStar(curveClasses.easy), 10).maxAbsX,
      ).toBeLessThan(0.02);
    });
  }
  it('R22d left/right symmetric: mirror curves and steers give mirrored x', () => {
    const a = track(curveClasses.medium, 0.9, 5).x;
    const b = track(-curveClasses.medium, -0.9, 5).x;
    expect(b).toBeCloseTo(-a, 9);
  });
});

import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { curveClasses } from '../../src/data/tracks';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame } from '../../src/sim/types';
import { constTrack } from './driving_helpers';

/**
 * R22b: the real base car must make a drift HOLDABLE at vmax.
 * At sp = 1 the equilibrium steer s* solves
 *   lerp(min, max, (s+1)/2) * driftRate = curve * centrifugal * centMulDrift * kCurve.
 * Real numbers (base.json after stage 2: driftRate 0.7): hard 4.5 -> rhs = 0.70875 -> lerp = 1.0125
 * -> (s+1)/2 = 0.5083 -> s* = 0.0167; medium 2.5 -> rhs = 0.39375 -> lerp = 0.5625 -> s* = -0.583.
 */
type DP = CarParams & {
  driftEnterSpeed: number;
  driftExitSpeed: number;
  driftSteerMin: number;
  driftSteerMax: number;
};
const P = baseCar as unknown as DP;

/** Equilibrium steer in the dir-relative frame (positive = into the corner). */
function sStar(curve: number): number {
  const rhs = curve * P.centrifugal * P.centMulDrift * P.kCurve;
  const lerpVal = rhs / P.driftRate;
  return 2 * ((lerpVal - P.driftSteerMin) / (P.driftSteerMax - P.driftSteerMin)) - 1;
}

describe('R22b drift calibration, equilibrium steer at sp = 1', () => {
  it('R22b hard: s* within [-0.35, 0.35]', () => {
    const s = sStar(curveClasses.hard);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(-0.35);
    expect(s).toBeLessThanOrEqual(0.35);
  });
  it('R22b medium: s* within [-0.95, -0.3]', () => {
    const s = sStar(curveClasses.medium);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(-0.95);
    expect(s).toBeLessThanOrEqual(-0.3);
  });
  it('R22b easy: needs more counter-steer than medium (drift pulls inward)', () => {
    // brief: "in easy the drift pulls inward". Weakest checkable form: s*(easy) < s*(medium).
    expect(Number.isFinite(sStar(curveClasses.easy))).toBe(true);
    expect(sStar(curveClasses.easy)).toBeLessThan(sStar(curveClasses.medium));
  });
});

describe('R22b run on a constant hard curve at vmax', () => {
  const K = 1.0; // gain on x; loop x'' + 3x' + 1.575 K x = 0 is overdamped for K = 1
  const SEGMENTS = 330; // 5.5 s at vmax

  for (const side of [1, -1] as const) {
    const tag = side > 0 ? 'right' : 'left';
    it(`R22b ${tag}: held drift stays on asphalt, in DRIFT, at >= 0.95 vmax for 330 segments`, () => {
      const hard = side * curveClasses.hard;
      const base = sStar(curveClasses.hard);
      expect(Number.isFinite(base)).toBe(true);
      const race = createRace(1, 1);
      const car: Car = race.cars[0]!;
      const startVx =
        side *
        (P.driftSteerMin + (P.driftSteerMax - P.driftSteerMin) * ((base + 1) / 2)) *
        P.driftRate;
      car.speed = P.vmax;
      car.x = 0;
      car.steer = side * base;
      car.vx = startVx;
      car.state = 'DRIFT';
      car.dir = side;
      const track = constTrack(hard, 2000);
      let maxAbsX = 0;
      let minSpeed = Infinity;
      let allDrift = true;
      let ticks = 0;
      while (car.z < SEGMENTS && ticks < 5000) {
        // xi > 0 means inside the corner (dir frame): steer less then, more when outside.
        const xi = side * car.x;
        const steerDir = Math.max(-1, Math.min(1, base - K * xi));
        const input: InputFrame = { steer: side * steerDir, brake: false, drift: true };
        step(race, [input], track, [P]);
        ticks++;
        const ax = Math.abs(car.x);
        if (!(ax <= maxAbsX)) maxAbsX = ax; // NaN also lands here and fails the bound below
        if (!(car.speed >= minSpeed)) minSpeed = car.speed;
        if (car.state !== 'DRIFT') allDrift = false;
      }
      expect(car.z).toBeGreaterThanOrEqual(SEGMENTS);
      expect(maxAbsX).toBeLessThanOrEqual(1);
      expect(allDrift).toBe(true);
      expect(minSpeed).toBeGreaterThanOrEqual(0.95 * P.vmax);
    });

    it(`R22b ${tag}: GRIP at vmax with full steer leaves the asphalt (why drift is needed)`, () => {
      const hard = side * curveClasses.hard;
      const race = createRace(1, 1);
      const car = race.cars[0]!;
      car.speed = P.vmax;
      car.steer = side;
      car.vx = side * baseCar.steerRate * 0.75; // steady grip lateral speed at sp = 1, full steer
      const track = constTrack(hard, 2000);
      const input: InputFrame = { steer: side, brake: false, drift: false };
      let left = false;
      for (let i = 0; i < 700 && car.z < 330; i++) {
        step(race, [input], track, [baseCar]);
        if (Math.abs(car.x) > 1) left = true;
      }
      expect(left).toBe(true);
      expect(car.state).toBe('GRIP');
    });
  }
});

import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { curveClasses } from '../../src/data/tracks';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { InputFrame, Track } from '../../src/sim/types';
import { constSpeed, constTrack } from './driving_helpers';

// Derivation: steady vx = s*steerRate*sp*(1-0.25*sp); push = c*sp^2*centrifugal*kCurve.
// Hold x at sp=1: s*2*0.75 = c*0.3*kCurve  =>  s = c*centrifugal*kCurve/(steerRate*0.75).
// Author decision 2026-11-19: easy (c=2) needs 55-65% steer at vmax: 2*0.3*1.5/1.5 = 0.6.
// medium (4.5): 4.5*0.45/1.5 = 1.35 > 1 and hard (7): 2.1 > 1, so neither is holdable in GRIP.

const arc = (c: number): Track =>
  buildTrack({ sections: [{ enter: 0, hold: 1000, leave: 0, curve: c }] });

/** Holds speed sp, starts at steady state for steer s; returns x change over `seconds`. */
function drift(c: number, s: number, sp: number, seconds: number): number {
  const race = createRace(1, 1);
  const car = race.cars[0]!;
  car.speed = sp;
  car.steer = s;
  car.vx = s * baseCar.steerRate * sp * (1 - 0.25 * sp);
  const input: InputFrame = { steer: s, brake: false, drift: false };
  const track = arc(c);
  const n = Math.round(seconds * 120);
  for (let i = 0; i < n; i++) step(race, [input], track, [constSpeed]);
  return car.x;
}

describe('calibration easy curve at vmax in GRIP', () => {
  it('required steer ratio c*centrifugal*kCurve/(steerRate*0.75) lies in [0.55, 0.65]', () => {
    const r =
      (baseCar.kCurve * baseCar.centrifugal * curveClasses.easy) / (baseCar.steerRate * 0.75);
    expect(r).toBeGreaterThanOrEqual(0.55);
    expect(r).toBeLessThanOrEqual(0.65);
  });
  for (const side of [1, -1]) {
    const c = side * curveClasses.easy;
    const tag = side > 0 ? 'right' : 'left';
    it(`${tag}: steer 0.6 holds the line (|dx| < 0.02 in 2 s)`, () => {
      expect(Math.abs(drift(c, side * 0.6, 1, 2))).toBeLessThan(0.02);
    });
    it(`${tag}: steer 0.45 drifts outward by > 0.3 in 2 s`, () => {
      expect(side * drift(c, side * 0.45, 1, 2)).toBeLessThan(-0.3);
    });
    it(`${tag}: steer 0.8 pulls inward`, () => {
      expect(side * drift(c, side * 0.8, 1, 2)).toBeGreaterThan(0);
    });
  }
});

describe('calibration medium and hard are not passable in GRIP at vmax', () => {
  // Full steer at sp = 1 gives steady vx = 1.5 (inward); push is 0.45*c > 1.5 for c >= 4.5.
  for (const cls of ['medium', 'hard'] as const) {
    for (const side of [1, -1]) {
      const tag = side > 0 ? 'right' : 'left';
      it(`${cls} ${tag}: full steer in GRIP leaves the asphalt within the corner`, () => {
        const race = createRace(1, 1);
        const car = race.cars[0]!;
        car.speed = 1;
        car.steer = side;
        car.vx = side * baseCar.steerRate * 0.75;
        const track = constTrack(side * curveClasses[cls], 2000);
        const input: InputFrame = { steer: side, brake: false, drift: false };
        let left = false;
        for (let i = 0; i < 700 && car.z < 330; i++) {
          step(race, [input], track, [constSpeed]);
          if (side * car.x < -1) left = true; // outward, not inward overshoot
        }
        expect(left).toBe(true);
        expect(car.state).toBe('GRIP');
      });
    }
  }
});

describe('calibration hard curve threshold speed', () => {
  const p = baseCar;
  // 2*(1-0.25 sp) = 0.3*kCurve*hard*sp  =>  sp* = steerRate/(0.25*steerRate + centrifugal*kCurve*hard)
  // = 2/(0.5 + 0.3*1.5*7) = 2/3.65 = 0.548
  const spStar = p.steerRate / (0.25 * p.steerRate + p.centrifugal * p.kCurve * curveClasses.hard);
  it('threshold speed is below vmax', () => {
    expect(spStar).toBeLessThan(1);
  });
  it('at vmax full steer still goes outward', () => {
    expect(drift(curveClasses.hard, 1, 1, 1)).toBeLessThan(-0.1);
    expect(drift(-curveClasses.hard, -1, 1, 1)).toBeGreaterThan(0.1);
  });
  it('full steer holds or pulls inward just below sp*, fails just above', () => {
    expect(drift(curveClasses.hard, 1, spStar - 0.05, 1)).toBeGreaterThanOrEqual(-1e-9);
    expect(drift(curveClasses.hard, 1, spStar + 0.05, 1)).toBeLessThan(0);
    expect(drift(-curveClasses.hard, -1, spStar - 0.05, 1)).toBeLessThanOrEqual(1e-9);
    expect(drift(-curveClasses.hard, -1, spStar + 0.05, 1)).toBeGreaterThan(0);
  });
});

describe('calibration P-controller on a constant easy curve', () => {
  // Requirement in isolation: a simple proportional GRIP controller at vmax keeps |x| < 1 on an easy curve.
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'right' : 'left';
    it(`${tag}: steer = clamp(-3x) keeps |x| < 1 for 600 segments at vmax`, () => {
      const race = createRace(1, 1);
      const car = race.cars[0]!;
      car.speed = baseCar.vmax;
      const track = constTrack(side * curveClasses.easy, 2000);
      const input: InputFrame = { steer: 0, brake: false, drift: false };
      const inputs = [input];
      const params = [baseCar];
      let maxX = 0;
      let guard = 0;
      while (car.z < 600 && guard++ < 100000) {
        input.steer = Math.max(-1, Math.min(1, -3 * car.x));
        step(race, inputs, track, params);
        maxX = Math.max(maxX, Math.abs(car.x));
      }
      expect(car.z).toBeGreaterThanOrEqual(600);
      expect(maxX).toBeLessThan(1);
    });
  }
});

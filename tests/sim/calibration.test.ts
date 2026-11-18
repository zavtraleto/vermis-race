import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { curveClasses, loadTestTwisty } from '../../src/data/tracks';
import { SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { InputFrame, Track } from '../../src/sim/types';
import { constSpeed } from './driving_helpers';

// Derivation: steady vx = s*steerRate*sp*(1-0.25*sp); push = c*sp^2*centrifugal*kCurve.
// Hold x at sp=1: s*2*0.75 = c*0.3*kCurve  =>  kCurve = 5*s/c.
// With s=0.75 on a medium curve c=2.5: kCurve = 1.5 (value in base.json).

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

describe('calibration kCurve', () => {
  it('kCurve*centrifugal*medium/(steerRate*0.75) lies in [0.70, 0.80]', () => {
    const r =
      (baseCar.kCurve * baseCar.centrifugal * curveClasses.medium) / (baseCar.steerRate * 0.75);
    expect(r).toBeGreaterThanOrEqual(0.7);
    expect(r).toBeLessThanOrEqual(0.8);
  });
});

describe('calibration medium curve at vmax', () => {
  for (const side of [1, -1]) {
    const c = side * curveClasses.medium;
    const tag = side > 0 ? 'right' : 'left';
    it(`${tag}: steer 0.75 holds the line (|dx| < 0.01 in 2 s)`, () => {
      expect(Math.abs(drift(c, side * 0.75, 1, 2))).toBeLessThan(0.01);
    });
    it(`${tag}: steer 0.5 drifts outward by > 0.5 in 2 s`, () => {
      expect(side * drift(c, side * 0.5, 1, 2)).toBeLessThan(-0.5);
    });
    it(`${tag}: steer 1.0 pulls inward`, () => {
      expect(side * drift(c, side * 1, 1, 2)).toBeGreaterThan(0);
    });
  }
});

describe('calibration hard curve', () => {
  const p = baseCar;
  // 2*(1-0.25 sp) = 0.3*kCurve*hard*sp  =>  sp* = steerRate/(0.25*steerRate + centrifugal*kCurve*hard)
  // = 2/(0.5 + 0.3*1.5*4.5) = 2/2.525 = 0.792 (director quoted ~0.8)
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

describe('calibration bot on test-twisty', () => {
  it('P-controller stays on the road on easy and medium, within xLimit on hard', () => {
    const tw = loadTestTwisty();
    const track = buildTrack(tw.def);
    const len = track.segments.length;
    // cumulative section ends -> class lookup
    const ends: number[] = [];
    let acc = 0;
    for (const s of tw.sections) {
      acc += s.enter + s.hold + s.leave;
      ends.push(acc);
    }
    const classAt = (z: number): 'easy' | 'medium' | 'hard' => {
      const seg = Math.floor(z) % len;
      let i = 0;
      while (i < ends.length - 1 && seg >= ends[i]!) i++;
      return tw.sections[i]!.curveClass;
    };
    const race = createRace(1, 1);
    const car = race.cars[0]!;
    const input: InputFrame = { steer: 0, brake: false, drift: false };
    const params = [baseCar];
    const inputs = [input];
    const maxX = { easy: 0, medium: 0, hard: 0 };
    let guard = 0;
    while (car.z < 2 * len && guard++ < 200000) {
      input.steer = Math.max(-1, Math.min(1, -3 * car.x));
      step(race, inputs, track, params);
      if (car.z >= len && car.z < 2 * len) {
        const k = classAt(car.z);
        const ax = Math.abs(car.x);
        if (ax > maxX[k]) maxX[k] = ax;
      }
    }
    expect(car.z).toBeGreaterThanOrEqual(2 * len);
    // director's prototype: hard ~1.13, easy/medium ~0.73
    expect(maxX.easy).toBeLessThan(1);
    expect(maxX.medium).toBeLessThan(1);
    expect(maxX.hard).toBeLessThanOrEqual(baseCar.xLimit);
    expect(SEG_PER_UNIT).toBe(60);
  });
});

import { describe, expect, it } from 'vitest';
import { baseCarA as baseCar } from './baseCarA';
import road from '../../src/data/road.json';
import { curveClasses } from '../../src/data/tracks';
import { createRace, step } from '../../src/sim/race';
import type { Car, InputFrame } from '../../src/sim/types';
import { constTrack } from './driving_helpers';

/**
 * R22b: the real base car (src/data) must make a drift HOLDABLE at the angle the brief names.
 * Holding condition at steady speed (lateral target = centrifugal push, curve c, sp = speed/vmax):
 *   angle * driftRate * sp = c * sp^2 * centrifugal * centMulDrift * kCurve
 *   => angle = C * sp,   C = c * centrifugal * centMulDrift * kCurve / driftRate.
 * Steady speed is the cap R22: sp = 1 - driftSpeedLoss * angle (vmax-relative), so
 *   angle = C * (1 - L*angle)  =>  angle* = C / (1 + C*L),  L = driftSpeedLoss.
 * The test derives angle* from the params of base.json, then checks the brief's windows:
 *   hard in [0.75, 0.85], medium in [0.45, 0.55], easy <= 0.25.
 */
const P = baseCar;
const L = P.driftSpeedLoss;

function holdAngle(curve: number): number {
  const C = (curve * P.centrifugal * P.centMulDrift * P.kCurve) / P.driftRate;
  return C / (1 + C * L);
}
const spAt = (a: number): number => 1 - L * a;

describe('R22c road and units', () => {
  it('R22c xLimit is 1.5 half-widths', () => {
    expect(P.xLimit).toBe(1.5);
  });
  it('R22c road: halfWidth 1000 and 8 lanes', () => {
    expect(road.halfWidth).toBe(1000);
    expect(road.lanes).toBe(8);
  });
  it('R22c centrifugal is the old value halved (0.3 -> 0.15); steerRate was halved to 1.0 then raised by R22d (windows in r22d.test.ts)', () => {
    expect(P.centrifugal).toBeCloseTo(0.15, 12);
    expect(P.steerRate).toBeGreaterThan(1.0);
  });
  it('R22c the old drift params are gone, the new ones are positive numbers', () => {
    const rec = P as unknown as Record<string, unknown>;
    for (const k of ['driftSteerMin', 'driftSteerMax', 'driftDrag']) expect(rec[k]).toBeUndefined();
    for (const k of [
      'driftAngleStart',
      'driftAngleExit',
      'driftStraightTime',
      'driftAngleResponse',
      'driftSpeedLoss',
      'driftBrake',
    ]) {
      expect(typeof rec[k], k).toBe('number');
      expect(rec[k] as number, k).toBeGreaterThan(0);
    }
    expect(P.driftAngleExit).toBeLessThan(P.driftAngleStart);
  });
});

describe('R22b holding angle windows (analytic, from base.json)', () => {
  it('R22b hard: angle in [0.75, 0.85]', () => {
    const a = holdAngle(curveClasses.hard);
    expect(a).toBeGreaterThanOrEqual(0.75);
    expect(a).toBeLessThanOrEqual(0.85);
  });
  it('R22b medium: angle in [0.45, 0.55]', () => {
    const a = holdAngle(curveClasses.medium);
    expect(a).toBeGreaterThanOrEqual(0.45);
    expect(a).toBeLessThanOrEqual(0.55);
  });
  it('R22b easy: angle <= 0.25', () => {
    expect(holdAngle(curveClasses.easy)).toBeLessThanOrEqual(0.25);
  });
  it('R22b holding angle is monotonic in curve: easy < medium < hard, and below 1', () => {
    expect(holdAngle(curveClasses.easy)).toBeLessThan(holdAngle(curveClasses.medium));
    expect(holdAngle(curveClasses.medium)).toBeLessThan(holdAngle(curveClasses.hard));
    expect(holdAngle(curveClasses.hard)).toBeLessThan(1);
  });
  it('R22b the steady speed at the hard holding angle is >= 0.85 vmax', () => {
    expect(spAt(holdAngle(curveClasses.hard))).toBeGreaterThanOrEqual(0.85);
  });
});

/** A drift already at the holding angle, steady speed, vx at target, steer = angle (dir frame). */
function holdingCar(cls: 'easy' | 'medium' | 'hard', side: 1 | -1, dAngle = 0) {
  const race = createRace(1, 1);
  const car: Car = race.cars[0]!;
  const a = holdAngle(curveClasses[cls]);
  const ang = a + dAngle;
  const sp = spAt(ang);
  car.state = 'DRIFT';
  car.dir = side;
  car.angle = side * ang;
  car.steer = side * ang;
  car.driftHeld = true;
  car.speed = sp * P.vmax;
  car.x = 0;
  car.vx = side * ang * P.driftRate * sp;
  const track = constTrack(side * curveClasses[cls], 3000);
  const input: InputFrame = { steer: side * ang, brake: false, drift: true };
  return { race, car, track, input };
}

describe('R22b simulation: holding the angle holds the corner', () => {
  for (const cls of ['medium', 'hard'] as const)
    for (const side of [1, -1] as const) {
      const tag = `${cls} ${side > 0 ? 'right' : 'left'}`;
      it(`R22b ${tag}: at the holding angle |x| stays bounded for 10 s, still DRIFT`, () => {
        const { race, car, track, input } = holdingCar(cls, side);
        let maxAbsX = 0;
        for (let i = 0; i < 1200; i++) {
          step(race, [input], track, [P]);
          maxAbsX = Math.max(maxAbsX, Math.abs(car.x));
          expect(car.state).toBe('DRIFT');
        }
        expect(maxAbsX).toBeLessThanOrEqual(0.1);
      });
    }

  for (const side of [1, -1] as const) {
    const tag = side > 0 ? 'right' : 'left';
    it(`R22b hard ${tag}: speed stays >= 0.85 vmax through a long corner at the holding angle`, () => {
      const { race, car, track, input } = holdingCar('hard', side);
      let minSp = Infinity;
      for (let i = 0; i < 1200; i++) {
        step(race, [input], track, [P]);
        minSp = Math.min(minSp, car.speed);
      }
      expect(minSp).toBeGreaterThanOrEqual(0.85 * P.vmax);
    });
    it(`R22b hard ${tag}: too much angle goes to the inside, too little falls to the outside`, () => {
      const more = holdingCar('hard', side, 0.1);
      const less = holdingCar('hard', side, -0.1);
      for (let i = 0; i < 240; i++) {
        step(more.race, [more.input], more.track, [P]);
        step(less.race, [less.input], less.track, [P]);
      }
      // right corner (+): inside is +x; the push to the outside is -x. side * x > 0 = inside.
      expect(side * more.car.x).toBeGreaterThan(0);
      expect(side * less.car.x).toBeLessThan(0);
    });
    it(`R22b medium ${tag}: too much angle costs speed (steady speed below the holding one)`, () => {
      const hold = holdingCar('medium', side);
      const more = holdingCar('medium', side, 0.15);
      for (let i = 0; i < 600; i++) {
        step(hold.race, [hold.input], hold.track, [P]);
        step(more.race, [more.input], more.track, [P]);
      }
      expect(more.car.speed).toBeLessThan(hold.car.speed);
    });
  }
});

describe('R22b on a straight a drift ends by R21', () => {
  for (const side of [1, -1] as const)
    it(`R22b ${side > 0 ? 'right' : 'left'}: entry, then steer back to 0: GRIP within driftStraightTime + 1 s`, () => {
      const race = createRace(1, 1);
      const car = race.cars[0]!;
      car.speed = 0.8 * P.vmax;
      car.steer = side * 0.5;
      const track = constTrack(0, 3000);
      const PA = { ...P, driftAutoExit: 1 }; // R21c: the small-angle exit is H12 A, explicit here
      step(race, [{ steer: side * 0.5, brake: false, drift: true }], track, [PA]);
      expect(car.state).toBe('DRIFT');
      const limit = Math.ceil((P.driftStraightTime + 1) * 120);
      let exitedAt = -1;
      for (let i = 0; i < limit; i++) {
        step(race, [{ steer: 0, brake: false, drift: true }], track, [PA]);
        if (car.state === 'GRIP') {
          exitedAt = i;
          break;
        }
      }
      expect(exitedAt).toBeGreaterThanOrEqual(0);
      expect(car.dir).toBe(0);
      expect(car.angle).toBe(0);
      // it cannot end sooner than the straight time itself
      expect(exitedAt).toBeGreaterThanOrEqual(Math.floor(P.driftStraightTime * 120) - 2);
    });
});

describe('R22b GRIP vs drift: who needs the drift (real data)', () => {
  // R22d rewrite (author decision 2026-11-19): easy needs 40-50% steer at vmax (was 55-65%).
  it('R22d easy in GRIP at vmax needs 40-50% steer: c * centrifugal * kCurve / (steerRate * 0.75)', () => {
    // steady vx = s*steerRate*0.75 (sp = 1), push = c*centrifugal*kCurve.
    const need = (curveClasses.easy * P.centrifugal * P.kCurve) / (P.steerRate * 0.75);
    expect(need).toBeGreaterThanOrEqual(0.4);
    expect(need).toBeLessThanOrEqual(0.5);
  });
  it('R22d easy holds the line in GRIP with the derived steer at vmax (|x| bounded 3 s)', () => {
    const need = (curveClasses.easy * P.centrifugal * P.kCurve) / (P.steerRate * 0.75);
    const race = createRace(1, 1);
    const car = race.cars[0]!;
    car.speed = P.vmax;
    car.steer = need;
    car.vx = need * P.steerRate * 0.75;
    const track = constTrack(curveClasses.easy, 3000);
    const noAccel = { ...P, accel: 0 };
    for (let i = 0; i < 360; i++) {
      step(race, [{ steer: need, brake: false, drift: false }], track, [noAccel]);
      expect(Math.abs(car.x)).toBeLessThan(0.1);
    }
  });
  // R22d rewrite: medium is no longer "drift only"; only hard leaves the asphalt (medium: r22d.test.ts).
  for (const cls of ['hard'] as const)
    for (const side of [1, -1] as const)
      it(`R22b ${cls} ${side > 0 ? 'right' : 'left'}: full steer in GRIP at vmax leaves the asphalt`, () => {
        const race = createRace(1, 1);
        const car = race.cars[0]!;
        car.speed = P.vmax;
        car.steer = side;
        car.vx = side * P.steerRate * 0.75;
        const track = constTrack(side * curveClasses[cls], 3000);
        const noAccel = { ...P, accel: 0 };
        let left = false;
        for (let i = 0; i < 700 && car.z < 330; i++) {
          step(race, [{ steer: side, brake: false, drift: false }], track, [noAccel]);
          if (side * car.x < -1) left = true; // outward, not inward overshoot
        }
        expect(left).toBe(true);
        expect(car.state).toBe('GRIP');
      });
});

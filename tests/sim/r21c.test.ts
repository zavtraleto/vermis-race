import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState } from '../../src/sim/types';
import { constTrack, inp, oneCar } from './driving_helpers';

/**
 * R21c (H12): driftAutoExit 0 = a drift ends only by releasing the drift input or by the speed
 * falling below driftExitSpeed * vmax; 1 = the R21 small-angle exit (angle*dir < driftAngleExit for
 * longer than driftStraightTime) still works. Params explicit; accel 0 keeps a set speed constant.
 * driftExitSpeed 0.3, driftAngleExit 0.1, driftStraightTime 0.4 s = 48 ticks.
 */
const P: CarParams = {
  ...baseCar,
  accel: 0,
  driftExitSpeed: 0.3,
  driftAngleExit: 0.1,
  driftStraightTime: 0.4,
  driftOffroad: 1,
};
const OFF: CarParams = { ...P, driftAutoExit: 0 };
const ON: CarParams = { ...P, driftAutoExit: 1 };
const track = constTrack(0, 4000);
const car = (s: RaceState): Car => s.cars[0]!;
const drifting = (side: 1 | -1, angle: number, over: Partial<Car> = {}): RaceState =>
  oneCar({ state: 'DRIFT', dir: side, angle: side * angle, steer: 0, driftHeld: true, speed: 0.8, ...over });
const run = (s: RaceState, n: number, i: InputFrame, p: CarParams): void => {
  for (let k = 0; k < n; k++) step(s, [i], track, [p]);
};

describe('R21c driftAutoExit 0 (H12 B): drift held until release or low speed', () => {
  for (const side of [1, -1] as const) {
    const tag = side > 0 ? 'right' : 'left';
    it(`R21c ${tag}: angle 0 for 10 s (1200 ticks) with the input held stays DRIFT`, () => {
      const s = drifting(side, 0);
      for (let k = 0; k < 1200; k++) {
        step(s, [inp(0, false, true)], track, [OFF]);
        expect(car(s).state).toBe('DRIFT');
      }
      expect(car(s).dir).toBe(side);
    });
    it(`R21c ${tag}: a small angle 0.05 (< driftAngleExit) for 10 s stays DRIFT`, () => {
      const s = drifting(side, 0.05);
      run(s, 1200, inp(0, false, true), OFF);
      expect(car(s).state).toBe('DRIFT');
    });
  }
  it('R21c entry on a straight, then the steer back to 0 for 10 s: still DRIFT', () => {
    const s = oneCar({ speed: 0.8, steer: 0.5 });
    step(s, [inp(0.5, false, true)], track, [OFF]);
    expect(car(s).state).toBe('DRIFT');
    run(s, 1200, inp(0, false, true), OFF);
    expect(car(s).state).toBe('DRIFT');
  });
  it('R21c release ends the drift on that step: GRIP, dir 0, angle 0', () => {
    const s = drifting(1, 0);
    run(s, 600, inp(0, false, true), OFF);
    step(s, [inp(0, false, false)], track, [OFF]);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).angle).toBe(0);
  });
  it('R21c speed below driftExitSpeed * vmax (0.29 < 0.3) ends it even with angle 0 and the input held', () => {
    const s = drifting(1, 0, { speed: 0.29 });
    step(s, [inp(0, false, true)], track, [OFF]);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).angle).toBe(0);
  });
  it('R21c braking down through 0.3 ends it (brake 0.6/s: from 0.5 within about 2 s)', () => {
    const s = drifting(1, 0, { speed: 0.5 });
    let ended = false;
    for (let k = 0; k < 360 && !ended; k++) {
      step(s, [inp(0, true, true)], track, [OFF]);
      ended = car(s).state === 'GRIP';
    }
    expect(ended).toBe(true);
    expect(car(s).speed).toBeLessThan(0.31);
  });
});

describe('R21c driftAutoExit 1 (H12 A): the small-angle exit still works', () => {
  for (const side of [1, -1] as const) {
    const tag = side > 0 ? 'right' : 'left';
    it(`R21c ${tag}: angle 0.05 for longer than driftStraightTime (48 ticks): DRIFT at 30 ticks, GRIP by 70`, () => {
      const s = drifting(side, 0.05);
      run(s, 30, inp(0, false, true), ON);
      expect(car(s).state).toBe('DRIFT');
      run(s, 40, inp(0, false, true), ON);
      expect(car(s).state).toBe('GRIP');
      expect(car(s).dir).toBe(0);
      expect(car(s).angle).toBe(0);
    });
  }
  it('R21c A: the same drift with driftAutoExit 0 is still DRIFT after the same 70 ticks (A/B differ)', () => {
    const a = drifting(1, 0.05);
    const b = drifting(1, 0.05);
    run(a, 70, inp(0, false, true), ON);
    run(b, 70, inp(0, false, true), OFF);
    expect(car(a).state).toBe('GRIP');
    expect(car(b).state).toBe('DRIFT');
  });
  it('R21c A: a healthy angle (0.5) is never dropped by the small-angle exit', () => {
    const s = drifting(1, 0.5, { steer: 0.5 });
    run(s, 600, inp(0.5, false, true), ON);
    expect(car(s).state).toBe('DRIFT');
  });
});

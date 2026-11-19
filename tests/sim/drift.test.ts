import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { loadTestTwisty } from '../../src/data/tracks';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, RaceState } from '../../src/sim/types';
import { constTrack, inp, oneCar } from './driving_helpers';

/**
 * Drift rules R20, R21, R21b, R22 (brief section 4, rewritten 2026-11-19: drift angle model).
 * Step order: R10 -> transitions R20/R21 -> lateral target (R11 or R22) -> R12 -> R13/R19 -> R18
 * -> R14 -> R15 -> R17 -> R16. Transitions see the smoothed steer after R10, the position and
 * speed from the START of the step.
 * Params are explicit here, never read from the data files (data numbers are recalibrated by R22b).
 *
 * Deliberate robustness: where the brief does not say whether the angle chase of the SAME tick is
 * applied before the lateral target / speed cap use the angle, the tests put the angle at its
 * steady value (angle = clamp(steer*dir,0,1)*dir), so both readings give the same numbers.
 */
const P: CarParams = {
  ...baseCar,
  vmax: 1,
  accel: 0.22,
  brake: 0.6,
  steerRate: 1.0,
  steerRise: 10,
  grip: 12,
  gripDrift: 3,
  centrifugal: 0.15,
  centMulDrift: 0.35,
  kCurve: 1.5,
  offroadMul: 0.99,
  xLimit: 1.5,
  driftRate: 0.45,
  driftArmTime: 0.3, // 36 ticks (R20 armed entry)
  driftEnterSpeed: 0.45,
  driftEnterSteer: 0.2,
  driftExitSpeed: 0.3,
  driftOffroadTime: 0.4,
  driftOffroad: 0, // H11 variant A unless a test says otherwise
  driftAngleStart: 0.5,
  driftAngleExit: 0.15,
  driftStraightTime: 0.5, // 60 ticks
  driftAngleResponse: 6,
  driftSpeedLoss: 0.3,
  driftBrake: 0.4,
  driftAutoExit: 1, // R21c / H12 A: these tests describe the small-angle exit, so it is set explicitly
};
/** accel 0: a manually set speed stays constant (R14) unless the test wants otherwise. */
const PC: CarParams = { ...P, accel: 0 };
/** No R15 slowdown and a far wall: for long runs that must not leave the road. */
const PFREE: CarParams = { ...P, offroadMul: 1, xLimit: 100 };

const track0 = constTrack(0);
const car = (s: RaceState): Car => s.cars[0]!;
/** A car already in DRIFT right: angle 0.6 = steer 0.6 (steady), driftHeld true. */
const drifting = (over: Partial<Car> = {}): RaceState =>
  oneCar({
    state: 'DRIFT',
    dir: 1,
    angle: 0.6,
    driftHeld: true,
    speed: 0.8,
    steer: 0.6,
    ...over,
  });
const one = (s: RaceState, i: InputFrame, t = track0, p: CarParams = P): void =>
  step(s, [i], t, [p]);

/** R12 with explicit grip. */
const r12 = (vx: number, tgt: number, g: number): number =>
  vx + (tgt - vx) * (1 - Math.exp(-g * DT));
/** R22 angle chase factor per tick: 1 - exp(-6/120) = 0.0487706. */
const kA = 1 - Math.exp(-P.driftAngleResponse * DT);

describe('R20 GRIP -> DRIFT, rising edge of the drift input', () => {
  const base = (over: Partial<Car> = {}): RaceState => oneCar({ speed: 0.8, steer: 0.5, ...over });

  it('R20 createRace initialises angle 0, driftHeld false, armTicks 0, lowTicks 0', () => {
    const s = createRace(7, 3);
    for (const c of s.cars) {
      expect(c.angle).toBe(0);
      expect(c.driftHeld).toBe(false);
      expect(c.armTicks).toBe(0);
      expect(c.lowTicks).toBe(0);
    }
  });
  it('R20 rising edge with speed and steer above thresholds: DRIFT, dir +1 (steer right)', () => {
    const s = base();
    one(s, inp(0.5, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
  it('R20 rising edge, steer left: DRIFT, dir -1', () => {
    const s = base({ steer: -0.5 });
    one(s, inp(-0.5, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(-1);
  });
  it('R20 angle = dir * driftAngleStart on entry (steer = start, so the R22 chase is a no-op)', () => {
    // driftAngleStart 0.35 and steer 0.35: whether or not R22 chases in the entry tick, angle 0.35.
    const p = { ...PC, driftAngleStart: 0.35 };
    const r = base({ steer: 0.35 });
    one(r, inp(0.35, false, true), track0, p);
    expect(car(r).angle).toBeCloseTo(0.35, 12);
    const l = base({ steer: -0.35 });
    one(l, inp(-0.35, false, true), track0, p);
    expect(car(l).angle).toBeCloseTo(-0.35, 12);
    expect(car(l).dir).toBe(-1);
  });
  it('R20 no drift input: stays GRIP, dir 0, angle 0', () => {
    const s = base();
    one(s, inp(0.5, false, false), track0, PC);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).angle).toBe(0);
  });
  it('R20 driftHeld records the drift input of the tick (true, then false)', () => {
    const s = base();
    one(s, inp(0.5, false, true), track0, PC);
    expect(car(s).driftHeld).toBe(true);
    one(s, inp(0.5, false, false), track0, PC);
    expect(car(s).driftHeld).toBe(false);
  });
  it('R20 held drift (driftHeld already true) does not enter: needs the rising edge', () => {
    const s = base({ driftHeld: true });
    one(s, inp(0.5, false, true), track0, PC);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).driftHeld).toBe(true);
  });
  it('R20 release then press again enters (new rising edge)', () => {
    const s = base({ driftHeld: true });
    one(s, inp(0.5, false, false), track0, PC);
    expect(car(s).state).toBe('GRIP');
    one(s, inp(0.5, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
  });
  it('R20 after a forced exit the still-held drift input does not re-enter', () => {
    const s = drifting({ speed: 0.29 }); // below driftExitSpeed*vmax = 0.3 -> forced exit (R21)
    one(s, inp(0.6, false, true), track0, PC);
    expect(car(s).state).toBe('GRIP');
    car(s).speed = 0.8; // fast again, steer still 0.6, drift button never released
    for (let i = 0; i < 10; i++) {
      one(s, inp(0.6, false, true), track0, PC);
      expect(car(s).state).toBe('GRIP');
    }
    one(s, inp(0.6, false, false), track0, PC); // release ...
    one(s, inp(0.6, false, true), track0, PC); // ... and press: new edge
    expect(car(s).state).toBe('DRIFT');
  });
  // R20 armed entry (rule changed 2026-11-19). Replaces the former test 'the edge is consumed:
  // pressing while conditions are unmet and meeting them later does not enter' (edge-tick-only).
  // driftArmTime 0.3 s = 36 ticks. steerRise 10/s: smoothed steer from 0 with input 1 is
  // 0.0833, 0.1667, 0.25 on its 1st..3rd step, so it exceeds 0.2 on the 3rd step.
  it('R20 armTicks: 1 on the edge tick, grows while held, resets to 0 on release', () => {
    const s = oneCar({ speed: 0.8, steer: 0 });
    one(s, inp(0, false, true), track0, PC);
    expect(car(s).armTicks).toBe(1);
    one(s, inp(0, false, true), track0, PC);
    one(s, inp(0, false, true), track0, PC);
    expect(car(s).armTicks).toBe(3);
    one(s, inp(0, false, false), track0, PC);
    expect(car(s).armTicks).toBe(0);
    expect(car(s).state).toBe('GRIP');
  });
  it.each([1, -1])('R20 steer crosses the threshold inside driftArmTime (side %i): enters on that tick', (side) => {
    // edge on tick 1 with steer 0; steer input 0 for ticks 1..10, then side*1: crossing on tick 13.
    const s = oneCar({ speed: 0.8, steer: 0 });
    for (let i = 0; i < 10; i++) {
      one(s, inp(0, false, true), track0, PC);
      expect(car(s).state).toBe('GRIP');
    }
    one(s, inp(side, false, true), track0, PC); // tick 11: 0.0833
    one(s, inp(side, false, true), track0, PC); // tick 12: 0.1667
    expect(car(s).state).toBe('GRIP');
    one(s, inp(side, false, true), track0, PC); // tick 13: 0.25 > 0.2, armTicks 13, 13*DT=0.108 <= 0.3
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(side);
    expect(car(s).angle).toBeCloseTo(side * PC.driftAngleStart, 12);
    expect(car(s).armTicks).toBe(0); // entry resets the arm
  });
  it('R20 dir = sign(steer) on the entry tick even if the early steer had the other sign', () => {
    const s = oneCar({ speed: 0.8, steer: 0.1 }); // small right steer at the edge: too small to enter
    one(s, inp(-1, false, true), track0, PC); // steer 0.1 -> 0.0167
    for (let i = 0; i < 6; i++) one(s, inp(-1, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(-1);
  });
  it('R20 steer crosses the threshold after driftArmTime: never enters while the input is held', () => {
    // 40 ticks of steer 0 (40*DT = 0.333 s > 0.3 s), then full steer for 120 ticks.
    const s = oneCar({ speed: 0.8, steer: 0 });
    for (let i = 0; i < 40; i++) one(s, inp(0, false, true), track0, PC);
    for (let i = 0; i < 120; i++) {
      one(s, inp(1, false, true), track0, PC);
      expect(car(s).state).toBe('GRIP');
    }
  });
  it('R20 release before the conditions are met: arm reset, later steer does not enter', () => {
    const s = oneCar({ speed: 0.8, steer: 0 });
    one(s, inp(1, false, true), track0, PC); // edge, steer 0.0833
    one(s, inp(1, false, true), track0, PC); // 0.1667
    one(s, inp(1, false, false), track0, PC); // release on tick 3 (steer 0.25 but no drift input)
    expect(car(s).armTicks).toBe(0);
    for (let i = 0; i < 10; i++) {
      one(s, inp(1, false, false), track0, PC);
      expect(car(s).state).toBe('GRIP');
      expect(car(s).armTicks).toBe(0);
    }
  });
  it('R20 a new press after the arm expired arms again and enters', () => {
    const s = oneCar({ speed: 0.8, steer: 0 });
    for (let i = 0; i < 40; i++) one(s, inp(0, false, true), track0, PC); // arm expires
    one(s, inp(1, false, false), track0, PC);
    one(s, inp(1, false, false), track0, PC);
    one(s, inp(1, false, false), track0, PC); // steer 0.25 now, drift released
    one(s, inp(1, false, true), track0, PC); // new edge: conditions met on the edge tick
    expect(car(s).state).toBe('DRIFT');
  });
  it('R20 speed condition met late inside the window also enters', () => {
    const s = oneCar({ speed: 0.4, steer: 0.5 }); // below 0.45 at the edge
    for (let i = 0; i < 10; i++) {
      one(s, inp(0.5, false, true), track0, PC);
      expect(car(s).state).toBe('GRIP');
    }
    car(s).speed = 0.8; // tick 11 sees speed 0.8, armTicks 11
    one(s, inp(0.5, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
  it('R20 speed condition met after driftArmTime does not enter', () => {
    const s = oneCar({ speed: 0.4, steer: 0.5 });
    for (let i = 0; i < 40; i++) one(s, inp(0.5, false, true), track0, PC);
    car(s).speed = 0.8;
    for (let i = 0; i < 20; i++) {
      one(s, inp(0.5, false, true), track0, PC);
      expect(car(s).state).toBe('GRIP');
    }
  });
  it('R20 armed entry is deterministic and serializable (armTicks in JSON round trip)', () => {
    const mk = (): RaceState => {
      const s = oneCar({ speed: 0.8, steer: 0 });
      for (let i = 0; i < 5; i++) one(s, inp(0, false, true), track0, PC);
      return s;
    };
    const a = mk();
    const b = JSON.parse(JSON.stringify(mk())) as RaceState;
    expect(car(a).armTicks).toBe(5);
    for (let i = 0; i < 10; i++) {
      one(a, inp(1, false, true), track0, PC);
      one(b, inp(1, false, true), track0, PC);
    }
    expect(b).toEqual(a);
    expect(car(a).state).toBe('DRIFT');
  });
  it('R20 speed <= driftEnterSpeed*vmax (0.45): stays GRIP; just above enters', () => {
    const a = base({ speed: 0.44 });
    one(a, inp(0.5, false, true), track0, PC);
    expect(car(a).state).toBe('GRIP');
    const b = base({ speed: 0.46 });
    one(b, inp(0.5, false, true), track0, PC);
    expect(car(b).state).toBe('DRIFT');
  });
  it('R20 speed threshold scales with vmax', () => {
    // vmax 2: threshold 0.9.
    const p2 = { ...PC, vmax: 2 };
    const a = base({ speed: 0.8 });
    one(a, inp(0.5, false, true), track0, p2);
    expect(car(a).state).toBe('GRIP');
    const b = base({ speed: 1.0 });
    one(b, inp(0.5, false, true), track0, p2);
    expect(car(b).state).toBe('DRIFT');
  });
  it('R20 |steer| <= driftEnterSteer (0.2): stays GRIP, both sides', () => {
    for (const st of [0.1, -0.1]) {
      const s = base({ steer: st });
      one(s, inp(st, false, true), track0, PC);
      expect(car(s).state).toBe('GRIP');
    }
  });
  it('R20 uses the SMOOTHED steer after R10, not the raw input', () => {
    // Rising edge at step 3 only: drift released for 2 steps (steer 0.0833, 0.1667 <= 0.2), pressed
    // at step 3 where steer = 0.25 > 0.2 -> enters exactly then.
    const s = oneCar({ speed: 0.8, steer: 0 });
    one(s, inp(1, false, false), track0, PC);
    one(s, inp(1, false, false), track0, PC);
    expect(car(s).state).toBe('GRIP');
    one(s, inp(1, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    // And the raw input 1 with a still-small smoothed steer must not enter:
    const t = oneCar({ speed: 0.8, steer: 0 });
    one(t, inp(1, false, true), track0, PC); // smoothed 0.0833
    expect(car(t).state).toBe('GRIP');
  });
  it('R20 H11 A (driftOffroad 0): off road (|x| > 1) no entry, |x| = 1 still enters', () => {
    for (const x of [1.2, -1.2]) {
      const s = base({ x });
      one(s, inp(0.5, false, true), track0, PC);
      expect(car(s).state).toBe('GRIP');
    }
    const c = base({ x: 1 });
    one(c, inp(0.5, false, true), track0, PC);
    expect(car(c).state).toBe('DRIFT');
  });
  it('R20 / R21b H11 B (driftOffroad 1): enters off road on both sides, other conditions still apply', () => {
    const PB = { ...PC, driftOffroad: 1 };
    const a = base({ x: 1.2 });
    one(a, inp(0.5, false, true), track0, PB);
    expect(car(a).state).toBe('DRIFT');
    expect(car(a).dir).toBe(1);
    const b = base({ x: -1.2, steer: -0.5 });
    one(b, inp(-0.5, false, true), track0, PB);
    expect(car(b).state).toBe('DRIFT');
    expect(car(b).dir).toBe(-1);
    const slow = base({ x: 1.2, speed: 0.44 });
    one(slow, inp(0.5, false, true), track0, PB);
    expect(car(slow).state).toBe('GRIP');
    const straight = base({ x: 1.2, steer: 0.1 });
    one(straight, inp(0.1, false, true), track0, PB);
    expect(car(straight).state).toBe('GRIP');
    const held = base({ x: 1.2, driftHeld: true });
    one(held, inp(0.5, false, true), track0, PB);
    expect(car(held).state).toBe('GRIP');
  });
  it('R20 dir does not flip when steer changes sign during the drift', () => {
    const s = base();
    one(s, inp(0.5, false, true), track0, PC);
    expect(car(s).dir).toBe(1);
    let crossed = false;
    for (let i = 0; i < 12; i++) {
      one(s, inp(-1, false, true), track0, PC);
      if (car(s).steer < 0) crossed = true;
      if (car(s).state === 'DRIFT') expect(car(s).dir).toBe(1);
    }
    expect(crossed).toBe(true);
  });
});

describe('R21 DRIFT -> GRIP', () => {
  it('R21 createRace initialises offTicks to 0', () => {
    for (const c of createRace(7, 3).cars) expect(c.offTicks).toBe(0);
  });
  it('R21 drift input released: GRIP, dir 0, angle 0 on that very step', () => {
    const s = drifting();
    one(s, inp(0.6, false, false), track0, PC);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).angle).toBe(0);
  });
  it('R21 drift held with a healthy angle keeps DRIFT (control)', () => {
    const s = drifting();
    one(s, inp(0.6, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
  it('R21 forced exit when speed < driftExitSpeed*vmax (0.3), drift still held; dir 0, angle 0', () => {
    const s = drifting({ speed: 0.29 });
    one(s, inp(0.6, false, true), track0, PC);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).angle).toBe(0);
  });
  it('R21 speed above the threshold does not exit', () => {
    const s = drifting({ speed: 0.31 });
    one(s, inp(0.6, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
  });
  it('R21 exit on the left side leaves dir 0 and angle 0 too', () => {
    const s = drifting({ dir: -1, angle: -0.6, steer: -0.6, speed: 0.29 });
    one(s, inp(-0.6, false, true), track0, PC);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).angle).toBe(0);
  });
  it('R21 small angle (angle*dir < driftAngleExit 0.15) for longer than driftStraightTime 0.5 s = 60 ticks ends the drift', () => {
    // angle 0.1, steer 0 -> target 0, the angle only gets smaller. Exact counter edge is not pinned:
    // still DRIFT after 50 ticks, GRIP after 70.
    const s = drifting({ angle: 0.1, steer: 0 });
    for (let i = 0; i < 50; i++) one(s, inp(0, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).lowTicks).toBeGreaterThanOrEqual(48);
    expect(car(s).lowTicks).toBeLessThanOrEqual(51);
    for (let i = 0; i < 20; i++) one(s, inp(0, false, true), track0, PC);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).angle).toBe(0);
  });
  it('R21 small angle on the left side ends the drift too (mirror)', () => {
    const s = drifting({ dir: -1, angle: -0.1, steer: 0 });
    for (let i = 0; i < 70; i++) one(s, inp(0, false, true), track0, PC);
    expect(car(s).state).toBe('GRIP');
  });
  it('R21 lowTicks counts consecutive ticks only: a recovered angle resets it to 0', () => {
    const s = drifting({ angle: 0.1, steer: 0 });
    for (let i = 0; i < 30; i++) one(s, inp(0, false, true), track0, PC);
    expect(car(s).lowTicks).toBeGreaterThanOrEqual(28);
    // Full steer into the corner: angle 0.1 -> 0.1439 -> 0.1857 (> 0.15) within 3 ticks.
    car(s).steer = 1;
    for (let i = 0; i < 4; i++) one(s, inp(1, false, true), track0, PC);
    expect(car(s).angle).toBeGreaterThan(0.15);
    expect(car(s).lowTicks).toBe(0);
    // Holding the big angle for 100 ticks (> 60 even together with the first 30) stays DRIFT.
    for (let i = 0; i < 100; i++) one(s, inp(1, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
  });
  it('R21 angle exactly at or above driftAngleExit does not count as small', () => {
    const s = drifting({ angle: 0.2, steer: 0.2 }); // steady 0.2 > 0.15
    for (let i = 0; i < 200; i++) one(s, inp(0.2, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).lowTicks).toBe(0);
  });
  it('R21 braking in drift ends it once speed is below 0.3*vmax', () => {
    // brake 0.6/s = 0.005 per tick: from 0.5 the speed passes 0.3 after about 40 ticks.
    const s = drifting({ speed: 0.5 });
    let exitTick = -1;
    for (let i = 0; i < 120; i++) {
      one(s, inp(0.6, true, true));
      if (car(s).state === 'GRIP') {
        exitTick = i;
        expect(car(s).dir).toBe(0);
        break;
      }
    }
    expect(exitTick).toBeGreaterThan(30);
    expect(exitTick).toBeLessThan(60);
  });
  it('R21 H11 A: forced exit after driftOffroadTime (0.4 s = 48 ticks) of consecutive off-road time', () => {
    // x = 1.4, angle 0.6 right: the lateral target pushes outward, x clamps at xLimit 1.5, the car
    // stays off road. Speed 1 > cap 0.82 falls by 0.4/s plus R15, stays above 0.3 for 52 ticks.
    // Exact counter convention is not pinned: 40 ticks DRIFT, 52 ticks GRIP.
    const s = drifting({ x: 1.4, speed: 1 });
    for (let i = 0; i < 40; i++) {
      one(s, inp(0.6, false, true));
      expect(Math.abs(car(s).x)).toBeGreaterThan(1);
      expect(car(s).state).toBe('DRIFT');
    }
    expect(car(s).offTicks).toBeGreaterThanOrEqual(39);
    expect(car(s).offTicks).toBeLessThanOrEqual(41);
    for (let i = 0; i < 12; i++) one(s, inp(0.6, false, true));
    expect(car(s).speed).toBeGreaterThan(0.3);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).angle).toBe(0);
  });
  it('R21 H11 A: off-road exit works on the left side too', () => {
    const s = drifting({ x: -1.4, speed: 1, steer: -0.6, dir: -1, angle: -0.6 });
    for (let i = 0; i < 52; i++) one(s, inp(-0.6, false, true));
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
  });
  it('R21 H11 A: offTicks resets on road and only consecutive off-road time counts', () => {
    const s = drifting({ x: 1.4, speed: 1 });
    for (let i = 0; i < 30; i++) one(s, inp(0.6, false, true));
    expect(car(s).offTicks).toBeGreaterThanOrEqual(29);
    car(s).x = 0.5; // back on the asphalt
    one(s, inp(0.6, false, true));
    expect(car(s).offTicks).toBe(0);
    expect(car(s).state).toBe('DRIFT');
    car(s).x = 1.4; // off again: 30 + 30 > 48 in total, but never 48 in a row
    for (let i = 0; i < 30; i++) one(s, inp(0.6, false, true));
    expect(car(s).speed).toBeGreaterThan(0.3);
    expect(car(s).state).toBe('DRIFT');
  });
  it('R21 offTicks stays 0 while on the road', () => {
    const s = drifting();
    for (let i = 0; i < 50; i++) one(s, inp(0.6, false, true), track0, PC);
    expect(car(s).offTicks).toBe(0);
  });
  it('R3 mid-drift state with angle, driftHeld, lowTicks is flat JSON: a round trip continues identically', () => {
    const track = constTrack(2.5);
    const a = drifting({ x: 0.2 });
    for (let i = 0; i < 60; i++) one(a, inp(0.3, false, true), track);
    expect(car(a).state).toBe('DRIFT');
    const b: RaceState = JSON.parse(JSON.stringify(a));
    expect(b).toEqual(a);
    for (let i = 0; i < 90; i++) {
      one(a, inp(0.3, false, true), track);
      one(b, inp(0.3, false, true), track);
    }
    expect(b).toEqual(a);
    expect(typeof car(b).angle).toBe('number');
    expect(typeof car(b).driftHeld).toBe('boolean');
    expect(typeof car(b).lowTicks).toBe('number');
  });
});

describe('R21b H11 variant B (driftOffroad = 1): drift on the shoulder', () => {
  const PB: CarParams = { ...PC, driftOffroad: 1, offroadMul: 1 };

  it('R21b no forced exit after driftOffroadTime: still DRIFT after 120 off-road ticks, both sides', () => {
    // offroadMul 1: R15 does not slow the car. x = 1.4, outward target keeps the car off road.
    const r = drifting({ x: 1.4, speed: 1 });
    const l = drifting({ x: -1.4, speed: 1, steer: -0.6, dir: -1, angle: -0.6 });
    for (let i = 0; i < 120; i++) {
      one(r, inp(0.6, false, true), track0, PB);
      one(l, inp(-0.6, false, true), track0, PB);
      expect(Math.abs(car(r).x)).toBeGreaterThan(1);
      expect(car(r).state).toBe('DRIFT');
      expect(car(l).state).toBe('DRIFT');
    }
    expect(car(r).dir).toBe(1);
    expect(car(l).dir).toBe(-1);
    expect(car(r).offTicks).toBeGreaterThanOrEqual(119);
  });
  it('R21b releasing drift or falling below driftExitSpeed still exits off road', () => {
    const a = drifting({ x: 1.4 });
    one(a, inp(0.6, false, false), track0, PB);
    expect(car(a).state).toBe('GRIP');
    const b = drifting({ x: 1.4, speed: 0.29 });
    one(b, inp(0.6, false, true), track0, PB);
    expect(car(b).state).toBe('GRIP');
  });
  it('R21b the small-angle exit R21 still works off road', () => {
    const s = drifting({ x: 1.4, angle: 0.1, steer: 0 });
    for (let i = 0; i < 70; i++) one(s, inp(0, false, true), track0, PB);
    expect(car(s).state).toBe('GRIP');
  });
  it('R21b R15 speed loss still applies off road in DRIFT', () => {
    // angle 0.6 steady -> cap 0.82; speed 0.8 < cap: 0.8 + 0.22/120 = 0.8018333; then R15:
    // * 0.99^(60/120).
    const p = { ...P, driftOffroad: 1 };
    const s = drifting({ x: 1.4, vx: 0.3 });
    one(s, inp(0.6, false, true), track0, p);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).speed).toBeCloseTo((0.8 + 0.22 * DT) * Math.pow(p.offroadMul, 60 * DT), 10);
  });
  it('R21b offTicks keeps counting with driftOffroad 1', () => {
    const s = drifting({ x: 1.4, speed: 1 });
    for (let i = 0; i < 30; i++) one(s, inp(0.6, false, true), track0, PB);
    expect(car(s).offTicks).toBeGreaterThanOrEqual(29);
    expect(car(s).offTicks).toBeLessThanOrEqual(31);
  });
  it('H11 A control: same setup with driftOffroad 0 exits after 0.4 s', () => {
    const s = drifting({ x: 1.4, speed: 1 });
    for (let i = 0; i < 52; i++) one(s, inp(0.6, false, true), track0, { ...P, driftOffroad: 0 });
    expect(car(s).state).toBe('GRIP');
  });
});

describe('R22 drift angle chases the steer', () => {
  it('R22 one tick: angle += (clamp(steer*dir,0,1)*dir - angle) * (1 - exp(-driftAngleResponse*DT))', () => {
    // angle 0.4, steer 0.6, dir +1: target 0.6, k = 1 - exp(-6/120) = 0.0487706
    // angle' = 0.4 + 0.2 * 0.0487706 = 0.4097541
    const s = drifting({ angle: 0.4 });
    one(s, inp(0.6, false, true), track0, PC);
    expect(car(s).angle).toBeCloseTo(0.4 + 0.2 * kA, 9);
    expect(car(s).angle).toBeCloseTo(0.4097541, 6);
  });
  it('R22 one tick, angle above the target: it comes down (angle 0.8, steer 0.5)', () => {
    // 0.8 + (0.5 - 0.8) * 0.0487706 = 0.7853688
    const s = drifting({ angle: 0.8, steer: 0.5 });
    one(s, inp(0.5, false, true), track0, PC);
    expect(car(s).angle).toBeCloseTo(0.8 - 0.3 * kA, 9);
  });
  it('R22 dir -1 mirror: negated angle (angle -0.4, steer -0.6)', () => {
    const s = drifting({ dir: -1, angle: -0.4, steer: -0.6 });
    one(s, inp(-0.6, false, true), track0, PC);
    expect(car(s).angle).toBeCloseTo(-(0.4 + 0.2 * kA), 9);
  });
  it('R22 converges to clamp(steer*dir,0,1)*dir and never overshoots it', () => {
    // after 200 ticks (1.667 s) the gap 0.2 shrinks by exp(-10) = 4.5e-5 -> 9e-6
    const s = drifting({ angle: 0.4 });
    let prev = 0.4;
    for (let i = 0; i < 200; i++) {
      one(s, inp(0.6, false, true), track0, PC);
      expect(car(s).angle).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(car(s).angle).toBeLessThanOrEqual(0.6 + 1e-12);
      prev = car(s).angle;
    }
    expect(car(s).angle).toBeCloseTo(0.6, 4);
  });
  it('R22 steer beyond 1 is not possible but full steer gives angle -> 1, never above', () => {
    const s = drifting({ angle: 0.6, steer: 1 });
    for (let i = 0; i < 400; i++) {
      one(s, inp(1, false, true), track0, PFREE);
      expect(car(s).angle).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(car(s).angle).toBeCloseTo(1, 4);
  });
  it('R22 counter-steer drives the angle toward 0 and never past it to the other side', () => {
    // steer -0.8 on dir +1: target clamp(-0.8,0,1) = 0. One tick: 0.5 * (1 - 0.0487706) = 0.4756147.
    const s = drifting({ angle: 0.5, steer: -0.8 });
    one(s, inp(-0.8, false, true), track0, PC);
    expect(car(s).angle).toBeCloseTo(0.5 * (1 - kA), 9);
    for (let i = 0; i < 300; i++) {
      one(s, inp(-0.8, false, true), track0, PC);
      expect(car(s).angle * 1).toBeGreaterThanOrEqual(0); // dir +1 side: never negative
    }
  });
  it('R22 counter-steer on dir -1 never gives a positive angle', () => {
    const s = drifting({ dir: -1, angle: -0.5, steer: 0.8 });
    for (let i = 0; i < 300; i++) {
      one(s, inp(0.8, false, true), track0, PC);
      expect(car(s).angle).toBeLessThanOrEqual(0);
    }
  });
  it('R22 steer toward the corner raises the angle, to the centre or outward lowers it', () => {
    const inward = drifting({ angle: 0.4, steer: 0.9 });
    const centre = drifting({ angle: 0.4, steer: 0 });
    const outward = drifting({ angle: 0.4, steer: -0.9 });
    one(inward, inp(0.9, false, true), track0, PC);
    one(centre, inp(0, false, true), track0, PC);
    one(outward, inp(-0.9, false, true), track0, PC);
    expect(car(inward).angle).toBeGreaterThan(0.4);
    expect(car(centre).angle).toBeLessThan(0.4);
    expect(car(outward).angle).toBeCloseTo(car(centre).angle, 12); // both targets are 0
  });
  it('R22 angle*dir stays in [0, 1] under a wild steer script', () => {
    for (const dir of [1, -1] as const) {
      const s = drifting({ dir, angle: 0.5 * dir, steer: 0 });
      for (let i = 0; i < 1500; i++) {
        const st = Math.sin(i / 17) * 1.2;
        one(s, inp(Math.max(-1, Math.min(1, st)), false, true), track0, PFREE);
        if (car(s).state !== 'DRIFT') break;
        expect(car(s).angle * dir).toBeGreaterThanOrEqual(0);
        expect(car(s).angle * dir).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });
});

describe('R22 drift lateral physics', () => {
  it('R22 vx, x after one step with a known state (right, curve 2)', () => {
    // angle 0.6 = steer 0.6 (steady), sp = 0.8, vx 0.3, driftRate 0.45.
    // target = 0.6 * 0.45 * 0.8 = 0.216
    // R12 gripDrift 3: k = 1 - exp(-3/120) = 0.0246901; vx = 0.3 + (0.216 - 0.3) * k = 0.297926
    // R13 push = 2 * 0.64 * 0.15 * 0.35 * 1.5 = 0.1008 per s -> 0.00084 per tick
    // x = 0.297926/120 - 0.00084 = 0.0024827 - 0.00084 = 0.0016427
    const s = drifting({ vx: 0.3 });
    one(s, inp(0.6, false, true), constTrack(2), PC);
    const vx = 0.3 + (0.216 - 0.3) * (1 - Math.exp(-3 * DT));
    expect(car(s).vx).toBeCloseTo(vx, 9);
    expect(car(s).vx).toBeCloseTo(0.297926, 5);
    expect(car(s).x).toBeCloseTo(vx * DT - 0.1008 * DT, 9);
    expect(car(s).x).toBeCloseTo(0.0016427, 6);
    expect(car(s).state).toBe('DRIFT');
  });
  it('R22 mirror: left drift gives exactly negated x, vx, angle and the same speed', () => {
    const r = drifting({ vx: 0.3 });
    const l = drifting({ vx: -0.3, steer: -0.6, dir: -1, angle: -0.6 });
    for (let i = 0; i < 30; i++) {
      one(r, inp(0.6, false, true), constTrack(2));
      one(l, inp(-0.6, false, true), constTrack(-2));
    }
    expect(car(l).x).toBeCloseTo(-car(r).x, 12);
    expect(car(l).vx).toBeCloseTo(-car(r).vx, 12);
    expect(car(l).angle).toBeCloseTo(-car(r).angle, 12);
    expect(car(l).speed).toBeCloseTo(car(r).speed, 12);
  });
  it('R22 vx target is angle*driftRate*sp: several steady angles (steer = angle)', () => {
    for (const a of [0.2, 0.45, 0.8, 1]) {
      const s = drifting({ angle: a, steer: a, vx: 0.1 });
      one(s, inp(a, false, true), track0, PC);
      expect(car(s).vx).toBeCloseTo(r12(0.1, a * 0.45 * 0.8, 3), 10);
    }
  });
  it('R22 the lateral target does not depend on steer directly, only through the angle', () => {
    // Same angle 0.6, different steer = same target after one tick up to the angle chase (tiny).
    const a = drifting({ angle: 0.6, steer: 0.6, vx: 0 });
    const b = drifting({ angle: 0.6, steer: -0.9, vx: 0 });
    one(a, inp(0.6, false, true), track0, PC);
    one(b, inp(-0.9, false, true), track0, PC);
    // the R22 target is angle-based: both within the 5% chase effect of 0.216 * k_grip
    const base = r12(0, 0.216, 3);
    expect(Math.abs(car(a).vx - base)).toBeLessThan(1e-3);
    expect(Math.abs(car(b).vx - base)).toBeLessThan(1e-3);
  });
  it('R22 gripDrift (3) is used, not grip (12)', () => {
    const s = drifting({ vx: 0 });
    one(s, inp(0.6, false, true), track0, PC);
    expect(Math.abs(car(s).vx - r12(0, 0.216, 3))).toBeLessThan(1e-10);
    expect(Math.abs(car(s).vx - r12(0, 0.216, 12))).toBeGreaterThan(1e-4);
  });
  it('R22 centrifugal push uses centMulDrift (0.35): vx pinned at the target, curve 4.5', () => {
    // vx = target 0.216 stays (R12). push = 4.5 * 0.64 * 0.15 * 0.35 * 1.5 = 0.2268 per s.
    // x = (0.216 - 0.2268)/120 = -0.00009
    const s = drifting({ vx: 0.216 });
    one(s, inp(0.6, false, true), constTrack(4.5), PC);
    expect(car(s).x).toBeCloseTo((0.216 - 0.2268) * DT, 10);
    expect(car(s).x).toBeCloseTo(-0.00009, 8);
  });
  it('R22 R15b multipliers are not applied in DRIFT off road, R15 slowdown is', () => {
    // x = 1.4, offroadGrip 20 and offroadSteerMul 0.5 must be ignored (gripDrift, full target).
    // vx = 0.3 + (0.216 - 0.3) * 0.0246901; x = 1.4 + vx/120
    // speed = (0.8 + 0.22/120) * 0.99^(0.5) (below cap 0.82: normal accel, then R15)
    const p = { ...P, offroadGrip: 20, offroadSteerMul: 0.5, driftOffroad: 1 };
    const s = drifting({ x: 1.4, vx: 0.3 });
    one(s, inp(0.6, false, true), track0, p);
    const vx = r12(0.3, 0.216, 3);
    expect(car(s).vx).toBeCloseTo(vx, 10);
    expect(car(s).x).toBeCloseTo(1.4 + vx * DT, 10);
    expect(car(s).speed).toBeCloseTo((0.8 + 0.22 * DT) * Math.pow(p.offroadMul, 60 * DT), 10);
  });
  it('R22 |vx| in drift is monotonic in the steady angle and symmetric for dir -1', () => {
    let prev = -Infinity;
    for (let k = 1; k <= 10; k++) {
      const a = k / 10;
      const r = drifting({ angle: a, steer: a, vx: 0 });
      const l = drifting({ angle: -a, steer: -a, dir: -1, vx: 0 });
      one(r, inp(a, false, true), track0, PC);
      one(l, inp(-a, false, true), track0, PC);
      expect(car(l).vx).toBeCloseTo(-car(r).vx, 12);
      expect(car(r).vx).toBeGreaterThan(prev);
      prev = car(r).vx;
    }
  });
  it('R18 position is bounded by xLimit in drift', () => {
    const s = drifting({ x: 1.4, vx: 2 });
    for (let i = 0; i < 20; i++) one(s, inp(1, false, true), track0, PC);
    expect(car(s).x).toBeLessThanOrEqual(P.xLimit);
  });
});

describe('R22 drift speed cap, angle costs speed', () => {
  // angle 0.6 steady: cap = vmax * (1 - 0.3 * 0.6) = 0.82
  it('R22 above the cap: speed -= driftBrake*DT, accel is not applied', () => {
    // 1.0 - 0.4/120 = 0.9966667
    const s = drifting({ speed: 1 });
    one(s, inp(0.6, false, true), track0, P);
    expect(car(s).speed).toBeCloseTo(1 - 0.4 * DT, 12);
  });
  it('R22 above the cap by less than one brake step: speed lands on the cap, not below', () => {
    const s = drifting({ speed: 0.8205 });
    one(s, inp(0.6, false, true), track0, P);
    expect(car(s).speed).toBeCloseTo(0.82, 12);
  });
  it('R22 below the cap: normal R14 accel (0.22/120 per tick)', () => {
    const s = drifting({ speed: 0.7 });
    one(s, inp(0.6, false, true), track0, P);
    expect(car(s).speed).toBeCloseTo(0.7 + 0.22 * DT, 12);
  });
  it('R22 below the cap by less than one accel step: speed lands on the cap, not above', () => {
    const s = drifting({ speed: 0.8199 });
    one(s, inp(0.6, false, true), track0, P);
    expect(car(s).speed).toBeCloseTo(0.82, 12);
  });
  it('R22 brake input works as in R14: speed -= brake*DT', () => {
    const s = drifting({ speed: 0.7 });
    one(s, inp(0.6, true, true), track0, P);
    expect(car(s).speed).toBeCloseTo(0.7 - 0.6 * DT, 12);
  });
  it('R22 the cap uses |angle|: the same on dir -1', () => {
    const s = drifting({ dir: -1, angle: -0.6, steer: -0.6, speed: 1 });
    one(s, inp(-0.6, false, true), track0, P);
    expect(car(s).speed).toBeCloseTo(1 - 0.4 * DT, 12);
  });
  it('R22 a held steady angle converges speed to vmax*(1 - driftSpeedLoss*|angle|); bigger angle, lower speed', () => {
    // angle 0.3: cap 0.91; angle 0.9: cap 0.73. Free of R15 and walls, x does not matter.
    const finals: number[] = [];
    for (const a of [0.3, 0.9]) {
      const s = drifting({ angle: a, steer: a, speed: 1 });
      for (let i = 0; i < 600; i++) one(s, inp(a, false, true), track0, { ...PFREE, driftOffroad: 1 }); // H11 B: the car may leave the road, only the cap is isolated
      expect(car(s).state).toBe('DRIFT');
      finals.push(car(s).speed);
    }
    expect(finals[0]).toBeCloseTo(0.91, 9);
    expect(finals[1]).toBeCloseTo(0.73, 9);
    expect(finals[0]!).toBeGreaterThan(finals[1]!);
  });
  it('R22 speed in drift never exceeds vmax (capMul 1) and never goes negative', () => {
    const s = drifting({ speed: 1 });
    for (let i = 0; i < 200; i++) {
      one(s, inp(0.6, false, true), track0, PFREE);
      expect(car(s).speed).toBeLessThanOrEqual(1);
      expect(car(s).speed).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('R2 determinism with drift input', () => {
  it('R2 two identical runs with drift on twisty are bit-identical, and drift actually happens', () => {
    const track = buildTrack(loadTestTwisty().def);
    // Steer held on one side for 180 ticks, then the other; the drift button is pressed afresh
    // every 200 ticks (rising edges), held for 150 of them.
    const script = (t: number): InputFrame => ({
      steer: Math.floor(t / 180) % 2 === 0 ? 0.5 : -0.5,
      brake: false,
      drift: t % 200 < 150,
    });
    const runOnce = (): { s: RaceState; sawDrift: boolean } => {
      const s = createRace(42, 1);
      let sawDrift = false;
      for (let i = 0; i < 1500; i++) {
        step(s, [script(s.tick)], track, [P]);
        if (s.cars[0]!.state === 'DRIFT') sawDrift = true;
      }
      return { s, sawDrift };
    };
    const a = runOnce();
    const b = runOnce();
    expect(a.sawDrift).toBe(true);
    expect(JSON.stringify(b.s)).toBe(JSON.stringify(a.s));
    expect(b.s).toStrictEqual(a.s);
  });
});

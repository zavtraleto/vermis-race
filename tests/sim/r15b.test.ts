import { describe, expect, it } from 'vitest';
import { baseCar as dataCar } from '../../src/data/cars';
import { loadTestTwisty } from '../../src/data/tracks';
import { DT, K_HEADING, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { CarParams, InputFrame, Track } from '../../src/sim/types';
import { constTrack, inp, mirrorTrack, oneCar } from './driving_helpers';

// R22c halved steerRate/centrifugal and xLimit in the data (lateral world speeds kept on a road twice
// as wide). These unit tests derive their numbers from the rules with the pre-R22c values, pinned here
// explicitly; the real data are covered by calibration.test.ts and the R22c describe in drift_calibration.
const baseCar: CarParams = { ...dataCar, steerRate: 2.0, centrifugal: 0.3, xLimit: 2 };

/**
 * R15b: off road (|x| > 1, evaluated on x at the START of the step) R12 uses
 * offroadGrip instead of grip and the R11 target is multiplied by offroadSteerMul.
 * The new CarParams fields are set explicitly here, never read from base.json.
 */
function withOff(
  over: Partial<CarParams> & { offroadGrip: number; offroadSteerMul: number },
): CarParams {
  return { ...baseCar, ...over } as unknown as CarParams;
}

/** R11 target (sp = speed/vmax before R14) times an extra multiplier. */
function target(steer: number, speed: number, p: CarParams, mul: number): number {
  const sp = speed / p.vmax;
  return steer * p.steerRate * sp * (1 - 0.25 * sp) * mul;
}

/** R12 with an explicit grip g. */
function r12(vx: number, tgt: number, g: number): number {
  return vx + (tgt - vx) * (1 - Math.exp(-g * DT));
}

/** Independent reference of the OLD model (R10-R19, brief), one car, grip state only. */
interface RefCar {
  z: number;
  x: number;
  speed: number;
  vx: number;
  steer: number;
  heading: number;
}
function refStepOld(c: RefCar, input: InputFrame, track: Track, p: CarParams): void {
  const n = track.segments.length;
  const sp0 = c.speed / p.vmax;
  let seg = Math.floor(c.z) % n;
  if (seg < 0) seg += n;
  const curve = track.segments[seg]!.curve;
  const rise = p.steerRise * DT;
  let d = input.steer - c.steer;
  if (d > rise) d = rise;
  if (d < -rise) d = -rise;
  c.steer += d;
  const tgt = c.steer * p.steerRate * sp0 * (1 - 0.25 * sp0);
  c.vx += (tgt - c.vx) * (1 - Math.exp(-p.grip * DT));
  c.x += c.vx * DT - curve * sp0 * sp0 * p.centrifugal * 1 * p.kCurve * DT;
  if (c.x > p.xLimit) {
    c.x = p.xLimit;
    if (c.vx > 0) c.vx = 0;
  } else if (c.x < -p.xLimit) {
    c.x = -p.xLimit;
    if (c.vx < 0) c.vx = 0;
  }
  let speed = input.brake ? c.speed - p.brake * DT : c.speed + p.accel * DT;
  if (speed > p.vmax) speed = p.vmax;
  if (speed < 0) speed = 0;
  if (c.x > 1 || c.x < -1) speed *= Math.pow(p.offroadMul, 60 * DT);
  c.speed = speed;
  c.heading += curve * speed * K_HEADING * DT;
  c.z += speed * DT * SEG_PER_UNIT;
}

/** Deterministic varied input: slow sine wander plus hard square-wave swings and periodic braking. */
function variedInput(t: number): InputFrame {
  const hard = Math.floor(t / 150) % 2 === 0 ? 1 : -1;
  const steer = t % 600 < 300 ? hard : Math.sin(t / 23);
  return { steer, brake: t % 700 > 640, drift: false };
}

describe('R15b off-road grip and steering', () => {
  it('one step off road (x = +-1.5) uses offroadGrip and offroadSteerMul exactly', () => {
    // steer 0.6 (already equal to input, R10 idle), speed 0.5 -> sp = 0.5, vx0 = 0.3, curve 0.
    // base target = 0.6*2*0.5*(1-0.125) = 0.525 ; scaled by 0.4 -> 0.21
    // k = 1 - exp(-3/120) ; vx = 0.3 + (0.21 - 0.3)*k
    const p = withOff({ ...baseCar, accel: 0, offroadGrip: 3, offroadSteerMul: 0.4 });
    for (const side of [1, -1]) {
      const s = oneCar({ x: 1.5 * side, vx: 0.3 * side, steer: 0.6 * side, speed: 0.5 });
      step(s, [inp(0.6 * side)], constTrack(0), [p]);
      const expected = side * r12(0.3, target(0.6, 0.5, p, 0.4), 3);
      expect(s.cars[0]!.vx).toBeCloseTo(expected, 12);
      // sanity of the hand arithmetic
      expect(target(0.6, 0.5, p, 0.4)).toBeCloseTo(0.21, 12);
      // must differ from the variant A result (grip 12, mul 1)
      const a = side * r12(0.3, target(0.6, 0.5, p, 1), baseCar.grip);
      expect(Math.abs(s.cars[0]!.vx - a)).toBeGreaterThan(1e-3);
    }
  });

  it('time constant is 1/offroadGrip: error shrinks by exp(-offroadGrip*N*DT)', () => {
    // offroadMul = 1 keeps speed (and so the target) constant; accel 0 as well.
    // Kept off road: x0 = +-1.5, steer 0.5, speed 0.5, target = 0.5*2*0.5*0.875*0.4 = 0.175,
    // vx0 = -0.1*side. |dx| over 120 ticks <= 0.175*1 s, so |x| stays in [1.3, 1.7], never <= 1 or at xLimit 2.
    const p = withOff({
      ...baseCar,
      accel: 0,
      offroadMul: 1,
      offroadGrip: 3,
      offroadSteerMul: 0.4,
    });
    const tgt = target(0.5, 0.5, p, 0.4);
    expect(tgt).toBeCloseTo(0.175, 12);
    for (const side of [1, -1]) {
      const s = oneCar({ x: 1.5 * side, vx: -0.1 * side, steer: 0.5 * side, speed: 0.5 });
      const err0 = tgt * side - s.cars[0]!.vx;
      const N = 120;
      for (let i = 0; i < N; i++) {
        step(s, [inp(0.5 * side)], constTrack(0), [p]);
        expect(Math.abs(s.cars[0]!.x)).toBeGreaterThan(1);
      }
      const err = tgt * side - s.cars[0]!.vx;
      const expectedErr = err0 * Math.exp(-3 * N * DT);
      expect(Math.abs(err - expectedErr) / Math.abs(expectedErr)).toBeLessThan(1e-9);
    }
  });

  it('on road (x = 0, 0.99, 1, -1) is independent of the off-road values', () => {
    const a = withOff({ ...baseCar, offroadGrip: 3, offroadSteerMul: 0.4 });
    const b = withOff({ ...baseCar, offroadGrip: 50, offroadSteerMul: 7 });
    // x stays in [-1, 1]: boundary starts push inward, others use small gentle steer for 100 ticks.
    const cases: Array<{ x: number; vx: number; steer: number }> = [
      { x: 0, vx: 0, steer: 0.5 },
      { x: 0.99, vx: -0.1, steer: -0.5 },
      { x: 1, vx: -0.1, steer: -0.5 },
      { x: -1, vx: 0.1, steer: 0.5 },
    ];
    for (const c of cases) {
      const sa = oneCar({ x: c.x, vx: c.vx, steer: c.steer, speed: 0.5 });
      const sb = oneCar({ x: c.x, vx: c.vx, steer: c.steer, speed: 0.5 });
      for (let i = 0; i < 100; i++) {
        expect(Math.abs(sa.cars[0]!.x)).toBeLessThanOrEqual(1);
        step(sa, [inp(c.steer)], constTrack(0), [a]);
        step(sb, [inp(c.steer)], constTrack(0), [b]);
        expect(sa).toEqual(sb);
      }
    }
  });

  it('condition uses x at the start of the step', () => {
    // steer 1, speed 0.5: base target 0.875 ; off-road target 0.875*0.4 = 0.35.
    const p = withOff({ ...baseCar, accel: 0, offroadGrip: 3, offroadSteerMul: 0.4 });
    const track = constTrack(0);
    // (a) x = 0.999, vx = +0.5 outward: x ends at 0.999 + ~0.0042 > 1, but the step is ON road.
    let s = oneCar({ x: 0.999, vx: 0.5, steer: 1, speed: 0.5 });
    step(s, [inp(1)], track, [p]);
    expect(s.cars[0]!.x).toBeGreaterThan(1);
    expect(s.cars[0]!.vx).toBeCloseTo(r12(0.5, target(1, 0.5, p, 1), 12), 12);
    // (b) x = 1.001, vx = -0.5 inward: x ends below 1, but the step is OFF road.
    s = oneCar({ x: 1.001, vx: -0.5, steer: 1, speed: 0.5 });
    step(s, [inp(1)], track, [p]);
    expect(s.cars[0]!.x).toBeLessThan(1);
    expect(s.cars[0]!.vx).toBeCloseTo(r12(-0.5, target(1, 0.5, p, 0.4), 3), 12);
  });

  it('variant A (offroadGrip = grip, offroadSteerMul = 1) equals the old model bitwise on a twisty run that leaves the road', () => {
    const track = buildTrack(loadTestTwisty().def);
    const p = withOff({ ...baseCar, offroadGrip: baseCar.grip, offroadSteerMul: 1 });
    const s = oneCar();
    const ref: RefCar = { z: 0, x: 0, speed: 0, vx: 0, steer: 0, heading: 0 };
    let offTicks = 0;
    for (let t = 0; t < 4000; t++) {
      const input = variedInput(t);
      if (Math.abs(s.cars[0]!.x) > 1) offTicks++;
      step(s, [input], track, [p]);
      refStepOld(ref, input, track, baseCar);
      const c = s.cars[0]!;
      expect(c.x).toBe(ref.x);
      expect(c.vx).toBe(ref.vx);
      expect(c.speed).toBe(ref.speed);
      expect(c.z).toBe(ref.z);
      expect(c.steer).toBe(ref.steer);
      expect(c.heading).toBe(ref.heading);
    }
    // the run must really spend time off road
    expect(offTicks).toBeGreaterThan(200);
  });

  it('left/right symmetry with off-road values different from variant A', () => {
    const track = buildTrack(loadTestTwisty().def);
    const mirror = mirrorTrack(track);
    const p = withOff({ ...baseCar, offroadGrip: 3, offroadSteerMul: 0.4 });
    // Two runs, one starting off road on each side (x = +-1.5), so both sides are
    // really visited; each run is compared with its mirrored twin.
    let offRight = 0;
    let offLeft = 0;
    for (const side of [1, -1]) {
      const s = oneCar({ x: 1.5 * side, speed: 0.5 });
      const m = oneCar({ x: -1.5 * side, speed: 0.5 });
      for (let t = 0; t < 1500; t++) {
        const raw = t < 300 ? side : variedInput(t).steer;
        step(s, [inp(raw)], track, [p]);
        step(m, [inp(-raw)], mirror, [p]);
        const a = s.cars[0]!;
        const b = m.cars[0]!;
        if (a.x > 1) offRight++;
        if (a.x < -1) offLeft++;
        expect(b.x).toBeCloseTo(-a.x, 12);
        expect(b.vx).toBeCloseTo(-a.vx, 12);
        expect(b.steer).toBeCloseTo(-a.steer, 12);
        expect(b.speed).toBeCloseTo(a.speed, 12);
      }
    }
    expect(offRight).toBeGreaterThan(50);
    expect(offLeft).toBeGreaterThan(50);
  });
});

// keep createRace import referenced for type-only tooling
void createRace;

import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import type { CarParams, Track } from '../../src/sim/types';
import { BRAKE, GAS, createRace, run } from './helpers';

// Own params so hand arithmetic does not depend on base.json.
// accel 10: speed after k gas steps = k * 10 / 120 = k / 12.
const P: CarParams = { ...baseCar, accel: 10, vmax: 100, brake: 10 };
const track = (...curves: number[]): Track => ({ segments: curves.map((curve) => ({ curve })) });

describe('R17 heading on a curved track', () => {
  it('constants used in the arithmetic below', () => {
    expect(DT).toBeCloseTo(1 / 120, 15);
    expect(SEG_PER_UNIT).toBe(60);
  });

  it('constant curve c=0.5, speed after update, 1 and 2 steps', () => {
    const s = createRace(1, 1);
    run(s, 1, () => [GAS], [P], track(0.5, 0.5, 0.5, 0.5));
    // step 1: speed = 10/120 = 1/12; heading = 0.5 * (1/12) * 1 * (1/120) = 1/2880
    expect(s.cars[0]!.heading).toBeCloseTo(1 / 2880, 15);
    run(s, 1, () => [GAS], [P], track(0.5, 0.5, 0.5, 0.5));
    // step 2: speed = 1/6; heading += 0.5 * (1/6) / 120 = 1/1440 = 2/2880
    // total = 1/2880 + 2/2880 = 3/2880 = 1/960
    expect(s.cars[0]!.heading).toBeCloseTo(1 / 960, 15);
  });

  it('sign symmetry: curve -c gives -heading', () => {
    const a = createRace(1, 1);
    const b = createRace(1, 1);
    run(a, 37, () => [GAS], [P], track(0.5, 0.5));
    run(b, 37, () => [GAS], [P], track(-0.5, -0.5));
    expect(a.cars[0]!.heading).toBeGreaterThan(0);
    expect(b.cars[0]!.heading).toBeCloseTo(-a.cars[0]!.heading, 15);
  });

  it('uses the segment under the car before z advances (boundary crossed in step 1)', () => {
    const s = createRace(1, 1);
    s.cars[0]!.z = 0.99;
    const t = track(0.4, -0.8);
    run(s, 1, () => [GAS], [P], t);
    // step 1: speed 1/12; z before 0.99 -> seg 0 (curve 0.4); z after = 0.99 + (1/12)/120*60 = 0.99+1/24 = 1.0317 (seg 1)
    // heading = 0.4 * (1/12) / 120 = 0.4/1440 = 1/3600  (using seg 1 would give -1/1800)
    expect(s.cars[0]!.heading).toBeCloseTo(1 / 3600, 15);
    run(s, 1, () => [GAS], [P], t);
    // step 2: z before 1.0317 -> seg 1 (curve -0.8); speed 1/6; heading += -0.8 * (1/6)/120 = -0.8/720 = -4/3600
    // total = 1/3600 - 4/3600 = -3/3600 = -1/1200
    expect(s.cars[0]!.heading).toBeCloseTo(-1 / 1200, 15);
  });

  it('segment index wraps by track length', () => {
    const s = createRace(1, 1);
    s.cars[0]!.z = 1.99;
    const t = track(0.4, -0.8);
    run(s, 2, () => [GAS], [P], t);
    // step 1: z 1.99 -> seg 1 (-0.8): heading = -0.8/1440 = -4/7200 ; z after = 2.0317
    // step 2: z 2.0317 floor 2 % 2 = seg 0 (0.4), speed 1/6: += 0.4/720 = 4/7200 ; total 0
    expect(s.cars[0]!.heading).toBeCloseTo(0, 15);
  });
});

describe('R4 per-car CarParams', () => {
  // A: accel 60, vmax 2, brake 120. B: accel 30, vmax 1, brake 30. Per step: A +0.5, B +0.25 (exact in binary).
  const A: CarParams = { ...baseCar, accel: 60, vmax: 2, brake: 120 };
  const B: CarParams = { ...baseCar, accel: 30, vmax: 1, brake: 30 };
  it('each car follows its own accel and vmax', () => {
    const s = createRace(1, 2);
    run(s, 2, () => [GAS, GAS], [A, B]);
    // A: 2*0.5 = 1.0 ; B: 2*0.25 = 0.5
    expect(s.cars[0]!.speed).toBeCloseTo(1.0, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(0.5, 12);
    run(s, 10, () => [GAS, GAS], [A, B]);
    // caps: A -> 2, B -> 1
    expect(s.cars[0]!.speed).toBeCloseTo(2, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(1, 12);
  });
  it('each car follows its own brake', () => {
    const s = createRace(1, 2);
    run(s, 10, () => [GAS, GAS], [A, B]);
    run(s, 1, () => [BRAKE, BRAKE], [A, B]);
    // A: 2 - 120/120 = 1 ; B: 1 - 30/120 = 0.75
    expect(s.cars[0]!.speed).toBeCloseTo(1, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(0.75, 12);
  });
});

describe('R2 mulberry32 known values', () => {
  // Independent reference (published mulberry32 algorithm), not imported from src.
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  it('reference gives the known first two outputs for seed 1', () => {
    const f = mulberry32(1);
    expect(f()).toBeCloseTo(0.6270739405881613, 15);
    expect(f()).toBeCloseTo(0.002735721180215478, 15);
  });
  it('nextRandom matches the reference and keeps whole state in state.rng', async () => {
    const { nextRandom } = await import('../../src/sim/rng');
    const s = createRace(1, 1);
    expect(s.rng).toBe(1);
    expect(nextRandom(s)).toBeCloseTo(0.6270739405881613, 15);
    expect(nextRandom(s)).toBeCloseTo(0.002735721180215478, 15);
    // state after two draws equals seed + 2 * 0x6d2b79f5 (int32 wrap)
    expect(s.rng).toBe((1 + 2 * 0x6d2b79f5) | 0);
  });
  it('step does not consume randomness in T1', () => {
    const s = createRace(12345, 2);
    run(s, 100, () => [GAS, BRAKE]);
    expect(s.rng).toBe(12345);
  });
});

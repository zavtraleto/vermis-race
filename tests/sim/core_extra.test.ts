import { describe, expect, it } from 'vitest';
import { baseCarA as baseCar } from './baseCarA';
import type { CarParams } from '../../src/sim/types';
import { BRAKE, GAS, createRace, run } from './helpers';

describe('R4 per-car CarParams', () => {
  // A: accel 60, vmax 2, brake 120. B: accel 30, vmax 1, brake 30. Per step: A +0.5, B +0.25 (exact in binary).
  // R204: the brake is brakeDecel; engineBrake 0 keeps the hand arithmetic (BRAKE has gas 0).
  const A: CarParams = { ...baseCar, accel: 60, vmax: 2, brakeDecel: 120, engineBrake: 0 };
  const B: CarParams = { ...baseCar, accel: 30, vmax: 1, brakeDecel: 30, engineBrake: 0 };
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

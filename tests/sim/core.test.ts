import { describe, expect, it } from 'vitest';
import { baseCarA as baseCar } from './baseCarA';
import { nextRandom } from '../../src/sim/rng';
import type { InputFrame } from '../../src/sim/types';
import { BRAKE, GAS, createRace, run } from './helpers';

// Deterministic varied input: brake on ticks 40..79 of every 200.
const pattern = (tick: number): InputFrame[] => [tick % 200 >= 40 && tick % 200 < 80 ? BRAKE : GAS];

describe('R1 fixed step', () => {
  it('one step increments tick by 1', () => {
    const s = createRace(1, 1);
    expect(s.tick).toBe(0);
    run(s, 1, () => [GAS]);
    expect(s.tick).toBe(1);
  });
  it('N steps give N ticks', () => {
    for (const n of [2, 17, 240]) {
      const s = createRace(1, 1);
      run(s, n, () => [GAS]);
      expect(s.tick).toBe(n);
    }
  });
});

describe('R2 determinism and seeded RNG', () => {
  it('same seed and inputs give deep-equal states', () => {
    const a = createRace(42, 2);
    const b = createRace(42, 2);
    const inp = (t: number): InputFrame[] => [pattern(t)[0]!, GAS];
    run(a, 500, inp);
    run(b, 500, inp);
    expect(a).toEqual(b);
  });
  it('nextRandom is in [0,1)', () => {
    const s = createRace(7, 1);
    for (let i = 0; i < 1000; i++) {
      const r = nextRandom(s);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });
  it('same seed gives same sequence', () => {
    const a = createRace(99, 1);
    const b = createRace(99, 1);
    for (let i = 0; i < 50; i++) expect(nextRandom(a)).toBe(nextRandom(b));
  });
  it('different seeds give different sequences', () => {
    const a = createRace(1, 1);
    const b = createRace(2, 1);
    const sa = Array.from({ length: 5 }, () => nextRandom(a));
    const sb = Array.from({ length: 5 }, () => nextRandom(b));
    expect(sa).not.toEqual(sb);
  });
  it('RNG state lives in state.rng: it advances, and restoring it replays the value', () => {
    const s = createRace(5, 1);
    const saved = s.rng;
    const first = nextRandom(s);
    expect(s.rng).not.toBe(saved);
    s.rng = saved;
    expect(nextRandom(s)).toBe(first);
  });
});

describe('R3 serializable state', () => {
  it('JSON round-trip mid-run continues identically', () => {
    const full = createRace(3, 1);
    run(full, 600, pattern);

    const half = createRace(3, 1);
    run(half, 300, pattern);
    const restored = JSON.parse(JSON.stringify(half)) as typeof half;
    expect(restored).toEqual(half);
    run(restored, 300, pattern);
    expect(restored).toEqual(full);
  });
});

describe('R4 inputs per car by index', () => {
  it('car 0 braking and car 1 not gives different speeds', () => {
    const s = createRace(1, 2);
    run(s, 60, () => [GAS, GAS]);
    // after 60 steps: 60 * 0.22/120 = 0.11
    expect(s.cars[0]!.speed).toBeCloseTo(0.11, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(0.11, 12);
    run(s, 10, () => [BRAKE, GAS]);
    // R204 (BRAKE = gas 0, brake 1): car 0: 0.11 - 10 * (engineBrake + brakeDecel)/120
    // car 1: 0.11 + 10 * 0.22/120 = 0.128333...
    expect(s.cars[0]!.speed).toBeCloseTo(
      0.11 - (10 * (baseCar.engineBrake + baseCar.brakeDecel)) / 120,
      12,
    );
    expect(s.cars[1]!.speed).toBeCloseTo(0.11 + (10 * 0.22) / 120, 12);
  });
});

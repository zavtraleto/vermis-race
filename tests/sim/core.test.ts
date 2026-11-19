import { describe, expect, it } from 'vitest';
import { baseCarA as baseCar } from './baseCarA';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { nextRandom } from '../../src/sim/rng';
import type { InputFrame } from '../../src/sim/types';
import { BRAKE, GAS, createRace, run } from './helpers';

const TOL = 1e-12;
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
    // car 0: 0.11 - 10 * 0.6/120 = 0.11 - 0.05 = 0.06
    // car 1: 0.11 + 10 * 0.22/120 = 0.128333...
    expect(s.cars[0]!.speed).toBeCloseTo(0.06, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(0.11 + (10 * 0.22) / 120, 12);
  });
});

describe('R14 automatic throttle, brake, speed bounds', () => {
  it('first step: speed = accel*DT = 0.22/120', () => {
    const s = createRace(1, 1);
    run(s, 1, () => [GAS]);
    expect(Math.abs(s.cars[0]!.speed - baseCar.accel * DT)).toBeLessThan(TOL);
    expect(s.cars[0]!.speed).toBeCloseTo(0.0018333333, 9);
  });
  it('brake step: speed -= brake*DT', () => {
    const s = createRace(1, 1);
    run(s, 120, () => [GAS]); // 0.22
    run(s, 1, () => [BRAKE]); // 0.22 - 0.6/120 = 0.215
    expect(s.cars[0]!.speed).toBeCloseTo(0.215, 12);
  });
  it('speed is monotone non-decreasing while not braking', () => {
    const s = createRace(1, 1);
    let prev = 0;
    for (let i = 0; i < 700; i++) {
      run(s, 1, () => [GAS]);
      expect(s.cars[0]!.speed).toBeGreaterThanOrEqual(prev);
      prev = s.cars[0]!.speed;
    }
  });
  it('speed never exceeds vmax (reached after 1/0.22 s ~ 546 steps)', () => {
    const s = createRace(1, 1);
    for (let i = 0; i < 700; i++) {
      run(s, 1, () => [GAS]);
      expect(s.cars[0]!.speed).toBeLessThanOrEqual(baseCar.vmax);
    }
    expect(s.cars[0]!.speed).toBeCloseTo(baseCar.vmax, 12);
  });
  it('speed never goes below 0 under long braking', () => {
    const s = createRace(1, 1);
    run(s, 60, () => [GAS]); // 0.11, brakes to 0 in 22 steps
    for (let i = 0; i < 100; i++) {
      run(s, 1, () => [BRAKE]);
      expect(s.cars[0]!.speed).toBeGreaterThanOrEqual(0);
    }
    expect(s.cars[0]!.speed).toBe(0);
  });
});

describe('R16 z advances by post-update speed', () => {
  it('step 1: z = (0.22/120) * DT * 60 = 0.000916666...', () => {
    const s = createRace(1, 1);
    run(s, 1, () => [GAS]);
    // Using the pre-update speed (0) would give z = 0.
    expect(s.cars[0]!.z).toBeCloseTo(baseCar.accel * DT * DT * SEG_PER_UNIT, 12);
    expect(s.cars[0]!.z).toBeCloseTo(0.000916666667, 11);
  });
  it('step 2 adds (2*0.22/120) * DT * 60 = 0.001833333; total 0.00275', () => {
    const s = createRace(1, 1);
    run(s, 2, () => [GAS]);
    expect(s.cars[0]!.z).toBeCloseTo(0.00275, 11);
  });
  it('z is monotone non-decreasing', () => {
    const s = createRace(1, 1);
    let prev = 0;
    for (let i = 0; i < 300; i++) {
      run(s, 1, pattern);
      expect(s.cars[0]!.z).toBeGreaterThanOrEqual(prev);
      prev = s.cars[0]!.z;
    }
  });
});

describe('R17 heading on a straight track', () => {
  it('stays exactly 0', () => {
    const s = createRace(1, 1);
    for (let i = 0; i < 600; i++) {
      run(s, 1, pattern);
      expect(Math.abs(s.cars[0]!.heading)).toBe(0);
    }
  });
});

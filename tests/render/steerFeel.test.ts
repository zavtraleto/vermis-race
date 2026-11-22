// Written from docs/brief.md "Ощущение руля: камера, колёса, следы" (R25c), not from code.
// [ADR 0005] the R27c camera part is removed with its rule; R24d (front marks) is off per brief.
import { describe, expect, it } from 'vitest';
import { stepWheelSpin } from '../../src/render/wheelSpin';

const DT = 1 / 60;
const TWO_PI = 2 * Math.PI;

describe('R25c wheel spin (stepWheelSpin)', () => {
  const R = 0.36; // m, a plausible model wheel radius

  it('hand number: speed 10 m/s, r 0.36 m, dt 1/60 -> +10/0.36/60 = 0.462963 rad', () => {
    expect(stepWheelSpin(0, 10, R, DT)).toBeCloseTo(10 / R / 60, 12);
    expect(stepWheelSpin(0, 10, R, DT)).toBeCloseTo(0.462963, 6);
  });

  it('travel 2πr is one full turn: the angle comes back to the same value', () => {
    // dt = 2π*0.36/10 = 0.226195 s at 10 m/s -> delta 2π
    for (const a0 of [0, 1, 3, 6]) {
      const a = stepWheelSpin(a0, 10, R, (TWO_PI * R) / 10);
      // wrapped: either a0 or a0 ± tiny round-off near the 0/2π seam
      const d = Math.abs(a - a0);
      expect(Math.min(d, TWO_PI - d)).toBeLessThan(1e-9);
    }
  });

  it('result is wrapped into [0, 2π)', () => {
    for (const [a0, v, dt] of [
      [0, 10, 1],
      [6.2, 30, 1 / 60],
      [0, 80, 7.3],
      [3, 0.001, 1 / 60],
    ] as const) {
      const a = stepWheelSpin(a0, v, R, dt);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(TWO_PI);
    }
  });

  it('speed 0: angle unchanged', () => {
    expect(stepWheelSpin(1.234, 0, R, DT)).toBe(1.234);
  });

  it('radius <= 0: angle unchanged (no division by zero, no NaN)', () => {
    expect(stepWheelSpin(2.5, 20, 0, DT)).toBe(2.5);
    expect(stepWheelSpin(2.5, 20, -0.3, DT)).toBe(2.5);
  });

  it('linear in dt: one step dt equals two steps dt/2 (mod 2π)', () => {
    for (const [v, dt] of [
      [10, 1 / 60],
      [45, 0.1],
      [3, 2],
    ] as const) {
      const one = stepWheelSpin(0.5, v, R, dt);
      const two = stepWheelSpin(stepWheelSpin(0.5, v, R, dt / 2), v, R, dt / 2);
      const d = Math.abs(one - two);
      expect(Math.min(d, TWO_PI - d)).toBeLessThan(1e-9);
    }
  });

  it('smaller wheel spins faster: same speed and dt, r 0.18 gives twice the delta of r 0.36', () => {
    const big = stepWheelSpin(0, 5, 0.36, DT); // 5/0.36/60 = 0.231481
    const small = stepWheelSpin(0, 5, 0.18, DT); // 5/0.18/60 = 0.462963
    expect(small).toBeCloseTo(2 * big, 12);
  });
});

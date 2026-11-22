// Written from docs/brief.md "Ощущение руля: камера, колёса, следы" (R25c, R24d), not from code.
// [ADR 0005] the R27c camera part is removed with its rule.
import { describe, expect, it } from 'vitest';
import sprites from '../../src/data/sprites.json';
import tunablesJson from '../../src/data/tunables.json';
import type { TunableSpec } from '../../src/dev/tunables';
import { frontMarksActive } from '../../src/render/tyreMarks';
import { stepWheelSpin } from '../../src/render/wheelSpin';

const MARKS = sprites.tyreMarks as unknown as Record<string, number>;
const spec: TunableSpec = tunablesJson;
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

describe('R24d front-wheel marks in a strong drift (frontMarksActive)', () => {
  const SLIP_FULL = 2; // threshold = 0.7*2 = 1.4 (exact in binary: doubling)

  it('data: sprites.json tyreMarks.frontMarkSlip 0.7, tunable in the dev panel', () => {
    expect(MARKS.frontMarkSlip).toBe(0.7);
    const r = spec.numbers['sprites.tyreMarks.frontMarkSlip'];
    expect(r).toBeDefined();
    expect(0.7).toBeGreaterThanOrEqual(r!.min);
    expect(0.7).toBeLessThanOrEqual(r!.max);
  });

  it('boundary is inclusive: |slip| = 0.7*slipFull -> true, just below -> false', () => {
    expect(frontMarksActive('DRIFT', 0.7 * SLIP_FULL, SLIP_FULL, 0.7)).toBe(true);
    expect(frontMarksActive('DRIFT', 1.4, SLIP_FULL, 0.7)).toBe(true);
    expect(frontMarksActive('DRIFT', 1.3999, SLIP_FULL, 0.7)).toBe(false);
    expect(frontMarksActive('DRIFT', 2.5, SLIP_FULL, 0.7)).toBe(true);
  });

  it('sign of slip does not matter (left/right symmetry)', () => {
    for (const slip of [0, 0.5, 1.3999, 1.4, 1.9, 3]) {
      expect(frontMarksActive('DRIFT', -slip, SLIP_FULL, 0.7)).toBe(
        frontMarksActive('DRIFT', slip, SLIP_FULL, 0.7),
      );
    }
    expect(frontMarksActive('DRIFT', -1.4, SLIP_FULL, 0.7)).toBe(true);
  });

  it('outside DRIFT: always false', () => {
    for (const slip of [0, 1.4, -3, 10])
      expect(frontMarksActive('GRIP', slip, SLIP_FULL, 0.7)).toBe(false);
    expect(frontMarksActive('GRIP', 1, SLIP_FULL, 0)).toBe(false);
  });

  it('frontMarkSlip 0 in DRIFT: always true (even slip 0)', () => {
    for (const slip of [0, -0.01, 1, 5])
      expect(frontMarksActive('DRIFT', slip, SLIP_FULL, 0)).toBe(true);
  });

  it('monotonic in |slip|: once true, larger |slip| stays true', () => {
    let seen = false;
    for (let i = 0; i <= 40; i++) {
      const on = frontMarksActive('DRIFT', i * 0.1, SLIP_FULL, 0.7);
      if (seen) expect(on).toBe(true);
      if (on) seen = true;
    }
    expect(seen).toBe(true);
  });
});

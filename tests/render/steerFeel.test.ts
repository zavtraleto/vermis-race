// Written from docs/brief.md "Ощущение руля: камера, колёса, следы" (R27c, R25c, R24d), not from code.
import { describe, expect, it } from 'vitest';
import camera from '../../src/data/camera.json';
import sprites from '../../src/data/sprites.json';
import tunablesJson from '../../src/data/tunables.json';
import type { TunableSpec } from '../../src/dev/tunables';
import { stepCamDrift, type CamDrift, type CamDriftConfig } from '../../src/render/cameraDrift';
import { frontMarksActive } from '../../src/render/tyreMarks';
import { stepWheelSpin } from '../../src/render/wheelSpin';

const CAM = camera as unknown as Record<string, number>;
const MARKS = sprites.tyreMarks as unknown as Record<string, number>;
const spec: TunableSpec = tunablesJson;

// Brief start numbers (R27c).
const CFG: CamDriftConfig = {
  camDriftShift: 0.05,
  camRollDeg: 1.5,
  camGripMul: 0.3,
  camDriftTau: 0.25,
};
const DT = 1 / 60;
const TWO_PI = 2 * Math.PI;

function fresh(shiftX = 0, rollDeg = 0): CamDrift {
  return { shiftX, rollDeg };
}

function run(s: CamDrift, g: number, drifting: boolean, seconds: number, cfg = CFG): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) stepCamDrift(s, g, drifting, DT, cfg);
}

describe('R27c camera shift into the turn and roll in drift (stepCamDrift)', () => {
  it('data: camera.json camDriftShift 0.05, camRollDeg 1.5, camGripMul 0.3, camDriftTau 0.25', () => {
    expect(CAM.camDriftShift).toBe(0.05);
    expect(CAM.camRollDeg).toBe(1.5);
    expect(CAM.camGripMul).toBe(0.3);
    expect(CAM.camDriftTau).toBe(0.25);
  });

  it('dev panel: the four camera numbers are tunable, defaults inside their ranges', () => {
    for (const k of ['camDriftShift', 'camRollDeg', 'camGripMul', 'camDriftTau']) {
      const r = spec.numbers[`camera.${k}`];
      expect(r, k).toBeDefined();
      expect(CAM[k]!).toBeGreaterThanOrEqual(r!.min);
      expect(CAM[k]!).toBeLessThanOrEqual(r!.max);
    }
  });

  it('straight (g = 0): target 0, an offset state converges to 0 in both states', () => {
    for (const drifting of [true, false]) {
      const s = fresh(0.04, -1.2);
      run(s, 0, drifting, 5); // 5 s = 20 tau: residual 0.04*e^-20 ~ 8e-11
      expect(Math.abs(s.shiftX)).toBeLessThan(1e-8);
      expect(Math.abs(s.rollDeg)).toBeLessThan(1e-8);
    }
  });

  it('DRIFT, g = 1: converges to camDriftShift 0.05 and camRollDeg 1.5', () => {
    const s = fresh();
    run(s, 1, true, 5);
    expect(s.shiftX).toBeCloseTo(0.05, 8);
    expect(s.rollDeg).toBeCloseTo(1.5, 8);
  });

  it('DRIFT, g = 1: after tau 0.25 s from 0 the state covers 1 - 1/e = 0.632121 of the way', () => {
    // 15 ticks of 1/60 = 0.25 s; exact exponent: 1 - exp(-15*(1/60)/0.25) = 1 - e^-1
    const s = fresh();
    run(s, 1, true, 0.25);
    const f = 1 - Math.exp(-1); // 0.6321205588
    expect(s.shiftX).toBeCloseTo(0.05 * f, 9); // 0.0316060
    expect(s.rollDeg).toBeCloseTo(1.5 * f, 9); // 0.9481808
  });

  it('hand number, one tick: 0 -> DRIFT g 1, dt 1/60: 0.05*(1 - exp(-1/15)) = 0.0032247', () => {
    const s = fresh();
    stepCamDrift(s, 1, true, DT, CFG);
    // 1 - exp(-0.0666667) = 0.0644930; *0.05 = 0.00322465; *1.5 = 0.0967395
    expect(s.shiftX).toBeCloseTo(0.00322465, 7);
    expect(s.rollDeg).toBeCloseTo(0.0967395, 6);
  });

  it('GRIP target is camGripMul 0.3 of the DRIFT one: g 1 -> 0.015 shift, 0.45 deg roll', () => {
    const s = fresh();
    run(s, 1, false, 5);
    expect(s.shiftX).toBeCloseTo(0.05 * 0.3, 8); // 0.015
    expect(s.rollDeg).toBeCloseTo(1.5 * 0.3, 8); // 0.45
  });

  it('proportional to g: DRIFT g 0.5 -> 0.025 shift, 0.75 deg roll', () => {
    const s = fresh();
    run(s, 0.5, true, 5);
    expect(s.shiftX).toBeCloseTo(0.025, 8);
    expect(s.rollDeg).toBeCloseTo(0.75, 8);
  });

  it('g is clamped to ±1: g 3 and g -7 give the same result as ±1', () => {
    const a = fresh();
    const b = fresh();
    stepCamDrift(a, 3, true, DT, CFG);
    stepCamDrift(b, 1, true, DT, CFG);
    expect(a).toEqual(b);
    const c = fresh();
    const d = fresh();
    run(c, -7, true, 5);
    run(d, -1, true, 5);
    expect(c.shiftX).toBe(d.shiftX);
    expect(c.rollDeg).toBe(d.rollDeg);
    expect(c.shiftX).toBeCloseTo(-0.05, 8);
  });

  it('left/right symmetry: g -> -g mirrors both fields exactly', () => {
    for (const drifting of [true, false]) {
      const p = fresh();
      const m = fresh();
      for (let i = 0; i < 40; i++) {
        const g = Math.sin(i * 0.3);
        stepCamDrift(p, g, drifting, DT, CFG);
        stepCamDrift(m, -g, drifting, DT, CFG);
        expect(m.shiftX === -p.shiftX).toBe(true); // === : +0 and -0 are equal
        expect(m.rollDeg === -p.rollDeg).toBe(true);
      }
    }
  });

  it('R27 defect regression: sign of g flips -> the state passes through 0 and settles on the other side', () => {
    const s = fresh();
    run(s, 1, true, 5);
    expect(s.shiftX).toBeGreaterThan(0);
    expect(s.rollDeg).toBeGreaterThan(0);
    let crossedShift = false;
    let crossedRoll = false;
    let prev = s.shiftX;
    for (let i = 0; i < Math.round(5 / DT); i++) {
      stepCamDrift(s, -1, true, DT, CFG);
      expect(s.shiftX).toBeLessThanOrEqual(prev); // monotonic towards the new target, no overshoot
      expect(s.shiftX).toBeGreaterThanOrEqual(-0.05 - 1e-12);
      prev = s.shiftX;
      if (s.shiftX < 0) crossedShift = true;
      if (s.rollDeg < 0) crossedRoll = true;
    }
    expect(crossedShift).toBe(true);
    expect(crossedRoll).toBe(true);
    expect(s.shiftX).toBeCloseTo(-0.05, 8);
    expect(s.rollDeg).toBeCloseTo(-1.5, 8);
  });

  it('camDriftShift 0 and camRollDeg 0: always 0 whatever g and state', () => {
    const off = { ...CFG, camDriftShift: 0, camRollDeg: 0 };
    const s = fresh();
    for (let i = 0; i < 120; i++) {
      stepCamDrift(s, i % 2 === 0 ? 1 : -0.6, i % 3 === 0, DT, off);
      expect(s.shiftX === 0).toBe(true);
      expect(s.rollDeg === 0).toBe(true);
    }
  });

  it('bounded: |shiftX| <= camDriftShift, |rollDeg| <= camRollDeg from rest under any g sequence', () => {
    const s = fresh();
    for (let i = 0; i < 600; i++) {
      stepCamDrift(s, 2 * Math.sin(i * 0.17), i % 50 < 30, DT, CFG);
      expect(Math.abs(s.shiftX)).toBeLessThanOrEqual(0.05 + 1e-12);
      expect(Math.abs(s.rollDeg)).toBeLessThanOrEqual(1.5 + 1e-12);
    }
  });

  it('frame-split independent (exact exponent): one step dt equals two steps dt/2 within 1e-9', () => {
    for (const [g, drifting, dt] of [
      [1, true, 1 / 30],
      [-0.4, false, 0.1],
      [0.8, true, 0.5],
    ] as const) {
      const a = fresh(0.01, -0.3);
      const b = fresh(0.01, -0.3);
      stepCamDrift(a, g, drifting, dt, CFG);
      stepCamDrift(b, g, drifting, dt / 2, CFG);
      stepCamDrift(b, g, drifting, dt / 2, CFG);
      expect(Math.abs(a.shiftX - b.shiftX)).toBeLessThan(1e-9);
      expect(Math.abs(a.rollDeg - b.rollDeg)).toBeLessThan(1e-9);
    }
  });

  it('dt = 0 leaves the state unchanged', () => {
    const s = fresh(0.02, 0.7);
    stepCamDrift(s, 1, true, 0, CFG);
    expect(s.shiftX).toBe(0.02);
    expect(s.rollDeg).toBe(0.7);
  });

  it('deterministic: the same inputs twice give identical state', () => {
    const a = fresh();
    const b = fresh();
    for (let i = 0; i < 100; i++) {
      const g = Math.cos(i * 0.21);
      stepCamDrift(a, g, i % 7 < 4, DT, CFG);
      stepCamDrift(b, g, i % 7 < 4, DT, CFG);
    }
    expect(a).toEqual(b);
  });
});

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

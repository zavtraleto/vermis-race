import { describe, expect, it } from 'vitest';
import { WheelSteer } from '../../src/render/wheelSteer';
import type { WheelSteerConfig } from '../../src/render/wheelSteer';

// Test numbers, not the game's: steerMaxDeg 30, steerTau 0.1 s.
const CFG: WheelSteerConfig = { steerMaxDeg: 30, steerTau: 0.1 };
const ONE_MINUS_E1 = 1 - Math.exp(-1); // 0.6321205588...

function closeRel(actual: number, expected: number, rel = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(expected)));
}

describe('R25b front-wheel steer angle', () => {
  it('R25b starts at 0', () => {
    expect(new WheelSteer().deg).toBe(0);
  });

  it('R25b one step of dt = tau reaches 1 - e^-1 of the target', () => {
    const w = new WheelSteer();
    w.update(1, 0.1, CFG);
    // target = 1 * 30 = 30; deg = 0 + 30 * (1 - e^-1) = 18.963616...
    closeRel(w.deg, 30 * ONE_MINUS_E1);
    expect(w.deg).toBeCloseTo(18.9636, 3);
  });

  it('R25b frame-rate independent: two half-steps equal one full step', () => {
    const a = new WheelSteer();
    a.update(0.5, 0.1, CFG);
    const b = new WheelSteer();
    b.update(0.5, 0.05, CFG);
    b.update(0.5, 0.05, CFG);
    // target 15; after total time tau: 15 * (1 - e^-1) = 9.481808...
    closeRel(a.deg, 15 * ONE_MINUS_E1);
    closeRel(b.deg, 15 * ONE_MINUS_E1);
  });

  it('R25b frame-rate independent at 60 fps over 0.3 s', () => {
    const w = new WheelSteer();
    for (let i = 0; i < 18; i++) w.update(1, 1 / 60, CFG);
    // 18 * (1/60) = 0.3 s = 3 tau: 30 * (1 - e^-3) = 28.506388...
    closeRel(w.deg, 30 * (1 - Math.exp(-3)));
  });

  it('R25b converges to the target and never overshoots', () => {
    const w = new WheelSteer();
    let prev = 0;
    for (let i = 0; i < 600; i++) {
      w.update(0.8, 1 / 60, CFG);
      expect(w.deg).toBeGreaterThanOrEqual(prev);
      expect(w.deg).toBeLessThanOrEqual(24 + 1e-9); // 0.8 * 30
      prev = w.deg;
    }
    expect(w.deg).toBeCloseTo(24, 6);
  });

  it('R25b sign follows steer and left/right is symmetric', () => {
    const r = new WheelSteer();
    const l = new WheelSteer();
    for (let i = 0; i < 10; i++) {
      r.update(0.6, 1 / 60, CFG);
      l.update(-0.6, 1 / 60, CFG);
    }
    expect(r.deg).toBeGreaterThan(0);
    expect(l.deg).toBeLessThan(0);
    expect(l.deg).toBe(-r.deg);
  });

  it('R25b clamps |steer| > 1 to steerMaxDeg', () => {
    const big = new WheelSteer();
    const one = new WheelSteer();
    big.update(3, 0.1, CFG);
    one.update(1, 0.1, CFG);
    expect(big.deg).toBe(one.deg);
    const neg = new WheelSteer();
    neg.update(-5, 0, { steerMaxDeg: 30, steerTau: 0 });
    expect(neg.deg).toBe(-30);
  });

  it('R25b steerTau <= 0 snaps to the target', () => {
    const w = new WheelSteer();
    w.update(0.5, 1 / 60, { steerMaxDeg: 30, steerTau: 0 });
    expect(w.deg).toBe(15); // 0.5 * 30
    w.update(-1, 1 / 60, { steerMaxDeg: 30, steerTau: -1 });
    expect(w.deg).toBe(-30);
  });

  it('R25b dt = 0 leaves the angle unchanged', () => {
    const w = new WheelSteer();
    w.update(1, 0.1, CFG);
    const d = w.deg;
    w.update(-1, 0, CFG);
    expect(w.deg).toBe(d);
  });

  it('R25b reset() returns to 0', () => {
    const w = new WheelSteer();
    w.update(1, 0.2, CFG);
    expect(w.deg).not.toBe(0);
    w.reset();
    expect(w.deg).toBe(0);
  });

  it('R25b reversing steer crosses zero smoothly and monotonically', () => {
    const w = new WheelSteer();
    for (let i = 0; i < 120; i++) w.update(-1, 1 / 60, CFG);
    expect(w.deg).toBeCloseTo(-30, 3);
    let prev = w.deg;
    let crossed = false;
    const maxStep = 60 * (1 - Math.exp(-1 / 6)); // |target - deg| <= 60, alpha at dt 1/60, tau 0.1
    for (let i = 0; i < 120; i++) {
      w.update(1, 1 / 60, CFG);
      expect(w.deg).toBeGreaterThan(prev); // strictly towards +30
      expect(w.deg - prev).toBeLessThanOrEqual(maxStep + 1e-9); // no jump
      expect(w.deg).toBeLessThanOrEqual(30 + 1e-9);
      if (prev < 0 && w.deg >= 0) crossed = true;
      prev = w.deg;
    }
    expect(crossed).toBe(true);
  });

  it('R25b deterministic: same inputs give the same angle', () => {
    const a = new WheelSteer();
    const b = new WheelSteer();
    const seq = [0.2, 1, -0.7, 0, 0.4, -1.5];
    for (const s of seq) {
      a.update(s, 1 / 60, CFG);
      b.update(s, 1 / 60, CFG);
    }
    expect(a.deg).toBe(b.deg);
  });
});

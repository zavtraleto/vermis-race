import { describe, expect, it } from 'vitest';
import { createMistakes, stepMistake } from '../../src/bot/mistakes';
import type { MistakeConfig, MistakeState } from '../../src/bot/mistakes';

const cfg: MistakeConfig = {
  mistakePeriod: [20, 50, 110],
  mistakeTimeMin: 0.3,
  mistakeTimeMax: 0.6,
  mistakeSteerMin: 0.3,
  mistakeSteerMax: 0.6,
  mistakeBandMul: 0.6,
  bandBoost: 0.06,
};
const DT = 0.05;

interface Ep {
  start: number;
  dur: number;
  off: number;
}

/** Runs the generator; episodes are maximal runs of a constant nonzero offset. */
function run(seed: number, skill: number, band: number, seconds: number): Ep[] {
  const m = createMistakes(seed);
  const eps: Ep[] = [];
  const steps = Math.round(seconds / DT);
  let cur: Ep | null = null;
  for (let i = 0; i < steps; i++) {
    const o = stepMistake(m, skill, band, cfg, DT);
    if (o !== 0) {
      if (cur && cur.off === o) cur.dur += DT;
      else {
        cur = { start: i * DT, dur: DT, off: o };
        eps.push(cur);
      }
    } else cur = null;
  }
  return eps;
}

function meanInterval(eps: Ep[]): number {
  // start-to-start, skipping the first interval (the initial draw is not specified)
  let sum = 0;
  let n = 0;
  for (let i = 2; i < eps.length; i++) {
    sum += eps[i]!.start - eps[i - 1]!.start;
    n++;
  }
  return sum / n;
}

describe('R63c bot mistakes', () => {
  it('determinism: same seed, same offsets', () => {
    const a = createMistakes(42);
    const b = createMistakes(42);
    for (let i = 0; i < 20000; i++)
      expect(stepMistake(a, 0, 0, cfg, DT)).toBe(stepMistake(b, 0, 0, cfg, DT));
    expect(a).toEqual(b);
  });
  it('different seeds differ', () => {
    const a = run(1, 0, 0, 2000).map((e) => e.start);
    const b = run(2, 0, 0, 2000).map((e) => e.start);
    expect(a).not.toEqual(b);
  });
  it('state is flat JSON (numbers only)', () => {
    const m = createMistakes(7);
    for (const v of Object.values(m)) expect(typeof v).toBe('number');
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
  it.each([
    [0, 20, 200000],
    [1, 50, 400000],
    [2, 110, 800000],
  ])('skill %i mean interval ~ period %i s (+-15%%)', (skill, period, secs) => {
    // start-to-start; mean duration 0.45 s is under 3% of the shortest period
    const mean = meanInterval(run(123, skill, 0, secs));
    expect(mean).toBeGreaterThan(period * 0.85);
    expect(mean).toBeLessThan(period * 1.15);
  });
  it('band > bandBoost/2 multiplies the interval by 0.6 (+-15%)', () => {
    // novice: 20 * 0.6 = 12 s; band 0.06 > 0.03
    const mean = meanInterval(run(5, 0, 0.06, 200000));
    expect(mean).toBeGreaterThan(12 * 0.85);
    expect(mean).toBeLessThan(12 * 1.15);
  });
  it('band exactly at bandBoost/2 is not boosted (strict >)', () => {
    const mean = meanInterval(run(5, 0, 0.03, 200000));
    expect(mean).toBeGreaterThan(20 * 0.85);
    expect(mean).toBeLessThan(20 * 1.15);
  });
  it('duration in [0.3, 0.6] and magnitude in [0.3, 0.6]', () => {
    const eps = run(9, 0, 0, 20000);
    expect(eps.length).toBeGreaterThan(100);
    for (const e of eps) {
      // dt quantisation: allow one step of slack on the upper bound
      expect(e.dur).toBeGreaterThanOrEqual(0.3 - 1e-9);
      expect(e.dur).toBeLessThanOrEqual(0.6 + DT + 1e-9);
      expect(Math.abs(e.off)).toBeGreaterThanOrEqual(0.3);
      expect(Math.abs(e.off)).toBeLessThanOrEqual(0.6);
    }
  });
  it('both signs occur, roughly balanced', () => {
    const eps = run(11, 0, 0, 40000);
    const pos = eps.filter((e) => e.off > 0).length;
    const neg = eps.filter((e) => e.off < 0).length;
    expect(pos).toBeGreaterThan(0);
    expect(neg).toBeGreaterThan(0);
    expect(pos / eps.length).toBeGreaterThan(0.4);
    expect(pos / eps.length).toBeLessThan(0.6);
  });
  it('offset is constant during a mistake and exactly 0 between (no -0)', () => {
    const m = createMistakes(3);
    let prev = 0;
    let changes = 0;
    for (let i = 0; i < 40000; i++) {
      const o = stepMistake(m, 0, 0, cfg, DT);
      expect(Object.is(o, -0)).toBe(false);
      if (o !== prev) {
        expect(o === 0 || prev === 0).toBe(true);
        changes++;
      }
      prev = o;
    }
    expect(changes).toBeGreaterThan(10);
  });
  it('JSON round-trip mid-mistake continues identically', () => {
    const m = createMistakes(77);
    let i = 0;
    while (stepMistake(m, 0, 0, cfg, DT) === 0 && i < 100000) i++; // now inside a mistake
    stepMistake(m, 0, 0, cfg, DT);
    const copy: MistakeState = JSON.parse(JSON.stringify(m)) as MistakeState;
    for (let k = 0; k < 20000; k++)
      expect(stepMistake(copy, 0, 0, cfg, DT)).toBe(stepMistake(m, 0, 0, cfg, DT));
    expect(copy).toEqual(m);
  });
  it('intervals are not periodic: variance > 0', () => {
    const eps = run(21, 0, 0, 20000);
    const d: number[] = [];
    for (let i = 1; i < eps.length; i++) d.push(eps[i]!.start - eps[i - 1]!.start);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const v = d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length;
    expect(v).toBeGreaterThan(1);
  });
});

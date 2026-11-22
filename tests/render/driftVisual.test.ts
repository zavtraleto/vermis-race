import { describe, expect, it } from 'vitest';
import { SmokePool, approach } from '../../src/render/driftVisual';

describe('approach (exponential)', () => {
  it('matches the closed form', () => {
    // tau 0.1, dt 0.1: 10 + (20-10)*(1-e^-1) = 10 + 6.3212056 = 16.3212056
    expect(approach(10, 20, 0.1, 0.1)).toBeCloseTo(16.3212056, 6);
    // downward: 0 -> -4, dt 0.2, tau 0.1: -4*(1-e^-2) = -3.4586587
    expect(approach(0, -4, 0.2, 0.1)).toBeCloseTo(-3.4586587, 6);
  });

  it('tau <= 0 returns target', () => {
    expect(approach(3, 7, 0.016, 0)).toBe(7);
    expect(approach(3, 7, 0.016, -1)).toBe(7);
  });

  it('dt = 0 returns current', () => {
    expect(approach(3, 7, 0, 0.2)).toBe(3);
  });

  it('never overshoots, is monotone in dt, and converges (both directions)', () => {
    for (const [cur, tgt] of [
      [0, 1],
      [1, 0],
      [-2, 5],
      [5, -2],
    ] as const) {
      let prev: number = cur;
      for (const dt of [0.001, 0.016, 0.1, 1, 10, 1000]) {
        const v = approach(cur, tgt, dt, 0.25);
        expect(v).toBeGreaterThanOrEqual(Math.min(cur, tgt) - 1e-12);
        expect(v).toBeLessThanOrEqual(Math.max(cur, tgt) + 1e-12);
        expect(Math.abs(tgt - v)).toBeLessThanOrEqual(Math.abs(tgt - prev) + 1e-12);
        prev = v;
      }
      expect(prev).toBeCloseTo(tgt, 9);
    }
  });

  it('at target stays at target', () => {
    expect(approach(2, 2, 0.5, 0.3)).toBeCloseTo(2, 12);
  });
});

describe('SmokePool', () => {
  it('starts empty', () => {
    expect(new SmokePool(4).count).toBe(0);
  });

  it('emit stores position and age01 starts at 0', () => {
    const p = new SmokePool(4);
    p.emit(1.5, -2.5, 2);
    expect(p.count).toBe(1);
    expect(p.x(0)).toBe(1.5);
    expect(p.y(0)).toBe(-2.5);
    expect(p.age01(0)).toBe(0);
  });

  it('update ages: age01 = age/life', () => {
    const p = new SmokePool(4);
    p.emit(0, 0, 2);
    p.update(0.5); // 0.5/2
    expect(p.age01(0)).toBeCloseTo(0.25, 9);
    p.update(0.5); // 1.0/2
    expect(p.age01(0)).toBeCloseTo(0.5, 9);
  });

  it('removes particles with age >= life, keeps the others', () => {
    const p = new SmokePool(4);
    p.emit(1, 0, 1); // dies at age 1
    p.emit(2, 0, 3);
    p.update(0.5);
    expect(p.count).toBe(2);
    p.update(0.5); // first reaches age == life -> removed
    expect(p.count).toBe(1);
    expect(p.x(0)).toBe(2);
    expect(p.age01(0)).toBeCloseTo(1 / 3, 9);
    p.update(5);
    expect(p.count).toBe(0);
  });

  it('age01 stays in [0,1) for all live particles', () => {
    const p = new SmokePool(8);
    for (let i = 0; i < 8; i++) p.emit(i, i, 0.5 + i * 0.1);
    for (let k = 0; k < 20; k++) {
      p.update(0.05);
      for (let i = 0; i < p.count; i++) {
        expect(p.age01(i)).toBeGreaterThanOrEqual(0);
        expect(p.age01(i)).toBeLessThan(1);
      }
    }
  });

  it('count never exceeds capacity; overflow overwrites the oldest', () => {
    const p = new SmokePool(3);
    p.emit(1, 0, 10);
    p.update(1);
    p.emit(2, 0, 10);
    p.update(1);
    p.emit(3, 0, 10);
    p.update(1); // ages: 3, 2, 1
    p.emit(4, 0, 10); // evicts x=1 (oldest)
    expect(p.count).toBe(3);
    const xs = [0, 1, 2].map((i) => p.x(i)).sort((a, b) => a - b);
    expect(xs).toEqual([2, 3, 4]);
    for (let i = 0; i < 50; i++) p.emit(100 + i, 0, 10);
    expect(p.count).toBe(3);
  });

  it('clear empties the pool and it is reusable', () => {
    const p = new SmokePool(3);
    p.emit(1, 1, 1);
    p.emit(2, 2, 1);
    p.clear();
    expect(p.count).toBe(0);
    p.emit(9, 8, 1);
    expect(p.count).toBe(1);
    expect(p.x(0)).toBe(9);
    expect(p.y(0)).toBe(8);
    expect(p.age01(0)).toBe(0);
  });

  it('is deterministic for identical call sequences', () => {
    const run = (): number[] => {
      const p = new SmokePool(5);
      const out: number[] = [];
      for (let k = 0; k < 40; k++) {
        if (k % 3 === 0) p.emit(k, -k, 0.4);
        p.update(0.05);
        for (let i = 0; i < p.count; i++) out.push(p.x(i), p.y(i), p.age01(i));
        out.push(p.count);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

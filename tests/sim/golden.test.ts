import { describe, expect, it } from 'vitest';
import { GAS, createRace, run } from './helpers';

describe('golden example (brief section 5)', () => {
  it('straight track, base car, 120 steps', () => {
    const s = createRace(1, 1);
    run(s, 120, () => [GAS]);
    const c = s.cars[0]!;
    // speed = 0.22 * 120 / 120 = 0.22 (+-1e-9)
    expect(Math.abs(c.speed - 0.22)).toBeLessThan(1e-9);
    // z = 0.22 * (120*121/2) / 120^2 * 60 = 0.22 * 7260 / 14400 * 60 = 6.655 (+-1e-6)
    expect(Math.abs(c.z - 6.655)).toBeLessThan(1e-6);
    // exact zeros (abs avoids -0)
    expect(Math.abs(c.x)).toBe(0);
    expect(Math.abs(c.travel)).toBe(0);
    expect(Math.abs(c.heading)).toBe(0);
    expect(c.driftTimer).toBe(0);
    expect(s.tick).toBe(120);
  });
});

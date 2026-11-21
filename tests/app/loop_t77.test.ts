import { describe, expect, it } from 'vitest';
import { copyRaceState } from '../../src/app/loop';
import { createRace } from '../../src/sim/race';

// R85f: relSide and relV are part of the flat car state, so copyRaceState must copy them
// (the render interpolates prev/curr; a stale memory in prev would be a second truth).
describe('copyRaceState with the R85f memory fields (relSide, relV)', () => {
  it('copies relSide and relV of every car; src untouched; dst JSON equals src', () => {
    const src = createRace(5, 2);
    const set = (i: number, side: number, v: number): void => {
      const c = src.cars[i] as unknown as Record<string, number>;
      c.relSide = side;
      c.relV = v;
    };
    set(0, -1, -0.3125); // set directly: this test is about the copy, not the rule
    set(1, 1, 0.0625);
    const before = JSON.stringify(src);
    const dst = createRace(999, 2);
    for (const c of dst.cars) {
      (c as unknown as Record<string, number>).relSide = 7;
      (c as unknown as Record<string, number>).relV = 7;
    }
    copyRaceState(src, dst);
    for (let i = 0; i < 2; i++) {
      const d = dst.cars[i] as unknown as Record<string, number>;
      const s = src.cars[i] as unknown as Record<string, number>;
      expect(d.relSide).toBe(s.relSide);
      expect(d.relV).toBe(s.relV);
    }
    expect(JSON.stringify(dst)).toBe(JSON.stringify(src));
    expect(JSON.stringify(src)).toBe(before);
  });
});

import { describe, expect, it } from 'vitest';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';

describe('structural constants (brief section 3)', () => {
  it('DT is 1/120 s', () => {
    expect(DT).toBe(1 / 120);
  });
  it('SEG_PER_UNIT is 60', () => {
    expect(SEG_PER_UNIT).toBe(60);
  });
});

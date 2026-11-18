import { describe, expect, it } from 'vitest';
import { parseParams } from '../../src/app/debug';

describe('parseParams ticks', () => {
  it('parses ?ticks=120', () => {
    expect(parseParams('?ticks=120').ticks).toBe(120);
  });
  it('absent -> null', () => {
    expect(parseParams('').ticks).toBeNull();
    expect(parseParams('?seed=3').ticks).toBeNull();
  });
  it('negative or garbage -> null', () => {
    expect(parseParams('?ticks=-1').ticks).toBeNull();
    expect(parseParams('?ticks=abc').ticks).toBeNull();
  });
  it('fraction is floored', () => {
    expect(parseParams('?ticks=2.7').ticks).toBe(2);
  });
  it('0 is valid', () => {
    expect(parseParams('?ticks=0').ticks).toBe(0);
  });
  it('frames still works', () => {
    expect(parseParams('?frames=5').frames).toBe(5);
    expect(parseParams('?frames=-2').frames).toBeNull();
    expect(parseParams('').frames).toBeNull();
    expect(parseParams('?frames=5&ticks=7')).toMatchObject({ frames: 5, ticks: 7 });
  });
});

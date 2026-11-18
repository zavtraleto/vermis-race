import { describe, expect, it } from 'vitest';
import { FrameStats } from '../../src/ui/frameStats';
import type { FrameSummary } from '../../src/ui/frameStats';

const blank = (): FrameSummary => ({ p50: -1, p99: -1, max: -1, samples: -1 });

function summary(s: FrameStats): FrameSummary {
  return { ...s.summarize(blank()) };
}

// Deterministic permutation of 1..100: i*37 mod 101 (101 is prime, so it is a bijection).
function shuffled100(): number[] {
  const out: number[] = [];
  for (let i = 1; i <= 100; i++) out.push((i * 37) % 101);
  return out;
}

describe('FS1 window and counts', () => {
  it('samples = min(pushed, capacity)', () => {
    const s = new FrameStats(4);
    expect(s.samples).toBe(0);
    s.push(1);
    s.push(2);
    expect(s.samples).toBe(2);
    for (let i = 0; i < 10; i++) s.push(i);
    expect(s.samples).toBe(4);
  });
  it('capacity 4, 6 pushes: only the last 4 count', () => {
    // window = 3,4,5,6; sorted same; n=4
    // p50 = sorted[ceil(0.5*4)-1] = sorted[1] = 4; p99 = sorted[ceil(3.96)-1] = sorted[3] = 6
    const s = new FrameStats(4);
    for (let v = 1; v <= 6; v++) s.push(v);
    expect(summary(s)).toEqual({ p50: 4, p99: 6, max: 6, samples: 4 });
  });
  it('partial window uses only pushed samples', () => {
    // [5,1,3] sorted 1,3,5; p50 = sorted[ceil(1.5)-1] = sorted[1] = 3; p99 = sorted[2] = 5
    const s = new FrameStats(10);
    s.push(5);
    s.push(1);
    s.push(3);
    expect(summary(s)).toEqual({ p50: 3, p99: 5, max: 5, samples: 3 });
  });
});

describe('FS2 nearest-rank percentiles', () => {
  it('1..100 in shuffled order: p50 = 50, p99 = 99, max = 100', () => {
    // p50 = sorted[ceil(50)-1] = sorted[49] = 50; p99 = sorted[ceil(99)-1] = sorted[98] = 99
    const s = new FrameStats(100);
    for (const v of shuffled100()) s.push(v);
    expect(summary(s)).toEqual({ p50: 50, p99: 99, max: 100, samples: 100 });
  });
  it('n = 10: p99 equals max', () => {
    // p99 = sorted[ceil(9.9)-1] = sorted[9] = max; p50 = sorted[4] = 5
    const s = new FrameStats(10);
    for (const v of [7, 3, 9, 1, 10, 5, 2, 8, 4, 6]) s.push(v);
    expect(summary(s)).toEqual({ p50: 5, p99: 10, max: 10, samples: 10 });
  });
  it('single value', () => {
    const s = new FrameStats(8);
    s.push(16.7);
    expect(summary(s)).toEqual({ p50: 16.7, p99: 16.7, max: 16.7, samples: 1 });
  });
  it('p50 <= p99 <= max always', () => {
    const s = new FrameStats(37);
    for (let i = 0; i < 200; i++) {
      s.push(((i * 7919) % 101) / 3);
      const r = summary(s);
      expect(r.p50).toBeLessThanOrEqual(r.p99);
      expect(r.p99).toBeLessThanOrEqual(r.max);
    }
  });
});

describe('FS3 spikes', () => {
  it('one spike in 100 shows in max but not in p99', () => {
    // 99 x 16.7 + 1 x 100: p99 = sorted[98] = 16.7, max = 100
    const s = new FrameStats(100);
    for (let i = 0; i < 99; i++) s.push(16.7);
    s.push(100);
    expect(summary(s)).toEqual({ p50: 16.7, p99: 16.7, max: 100, samples: 100 });
  });
  it('two spikes in 100 (2% > 1%) show in p99', () => {
    // 98 x 16.7 + 2 x 100: sorted[98] = 100
    const s = new FrameStats(100);
    for (let i = 0; i < 98; i++) s.push(16.7);
    s.push(100);
    s.push(100);
    expect(summary(s)).toEqual({ p50: 16.7, p99: 100, max: 100, samples: 100 });
  });
});

describe('FS4 empty, clear, summarize contract', () => {
  it('empty window gives zeros, overwriting prefilled out', () => {
    const s = new FrameStats(5);
    expect(summary(s)).toEqual({ p50: 0, p99: 0, max: 0, samples: 0 });
  });
  it('clear empties the window and later pushes start fresh', () => {
    const s = new FrameStats(5);
    for (let v = 1; v <= 7; v++) s.push(v * 10);
    s.clear();
    expect(s.samples).toBe(0);
    expect(summary(s)).toEqual({ p50: 0, p99: 0, max: 0, samples: 0 });
    s.push(2);
    s.push(4);
    expect(summary(s)).toEqual({ p50: 2, p99: 4, max: 4, samples: 2 });
  });
  it('summarize returns the very object passed in', () => {
    const s = new FrameStats(3);
    s.push(1);
    const out = blank();
    expect(s.summarize(out)).toBe(out);
    expect(out.max).toBe(1);
  });
  it('summarize twice gives the same result', () => {
    const s = new FrameStats(100);
    for (const v of shuffled100()) s.push(v);
    expect(summary(s)).toEqual(summary(s));
  });
  it('after summarize, a push overwrites the oldest value, not the smallest', () => {
    // capacity 3; pushed 10,1,5 (oldest = 10). Summarize, then push 7 -> window 1,5,7 (max 7).
    // If summarize sorted the window in place, 10 would be kept or 1 dropped.
    const s = new FrameStats(3);
    s.push(10);
    s.push(1);
    s.push(5);
    expect(summary(s).max).toBe(10);
    s.push(7);
    expect(summary(s)).toEqual({ p50: 5, p99: 7, max: 7, samples: 3 });
    // next oldest is 1: push 8 -> window 5,7,8
    s.push(8);
    expect(summary(s)).toEqual({ p50: 7, p99: 8, max: 8, samples: 3 });
  });
});

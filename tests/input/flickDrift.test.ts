import { describe, expect, it } from 'vitest';
import hypotheses from '../../src/data/hypotheses.json';
import { inputConfig } from '../../src/data/input';
import { createFlickDrift } from '../../src/input/flickDrift';
import { resolveDriftEntry } from '../../src/input/scheme';

/**
 * H3 variant E: flick drift (brief section 6, table row H3). Literal config: delta 0.5 within 120 ms.
 * Convention in these tests: right after down(t) the adapter reports the stick's initial steer
 * with sample(0, t) (a fresh touch starts at steer 0). Times in ms.
 */
const cfg = { flickDelta: 0.5, flickWindowMs: 120 };
const mk = () => createFlickDrift(cfg);
const started = (t = 0) => {
  const f = mk();
  f.down(t);
  f.sample(0, t);
  return f;
};

describe('H3 E data and flag', () => {
  it('H3 E is the default drift entry; A, C and D stay selectable', () => {
    expect(hypotheses.H3_driftEntry).toBe('E');
    for (const v of ['A', 'C', 'D']) {
      const w: string[] = [];
      expect(resolveDriftEntry(v, (m) => w.push(m))).toBe(v);
      expect(w).toEqual([]);
    }
  });
  it('H3 E resolveDriftEntry accepts E silently', () => {
    const w: string[] = [];
    expect(resolveDriftEntry('E', (m) => w.push(m))).toBe('E');
    expect(w).toEqual([]);
  });
  it('H3 E input.json: flickDelta 0.5, flickWindowMs 120', () => {
    expect(inputConfig.touch.flickDelta).toBe(0.5);
    expect(inputConfig.touch.flickWindowMs).toBe(120);
  });
});

describe('H3 E flickDrift: activation', () => {
  it('starts inactive; down alone does not activate', () => {
    const f = mk();
    expect(f.active).toBe(false);
    f.down(0);
    expect(f.active).toBe(false);
  });
  it.each([1, -1])('a jump of 0.6 within 50 ms (side %i) activates', (side) => {
    const f = started();
    f.sample(side * 0.3, 25);
    f.sample(side * 0.6, 50);
    expect(f.active).toBe(true);
  });
  it('a change of exactly flickDelta within the window activates (>=): 0 -> 0.5 in 100 ms', () => {
    const f = started();
    f.sample(0.25, 50);
    f.sample(0.5, 100);
    expect(f.active).toBe(true);
  });
  it('a change just under flickDelta (0.45) within the window does not activate', () => {
    const f = started();
    f.sample(0.45, 100);
    expect(f.active).toBe(false);
  });
  it('slow movement of any total size never activates: 0 -> 1 in 1 s at 60 Hz (max 0.12 per 120 ms window)', () => {
    const f = started();
    for (let i = 1; i <= 60; i++) {
      f.sample(i / 60, (i * 1000) / 60);
      expect(f.active).toBe(false);
    }
  });
  it('slow sweep across the whole range both ways (-1 -> 1 over 2 s) never activates', () => {
    const f = mk();
    f.down(0);
    f.sample(-1, 0);
    for (let i = 1; i <= 120; i++) {
      f.sample(-1 + (2 * i) / 120, (i * 2000) / 120);
      expect(f.active).toBe(false);
    }
  });
  it('a change of 0.6 spread over 200 ms (0.36 per 120 ms window) does not activate', () => {
    const f = started();
    for (let i = 1; i <= 10; i++) {
      f.sample((0.6 * i) / 10, i * 20);
      expect(f.active).toBe(false);
    }
  });
  it('the old sample leaves the window: 0 at t = 0, 0.6 at t = 200 with nothing in between -> inactive', () => {
    const f = started();
    f.sample(0.6, 200);
    expect(f.active).toBe(false);
  });
  it('the oldest sample inside the window is the reference: 0.4 at 100 ms then -0.2 at 160 ms (0.6) activates', () => {
    const f = started();
    f.sample(0.4, 100);
    expect(f.active).toBe(false);
    f.sample(-0.2, 160);
    expect(f.active).toBe(true);
  });
  it('jitter +-0.05 at 60 Hz for 5 s never activates', () => {
    const f = started();
    for (let i = 1; i <= 300; i++) {
      f.sample(i % 2 === 0 ? 0.05 : -0.05, (i * 1000) / 60);
      expect(f.active).toBe(false);
    }
  });
  it('samples outside down..up are ignored (before down, after up)', () => {
    const f = mk();
    f.sample(0, 0);
    f.sample(0.9, 20);
    expect(f.active).toBe(false);
    const g = started();
    g.up(10);
    g.sample(0, 20);
    g.sample(0.9, 40);
    expect(g.active).toBe(false);
  });
});

describe('H3 E flickDrift: latching and reset', () => {
  const flicked = () => {
    const f = started();
    f.sample(0.3, 25);
    f.sample(0.6, 50);
    return f;
  };
  it('stays active while down, even with the steer back at 0 for 2 s and slow movement', () => {
    const f = flicked();
    for (let i = 1; i <= 120; i++) {
      f.sample(0, 50 + i * 20);
      expect(f.active).toBe(true);
    }
    f.sample(-0.3, 3000);
    expect(f.active).toBe(true);
  });
  it('up clears active', () => {
    const f = flicked();
    f.up(60);
    expect(f.active).toBe(false);
  });
  it('a new down starts clean: no carry-over of samples from the previous touch', () => {
    const f = flicked();
    f.up(60);
    f.down(70);
    f.sample(0, 70);
    f.sample(0.1, 90); // against the old 0.6 sample (40 ms ago) this would be 0.5, but that touch is gone
    expect(f.active).toBe(false);
  });
  it('after up, a new touch can flick again', () => {
    const f = flicked();
    f.up(60);
    f.down(500);
    f.sample(0, 500);
    f.sample(-0.7, 540);
    expect(f.active).toBe(true);
  });
  it('a touch that did not flick stays inactive after up/down (no leak of the active flag)', () => {
    const f = started();
    f.sample(0.1, 20);
    f.up(30);
    expect(f.active).toBe(false);
    f.down(100);
    expect(f.active).toBe(false);
  });
});

describe('H3 E flickDrift: determinism', () => {
  it('the same sequence on two instances gives the same active flag at every step', () => {
    const a = started();
    const b = started();
    const seq = [0.05, 0.1, 0.5, 0.52, 0.2, 0.0, -0.4, -0.45];
    seq.forEach((v, i) => {
      a.sample(v, 30 + i * 25);
      b.sample(v, 30 + i * 25);
      expect(a.active).toBe(b.active);
    });
  });
  it('a long slow session (10000 samples) keeps working: a flick at the end still activates', () => {
    const f = started();
    let t = 0;
    for (let i = 0; i < 10000; i++) {
      t += 16;
      f.sample(Math.sin(i / 200) * 0.3, t);
    }
    expect(f.active).toBe(false);
    f.sample(0.9, t + 30);
    f.sample(-0.1, t + 40);
    expect(f.active).toBe(true);
  });
});

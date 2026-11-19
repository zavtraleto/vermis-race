import { describe, expect, it } from 'vitest';
import hypotheses from '../../src/data/hypotheses.json';
import { inputConfig } from '../../src/data/input';
import { createRetouchDrift } from '../../src/input/retouchDrift';
import { resolveDriftEntry } from '../../src/input/scheme';

// Literal config (H3 variant D): re-touch within 300 ms, swipe at least 30 px sideways.
const cfg = { retouchWindowMs: 300, retouchSwipePx: 30 };
const mk = () => createRetouchDrift(cfg);

describe('H3 variant D: data and flag', () => {
  it('H3 D is the default drift entry', () => {
    expect(hypotheses.H3_driftEntry).toBe('D');
  });
  it('H3 resolveDriftEntry accepts D silently', () => {
    const warnings: string[] = [];
    expect(resolveDriftEntry('D', (m) => warnings.push(m))).toBe('D');
    expect(warnings).toEqual([]);
  });
  it('H3 input.json carries positive retouchWindowMs and retouchSwipePx', () => {
    const t = inputConfig.touch as unknown as Record<string, number>;
    expect(t.retouchWindowMs).toBeGreaterThan(0);
    expect(t.retouchSwipePx).toBeGreaterThan(0);
  });
});

describe('H3 variant D re-touch drift: arming', () => {
  it('starts inactive', () => {
    expect(mk().active).toBe(false);
  });
  it('the very first touch is never armed: a big swipe just steers', () => {
    const r = mk();
    r.down(100, 0);
    r.move(200, 50);
    r.move(300, 100);
    expect(r.active).toBe(false);
  });
  it.each([1, -1])('side %i: fast re-touch + swipe of >= retouchSwipePx activates', (side) => {
    const r = mk();
    r.down(100, 0);
    r.up(100);
    r.down(100, 200); // 100 ms after up, inside the 300 ms window
    r.move(100 + 29 * side, 220);
    expect(r.active).toBe(false); // 29 px < 30
    r.move(100 + 30 * side, 240);
    expect(r.active).toBe(true); // exactly the swipe threshold
  });
  it('swipe distance is measured from the re-touch point, in either direction', () => {
    const r = mk();
    r.down(0, 0);
    r.up(10);
    r.down(500, 50);
    r.move(520, 60);
    expect(r.active).toBe(false);
    r.move(470, 70);
    expect(r.active).toBe(true);
  });
  it('no move after the armed down: not active (a tap-tap is not a drift)', () => {
    const r = mk();
    r.down(100, 0);
    r.up(50);
    r.down(100, 100);
    expect(r.active).toBe(false);
  });
});

describe('H3 variant D re-touch drift: window', () => {
  it('re-touch exactly retouchWindowMs after up is still armed', () => {
    const r = mk();
    r.down(100, 0);
    r.up(1000);
    r.down(100, 1300);
    r.move(160, 1320);
    expect(r.active).toBe(true);
  });
  it('re-touch one ms after the window is not armed: slow re-touch just steers', () => {
    const r = mk();
    r.down(100, 0);
    r.up(1000);
    r.down(100, 1301);
    r.move(200, 1320);
    r.move(300, 1340);
    expect(r.active).toBe(false);
  });
  it('the window runs from the last up, not from the last down', () => {
    const r = mk();
    r.down(100, 0);
    r.up(5000); // a long first touch
    r.down(100, 5100);
    r.move(150, 5120);
    expect(r.active).toBe(true);
  });
});

describe('H3 variant D re-touch drift: active and up', () => {
  it('active stays true while the finger moves around, including back to centre (R21 ends it, not the input)', () => {
    const r = mk();
    r.down(100, 0);
    r.up(10);
    r.down(100, 50);
    r.move(150, 60);
    expect(r.active).toBe(true);
    r.move(100, 70);
    expect(r.active).toBe(true);
    r.move(60, 80);
    expect(r.active).toBe(true);
  });
  it('up clears active', () => {
    const r = mk();
    r.down(100, 0);
    r.up(10);
    r.down(100, 50);
    r.move(150, 60);
    r.up(100);
    expect(r.active).toBe(false);
  });
  it('up also clears armed: a slow re-touch after it just steers, a quick one after the next up arms again', () => {
    const r = mk();
    r.down(100, 0);
    r.up(10);
    r.down(100, 50); // armed
    r.move(150, 60); // active
    r.up(100);
    r.down(100, 1000); // slow re-touch after the second up: not armed
    r.move(200, 1010);
    expect(r.active).toBe(false);
    r.up(1020);
    r.down(100, 1100); // quick after that up: armed again
    r.move(160, 1110);
    expect(r.active).toBe(true);
  });
  it('an armed touch that never swiped, then released, does not carry armed over', () => {
    const r = mk();
    r.down(100, 0);
    r.up(10);
    r.down(100, 50); // armed, no swipe
    r.up(1000);
    r.down(100, 1500); // 500 ms after the last up: not armed
    r.move(200, 1510);
    expect(r.active).toBe(false);
  });
  it('a move before any down is ignored', () => {
    const r = mk();
    r.move(500, 10);
    expect(r.active).toBe(false);
  });
  it('is deterministic: same event sequence gives the same active flags', () => {
    const run = () => {
      const r = mk();
      const out: boolean[] = [];
      r.down(10, 0);
      out.push(r.active);
      r.up(30);
      r.down(10, 60);
      out.push(r.active);
      r.move(50, 70);
      out.push(r.active);
      r.up(90);
      out.push(r.active);
      return out;
    };
    expect(run()).toEqual(run());
    expect(run()).toEqual([false, false, true, false]);
  });
});

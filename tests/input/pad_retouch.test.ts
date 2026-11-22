import { describe, expect, it } from 'vitest';
import { inputConfig } from '../../src/data/input';
import { createPad } from '../../src/input/pad';
import type { InputFrame } from '../../src/sim/types';

// R202 drift entry by re-touch (input layer): finger lifted and touching again no later than
// retouchWindow (0.3 s) after the lift, and |steer| >= retouchSteer (0.5) within retouchWindow after
// the touch -> driftTap true on exactly one tick. Plain steering without lifting never.
const cfg = inputConfig.pad;
const W = 400;
const H = 800;
const span = cfg.steerSpan * (W / 2); // 140 px = full steer
const TICK = 1000 / 120; // read once per sim tick
const FULL_R = W / 2 + span; // steer 1
const CENTRE = W / 2; // steer 0
const SMALL = W / 2 + 0.3 * span; // u = 0.3 -> steer (0.3 - 0.08)/0.92 = 0.239 < 0.5

type Ev = { t: number; f: (p: ReturnType<typeof createPad>) => void };

/** Reads every tick from 0 to endMs, applying pointer events at their times; returns tap times. */
function run(events: Ev[], endMs: number): number[] {
  const pad = createPad(cfg);
  pad.setArea(W, H);
  const out: InputFrame = { steer: 0, gas: 1, brake: 0, driftTap: false };
  const taps: number[] = [];
  let e = 0;
  const sorted = [...events].sort((a, b) => a.t - b.t);
  for (let t = 0; t <= endMs; t += TICK) {
    while (e < sorted.length && sorted[e]!.t <= t) sorted[e++]!.f(pad);
    pad.read(t, out);
    if (out.driftTap) taps.push(t);
  }
  return taps;
}

const down = (t: number, x: number): Ev => ({ t, f: (p) => p.pointerDown(1, x, H / 2, t) });
const move = (t: number, x: number): Ev => ({ t, f: (p) => p.pointerMove(1, x, H / 2, t) });
const up = (t: number): Ev => ({ t, f: (p) => p.pointerUp(1, t) });

describe('R202 drift entry by re-touch', () => {
  const winMs = cfg.retouchWindow * 1000;

  it('R202: retouchWindow 0.3 s and retouchSteer 0.5 in src/data/input.json', () => {
    expect(cfg.retouchWindow).toBe(0.3);
    expect(cfg.retouchSteer).toBe(0.5);
  });

  it('R202: lift and touch again at full steer within the window -> driftTap on exactly one tick', () => {
    for (const x of [FULL_R, W / 2 - span]) {
      // touch at 100, lift at 500, touch again at 600 (100 ms later) already at full steer
      const taps = run([down(100, CENTRE), up(500), down(600, x)], 1500);
      expect(taps.length, `x ${x}`).toBe(1);
      expect(taps[0]!).toBeGreaterThanOrEqual(600);
      expect(taps[0]!).toBeLessThanOrEqual(600 + winMs);
    }
  });

  it('R202: retouch at the centre, steer to full within the window after the touch -> one driftTap', () => {
    // touch again at 600 at the centre, reach full steer at 750 (150 ms after the touch)
    const taps = run([down(100, CENTRE), up(500), down(600, CENTRE), move(750, FULL_R)], 1500);
    expect(taps.length).toBe(1);
    expect(taps[0]!).toBeGreaterThanOrEqual(750);
    expect(taps[0]!).toBeLessThanOrEqual(600 + winMs);
  });

  it('R202: holding the full steer after the gesture does not repeat driftTap', () => {
    const ev = [down(100, CENTRE), up(500), down(600, FULL_R)];
    for (let t = 610; t < 3000; t += 20) ev.push(move(t, FULL_R + (t % 40 === 0 ? 1 : -1)));
    expect(run(ev, 3000).length).toBe(1);
  });

  it('R202: too-late retouch (lift + 0.3 s + 50 ms) never sets driftTap', () => {
    const taps = run([down(100, CENTRE), up(500), down(500 + winMs + 50, FULL_R)], 2000);
    expect(taps).toEqual([]);
  });

  it('R202: full steer reached too late after the touch (touch + 0.3 s + 50 ms) never', () => {
    const taps = run(
      [down(100, CENTRE), up(500), down(600, CENTRE), move(600 + winMs + 50, FULL_R)],
      2000,
    );
    expect(taps).toEqual([]);
  });

  it('R202: retouch with |steer| < retouchSteer never', () => {
    const taps = run([down(100, CENTRE), up(500), down(600, SMALL)], 2000);
    expect(taps).toEqual([]);
  });

  it('R202: the very first touch (no lift before it) at full steer never', () => {
    expect(run([down(100, FULL_R)], 1500)).toEqual([]);
  });

  it('R202: plain steering without lifting never (sweep left and right for 3 s)', () => {
    const ev = [down(0, CENTRE)];
    for (let t = 8; t < 3000; t += 8) ev.push(move(t, CENTRE + 180 * Math.sin(t / 100)));
    expect(run(ev, 3000)).toEqual([]);
  });

  it('R202: two gestures in a row give two driftTaps', () => {
    const ev = [down(100, CENTRE), up(500), down(600, FULL_R), up(1200), down(1300, W / 2 - span)];
    expect(run(ev, 2500).length).toBe(2);
  });
});

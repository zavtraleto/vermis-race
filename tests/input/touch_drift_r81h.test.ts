import { describe, expect, it } from 'vitest';
import { inputConfig } from '../../src/data/input';
import hypotheses from '../../src/data/hypotheses.json';
import tunables from '../../src/data/tunables.json';
import type { TouchStick } from '../../src/input/touchStick';
import type { TouchStickConfig } from '../../src/input/types';
import { createZoneStick } from '../../src/input/zoneStick';
import type { InputFrame } from '../../src/sim/types';

/**
 * Spec: docs/brief.md R81h (H19_touchDrift, default A), on the R81g zone stick.
 * Steer for all modes: clamp(dx/R, -1, 1), R = stickRadius*width, centre = touch-down point.
 * Numbers (input.json, touch section): stickRadius 0.16, flickMs 200, flickDist 0.6,
 * driftZoneFrac 0.5, driftPull 0.6, steerZoneFrac 0.35. Screen 360 x 640:
 *   R = 0.16*360 = 57.6 px
 *   A: flick threshold = R*flickDist = 57.6*0.6 = 34.56 px, window 200 ms from touch-down
 *   B: pull threshold  = R*driftPull = 34.56 px (R81g)
 *   C: steering zone y >= 640*(1 - 0.35) = 416, height 224; bottom half (driftZoneFrac 0.5):
 *      y >= 416 + 224*0.5 = 528 (inclusive towards drift)
 * Time is passed to pointerDown / pointerMove / pointerUp as the last argument (tMs), as the
 * existing TouchStick interface already does.
 */
type Mode = 'A' | 'B' | 'C';
type Cfg = TouchStickConfig & {
  touchDrift: Mode;
  flickMs: number;
  flickDist: number;
  driftZoneFrac: number;
};
const data = inputConfig.touch as Partial<Cfg> & TouchStickConfig;
const cfgOf = (mode: Mode): Cfg => ({ ...(data as Cfg), touchDrift: mode });

const W = 360;
const H = 640;
const X0 = 180;
const Y0 = 450; // steering zone, upper half (416 <= 450 < 528)
const R = 0.16 * W; // 57.6
const FLICK = R * 0.6; // 34.56
const PULL = R * 0.6; // 34.56
const ZONE_TOP = 416; // 640*(1-0.35)
const DRIFT_TOP = 528; // 416 + 224*0.5
const YC = 580; // C drift half (>= 528), room for moves both ways

const mk = (c: Cfg): TouchStick => {
  const s = createZoneStick(c);
  s.setArea(W, H);
  return s;
};
const read = (s: TouchStick, t: number): InputFrame => {
  const f: InputFrame = { steer: 0, brake: false, drift: false };
  s.read(t, f);
  return f;
};
const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

describe('R81h data (hypotheses.json, input.json touch section, dev panel)', () => {
  it('hypotheses.json H19_touchDrift is "A"', () => {
    expect((hypotheses as Record<string, string>).H19_touchDrift).toBe('A');
  });
  it('input.json: flickMs 200, flickDist 0.6, driftZoneFrac 0.5; driftPull stays 0.6', () => {
    expect(data.flickMs).toBe(200);
    expect(data.flickDist).toBe(0.6);
    expect(data.driftZoneFrac).toBe(0.5);
    expect(data.driftPull).toBe(0.6);
    expect(data.stickRadius).toBe(0.16);
  });
  it('dev panel offers H19 A, B, C (every hypothesis is a runtime flag; R95 "тот же флаг")', () => {
    const flags = (tunables as { flags: Record<string, string[]> }).flags;
    expect(flags['hypotheses.H19_touchDrift']).toEqual(expect.arrayContaining(['A', 'B', 'C']));
  });
});

describe('R81h A: sideways flick within flickMs latches drift', () => {
  it.each([1, -1])('flick of 34.56 + 0.5 px at 100 ms latches until release (side %i)', (sg) => {
    const s = mk(cfgOf('A'));
    expect(s.pointerDown(1, X0, Y0, 0)).toBe(true);
    expect(read(s, 0).drift).toBe(false);
    s.pointerMove(1, X0 + sg * (FLICK + 0.5), Y0, 100);
    for (const t of [100, 300, 1000, 5000]) expect(read(s, t).drift).toBe(true);
    s.pointerUp(1, 6000);
    const f = read(s, 6000);
    expect(f.drift).toBe(false);
    expect(f.steer === 0).toBe(true);
  });
  it('exactly R*flickDist (34.56 px) inside the window latches (>=)', () => {
    const s = mk(cfgOf('A'));
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + FLICK, Y0, 50);
    expect(read(s, 50).drift).toBe(true);
  });
  it('34.56 - 0.5 px inside the window does not latch', () => {
    const s = mk(cfgOf('A'));
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + FLICK - 0.5, Y0, 50);
    s.pointerMove(1, X0 - (FLICK - 0.5), Y0, 150);
    expect(read(s, 150).drift).toBe(false);
  });
  it('flick at 199 ms (inside 200) latches; touch-down at t = 1000 counts its own window', () => {
    const s = mk(cfgOf('A'));
    s.pointerDown(1, X0, Y0, 1000);
    s.pointerMove(1, X0 + FLICK + 1, Y0, 1199);
    expect(read(s, 1199).drift).toBe(true);
  });
  it('the same distance after the window (201 ms) does not latch, and never later in this touch', () => {
    const s = mk(cfgOf('A'));
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + 5, Y0, 100); // small move inside the window
    s.pointerMove(1, X0 + FLICK + 1, Y0, 201);
    expect(read(s, 201).drift).toBe(false);
    // later, larger flicks both ways and pulls down: still ordinary steering
    s.pointerMove(1, X0 - 3 * R, Y0, 300);
    s.pointerMove(1, X0 + 3 * R, Y0 + 3 * PULL, 320);
    s.pointerMove(1, X0, Y0, 340);
    expect(read(s, 340).drift).toBe(false);
  });
  it('returning the finger to the centre and past it keeps the latch', () => {
    const s = mk(cfgOf('A'));
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + FLICK + 2, Y0, 80);
    expect(read(s, 80).drift).toBe(true);
    s.pointerMove(1, X0, Y0, 400);
    expect(read(s, 400).drift).toBe(true);
    s.pointerMove(1, X0 - 0.8 * R, Y0, 600);
    const f = read(s, 600);
    expect(f.drift).toBe(true);
    expect(f.steer).toBeCloseTo(-0.8, 9);
  });
  it('a flick between two reads still latches (any move of this touch inside the window)', () => {
    const s = mk(cfgOf('A'));
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + FLICK + 1, Y0, 60);
    s.pointerMove(1, X0 + 2, Y0, 90);
    expect(read(s, 300).drift).toBe(true);
  });
  it('moving down of any size never latches in A (inside or after the window)', () => {
    const s = mk(cfgOf('A'));
    s.pointerDown(1, X0, Y0, 0);
    for (let k = 1; k <= 5; k++) s.pointerMove(1, X0, Y0 + k * PULL, k * 30); // up to 5 pulls by 150 ms
    expect(read(s, 150).drift).toBe(false);
    s.pointerMove(1, X0, H - 1, 400);
    expect(read(s, 400).drift).toBe(false);
  });
  it('release then a new touch opens a new window', () => {
    const s = mk(cfgOf('A'));
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + FLICK + 1, Y0, 50);
    expect(read(s, 50).drift).toBe(true);
    s.pointerUp(1, 500);
    expect(read(s, 500).drift).toBe(false);
    // new touch at t = 2000: no drift on touch-down, flick at 2150 (150 ms) latches again
    expect(s.pointerDown(2, 100, Y0 + 20, 2000)).toBe(true);
    expect(read(s, 2000).drift).toBe(false);
    s.pointerMove(2, 100 - FLICK - 1, Y0 + 20, 2150);
    expect(read(s, 2150).drift).toBe(true);
  });
  it('a new touch whose window expires does not inherit the previous latch', () => {
    const s = mk(cfgOf('A'));
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + FLICK + 1, Y0, 50);
    s.pointerCancel(1, 100);
    s.pointerDown(2, X0, Y0, 1000);
    s.pointerMove(2, X0 + FLICK + 1, Y0, 1300); // 300 ms after touch-down
    expect(read(s, 1300).drift).toBe(false);
  });
  it.each([-1.5, -1, -0.6, -0.2, 0, 0.3, 0.8, 1, 2])(
    'steer is linear as in R81g: dx = %f R -> clamp(dx/R), any dy, latched or not',
    (k) => {
      for (const t of [50, 400]) {
        for (const dy of [-60, 0, 80]) {
          const s = mk(cfgOf('A'));
          s.pointerDown(1, X0, Y0, 0);
          s.pointerMove(1, X0 + k * R, Y0 + dy, t);
          expect(read(s, t).steer).toBeCloseTo(clamp1(k), 9);
        }
      }
    },
  );
  it('left/right symmetry: steer odd in dx, drift equal', () => {
    for (const k of [0.3, 0.6, 0.61, 1.2]) {
      for (const t of [100, 250]) {
        const a = mk(cfgOf('A'));
        const b = mk(cfgOf('A'));
        a.pointerDown(1, X0, Y0, 0);
        b.pointerDown(1, X0, Y0, 0);
        a.pointerMove(1, X0 + k * R, Y0, t);
        b.pointerMove(1, X0 - k * R, Y0, t);
        const fa = read(a, t);
        const fb = read(b, t);
        expect(fb.steer).toBeCloseTo(-fa.steer, 12);
        expect(fb.drift).toBe(fa.drift);
      }
    }
  });
  it('brake is always false', () => {
    const s = mk(cfgOf('A'));
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + FLICK + 1, Y0, 50);
    expect(read(s, 50).brake).toBe(false);
  });
});

describe('R81h B: pull-down as R81g, unchanged', () => {
  it('dy = 34.56 - 0.5 no drift; dy = 34.56 latches; back up keeps it; sideways alone never', () => {
    const s = mk(cfgOf('B'));
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + 3 * R, Y0, 50); // far sideways inside 200 ms: no flick drift in B
    expect(read(s, 50).drift).toBe(false);
    s.pointerMove(1, X0, Y0 + PULL - 0.5, 100);
    expect(read(s, 100).drift).toBe(false);
    s.pointerMove(1, X0 + 0.4 * R, Y0 + PULL, 400);
    let f = read(s, 400);
    expect(f.drift).toBe(true);
    expect(f.steer).toBeCloseTo(0.4, 9);
    s.pointerMove(1, X0, Y0 - 100, 500);
    expect(read(s, 500).drift).toBe(true);
    s.pointerUp(1, 600);
    f = read(s, 600);
    expect(f.drift).toBe(false);
    expect(f.steer === 0).toBe(true);
  });
  it('B ignores the C drift half: touch-down at y = 580 does not drift by itself', () => {
    const s = mk(cfgOf('B'));
    s.pointerDown(1, X0, YC, 0);
    expect(read(s, 0).drift).toBe(false);
  });
});

describe('R81h C: touch in the bottom driftZoneFrac of the steering zone drifts', () => {
  it('touch-down at y = 580 (>= 528): drift true at once, through any moves, until release', () => {
    const s = mk(cfgOf('C'));
    expect(s.pointerDown(1, X0, YC, 0)).toBe(true);
    expect(read(s, 0).drift).toBe(true);
    s.pointerMove(1, X0 + 0.5 * R, YC - 200, 100); // up into the upper half and above the zone
    expect(read(s, 100).drift).toBe(true);
    s.pointerMove(1, X0 - 2 * R, YC, 3000);
    expect(read(s, 3000).drift).toBe(true);
    s.pointerUp(1, 3100);
    const f = read(s, 3100);
    expect(f.drift).toBe(false);
    expect(f.steer === 0).toBe(true);
  });
  it('boundary: y = 528 drifts (inclusive), y = 527.5 does not', () => {
    const a = mk(cfgOf('C'));
    a.pointerDown(1, X0, DRIFT_TOP, 0);
    expect(read(a, 0).drift).toBe(true);
    const b = mk(cfgOf('C'));
    b.pointerDown(1, X0, DRIFT_TOP - 0.5, 0);
    expect(read(b, 0).drift).toBe(false);
  });
  it('touch-down in the upper half (y = 416 and 450) never drifts: pull down, flick sideways, into the drift half', () => {
    for (const y0 of [ZONE_TOP, Y0]) {
      const s = mk(cfgOf('C'));
      expect(s.pointerDown(1, X0, y0, 0)).toBe(true);
      expect(read(s, 0).drift).toBe(false);
      s.pointerMove(1, X0 + FLICK + 5, y0, 50); // A-style flick
      expect(read(s, 50).drift).toBe(false);
      s.pointerMove(1, X0, y0 + 3 * PULL, 100); // B-style pull, ends inside the drift half
      expect(read(s, 100).drift).toBe(false);
      s.pointerMove(1, X0 - 3 * R, H - 1, 2000);
      expect(read(s, 2000).drift).toBe(false);
    }
  });
  it('touch above the steering zone is still ignored (y = 415)', () => {
    const s = mk(cfgOf('C'));
    expect(s.pointerDown(1, X0, ZONE_TOP - 1, 0)).toBe(false);
    expect(read(s, 0).drift).toBe(false);
  });
  it.each([-1.5, -0.7, -0.2, 0, 0.25, 0.9, 1, 1.8])(
    'steer is the same in both halves: dx = %f R -> clamp(dx/R)',
    (k) => {
      for (const y0 of [Y0, YC]) {
        const s = mk(cfgOf('C'));
        s.pointerDown(1, X0, y0, 0);
        s.pointerMove(1, X0 + k * R, y0 + 30, 50);
        expect(read(s, 50).steer).toBeCloseTo(clamp1(k), 9);
      }
    },
  );
  it('a new touch takes its type from its own touch-down point', () => {
    const s = mk(cfgOf('C'));
    s.pointerDown(1, X0, YC, 0);
    expect(read(s, 0).drift).toBe(true);
    s.pointerUp(1, 100);
    s.pointerDown(2, X0, Y0, 200);
    expect(read(s, 200).drift).toBe(false);
    s.pointerUp(2, 300);
    s.pointerDown(3, X0, YC, 400);
    expect(read(s, 400).drift).toBe(true);
  });
});

describe('R81h mode is read live at each pointerDown', () => {
  it('changing cfg.touchDrift between touches changes the next touch; an active touch keeps its mode', () => {
    const c = cfgOf('A');
    const s = mk(c);
    // A: flick drifts
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + FLICK + 1, Y0, 50);
    expect(read(s, 50).drift).toBe(true);
    s.pointerUp(1, 100);
    // switch to C between touches: bottom touch drifts at once, a flick in the upper half does not
    c.touchDrift = 'C';
    s.pointerDown(2, X0, YC, 200);
    expect(read(s, 200).drift).toBe(true);
    s.pointerUp(2, 300);
    s.pointerDown(3, X0, Y0, 400);
    s.pointerMove(3, X0 + FLICK + 1, Y0, 450);
    expect(read(s, 450).drift).toBe(false);
    s.pointerUp(3, 500);
    // switch to B: pull down drifts, a flick does not
    c.touchDrift = 'B';
    s.pointerDown(4, X0, Y0, 600);
    s.pointerMove(4, X0 + FLICK + 1, Y0, 650);
    expect(read(s, 650).drift).toBe(false);
    s.pointerMove(4, X0, Y0 + PULL + 1, 700);
    expect(read(s, 700).drift).toBe(true);
    s.pointerUp(4, 800);
    // back to A
    c.touchDrift = 'A';
    s.pointerDown(5, X0, Y0, 900);
    s.pointerMove(5, X0, Y0 + PULL + 1, 950);
    expect(read(s, 950).drift).toBe(false);
    s.pointerMove(5, X0 - FLICK - 1, Y0, 1000);
    expect(read(s, 1000).drift).toBe(true);
  });
});

describe('R81h determinism', () => {
  it.each(['A', 'B', 'C'] as const)('mode %s: the same events twice give identical frames', (m) => {
    const run = (): InputFrame[] => {
      const s = mk(cfgOf(m));
      const out: InputFrame[] = [];
      s.pointerDown(1, X0, Y0 + 40, 0);
      for (let t = 1; t <= 60; t++) {
        s.pointerMove(1, X0 + 1.4 * R * Math.sin(t / 3), Y0 + 40 + 50 * Math.sin(t / 11), t * 16);
        out.push(read(s, t * 16));
      }
      s.pointerUp(1, 1000);
      out.push(read(s, 1000));
      return out;
    };
    expect(run()).toEqual(run());
  });
});

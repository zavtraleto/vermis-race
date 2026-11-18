import { describe, expect, it } from 'vitest';
import { inputConfig } from '../../src/data/input';
import { createTouchStick, stickResponse } from '../../src/input/touchStick';
import type { InputFrame } from '../../src/sim/types';

const cfg = inputConfig.touch;
const W = 360;
const H = 640;
const R = 72; // stickRadiusFrac 0.2 * 360
const ZONE_Y = 416; // 640 * (1 - 0.35)
const Y = 500; // inside the zone

const mk = () => {
  const s = createTouchStick(cfg);
  s.setArea(W, H);
  return s;
};
const frame = (): InputFrame => ({ steer: 0, brake: false, drift: false });
const read = (s: ReturnType<typeof mk>, t: number): InputFrame => {
  const f = frame();
  s.read(t, f);
  return f;
};

describe('input config sanity (touch)', () => {
  it('values match the spec', () => {
    expect(cfg.stickRadiusFrac).toBe(0.2);
    expect(cfg.deadZone).toBe(0.05);
    expect(cfg.responseExp).toBe(1.4);
    expect(cfg.releaseMs).toBeGreaterThanOrEqual(80);
    expect(cfg.releaseMs).toBeLessThanOrEqual(120);
    expect(cfg.steerZoneFrac).toBe(0.35);
    expect(cfg.driftPullDownPx).toBe(40);
  });
});

describe('stickResponse', () => {
  it('dead zone: |raw| <= 0.05 -> 0, both signs', () => {
    expect(stickResponse(0, cfg)).toBe(0);
    expect(stickResponse(0.04, cfg)).toBe(0);
    expect(stickResponse(-0.04, cfg)).toBe(0);
    expect(stickResponse(0.05, cfg)).toBe(0);
    expect(stickResponse(-0.05, cfg)).toBe(0);
  });

  // 0.5^1.4 = exp(1.4 * ln 0.5) = exp(-0.970406) ~= 0.378929
  it('control points', () => {
    expect(stickResponse(0.5, cfg)).toBeCloseTo(0.378929, 6);
    expect(stickResponse(0.5, cfg)).toBeCloseTo(0.5 ** 1.4, 12);
    expect(stickResponse(1, cfg)).toBeCloseTo(1, 12);
    expect(stickResponse(1.5, cfg)).toBeCloseTo(1, 12);
    expect(stickResponse(-0.5, cfg)).toBeCloseTo(-(0.5 ** 1.4), 12);
    expect(stickResponse(-1, cfg)).toBeCloseTo(-1, 12);
    expect(stickResponse(-1.5, cfg)).toBeCloseTo(-1, 12);
  });

  it('odd symmetry, bounds, monotonic', () => {
    let prev = -2;
    for (let i = -150; i <= 150; i++) {
      const raw = i / 100;
      const v = stickResponse(raw, cfg);
      expect(v).toBeCloseTo(-stickResponse(-raw, cfg), 12);
      expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-12);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
});

describe('touch: steering from raw offset', () => {
  it.each([
    [0.04, 0],
    [0.5, 0.5 ** 1.4],
    [1, 1],
    [1.5, 1],
    [-0.04, 0],
    [-0.5, -(0.5 ** 1.4)],
    [-1, -1],
    [-1.5, -1],
  ])('raw %f -> steer %f', (raw, expected) => {
    const s = mk();
    expect(s.pointerDown(1, 180, Y, 0)).toBe(true);
    s.pointerMove(1, 180 + raw * R, Y, 10);
    expect(read(s, 10).steer).toBeCloseTo(expected, 9);
  });

  it('just inside the dead zone is 0, just outside is not', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerMove(1, 180 + 0.04 * R, Y, 5);
    expect(read(s, 5).steer).toBe(0);
    s.pointerMove(1, 180 + 0.2 * R, Y, 10);
    expect(read(s, 10).steer).toBeCloseTo(0.2 ** 1.4, 9);
  });

  it('left/right symmetry for a set of offsets', () => {
    for (const dx of [3, 10, 25, 36, 60, 72, 90, 150]) {
      const r = mk();
      const l = mk();
      r.pointerDown(1, 180, Y, 0);
      l.pointerDown(1, 180, Y, 0);
      r.pointerMove(1, 180 + dx, Y, 10);
      l.pointerMove(1, 180 - dx, Y, 10);
      expect(read(l, 10).steer).toBeCloseTo(-read(r, 10).steer, 12);
    }
  });

  it('steer is monotonic in x while moving right, and bounded', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    let prev = -2;
    for (let x = 180; x <= 400; x += 4) {
      s.pointerMove(1, x, Y, 10);
      const v = read(s, 10).steer;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-12);
      prev = v;
    }
  });
});

describe('touch: anchor dragging', () => {
  it('after overshoot, moving back by half a radius gives raw 0.5 at once', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    // Intermediate moves: 180 -> 220 -> 260 -> 302 (overshoots R: raw would be 122/72).
    s.pointerMove(1, 220, Y, 10);
    s.pointerMove(1, 260, Y, 20);
    s.pointerMove(1, 302, Y, 30);
    // Anchor dragged to 302 - 72 = 230.
    expect(read(s, 30).steer).toBeCloseTo(1, 9);
    s.pointerMove(1, 266, Y, 40); // (266 - 230)/72 = 0.5
    expect(read(s, 40).steer).toBeCloseTo(0.5 ** 1.4, 9);
  });

  it('instant reversal without dead travel', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerMove(1, 220, Y, 10);
    s.pointerMove(1, 260, Y, 20);
    s.pointerMove(1, 302, Y, 30);
    s.pointerMove(1, 266, Y, 40);
    s.pointerMove(1, 230 - 36, Y, 50); // (194 - 230)/72 = -0.5
    expect(read(s, 50).steer).toBeCloseTo(-(0.5 ** 1.4), 9);
  });

  it('anchor drags to the left symmetrically', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerMove(1, 140, Y, 10);
    s.pointerMove(1, 100, Y, 20);
    s.pointerMove(1, 58, Y, 30); // anchor -> 58 + 72 = 130
    expect(read(s, 30).steer).toBeCloseTo(-1, 9);
    s.pointerMove(1, 94, Y, 40); // (94 - 130)/72 = -0.5
    expect(read(s, 40).steer).toBeCloseTo(-(0.5 ** 1.4), 9);
    s.pointerMove(1, 166, Y, 50); // (166 - 130)/72 = +0.5
    expect(read(s, 50).steer).toBeCloseTo(0.5 ** 1.4, 9);
  });
});

describe('touch: no smoothing while held', () => {
  it('steer equals stickResponse(raw) at the same read time, over several reads', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerMove(1, 180 + 36, Y, 100);
    const expected = stickResponse(0.5, cfg);
    for (const t of [100, 101, 116, 133, 500]) {
      expect(read(s, t).steer).toBeCloseTo(expected, 12);
    }
    s.pointerMove(1, 180 - 18, Y, 600); // raw -0.25
    expect(read(s, 600).steer).toBeCloseTo(stickResponse(-0.25, cfg), 12);
    expect(read(s, 700).steer).toBeCloseTo(stickResponse(-0.25, cfg), 12);
  });
});

describe('touch: release', () => {
  const RMS = cfg.releaseMs;

  it('from full lock goes linearly to 0 in releaseMs', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerMove(1, 180 + R, Y, 10);
    expect(read(s, 10).steer).toBeCloseTo(1, 9);
    s.pointerUp(1, 1000);
    expect(read(s, 1000 + 20).steer).toBeCloseTo(1 - 20 / RMS, 9);
    expect(read(s, 1000 + 20).steer).toBeGreaterThan(0);
    expect(read(s, 1000 + RMS / 2).steer).toBeCloseTo(0.5, 9);
    expect(read(s, 1000 + RMS).steer).toBeCloseTo(0, 9);
    expect(read(s, 1000 + 500).steer).toBeCloseTo(0, 9);
  });

  it('is monotonically decreasing after release', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerMove(1, 180 + R, Y, 10);
    s.pointerUp(1, 1000);
    let prev = 2;
    for (let dt = 0; dt <= RMS + 20; dt += 5) {
      const v = read(s, 1000 + dt).steer;
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
  });

  it('partial value reaches 0 at value * releaseMs', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerMove(1, 180 + 36, Y, 10);
    const v0 = 0.5 ** 1.4;
    s.pointerUp(1, 1000);
    expect(read(s, 1000 + v0 * RMS * 0.5).steer).toBeCloseTo(v0 * 0.5, 9);
    expect(read(s, 1000 + v0 * RMS).steer).toBeCloseTo(0, 9);
  });

  it('mirror for negative lock', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerMove(1, 180 - R, Y, 10);
    s.pointerUp(1, 1000);
    expect(read(s, 1000 + 20).steer).toBeCloseTo(-(1 - 20 / RMS), 9);
    expect(read(s, 1000 + RMS).steer).toBeCloseTo(0, 9);
  });

  it('activeId reflects the active pointer', () => {
    const s = mk();
    expect(s.activeId).toBeNull();
    s.pointerDown(1, 180, Y, 0);
    expect(s.activeId).toBe(1);
    s.pointerUp(1, 50);
    expect(s.activeId).toBeNull();
  });

  it('pointerCancel behaves like pointerUp', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerMove(1, 180 + R, Y + 50, 20);
    expect(read(s, 20).drift).toBe(true);
    s.pointerCancel(1, 1000);
    expect(s.activeId).toBeNull();
    expect(read(s, 1000).drift).toBe(false);
    expect(read(s, 1000 + 20).steer).toBeCloseTo(1 - 20 / RMS, 9);
    expect(read(s, 1000 + RMS).steer).toBeCloseTo(0, 9);
  });

  it('a new touch after release works normally', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerMove(1, 180 + R, Y, 10);
    s.pointerUp(1, 20);
    expect(s.pointerDown(2, 100, Y, 500)).toBe(true);
    s.pointerMove(2, 100 + 36, Y, 510);
    expect(read(s, 510).steer).toBeCloseTo(0.5 ** 1.4, 9);
  });
});

describe('touch: steering zone', () => {
  it('pointerDown above the zone is rejected and does nothing', () => {
    const s = mk();
    expect(s.pointerDown(1, 180, 400, 0)).toBe(false);
    expect(s.activeId).toBeNull();
    s.pointerMove(1, 250, 400, 10);
    expect(read(s, 10)).toEqual({ steer: 0, brake: false, drift: false });
    s.pointerMove(1, 250, 600, 20);
    expect(read(s, 20)).toEqual({ steer: 0, brake: false, drift: false });
    s.pointerUp(1, 30);
    expect(read(s, 30).steer).toBe(0);
  });

  it('pointerDown inside the zone is accepted', () => {
    const s = mk();
    expect(s.pointerDown(1, 180, 420, 0)).toBe(true);
    expect(s.activeId).toBe(1);
  });

  it('zone boundary y = 640 * 0.65 = 416 is inclusive', () => {
    expect(ZONE_Y).toBe(H * (1 - 0.35));
    expect(mk().pointerDown(1, 180, ZONE_Y, 0)).toBe(true);
    expect(mk().pointerDown(1, 180, ZONE_Y - 0.5, 0)).toBe(false);
  });

  it('a pointer that went down above the zone does not block a later in-zone pointer', () => {
    const s = mk();
    expect(s.pointerDown(1, 180, 100, 0)).toBe(false);
    expect(s.pointerDown(2, 180, 500, 10)).toBe(true);
    expect(s.activeId).toBe(2);
    s.pointerMove(2, 216, 500, 20);
    expect(read(s, 20).steer).toBeCloseTo(0.5 ** 1.4, 9);
  });

  it('geometry follows setArea', () => {
    const s = createTouchStick(cfg);
    s.setArea(200, 400); // zone y >= 260, R = 40
    expect(s.pointerDown(1, 100, 250, 0)).toBe(false);
    expect(s.pointerDown(1, 100, 270, 0)).toBe(true);
    s.pointerMove(1, 120, 270, 10); // raw 0.5
    expect(read(s, 10).steer).toBeCloseTo(0.5 ** 1.4, 9);
  });
});

describe('touch: drift H3 A (pull-down)', () => {
  it('drift = (y - downY >= 40)', () => {
    const s = mk();
    s.pointerDown(1, 180, 500, 0);
    expect(read(s, 0).drift).toBe(false);
    s.pointerMove(1, 180, 539, 10);
    expect(read(s, 10).drift).toBe(false);
    s.pointerMove(1, 180, 540, 20);
    expect(read(s, 20).drift).toBe(true);
    s.pointerMove(1, 180, 530, 30);
    expect(read(s, 30).drift).toBe(false);
    s.pointerMove(1, 180, 545, 40);
    expect(read(s, 40).drift).toBe(true);
    s.pointerUp(1, 50);
    expect(read(s, 50).drift).toBe(false);
  });

  it('does not depend on x', () => {
    const s = mk();
    s.pointerDown(1, 180, 500, 0);
    s.pointerMove(1, 300, 540, 10);
    expect(read(s, 10).drift).toBe(true);
    s.pointerMove(1, 20, 540, 20);
    expect(read(s, 20).drift).toBe(true);
    s.pointerMove(1, 20, 539, 30);
    expect(read(s, 30).drift).toBe(false);
  });

  it('moving up never drifts', () => {
    const s = mk();
    s.pointerDown(1, 180, 500, 0);
    s.pointerMove(1, 180, 430, 10);
    expect(read(s, 10).drift).toBe(false);
  });
});

describe('touch: brake and second finger', () => {
  it('brake is always false', () => {
    const s = mk();
    expect(read(s, 0).brake).toBe(false);
    s.pointerDown(1, 180, 600, 0);
    s.pointerMove(1, 180, 639, 10);
    expect(read(s, 10).brake).toBe(false);
    s.pointerUp(1, 20);
    expect(read(s, 30).brake).toBe(false);
  });

  it('second pointer is ignored while the first is active', () => {
    const s = mk();
    expect(s.pointerDown(1, 180, Y, 0)).toBe(true);
    s.pointerMove(1, 216, Y, 10);
    const before = read(s, 10).steer;
    expect(before).toBeCloseTo(0.5 ** 1.4, 9);
    expect(s.pointerDown(2, 100, Y, 20)).toBe(false);
    expect(s.activeId).toBe(1);
    s.pointerMove(2, 20, 600, 30);
    const f = read(s, 30);
    expect(f.steer).toBeCloseTo(before, 12);
    expect(f.drift).toBe(false);
    s.pointerUp(2, 40);
    expect(s.activeId).toBe(1);
    expect(read(s, 40).steer).toBeCloseTo(before, 12);
  });

  it('pointerCancel of a non-active pointer does not release the active one', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerDown(2, 100, Y, 5);
    s.pointerCancel(2, 10);
    expect(s.activeId).toBe(1);
  });

  it('an ignored pointer stays ignored after the first is released', () => {
    const s = mk();
    s.pointerDown(1, 180, Y, 0);
    s.pointerDown(2, 100, Y, 5);
    s.pointerUp(1, 100);
    s.pointerMove(2, 200, Y, 110);
    expect(s.activeId).toBeNull();
    expect(read(s, 110 + cfg.releaseMs).steer).toBeCloseTo(0, 9);
  });
});

describe('touch: determinism', () => {
  it('same event sequence twice gives identical output', () => {
    const run = () => {
      const s = mk();
      const out: number[] = [];
      s.pointerDown(1, 180, Y, 0);
      s.pointerMove(1, 250, Y + 45, 16);
      out.push(read(s, 16).steer);
      s.pointerUp(1, 40);
      out.push(read(s, 70).steer);
      return out;
    };
    expect(run()).toEqual(run());
  });
});

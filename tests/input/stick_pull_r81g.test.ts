import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { inputConfig } from '../../src/data/input';
import { createAutoDrift } from '../../src/input/autoDrift';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPlayerInput } from '../../src/input/player';
import type { TouchStick } from '../../src/input/touchStick';
import { createZoneStick } from '../../src/input/zoneStick';
import type { InputFrame } from '../../src/sim/types';

/**
 * Spec: docs/brief.md R81g "Касание", "Клавиатура" (T73). Zone stick with the default data:
 * - steer = clamp(dx/R, -1, 1), R = stickRadius*width, centre = touch-down point (dy does not steer);
 * - drift latched from the first move of this touch with dy = y - y0 >= R*driftPull (screen y grows
 *   downward) until release; moving back up keeps it; no sideways border (any |dx| never latches);
 * - release: drift false at once; a new touch = new origin, latch cleared.
 * Numbers (input.json): stickRadius 0.16, driftPull 0.6 (new). Screen 360 x 640:
 *   R = 0.16*360 = 57.6 px; pull threshold = 57.6*0.6 = 34.56 px.
 */
type Cfg = typeof inputConfig.touch & { driftPull?: number; driftEdge: number };
const cfg = inputConfig.touch as Cfg;
const W = 360;
const H = 640;
const X0 = 180;
const Y0 = 450; // inside the steering zone (y >= 640*(1 - 0.35) = 416), 190 px of room below
const R = 0.16 * W; // 57.6
const PULL = R * 0.6; // 34.56

const mk = (c: Cfg = cfg): TouchStick => {
  const s = createZoneStick(c);
  s.setArea(W, H);
  return s;
};
const read = (s: TouchStick, t: number): InputFrame => {
  const f: InputFrame = { steer: 0, brake: false, drift: false };
  s.read(t, f);
  return f;
};

describe('R81g touch data (src/data/input.json)', () => {
  it('driftPull 0.6 (new); stickRadius 0.16 unchanged; driftEdge 0 (no sideways border)', () => {
    expect(cfg.driftPull).toBe(0.6);
    expect(cfg.stickRadius).toBe(0.16);
    expect(cfg.driftEdge).toBe(0);
    expect(cfg.zoneReleaseMs).toBe(0);
  });
});

describe('R81g pull-down drift latch (zone stick, default data)', () => {
  it('threshold: dy = 34.56 - 0.5 px gives no drift; dy = 34.56 + 0.5 px latches', () => {
    const s = mk();
    expect(s.pointerDown(1, X0, Y0, 0)).toBe(true);
    expect(read(s, 0).drift).toBe(false);
    s.pointerMove(1, X0, Y0 + PULL - 0.5, 10);
    expect(read(s, 10).drift).toBe(false);
    s.pointerMove(1, X0, Y0 + PULL + 0.5, 20);
    expect(read(s, 20).drift).toBe(true);
  });
  it('dy exactly R*driftPull latches (>=)', () => {
    const s = mk();
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0, Y0 + PULL, 10);
    expect(read(s, 10).drift).toBe(true);
  });
  it('latched until release: later reads stay true for seconds', () => {
    const s = mk();
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0 + 0.3 * R, Y0 + PULL + 5, 10);
    for (const t of [10, 100, 1000, 5000]) expect(read(s, t).drift).toBe(true);
  });
  it('moving the finger back up (to the origin and above it) keeps the latch', () => {
    const s = mk();
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0, Y0 + PULL + 1, 10);
    expect(read(s, 10).drift).toBe(true);
    s.pointerMove(1, X0, Y0, 20);
    expect(read(s, 20).drift).toBe(true);
    s.pointerMove(1, X0, Y0 - 120, 30);
    expect(read(s, 30).drift).toBe(true);
  });
  it('a pull between two reads still latches (any move of this touch)', () => {
    const s = mk();
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0, Y0 + PULL + 1, 5);
    s.pointerMove(1, X0, Y0 + 2, 8);
    expect(read(s, 10).drift).toBe(true);
  });
  it('moving up never latches (dy < 0 of any size)', () => {
    const s = mk();
    s.pointerDown(1, X0, Y0, 0);
    for (let k = 1; k <= 8; k++) s.pointerMove(1, X0, Y0 - k * 40, k * 10);
    expect(read(s, 100).drift).toBe(false);
  });
  it.each([1, -1])('sideways move alone never latches (side %i, up to 4 R and back)', (sg) => {
    const s = mk();
    s.pointerDown(1, X0, Y0, 0);
    // dx up to 4 R = 230 px stays inside nothing; only the sideways border of R81c would latch here
    for (let k = 1; k <= 40; k++) {
      s.pointerMove(1, X0 + sg * k * 0.1 * R, Y0 + 0.5 * PULL, k * 10); // dy below the threshold
      expect(read(s, k * 10).drift).toBe(false);
    }
    s.pointerMove(1, X0, Y0, 500);
    expect(read(s, 500).drift).toBe(false);
  });
  it('release (up or cancel): drift false and steer 0 at once', () => {
    for (const how of ['up', 'cancel'] as const) {
      const s = mk();
      s.pointerDown(1, X0, Y0, 0);
      s.pointerMove(1, X0 + 0.7 * R, Y0 + PULL + 3, 10);
      expect(read(s, 10).drift).toBe(true);
      if (how === 'up') s.pointerUp(1, 20);
      else s.pointerCancel(1, 20);
      const f = read(s, 20);
      expect(f.drift).toBe(false);
      expect(f.steer === 0).toBe(true);
      expect(s.activeId).toBeNull();
    }
  });
  it('a new touch is a new origin with the latch cleared', () => {
    const s = mk();
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0, Y0 + PULL + 10, 10);
    expect(read(s, 10).drift).toBe(true);
    s.pointerUp(1, 20);
    // new touch lower on the screen: the old origin no longer counts (its dy to the old origin is 60)
    expect(s.pointerDown(2, 100, Y0 + 60, 200)).toBe(true);
    expect(read(s, 200).drift).toBe(false);
    s.pointerMove(2, 100 + 0.5 * R, Y0 + 60 + PULL - 1, 210);
    let f = read(s, 210);
    expect(f.drift).toBe(false);
    expect(f.steer).toBeCloseTo(0.5, 9); // dx from the new origin
    s.pointerMove(2, 100 + 0.5 * R, Y0 + 60 + PULL + 1, 220);
    f = read(s, 220);
    expect(f.drift).toBe(true);
  });
  it('the pull-down gesture repeats: touch high, pull, release, touch high again, pull again', () => {
    const s = mk();
    for (let n = 0; n < 3; n++) {
      const t = n * 1000;
      s.pointerDown(1, X0, Y0, t);
      s.pointerMove(1, X0 + 0.4 * R, Y0, t + 10); // steer first, higher
      expect(read(s, t + 10).drift).toBe(false);
      s.pointerMove(1, X0 + 0.4 * R, Y0 + PULL + 2, t + 20); // pull down
      expect(read(s, t + 20).drift).toBe(true);
      s.pointerUp(1, t + 500);
      expect(read(s, t + 500).drift).toBe(false);
    }
  });
  it('brake is always false', () => {
    const s = mk();
    s.pointerDown(1, X0, Y0, 0);
    s.pointerMove(1, X0, Y0 + PULL + 1, 10);
    expect(read(s, 10).brake).toBe(false);
  });
});

describe('R81g touch steer is unaffected by dy', () => {
  it.each([-1.5, -1, -0.6, -0.2, 0, 0.3, 0.8, 1, 2])(
    'dx = %f R: steer = clamp(dx/R) for dy = -100, 0, 20, 34.56 + 1, 150',
    (k) => {
      for (const dy of [-100, 0, 20, PULL + 1, 150]) {
        const s = mk();
        s.pointerDown(1, X0, Y0, 0);
        s.pointerMove(1, X0 + k * R, Y0 + dy, 10);
        expect(read(s, 10).steer).toBeCloseTo(Math.max(-1, Math.min(1, k)), 9);
      }
    },
  );
  it('left/right symmetry with the drift latched: steer odd in dx, drift the same', () => {
    for (const k of [0.1, 0.45, 0.9, 1.4]) {
      const a = mk();
      const b = mk();
      a.pointerDown(1, X0, Y0, 0);
      b.pointerDown(1, X0, Y0, 0);
      a.pointerMove(1, X0 + k * R, Y0 + PULL + 4, 10);
      b.pointerMove(1, X0 - k * R, Y0 + PULL + 4, 10);
      const fa = read(a, 10);
      const fb = read(b, 10);
      expect(fb.steer).toBeCloseTo(-fa.steer, 12);
      expect(fa.drift).toBe(true);
      expect(fb.drift).toBe(true);
    }
  });
  it('determinism: the same events twice give identical frames', () => {
    const run = (): InputFrame[] => {
      const s = mk();
      const out: InputFrame[] = [];
      s.pointerDown(1, X0, Y0, 0);
      for (let t = 1; t <= 60; t++) {
        s.pointerMove(1, X0 + 1.4 * R * Math.sin(t / 7), Y0 + 50 * Math.sin(t / 11), t * 16);
        out.push(read(s, t * 16));
      }
      s.pointerUp(1, 1000);
      out.push(read(s, 1000));
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('R81g player input (default car: model B, driftEntry from cars/base.json)', () => {
  // R81g "Слой игрока": with model 1 and driftEntry 3 (the default) the touch drift is the stick's
  // pull-down latch, not "finger on the screen".
  const rig = () => {
    const car = { model: 1, driftEntry: baseCar.driftEntry }; // H14 pin [2026-11-22]: model B explicitly (data default is model C, R150)
    const clock = { t: 0 };
    const touch = mk();
    const player = createPlayerInput(
      createKeyboardInput(inputConfig.keyboard, car),
      touch,
      () => clock.t,
      {
        hypotheses: { H3_driftEntry: 'E' },
        autoDrift: createAutoDrift(inputConfig.touch),
        car,
        warn: () => undefined,
      },
    );
    const f: InputFrame = { steer: 0, brake: false, drift: false };
    const at = (t: number): InputFrame => {
      clock.t = t;
      player.read(f);
      return f;
    };
    return { touch, at };
  };
  it('default car is model 1 with driftEntry 3', () => {
    // H14 pin [2026-11-22]: the data default became model C (R150, tests/sim/modelc_data.test.ts);
    // this block is pinned to model 1 in `rig` and `kb`, so only driftEntry is read from the data.
    expect(baseCar.driftEntry).toBe(3);
  });
  it('finger down and steering is not a drift; the pull down is; up keeps it; release ends it', () => {
    const r = rig();
    r.touch.pointerDown(1, X0, Y0, 0);
    let f = r.at(0);
    expect(f.drift).toBe(false);
    r.touch.pointerMove(1, X0 + 0.6 * R, Y0, 10);
    f = r.at(10);
    expect(f.drift).toBe(false);
    expect(f.steer).toBeCloseTo(0.6, 9);
    r.touch.pointerMove(1, X0 + 3 * R, Y0, 20); // far sideways: still no drift
    expect(r.at(20).drift).toBe(false);
    r.touch.pointerMove(1, X0 + 0.6 * R, Y0 + PULL + 1, 30);
    f = r.at(30);
    expect(f.drift).toBe(true);
    expect(f.steer).toBeCloseTo(0.6, 9);
    r.touch.pointerMove(1, X0 - 0.3 * R, Y0 - 20, 40);
    f = r.at(40);
    expect(f.drift).toBe(true);
    expect(f.steer).toBeCloseTo(-0.3, 9);
    r.touch.pointerUp(1, 50);
    f = r.at(50);
    expect(f.drift).toBe(false);
    expect(f.steer === 0).toBe(true);
  });
});

describe('R81g keyboard (default car): drift = Space held, arrows / A-D at full value at once', () => {
  const kb = () =>
    createKeyboardInput(inputConfig.keyboard, {
      model: 1, // H14 pin [2026-11-22]: model B explicitly (data default is model C, R150)
      driftEntry: baseCar.driftEntry,
    });
  const rd = (k: ReturnType<typeof kb>, t: number): InputFrame => {
    const f: InputFrame = { steer: 0, brake: false, drift: false };
    k.read(t, f);
    return f;
  };
  it.each([
    ['ArrowRight', 1],
    ['ArrowLeft', -1],
    ['KeyD', 1],
    ['KeyA', -1],
  ] as const)(
    '%s: steer %i on the first read; Space adds drift without changing steer',
    (key, sg) => {
      const k = kb();
      k.keyDown(key, 0);
      let f = rd(k, 10);
      expect(f.steer).toBe(sg);
      expect(f.drift).toBe(false);
      k.keyDown('Space', 20);
      for (let t = 30; t <= 100; t += 10) {
        f = rd(k, t);
        expect(f.steer).toBe(sg);
        expect(f.drift).toBe(true);
      }
      k.keyUp('Space', 110);
      expect(rd(k, 120).drift).toBe(false);
    },
  );
});

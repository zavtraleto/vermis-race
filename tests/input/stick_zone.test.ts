import { beforeAll, describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { inputConfig } from '../../src/data/input';
import { createAutoDrift } from '../../src/input/autoDrift';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPlayerInput } from '../../src/input/player';
import type { TouchStick } from '../../src/input/touchStick';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { CarParams, InputFrame } from '../../src/sim/types';
import { NO_GRIP_LEAD } from '../sim/pinGripLead';

/**
 * R81c input side (touch and keyboard, driftEntry 3). ASSUMED API (no implementation yet):
 * - `src/input/zoneStick.ts` exports `createZoneStick(cfg)` returning the same `TouchStick` interface
 *   as `createTouchStick` (setArea, pointerDown/Move/Up/Cancel, activeId, read). Its numbers come
 *   from `inputConfig.touch`: `stickRadius` (fraction of the game area width) and `driftEdge`
 *   (multiple of stickRadius); the touch-down rule (steering zone steerZoneFrac) is kept as now.
 * - keyboard and player input get the live car object `{ model, driftEntry }` (model 1, driftEntry 3).
 * Brief: steer = clamp(dx/stickRadius, -1, 1), dx = finger x - touch-down x (the centre stays at the
 * touch point); drift false until |dx| >= stickRadius*driftEdge once, then true until release.
 */
type TouchCfg = typeof inputConfig.touch & { stickRadius: number; driftEdge: number };
// T73 (R81g): the default zone stick has no sideways border (driftEdge 0) and drifts by a pull down
// (driftPull). The R81c sideways path stays in code; these tests pin it: driftEdge 1.35, driftPull 0 (off).
const R81C_PIN = { driftEdge: 1.35, driftPull: 0 };
const cfg = { ...inputConfig.touch, ...R81C_PIN } as TouchCfg;
const W = 360;
const H = 640;
const X0 = 180;
const Y = 560; // inside the steering zone (bottom 35%: y >= 416)
const R = cfg.stickRadius * W; // 0.16*360 = 57.6 px
const EDGE = R * cfg.driftEdge; // 57.6*1.35 = 77.76 px

// Loaded at run time so that the keyboard tests below still run while the module does not exist.
const ZONE_STICK_MODULE = '../../src/input/zoneStick';
let createZoneStick: (c: TouchCfg) => TouchStick = () => {
  throw new Error('not implemented: src/input/zoneStick.ts createZoneStick');
};
beforeAll(async () => {
  try {
    const m = (await import(/* @vite-ignore */ ZONE_STICK_MODULE)) as {
      createZoneStick: (c: TouchCfg) => TouchStick;
    };
    createZoneStick = m.createZoneStick;
  } catch {
    // keep the not-implemented stub
  }
});

const mk = (): TouchStick => {
  const s = createZoneStick(cfg);
  s.setArea(W, H);
  return s;
};
const read = (s: TouchStick, t: number): InputFrame => {
  const f: InputFrame = { steer: 0, brake: false, drift: false };
  s.read(t, f);
  return f;
};

describe('R81c touch config (src/data/input.json)', () => {
  it('stickRadius 0.16 of the screen width; driftEdge 1.35 pinned here (data: 0 since T73, R81g)', () => {
    expect(inputConfig.touch.stickRadius).toBe(0.16);
    expect(cfg.stickRadius).toBe(0.16);
    expect(cfg.driftEdge).toBe(1.35);
    expect(R).toBeCloseTo(57.6, 9);
    expect(EDGE).toBeCloseTo(77.76, 9);
  });
});

describe('R81c touch steer = clamp(dx/stickRadius, -1, 1)', () => {
  it.each([0.03, 0.25, 0.5, 0.9, 1, 1.2])(
    'dx = %f R gives steer = clamp(dx/R), both sides',
    (k) => {
      for (const sg of [1, -1]) {
        const s = mk();
        expect(s.pointerDown(1, X0, Y, 0)).toBe(true);
        s.pointerMove(1, X0 + sg * k * R, Y, 10);
        expect(read(s, 10).steer).toBeCloseTo(sg * Math.min(1, k), 9);
      }
    },
  );
  it('the centre stays at the touch point: out to 1.3 R and back to 0.5 R gives 0.5 (no anchor drag)', () => {
    const s = mk();
    s.pointerDown(1, X0, Y, 0);
    s.pointerMove(1, X0 + 1.3 * R, Y, 10); // 1.3 < 1.35: still no drift
    expect(read(s, 10).steer).toBe(1);
    s.pointerMove(1, X0 + 0.5 * R, Y, 20);
    expect(read(s, 20).steer).toBeCloseTo(0.5, 9);
    expect(read(s, 20).drift).toBe(false);
  });
  it('monotonic and bounded in dx, odd-symmetric', () => {
    let prev = -2;
    for (let dx = -2 * EDGE; dx <= 2 * EDGE; dx += 3) {
      const s = mk();
      s.pointerDown(1, X0, Y, 0);
      s.pointerMove(1, X0 + dx, Y, 10);
      const v = read(s, 10).steer;
      const m = mk();
      m.pointerDown(1, X0, Y, 0);
      m.pointerMove(1, X0 - dx, Y, 10);
      expect(read(m, 10).steer).toBeCloseTo(-v, 12);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
  it('vertical finger travel does not steer and does not drift (no pull-down gesture)', () => {
    const s = mk();
    s.pointerDown(1, X0, Y, 0);
    s.pointerMove(1, X0 + 0.5 * R, Y + 70, 10);
    const f = read(s, 10);
    expect(f.steer).toBeCloseTo(0.5, 9);
    expect(f.drift).toBe(false);
  });
});

describe('R81c touch drift: latched from the first crossing of the edge until release', () => {
  it('false inside the edge, true from the read after crossing, both sides', () => {
    for (const sg of [1, -1]) {
      const s = mk();
      s.pointerDown(1, X0, Y, 0);
      expect(read(s, 0).drift).toBe(false);
      s.pointerMove(1, X0 + sg * (EDGE - 0.5), Y, 10);
      expect(read(s, 10).drift).toBe(false);
      s.pointerMove(1, X0 + sg * (EDGE + 0.5), Y, 20);
      const f = read(s, 20);
      expect(f.drift).toBe(true);
      expect(f.steer).toBe(sg);
    }
  });
  it('stays true after the finger returns inside the zone and to the centre', () => {
    const s = mk();
    s.pointerDown(1, X0, Y, 0);
    s.pointerMove(1, X0 + EDGE + 1, Y, 10);
    expect(read(s, 10).drift).toBe(true);
    s.pointerMove(1, X0 + 0.2 * R, Y, 20);
    let f = read(s, 20);
    expect(f.drift).toBe(true);
    expect(f.steer).toBeCloseTo(0.2, 9);
    s.pointerMove(1, X0 - 0.4 * R, Y, 30); // the other side, inside: still latched
    f = read(s, 30);
    expect(f.drift).toBe(true);
    expect(f.steer).toBeCloseTo(-0.4, 9);
    for (const t of [100, 500, 3000]) expect(read(s, t).drift).toBe(true);
  });
  it('a crossing between two reads still latches ("ни разу не вышел")', () => {
    const s = mk();
    s.pointerDown(1, X0, Y, 0);
    s.pointerMove(1, X0 + EDGE + 1, Y, 5);
    s.pointerMove(1, X0 + 0.3 * R, Y, 8);
    expect(read(s, 10).drift).toBe(true);
  });
  it('release: drift false at once; pointerCancel works the same', () => {
    for (const end of ['up', 'cancel'] as const) {
      const s = mk();
      s.pointerDown(1, X0, Y, 0);
      s.pointerMove(1, X0 + EDGE + 1, Y, 10);
      expect(read(s, 10).drift).toBe(true);
      if (end === 'up') s.pointerUp(1, 20);
      else s.pointerCancel(1, 20);
      expect(read(s, 20).drift).toBe(false);
      expect(s.activeId).toBeNull();
    }
  });
  it('a new touch starts unlatched', () => {
    const s = mk();
    s.pointerDown(1, X0, Y, 0);
    s.pointerMove(1, X0 - EDGE - 1, Y, 10);
    expect(read(s, 10).drift).toBe(true);
    s.pointerUp(1, 20);
    expect(s.pointerDown(2, 100, Y, 200)).toBe(true);
    expect(read(s, 200).drift).toBe(false);
    s.pointerMove(2, 100 + 0.9 * R, Y, 210);
    const f = read(s, 210);
    expect(f.drift).toBe(false);
    expect(f.steer).toBeCloseTo(0.9, 9);
  });
  it('brake is always false', () => {
    const s = mk();
    s.pointerDown(1, X0, Y, 0);
    s.pointerMove(1, X0 + EDGE + 1, Y, 10);
    expect(read(s, 10).brake).toBe(false);
  });
  it('determinism: same events twice give identical frames', () => {
    const run = (): InputFrame[] => {
      const s = mk();
      const out: InputFrame[] = [];
      s.pointerDown(1, X0, Y, 0);
      for (let t = 1; t <= 60; t++) {
        s.pointerMove(1, X0 + 1.6 * EDGE * Math.sin(t / 7), Y, t * 16);
        out.push(read(s, t * 16));
      }
      s.pointerUp(1, 1000);
      out.push(read(s, 1000));
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('R81c release of the zone stick (zoneReleaseMs, T68)', () => {
  type RelCfg = TouchCfg & { zoneReleaseMs: number };
  const mkWith = (over: Partial<RelCfg>): TouchStick => {
    const s = createZoneStick({ ...cfg, ...over } as RelCfg);
    s.setArea(W, H);
    return s;
  };
  it('data: touch.zoneReleaseMs 0; releaseMs of the other schemes stays 100', () => {
    expect((cfg as RelCfg).zoneReleaseMs).toBe(0);
    expect(cfg.releaseMs).toBe(100);
  });
  it.each([1, -1, 0.6, -0.3])(
    'zoneReleaseMs 0: the first read after pointerup gives steer 0 and drift false (steer at release %f)',
    (k) => {
      for (const drifting of [false, true]) {
        const s = mk();
        s.pointerDown(1, X0, Y, 0);
        if (drifting) s.pointerMove(1, X0 + Math.sign(k) * (EDGE + 1), Y, 5);
        s.pointerMove(1, X0 + k * R, Y, 10);
        expect(read(s, 10).steer).toBeCloseTo(k, 9);
        s.pointerUp(1, 20);
        const f = read(s, 20); // same ms as the release
        expect(f.steer === 0).toBe(true); // +0 or -0
        expect(f.drift).toBe(false);
        expect(read(s, 36).steer === 0).toBe(true);
      }
    },
  );
  it('zoneReleaseMs drives the zone stick, not releaseMs: zoneReleaseMs 50, releaseMs 1000 -> full lock is 0.5 after 25 ms, 0 after 50 ms', () => {
    const s = mkWith({ zoneReleaseMs: 50, releaseMs: 1000 });
    s.pointerDown(1, X0, Y, 0);
    s.pointerMove(1, X0 + R, Y, 10);
    s.pointerUp(1, 100);
    expect(read(s, 125).steer).toBeCloseTo(0.5, 9); // 1 - 25/50
    expect(read(s, 150).steer === 0).toBe(true);
  });
  it('pointerCancel releases the same way', () => {
    const s = mk();
    s.pointerDown(1, X0, Y, 0);
    s.pointerMove(1, X0 - R, Y, 10);
    s.pointerCancel(1, 20);
    expect(read(s, 20).steer === 0).toBe(true);
  });
});

describe('R81c player input (touch + keyboard combined, model B, driftEntry 3)', () => {
  const rig = () => {
    const car = { model: 1, driftEntry: 3 };
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
    return { clock, touch, player, f };
  };
  it('finger on the screen inside the zone is not a drift; crossing the edge is', () => {
    const r = rig();
    r.touch.pointerDown(1, X0, Y, 0);
    r.touch.pointerMove(1, X0 + 0.8 * R, Y, 10);
    r.clock.t = 10;
    r.player.read(r.f);
    expect(r.f.drift).toBe(false);
    expect(r.f.steer).toBeCloseTo(0.8, 9);
    r.touch.pointerMove(1, X0 + EDGE + 1, Y, 20);
    r.clock.t = 20;
    r.player.read(r.f);
    expect(r.f.drift).toBe(true);
    r.touch.pointerMove(1, X0 + 0.1 * R, Y, 30);
    r.clock.t = 30;
    r.player.read(r.f);
    expect(r.f.drift).toBe(true);
    r.touch.pointerUp(1, 40);
    r.clock.t = 40;
    r.player.read(r.f);
    expect(r.f.drift).toBe(false);
  });
});

describe('R81c keyboard (driftEntry 3): drift = Space, steer = arrows at full value at once', () => {
  const V3 = { model: 1, driftEntry: 3 };
  const kbd = (car: { model: number; driftEntry: number } = { ...V3 }) =>
    createKeyboardInput(inputConfig.keyboard, car);
  const rd = (kb: ReturnType<typeof kbd>, t: number): InputFrame => {
    const f: InputFrame = { steer: 0, brake: false, drift: false };
    kb.read(t, f);
    return f;
  };
  it.each([
    ['ArrowRight', 1],
    ['ArrowLeft', -1],
  ] as const)('%s held, then Space: no synthesized zero read, steer stays %i', (key, sg) => {
    const kb = kbd();
    kb.keyDown(key, 0);
    rd(kb, 500);
    kb.keyDown('Space', 500);
    for (let t = 510; t <= 600; t += 10) {
      const f = rd(kb, t);
      expect(f.steer).toBe(sg);
      expect(f.drift).toBe(true);
    }
  });
  it('Space held, then an arrow: full value on the first read', () => {
    const kb = kbd();
    kb.keyDown('Space', 0);
    expect(rd(kb, 100).steer).toBe(0);
    kb.keyDown('ArrowLeft', 100);
    expect(rd(kb, 110).steer).toBe(-1);
  });
  it('without Space the arrows are also full at once (no steerRampMs ramp), and 0 at once on release', () => {
    const kb = kbd();
    kb.keyDown('ArrowRight', 0);
    const f = rd(kb, 10); // a ramp would give 10/120 = 0.083
    expect(f.steer).toBe(1);
    expect(f.drift).toBe(false);
    kb.keyUp('ArrowRight', 20);
    expect(rd(kb, 30).steer).toBe(0);
  });
  it('both arrows: steer 0', () => {
    const kb = kbd();
    kb.keyDown('Space', 0);
    kb.keyDown('ArrowLeft', 0);
    kb.keyDown('ArrowRight', 0);
    expect(rd(kb, 10).steer).toBe(0);
  });
  it('drift follows Space exactly: pressed true, released false', () => {
    const kb = kbd();
    expect(rd(kb, 0).drift).toBe(false);
    kb.keyDown('Space', 10);
    expect(rd(kb, 20).drift).toBe(true);
    kb.keyUp('Space', 30);
    expect(rd(kb, 40).drift).toBe(false);
  });
  it('driftEntry is read live: 3 -> 0 brings back the R81 zero read', () => {
    const car = { ...V3 };
    const kb = kbd(car);
    car.driftEntry = 0;
    kb.keyDown('ArrowRight', 0);
    rd(kb, 500);
    kb.keyDown('Space', 500);
    expect(rd(kb, 510).steer).toBe(0);
    expect(rd(kb, 520).steer).toBe(1);
  });
  it('determinism: same events twice give identical frames', () => {
    const run = (): number[] => {
      const kb = kbd();
      const out: number[] = [];
      kb.keyDown('ArrowLeft', 0);
      for (let t = 10; t <= 400; t += 10) {
        if (t === 200) kb.keyDown('Space', t);
        if (t === 300) kb.keyUp('ArrowLeft', t);
        out.push(rd(kb, t).steer);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('R81c keyboard end to end with the sim (model B, driftEntry 3, real base car)', () => {
  // Real base numbers, lamps off; 0.9 vmax > driftEnterSpeed. DT = 1/120 s.
  const params: CarParams = {
    ...baseCar,
    model: 1,
    driftEntry: 3,
    crashMinSpeed: 1e9,
    ...NO_GRIP_LEAD,
  }; // R85b off: about R81c
  it('arrow held, Space pressed: DRIFT on the first tick after the press; Space released: GRIP', () => {
    const car = { model: 1, driftEntry: 3 };
    const kb = createKeyboardInput(inputConfig.keyboard, car);
    const s = createRace(1, 1);
    const c = s.cars[0]!;
    c.speed = 0.9 * params.vmax;
    const track = makeStraightTrack(4000);
    const f: InputFrame = { steer: 0, brake: false, drift: false };
    const tick = (): void => {
      kb.read(s.tick * DT * 1000, f);
      step(s, [f], track, [params]);
    };
    kb.keyDown('ArrowRight', 0);
    for (let i = 0; i < 60; i++) tick();
    expect(c.state).toBe('GRIP');
    kb.keyDown('Space', s.tick * DT * 1000);
    tick();
    expect(c.state).toBe('DRIFT');
    expect(c.dir).toBe(1);
    for (let i = 0; i < 60; i++) tick();
    kb.keyUp('Space', s.tick * DT * 1000);
    tick();
    expect(c.state).toBe('GRIP');
  });
});

// R151 / R155 / R161 input side of model C (docs/brief.md; written before the implementation).
// API assumed here (stubs in src): createZoneStick(cfg, car?) where `car` is read live,
// { model, state? }: model 2 (C) adds the vertical axis `throttle` and drops the drift latches; in
// state DRIFT the steer travel is driftSteerMul*R [решение директора 2026-11-22]. Keyboard: the car
// view { model: 2 } of createKeyboardInput. Numbers: the brief start numbers, spread from a variable
// (input.json has its own data test, tests/sim/modelc_data.test.ts).
// Screen 360 x 640: R = stickRadius*width = 0.16*360 = 57.6 px; dead = 0.5*R = 28.8 px; full =
// 1.3*R = 74.88 px; throttle = -+min(1, (|dy| - dead)/(full - dead))^1.4 (dy > 0 = down = lift).
import { describe, expect, it } from 'vitest';
import { inputConfig } from '../../src/data/input';
import { createAutoDrift } from '../../src/input/autoDrift';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPlayerInput } from '../../src/input/player';
import { createZoneStick } from '../../src/input/zoneStick';
import type { TouchStickConfig } from '../../src/input/types';
import { DT } from '../../src/sim/constants';
import type { InputFrame } from '../../src/sim/types';
import { PC, Sim, figTrack } from '../sim/modelc_helpers';

const C_TOUCH = {
  thrDead: 0.5,
  thrFull: 1.3,
  thrExp: 1.4,
  edgeMargin: 8,
  thrTauMs: 25,
  driftSteerMul: 1.5,
};
const cfg: TouchStickConfig = { ...inputConfig.touch, stickRadius: 0.16, ...C_TOUCH };
const W = 360;
const H = 640;
const X0 = 180;
const R = 0.16 * W; // 57.6
const DEAD = 0.5 * R; // 28.8
const FULL = 1.3 * R; // 74.88
const LIFT_ON = 0.4; // R154 liftOn

/** R151 mapping by hand (gap = px from the touch-down point to the bottom edge). */
function thrOf(dy: number, gap: number): number {
  let full = FULL;
  let dead = DEAD;
  if (dy > 0) {
    const room = Math.max(4, gap - 8);
    if (room < full) {
      dead *= room / full;
      full = room;
    }
  }
  const a = Math.abs(dy);
  if (a <= dead) return 0;
  const t = Math.pow(Math.min(1, (a - dead) / (full - dead)), 1.4);
  return dy > 0 ? -t : t;
}
/** dy at which the lift threshold -0.4 is reached: dead + (full - dead)*0.4^(1/1.4). */
function liftPull(gap: number): number {
  let full = FULL;
  let dead = DEAD;
  const room = Math.max(4, gap - 8);
  if (room < full) {
    dead *= room / full;
    full = room;
  }
  return dead + (full - dead) * Math.pow(LIFT_ON, 1 / 1.4);
}

type CarView = { model: number; state: 'GRIP' | 'DRIFT' };
function rig(gap = 160, view: CarView = { model: 2, state: 'GRIP' }, c: TouchStickConfig = cfg) {
  const st = createZoneStick(c, view);
  st.setArea(W, H);
  const y0 = H - gap;
  const f: InputFrame = { steer: 0, brake: false, drift: false };
  const down = (t = 0): void => void st.pointerDown(1, X0, y0, t);
  const move = (dx: number, dy: number, t: number): void => st.pointerMove(1, X0 + dx, y0 + dy, t);
  const read = (t: number): InputFrame => {
    st.read(t, f);
    return f;
  };
  return { st, view, y0, down, move, read };
}
/** Settled value: move at t, read 1000 ms later (smoothing 25 ms: e^-40 left). */
function settled(dx: number, dy: number, gap = 160, view?: CarView): InputFrame {
  const r = rig(gap, view);
  r.down(0);
  r.read(0);
  r.move(dx, dy, 10);
  return r.read(1010);
}

describe('R151 vertical axis of the zone stick (model C)', () => {
  it('hand numbers: dy -50 (up) -> +((50 - 28.8)/46.08)^1.4 = +0.33725', () => {
    expect(thrOf(-50, 160)).toBeCloseTo(0.33725, 4);
  });
  it('dead zone: |dy| <= 28.8 px gives throttle 0, up and down', () => {
    for (const dy of [-28.8, -20, -5, 0, 5, 20, 28.8]) expect(settled(0, dy).throttle).toBe(0);
  });
  it('curve after the dead zone: throttle = -+t^1.4, up +, down -; full travel and beyond = +-1', () => {
    for (const dy of [-120, -74.88, -60, -50, -35, 35, 50, 60, 74.88, 120])
      expect(settled(0, dy).throttle!).toBeCloseTo(thrOf(dy, 160), 6);
    expect(settled(0, 100).throttle!).toBeCloseTo(-1, 9);
    expect(settled(0, -100).throttle!).toBeCloseTo(1, 9);
  });
  it('monotone in dy: lower finger -> lower throttle', () => {
    let prev = Infinity;
    for (let dy = -90; dy <= 90; dy += 3) {
      const v = settled(0, dy).throttle!;
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });
  it('dx does not change the throttle, dy does not change the steer', () => {
    const a = settled(30, -50);
    expect(a.steer).toBeCloseTo(30 / R, 9); // 0.5208
    expect(a.throttle!).toBeCloseTo(thrOf(-50, 160), 6);
    const b = settled(-30, 0);
    expect(b.steer).toBeCloseTo(-30 / R, 9);
    expect(b.throttle).toBe(0);
  });
  it('lift threshold (-0.4): 53 px with >= 83 px to the bottom, 37 px with 60 px, 15.5 px with 30 px', () => {
    // Hand: 83 px: room 75 >= 74.88, pull = 28.8 + 46.08*0.4^(1/1.4) = 28.8 + 46.08*0.51969 = 52.75;
    // 60 px: room 52, dead 28.8*52/74.88 = 20.0, pull = 20.0 + 32*0.51969 = 36.63;
    // 30 px: room 22, dead 8.4615, pull = 8.4615 + 13.538*0.51969 = 15.50.
    expect(liftPull(83)).toBeCloseTo(52.75, 1);
    expect(liftPull(60)).toBeCloseTo(36.63, 1);
    expect(liftPull(30)).toBeCloseTo(15.5, 1);
    for (const gap of [83, 160, 60, 30]) {
      const p = liftPull(gap);
      expect(settled(0, p - 0.5, gap).throttle!).toBeGreaterThan(-LIFT_ON);
      expect(settled(0, p + 0.5, gap).throttle!).toBeLessThanOrEqual(-LIFT_ON);
    }
  });
  it('near the bottom the travel down shrinks to room = gap - 8 (>= 4 px): the bottom edge gives -1', () => {
    expect(settled(0, 52, 60).throttle!).toBeCloseTo(-1, 9); // room 52
    expect(settled(0, 22, 30).throttle!).toBeCloseTo(-1, 9); // room 22
    expect(settled(0, 4, 10).throttle!).toBeCloseTo(-1, 9); // room max(4, 2) = 4
    // up is not shortened
    expect(settled(0, -50, 30).throttle!).toBeCloseTo(thrOf(-50, 160), 6);
  });
  it('smoothing thrTauMs 25: a jump to full up reads 1 - e^-1 = 0.632 after 25 ms (+-0.02)', () => {
    const r = rig();
    r.down(0);
    r.read(0);
    r.move(0, -100, 0);
    expect(r.read(25).throttle!).toBeGreaterThan(0.632 - 0.02);
    expect(r.read(25).throttle!).toBeLessThan(0.632 + 0.02);
  });
  it('release: steer 0 and throttle 0 on the first read', () => {
    const r = rig();
    r.down(0);
    r.read(0);
    r.move(40, 70, 10);
    r.read(500);
    r.st.pointerUp(1, 510);
    const f = r.read(510);
    expect(f.steer).toBe(0);
    expect(f.throttle).toBe(0);
  });
  it('no drift latches and no brake in model C: pull down 60 px, touchDrift A flick, C bottom zone -> drift false', () => {
    expect(settled(0, 60).drift).toBe(false);
    expect(settled(0, 60).brake).toBe(false);
    for (const touchDrift of ['A', 'B', 'C'] as const) {
      const st = createZoneStick({ ...cfg, touchDrift }, { model: 2, state: 'GRIP' });
      st.setArea(W, H);
      st.pointerDown(1, X0, H - 10, 0); // bottom of the zone (H19 C)
      st.pointerMove(1, X0 + 1.2 * R, H - 10 + 50, 20); // fast flick (H19 A) and pull (R81g)
      const f: InputFrame = { steer: 0, brake: false, drift: false };
      st.read(30, f);
      expect(f.drift).toBe(false);
    }
  });
  it('model 1 (B) keeps no throttle: a vertical move gives throttle 0 / absent', () => {
    const f = settled(0, -60, 160, { model: 1, state: 'GRIP' });
    expect(f.throttle ?? 0).toBe(0);
  });
});

describe('R155 drift steer travel x driftSteerMul 1.5 [решение директора 2026-11-22]', () => {
  // In DRIFT of model C: steer = clamp(dx/(R*1.5), -1, 1): the hold share uHold 0.5 is at 43.2 px.
  it('in DRIFT: dx 43.2 -> 0.5, dx -43.2 -> -0.5, dx 86.4 -> 1, dx 120 -> 1', () => {
    const v: CarView = { model: 2, state: 'DRIFT' };
    expect(settled(43.2, 0, 160, v).steer).toBeCloseTo(0.5, 9);
    expect(settled(-43.2, 0, 160, v).steer).toBeCloseTo(-0.5, 9);
    expect(settled(86.4, 0, 160, v).steer).toBeCloseTo(1, 9);
    expect(settled(120, 0, 160, v).steer).toBe(1);
  });
  it('in GRIP the travel is R: dx 43.2 -> 0.75, dx 57.6 -> 1', () => {
    expect(settled(43.2, 0).steer).toBeCloseTo(0.75, 9);
    expect(settled(57.6, 0).steer).toBeCloseTo(1, 9);
  });
  it('the state is read live: the same finger reads 0.75 in GRIP and 0.5 once the car is in DRIFT', () => {
    const r = rig();
    r.down(0);
    r.move(43.2, 0, 10);
    expect(r.read(20).steer).toBeCloseTo(0.75, 9);
    r.view.state = 'DRIFT';
    expect(r.read(30).steer).toBeCloseTo(0.5, 9);
    r.view.state = 'GRIP';
    expect(r.read(40).steer).toBeCloseTo(0.75, 9);
  });
  it('model 1 in DRIFT keeps dx/R (the multiplier is model C only)', () => {
    expect(settled(43.2, 0, 160, { model: 1, state: 'DRIFT' }).steer).toBeCloseTo(0.75, 9);
  });
  it('the error band of the average bot (+-30% of uHold = +-0.15 steer) is +-12.96 px in DRIFT (was +-8.64)', () => {
    expect(0.15 * R * 1.5).toBeCloseTo(12.96, 9);
    const v: CarView = { model: 2, state: 'DRIFT' };
    expect(settled(43.2 + 12.96, 0, 160, v).steer).toBeCloseTo(0.65, 9);
  });
});

describe('R151 keyboard of model C: up/down = throttle +-1, steer at full value at once', () => {
  const kb = () => createKeyboardInput(inputConfig.keyboard, { model: 2, driftEntry: 3 });
  const rd = (k: ReturnType<typeof kb>, t: number): InputFrame => {
    const f: InputFrame = { steer: 0, brake: false, drift: false };
    k.read(t, f);
    return f;
  };
  for (const [code, v] of [
    ['ArrowUp', 1],
    ['KeyW', 1],
    ['ArrowDown', -1],
    ['KeyS', -1],
  ] as const) {
    it(`${code}: throttle ${v} on the first read, 0 after keyUp, no brake`, () => {
      const k = kb();
      expect(k.keyDown(code, 0)).toBe(true);
      const f = rd(k, 1);
      expect(f.throttle).toBe(v);
      expect(f.brake).toBe(false);
      k.keyUp(code, 2);
      expect(rd(k, 3).throttle).toBe(0);
    });
  }
  it('up and down together, or none: throttle 0', () => {
    const k = kb();
    expect(rd(k, 0).throttle).toBe(0);
    k.keyDown('ArrowUp', 1);
    k.keyDown('KeyS', 1);
    expect(rd(k, 2).throttle).toBe(0);
  });
  it('arrows / A-D: steer +-1 on the first read (no ramp), independent of the throttle keys', () => {
    for (const [code, v] of [
      ['ArrowRight', 1],
      ['KeyD', 1],
      ['ArrowLeft', -1],
      ['KeyA', -1],
    ] as const) {
      const k = kb();
      k.keyDown('ArrowDown', 0);
      k.keyDown(code, 0);
      const f = rd(k, 1);
      expect(f.steer).toBe(v);
      expect(f.throttle).toBe(-1);
    }
  });
});

describe('R151 player input of model C passes the throttle', () => {
  const mk = () => {
    const car = { model: 2, driftEntry: 3 };
    const clock = { t: 0 };
    const kb = createKeyboardInput(inputConfig.keyboard, car);
    const touch = createZoneStick(cfg, { model: 2, state: 'GRIP' });
    touch.setArea(W, H);
    const player = createPlayerInput(kb, touch, () => clock.t, {
      hypotheses: { H3_driftEntry: 'E' },
      autoDrift: createAutoDrift(inputConfig.touch),
      car,
      warn: () => undefined,
    });
    const f: InputFrame = { steer: 0, brake: false, drift: false };
    const at = (t: number): InputFrame => {
      clock.t = t;
      player.read(f);
      return f;
    };
    return { kb, touch, at };
  };
  it('touch only: the stick throttle arrives; keyboard only: the key throttle arrives', () => {
    const a = mk();
    a.touch.pointerDown(1, X0, H - 160, 0);
    a.touch.pointerMove(1, X0, H - 160 - 100, 0);
    expect(a.at(1000).throttle!).toBeCloseTo(1, 6);
    const b = mk();
    b.kb.keyDown('ArrowDown', 0);
    expect(b.at(10).throttle).toBe(-1);
  });
});

describe('R161 touch response: vertical wander does not open windows; latency of the pull', () => {
  // Spike partJitter: dy = amp*sin(2*pi*hz*t + 0.7), moved and read every tick (DT) for 20 s; a window
  // opens only at throttle <= -liftOn (R154). Raw peak at +-30 px with 50 px to the bottom: room 42,
  // dead 16.15, (13.85/25.85)^1.4 = 0.417 > 0.4 - the 25 ms smoothing keeps the read above -0.4.
  const wander = (amp: number, hz: number, gap: number): number => {
    const r = rig(gap);
    r.down(0);
    let min = 0;
    for (let i = 0; i < Math.round(20 / DT); i++) {
      const t = i * DT;
      r.move(20, amp * Math.sin(2 * Math.PI * hz * t + 0.7), t * 1000);
      min = Math.min(min, r.read(t * 1000).throttle!);
    }
    return min;
  };
  for (const gap of [50, 110])
    for (const amp of [25, 30])
      for (const hz of [2, 5])
        it(`+-${amp} px at ${hz} Hz, ${gap} px to the bottom: throttle stays above -0.4`, () => {
          expect(wander(amp, hz, gap)).toBeGreaterThan(-LIFT_ON);
        });
  for (const hz of [2, 5])
    it(`+-40 px at ${hz} Hz, 110 px to the bottom: throttle stays above -0.4`, () => {
      expect(wander(40, hz, 110)).toBeGreaterThan(-LIFT_ON);
    });
  for (const vPx of [600, 1200])
    it(`full steer, finger pulled down at ${vPx} px/s (110 px to the bottom): dead zone exit -> DRIFT <= 100 ms`, () => {
      const r = rig(110);
      const s = new Sim(figTrack(0, 4000, 0), PC, 1, 0, 60);
      r.down(0);
      let tDead = NaN;
      let tLatch = NaN;
      for (let i = 0; i < Math.round(0.6 / DT); i++) {
        const t = i * DT;
        const dy = Math.min(80, vPx * t);
        if (dy > DEAD && Number.isNaN(tDead)) tDead = t;
        r.move(R, dy, t * 1000);
        r.view.state = s.car.state;
        const f = r.read(t * 1000);
        s.tick(f.steer, f.throttle ?? 0);
        if (s.drift && Number.isNaN(tLatch)) tLatch = t + DT;
      }
      expect(tLatch - tDead).toBeLessThanOrEqual(0.1);
    });
});

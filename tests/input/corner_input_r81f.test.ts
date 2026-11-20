import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { inputConfig } from '../../src/data/input';
import { createAutoDrift } from '../../src/input/autoDrift';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPlayerInput } from '../../src/input/player';
import type { TouchStick } from '../../src/input/touchStick';
import { createZoneStick } from '../../src/input/zoneStick';
import { DT } from '../../src/sim/constants';
import { createRace } from '../../src/sim/race';
import type { CarParams, InputFrame, Track } from '../../src/sim/types';
import { T71, stepV } from '../sim/corner_helpers';

/**
 * R81f "Ввод" (driftEntry 5, H16 = F): input.drift means "drift allowed".
 * - touch: finger on the screen (mouse button held); the zone stick without the drift border, as in
 *   R81e "Ввод": steer = clamp(dx/stickRadius, -1, 1), centre = touch point, zoneReleaseMs 0, no latch.
 * - keyboard: Space (or Shift) held; steer = arrows at full value at once (no steerRampMs ramp), and no
 *   R81 "Клавиатура" zero-read substitution. Arrows without Space: drift false.
 * ASSUMED API (as in the R81c / R81e input tests): keyboard and player input read the live car
 * `{ model, driftEntry }`.
 */
const V5C = { model: 1, driftEntry: 5 };
const W = 360;
const H = 640;
const X0 = 180;
const Y = 560;
const R = inputConfig.touch.stickRadius * W;
const EDGE = R * inputConfig.touch.driftEdge;
const frame = (): InputFrame => ({ steer: 0, brake: false, drift: false });

describe('R81f keyboard (driftEntry 5): drift = Space or Shift held, steer = arrows at full value at once', () => {
  const kbd = () => createKeyboardInput(inputConfig.keyboard, { ...V5C });
  const rd = (kb: ReturnType<typeof kbd>, t: number): InputFrame => {
    const f = frame();
    kb.read(t, f);
    return f;
  };
  it.each(['Space', 'ShiftLeft', 'ShiftRight'])('%s alone: drift true, steer 0', (key) => {
    const kb = kbd();
    kb.keyDown(key, 0);
    const f = rd(kb, 10);
    expect(f.drift).toBe(true);
    expect(f.steer).toBe(0);
    kb.keyUp(key, 20);
    expect(rd(kb, 30).drift).toBe(false);
  });
  it.each([
    ['ArrowRight', 1],
    ['ArrowLeft', -1],
    ['KeyD', 1],
    ['KeyA', -1],
  ] as const)('%s alone: steer %i on the first read (no ramp), drift false', (key, sg) => {
    const kb = kbd();
    kb.keyDown(key, 0);
    const f = rd(kb, 10); // a 120 ms ramp would give 10/120 = 0.083
    expect(f.steer).toBe(sg);
    expect(f.drift).toBe(false);
  });
  it('arrow held, then Space: no zero read, steer stays 1 and drift turns true on the next read', () => {
    const kb = kbd();
    kb.keyDown('ArrowRight', 0);
    expect(rd(kb, 100).steer).toBe(1);
    kb.keyDown('Space', 100);
    for (let t = 110; t <= 200; t += 10) {
      const f = rd(kb, t);
      expect(f.steer).toBe(1);
      expect(f.drift).toBe(true);
    }
    kb.keyUp('Space', 200);
    const g = rd(kb, 210);
    expect(g.steer).toBe(1);
    expect(g.drift).toBe(false);
  });
  it('Space held, then an arrow: full steer at once, drift stays true', () => {
    const kb = kbd();
    kb.keyDown('Space', 0);
    rd(kb, 50);
    kb.keyDown('ArrowLeft', 50);
    const f = rd(kb, 60);
    expect(f.steer).toBe(-1);
    expect(f.drift).toBe(true);
  });
  it('determinism: same events twice give identical frames', () => {
    const run = (): InputFrame[] => {
      const kb = kbd();
      const out: InputFrame[] = [];
      kb.keyDown('ArrowLeft', 0);
      for (let t = 10; t <= 400; t += 10) {
        if (t === 150) kb.keyDown('Space', t);
        if (t === 200) kb.keyDown('ArrowRight', t);
        if (t === 300) kb.keyUp('ArrowLeft', t);
        if (t === 350) kb.keyUp('Space', t);
        out.push(rd(kb, t));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('R81f touch through the player input (model B, driftEntry 5): drift = finger on the screen', () => {
  const rig = () => {
    const car = { ...V5C };
    const clock = { t: 0 };
    const touch: TouchStick = createZoneStick(inputConfig.touch);
    touch.setArea(W, H);
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
    const f = frame();
    const at = (t: number): InputFrame => {
      clock.t = t;
      player.read(f);
      return f;
    };
    return { touch, at };
  };
  for (const sg of [1, -1]) {
    it(`side ${sg}: held from touch-down; linear steer inside the zone; steer 1 past the old border; still held back inside`, () => {
      const r = rig();
      r.touch.pointerDown(1, X0, Y, 0);
      let f = r.at(0);
      expect(f.drift).toBe(true);
      expect(f.steer).toBe(0);
      r.touch.pointerMove(1, X0 + sg * 0.5 * R, Y, 10);
      f = r.at(10);
      expect(f.drift).toBe(true);
      expect(f.steer).toBeCloseTo(sg * 0.5, 9);
      r.touch.pointerMove(1, X0 + sg * (EDGE + 30), Y, 20);
      f = r.at(20);
      expect(f.steer).toBe(sg);
      expect(f.drift).toBe(true);
      r.touch.pointerMove(1, X0 + sg * 0.1 * R, Y, 30);
      f = r.at(30);
      expect(f.steer).toBeCloseTo(sg * 0.1, 9);
      expect(f.drift).toBe(true);
    });
  }
  it('release (up or cancel): steer 0 and drift false on the first read; a new touch is held again at once', () => {
    for (const how of ['up', 'cancel'] as const) {
      const r = rig();
      r.touch.pointerDown(1, X0, Y, 0);
      r.touch.pointerMove(1, X0 + 2 * R, Y, 10);
      expect(r.at(10).drift).toBe(true);
      if (how === 'up') r.touch.pointerUp(1, 20);
      else r.touch.pointerCancel(1, 20);
      const f = r.at(20);
      expect(f.steer).toBe(0);
      expect(f.drift).toBe(false);
      r.touch.pointerDown(2, X0 + 40, Y, 30);
      expect(r.at(30).drift).toBe(true);
    }
  });
});

describe('R81f keyboard end to end with the sim (variant 5, real base car, T71 numbers)', () => {
  const params = { ...baseCar, ...T71, model: 1, crashMinSpeed: 1e9, driftTurbo: 0 } as CarParams;
  const run = (track: Track, keys: string[], ticks: number) => {
    const kb = createKeyboardInput(inputConfig.keyboard, { ...V5C });
    const s = createRace(1, 1);
    const c = s.cars[0]!;
    c.speed = params.vmax;
    c.z = 10;
    const f = frame();
    for (const k of keys) kb.keyDown(k, 0);
    const states: string[] = [];
    for (let i = 0; i < ticks; i++) {
      kb.read(s.tick * DT * 1000, f);
      stepV(s, [f], track, [params]);
      states.push(`${c.state}${c.dir}`);
    }
    return { states, kb, s, c, f };
  };
  const HARD: Track = { segments: Array.from({ length: 4000 }, () => ({ curve: 7 })) };
  const LEFT: Track = { segments: Array.from({ length: 4000 }, () => ({ curve: -7 })) };
  const STR: Track = { segments: Array.from({ length: 4000 }, () => ({ curve: 0 })) };
  it('Space on a straight does nothing: GRIP for 2 s (with and without an arrow)', () => {
    for (const keys of [['Space'], ['Space', 'ArrowRight'], ['ShiftLeft', 'ArrowLeft']])
      expect(run(STR, keys, 240).states.every((x) => x === 'GRIP0')).toBe(true);
  });
  it('Space in a corner: DRIFT on the corner side from the first tick, whatever arrow is held', () => {
    for (const keys of [['Space'], ['Space', 'ArrowRight'], ['Space', 'ArrowLeft']]) {
      expect(run(HARD, keys, 120).states.every((x) => x === 'DRIFT1')).toBe(true);
      expect(run(LEFT, keys, 120).states.every((x) => x === 'DRIFT-1')).toBe(true);
    }
  });
  it('arrows without Space in a corner: GRIP', () => {
    expect(run(HARD, ['ArrowRight'], 120).states.every((x) => x === 'GRIP0')).toBe(true);
  });
  it('Space released in the corner: GRIP on that tick; pressed again: DRIFT on the next tick', () => {
    const r = run(HARD, ['Space'], 60);
    expect(r.c.state).toBe('DRIFT');
    r.kb.keyUp('Space', r.s.tick * DT * 1000);
    r.kb.read(r.s.tick * DT * 1000, r.f);
    stepV(r.s, [r.f], HARD, [params]);
    expect(r.c.state).toBe('GRIP');
    r.kb.keyDown('Space', r.s.tick * DT * 1000);
    r.kb.read(r.s.tick * DT * 1000, r.f);
    stepV(r.s, [r.f], HARD, [params]);
    expect(r.c.state).toBe('DRIFT');
  });
});

import { describe, expect, it } from 'vitest';
import { inputConfig } from '../../src/data/input';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPlayerInput } from '../../src/input/player';
import { createTouchStick } from '../../src/input/touchStick';
import type { InputFrame } from '../../src/sim/types';

const frame = (): InputFrame => ({ steer: 0, brake: false, drift: false });

const setup = () => {
  const kb = createKeyboardInput(inputConfig.keyboard);
  const touch = createTouchStick(inputConfig.touch);
  touch.setArea(360, 640);
  const clock = { t: 0 };
  const player = createPlayerInput(kb, touch, () => clock.t);
  return { kb, touch, clock, player };
};

describe('createPlayerInput', () => {
  it('last starts all zero/false', () => {
    const { player } = setup();
    expect(player.last).toEqual({ steer: 0, brake: false, drift: false });
  });

  it('idle read gives zero and last mirrors it', () => {
    const { player, clock } = setup();
    const out = { steer: 5, brake: true, drift: true };
    clock.t = 100;
    player.read(out);
    expect(out).toEqual({ steer: 0, brake: false, drift: false });
    expect(player.last).toEqual(out);
  });

  // keyboard right at 60 ms: 60/120 = 0.5
  it('keyboard alone: right at 60 ms -> 0.5; last mirrors out', () => {
    const { kb, player, clock } = setup();
    kb.keyDown('KeyD', 0);
    clock.t = 60;
    const out = frame();
    player.read(out);
    expect(out.steer).toBeCloseTo(0.5, 9);
    expect(player.last).toEqual(out);
    expect(player.last).not.toBe(out);
  });

  it('touch alone: raw -1 -> steer -1', () => {
    const { touch, player, clock } = setup();
    touch.pointerDown(1, 180, 500, 0);
    touch.pointerMove(1, 108, 500, 60);
    clock.t = 60;
    const out = frame();
    player.read(out);
    expect(out.steer).toBeCloseTo(-1, 9);
  });

  // keyboard right at 60 ms = 0.5; touch raw -1 -> -1; larger magnitude wins -> -1.
  it('combines: larger magnitude steer wins', () => {
    const { kb, touch, player, clock } = setup();
    kb.keyDown('KeyD', 0);
    touch.pointerDown(1, 180, 500, 0);
    touch.pointerMove(1, 108, 500, 60);
    clock.t = 60;
    const out = frame();
    player.read(out);
    expect(out.steer).toBeCloseTo(-1, 9);
    expect(player.last.steer).toBeCloseTo(-1, 9);
  });

  it('brake from keyboard and drift from touch both appear', () => {
    const { kb, touch, player, clock } = setup();
    kb.keyDown('KeyS', 0);
    touch.pointerDown(1, 180, 500, 0);
    touch.pointerMove(1, 180, 545, 10);
    clock.t = 10;
    const out = frame();
    player.read(out);
    expect(out.brake).toBe(true);
    expect(out.drift).toBe(true);
    expect(player.last).toEqual(out);
  });

  it('samples both sources at now() of each read (fake clock)', () => {
    const { kb, player, clock } = setup();
    kb.keyDown('KeyD', 0);
    const out = frame();
    clock.t = 30;
    player.read(out);
    expect(out.steer).toBeCloseTo(0.25, 9);
    clock.t = 90;
    player.read(out);
    expect(out.steer).toBeCloseTo(0.75, 9);
    expect(player.last.steer).toBeCloseTo(0.75, 9);
  });

  it('last keeps the same object identity across reads', () => {
    const { player, clock } = setup();
    const ref = player.last;
    clock.t = 10;
    player.read(frame());
    expect(player.last).toBe(ref);
  });

  it('determinism: same inputs twice -> same frames', () => {
    const run = () => {
      const { kb, touch, player, clock } = setup();
      const outs: InputFrame[] = [];
      kb.keyDown('KeyD', 0);
      touch.pointerDown(1, 180, 500, 5);
      for (const t of [10, 40, 80]) {
        touch.pointerMove(1, 180 - t, 500 + t, t);
        clock.t = t;
        const o = frame();
        player.read(o);
        outs.push(o);
      }
      return outs;
    };
    expect(run()).toEqual(run());
  });
});

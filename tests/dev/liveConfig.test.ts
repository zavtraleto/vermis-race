import { describe, expect, it } from 'vitest';
import camera from '../../src/data/camera.json';
import input from '../../src/data/input.json';
import palette from '../../src/data/palette.json';
import sprites from '../../src/data/sprites.json';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createTouchStick } from '../../src/input/touchStick';
import car3d from '../../src/data/car3d.json';
import { CarView } from '../../src/render/carModel';
import type { InputFrame } from '../../src/sim/types';

// T4 spec: a live edit of a config object takes effect on the next read, no rebuild.
const frame = (): InputFrame => ({ steer: 0, brake: false, drift: false });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('consumers read config live', () => {
  it('keyboard ramp follows steerRampMs changed after creation', () => {
    const cfg = clone(input.keyboard);
    const kb = createKeyboardInput(cfg);
    cfg.steerRampMs = 200;
    kb.keyDown('ArrowRight', 0);
    const f = frame();
    kb.read(100, f);
    expect(f.steer).toBeCloseTo(0.5, 9);
  });

  it('touch stick radius follows stickRadiusFrac changed after creation', () => {
    const cfg = clone(input.touch);
    cfg.deadZone = 0;
    cfg.responseExp = 1;
    const stick = createTouchStick(cfg);
    stick.setArea(100, 100);
    cfg.stickRadiusFrac = 0.5; // R = 50 px
    expect(stick.pointerDown(1, 50, 95, 0)).toBe(true);
    stick.pointerMove(1, 75, 95, 10);
    const f = frame();
    stick.read(10, f);
    expect(f.steer).toBeCloseTo(0.5, 9);
  });

  it('3D player car follows sprites.player.baseY changed after creation', () => {
    const cfg = clone(sprites);
    const car = new CarView(car3d, cfg.player, camera, palette);
    car.update(0, 0, 0);
    const before = (car.rearLY + car.rearRY) / 2;
    cfg.player.baseY -= 0.1;
    car.update(0, 0, 0);
    expect((car.rearLY + car.rearRY) / 2).toBeCloseTo(before - 0.1 * camera.screenHeight, 3);
  });
});

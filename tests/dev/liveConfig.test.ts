import { describe, expect, it } from 'vitest';
import camera from '../../src/data/camera.json';
import input from '../../src/data/input.json';
import palette from '../../src/data/palette.json';
import sprites from '../../src/data/sprites.json';
import { createPad } from '../../src/input/pad';
import car3d from '../../src/data/car3d.json';
import { CarView } from '../../src/render/carModel';
import type { InputFrame } from '../../src/sim/types';

// T4 spec: a live edit of a config object takes effect on the next read, no rebuild.
const frame = (): InputFrame => ({ steer: 0, gas: 1, brake: 0, driftTap: false });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('consumers read config live', () => {
  it('control pad follows steerSpan changed after creation (R202)', () => {
    const cfg = clone(input.pad);
    cfg.steerDead = 0;
    const pad = createPad(cfg);
    pad.setArea(100, 100);
    cfg.steerSpan = 0.5; // full steer at 0.5 * 50 = 25 px from the centre
    expect(pad.pointerDown(1, 50, 50, 0)).toBe(true);
    pad.pointerMove(1, 62.5, 50, 10);
    const f = frame();
    pad.read(10, f);
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

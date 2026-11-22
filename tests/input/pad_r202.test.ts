import { describe, expect, it } from 'vitest';
import { inputConfig } from '../../src/data/input';
import { combineInputs } from '../../src/input/combine';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPad, padPedals, padSteer } from '../../src/input/pad';
import type { InputFrame } from '../../src/sim/types';

// R202 control pad, keyboard and mouse (input layer). Numbers from src/data/input.json.
const cfg = inputConfig.pad;
const fresh = (): InputFrame => ({ steer: 9, gas: 9, brake: 9, driftTap: true });
const expectedSteer = (u: number): number =>
  Math.abs(u) <= cfg.steerDead
    ? 0
    : (Math.sign(u) * (Math.abs(u) - cfg.steerDead)) / (1 - cfg.steerDead);

describe('R202 pad steer (X axis)', () => {
  it('R202: dead zone gives 0', () => {
    expect(padSteer(0, cfg)).toBe(0);
    expect(padSteer(cfg.steerDead, cfg)).toBe(0);
    expect(padSteer(-cfg.steerDead / 2, cfg)).toBe(0);
  });

  it('R202: outside the dead zone steer = sign*(|u| - dead)/(1 - dead)', () => {
    // u = 0.5, dead 0.08: (0.5 - 0.08)/0.92 = 0.456522
    expect(padSteer(0.5, cfg)).toBeCloseTo(expectedSteer(0.5), 12);
    expect(padSteer(-0.5, cfg)).toBeCloseTo(-expectedSteer(0.5), 12);
    expect(padSteer(1, cfg)).toBe(1);
    expect(padSteer(-1, cfg)).toBe(-1);
  });

  it('R202: property: monotone and odd on [-1, 1]', () => {
    let prev = -Infinity;
    for (let u = -1; u <= 1.0000001; u += 0.01) {
      const s = padSteer(u, cfg);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(padSteer(-u, cfg)).toBeCloseTo(-s, 12);
      expect(Math.abs(s)).toBeLessThanOrEqual(1);
      prev = s;
    }
  });
});

describe('R202 pad gas and brake (Y axis)', () => {
  const lz = cfg.liftZone;
  const at = (y: number): InputFrame => {
    const out = fresh();
    padPedals(y, cfg, out);
    return out;
  };

  it('R202: liftZone is 1/3', () => {
    expect(lz).toBeCloseTo(1 / 3, 3);
  });

  it('R202: y >= 0 -> gas 1, brake 0', () => {
    for (const y of [0, 0.3, 1]) {
      expect(at(y).gas).toBe(1);
      expect(at(y).brake).toBe(0);
    }
  });

  it('R202: -liftZone <= y < 0 -> gas 1 -> 0 linearly, brake 0', () => {
    // y = -lz/2 -> gas 0.5
    expect(at(-lz / 2).gas).toBeCloseTo(0.5, 9);
    expect(at(-lz / 2).brake).toBe(0);
    expect(at(-lz).gas).toBeCloseTo(0, 9);
    expect(at(-lz).brake).toBeCloseTo(0, 9);
  });

  it('R202: y < -liftZone -> gas 0, brake 0 -> 1 linearly to y = -1', () => {
    // y = -(1 + lz)/2 (middle of the brake zone) -> brake 0.5
    const mid = at(-(1 + lz) / 2);
    expect(mid.gas).toBe(0);
    expect(mid.brake).toBeCloseTo(0.5, 9);
    expect(at(-1).gas).toBe(0);
    expect(at(-1).brake).toBeCloseTo(1, 12);
  });
});

describe('R202 pad pointer model', () => {
  // Area 400x800: centre (200, 400); full steer at 0.7*200 = 140 px; pad half-height = padHalfH*400 px.
  const W = 400;
  const H = 800;
  const halfH = cfg.padHalfH * (H / 2);

  it('R202/R201: before any touch and after release the frame is {steer 0, gas 1, brake 0}', () => {
    const pad = createPad(cfg);
    pad.setArea(W, H);
    const out = fresh();
    pad.read(0, out);
    expect(out).toEqual({ steer: 0, gas: 1, brake: 0, driftTap: false });
    pad.pointerDown(1, 300, 600, 10);
    pad.pointerUp(1, 20);
    const out2 = fresh();
    pad.read(1000, out2);
    expect(out2).toEqual({ steer: 0, gas: 1, brake: 0, driftTap: false });
  });

  it('R202: X offset / (steerSpan*half width), clamped, then the dead zone remap', () => {
    const pad = createPad(cfg);
    pad.setArea(W, H);
    const span = cfg.steerSpan * (W / 2); // 140 px
    pad.pointerDown(1, W / 2 + 0.5 * span, H / 2, 0);
    const out = fresh();
    pad.read(0, out);
    // u = 0.5 -> 0.456522
    expect(out.steer).toBeCloseTo(expectedSteer(0.5), 9);
    pad.pointerMove(1, W / 2 - 0.5 * span, H / 2, 1);
    pad.read(1, out);
    expect(out.steer).toBeCloseTo(-expectedSteer(0.5), 9);
    pad.pointerMove(1, W, H / 2, 2); // beyond the span -> clamped to 1
    pad.read(2, out);
    expect(out.steer).toBe(1);
  });

  it('R202: Y offset / pad half-height, up = +: lift and brake zones', () => {
    const pad = createPad(cfg);
    pad.setArea(W, H);
    const out = fresh();
    pad.pointerDown(1, W / 2, H / 2 - 0.5 * halfH, 0); // above centre: y = +0.5
    pad.read(0, out);
    expect(out.gas).toBe(1);
    expect(out.brake).toBe(0);
    pad.pointerMove(1, W / 2, H / 2 + (cfg.liftZone / 2) * halfH, 1); // y = -lz/2
    pad.read(1, out);
    expect(out.gas).toBeCloseTo(0.5, 6);
    expect(out.brake).toBe(0);
    pad.pointerMove(1, W / 2, H / 2 + 0.5 * halfH, 2); // y = -0.5
    pad.read(2, out);
    expect(out.gas).toBe(0);
    // brake = (0.5 - lz)/(1 - lz) = 0.25
    expect(out.brake).toBeCloseTo((0.5 - cfg.liftZone) / (1 - cfg.liftZone), 6);
    pad.pointerMove(1, W / 2, H, 3); // beyond the pad -> y clamped to -1
    pad.read(3, out);
    expect(out.brake).toBeCloseTo(1, 9);
  });

  it('R202: plain steering without lifting the finger never sets driftTap', () => {
    const pad = createPad(cfg);
    pad.setArea(W, H);
    const out = fresh();
    pad.pointerDown(1, W / 2, H / 2, 0);
    for (let t = 0; t < 2000; t += 8) {
      pad.pointerMove(1, W / 2 + 180 * Math.sin(t / 100), H / 2, t);
      pad.read(t, out);
      expect(out.driftTap).toBe(false);
    }
  });
});

describe('R202 keyboard', () => {
  it('R202: no keys -> {steer 0, gas 1, brake 0, driftTap false}', () => {
    const kb = createKeyboardInput();
    const out = fresh();
    kb.read(0, out);
    expect(out).toEqual({ steer: 0, gas: 1, brake: 0, driftTap: false });
  });

  it('R202: ArrowLeft / ArrowRight = steer target -1 / +1', () => {
    const kb = createKeyboardInput();
    const out = fresh();
    kb.keyDown('ArrowLeft', 0);
    kb.read(0, out);
    expect(out.steer).toBe(-1);
    kb.keyUp('ArrowLeft', 1);
    kb.keyDown('ArrowRight', 1);
    kb.read(1, out);
    expect(out.steer).toBe(1);
  });

  it('R202: ArrowDown = brake 1 and gas 0', () => {
    const kb = createKeyboardInput();
    const out = fresh();
    kb.keyDown('ArrowDown', 0);
    kb.read(0, out);
    expect(out.gas).toBe(0);
    expect(out.brake).toBe(1);
    kb.keyUp('ArrowDown', 1);
    kb.read(1, out);
    expect(out.gas).toBe(1);
    expect(out.brake).toBe(0);
  });

  it('R202: Space gives driftTap for exactly one tick, even while held', () => {
    const kb = createKeyboardInput();
    const out = fresh();
    kb.keyDown('Space', 0);
    kb.read(0, out);
    expect(out.driftTap).toBe(true);
    for (let t = 1; t < 20; t++) {
      kb.keyDown('Space', t); // key repeat
      kb.read(t, out);
      expect(out.driftTap).toBe(false);
    }
    kb.keyUp('Space', 20);
    kb.read(21, out);
    expect(out.driftTap).toBe(false);
  });
});

describe('R202 pad + keyboard combined', () => {
  const released: InputFrame = { steer: 0, gas: 1, brake: 0, driftTap: false };

  it('R202: released pad + keyboard ArrowDown -> gas 0, brake 1', () => {
    const out = fresh();
    combineInputs(released, { steer: 0, gas: 0, brake: 1, driftTap: false }, out);
    expect(out).toEqual({ steer: 0, gas: 0, brake: 1, driftTap: false });
  });

  it('R202: pad steer with no keys is kept; keyboard Space adds driftTap', () => {
    const out = fresh();
    combineInputs(
      { steer: 0.4, gas: 1, brake: 0, driftTap: false },
      { ...released, driftTap: true },
      out,
    );
    expect(out.steer).toBe(0.4);
    expect(out.gas).toBe(1);
    expect(out.brake).toBe(0);
    expect(out.driftTap).toBe(true);
  });

  it('R202: both released -> released', () => {
    const out = fresh();
    combineInputs(released, released, out);
    expect(out).toEqual(released);
  });
});

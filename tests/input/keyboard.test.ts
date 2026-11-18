import { describe, expect, it } from 'vitest';
import { inputConfig } from '../../src/data/input';
import { createKeyboardInput } from '../../src/input/keyboard';
import type { InputFrame } from '../../src/sim/types';

const RAMP = inputConfig.keyboard.steerRampMs;
const frame = (): InputFrame => ({ steer: 0, brake: false, drift: false });
const mk = () => createKeyboardInput(inputConfig.keyboard);
const steerAt = (kb: ReturnType<typeof mk>, t: number): number => {
  const f = frame();
  kb.read(t, f);
  return f.steer;
};

describe('input config sanity', () => {
  it('keyboard ramp is 120 ms', () => {
    expect(RAMP).toBe(120);
  });
});

describe('keyboard: key mapping', () => {
  it('returns true for our codes, false for others', () => {
    const kb = mk();
    for (const c of [
      'KeyA',
      'ArrowLeft',
      'KeyD',
      'ArrowRight',
      'KeyS',
      'ArrowDown',
      'ShiftLeft',
      'ShiftRight',
      'Space',
    ]) {
      expect(kb.keyDown(c, 0), c).toBe(true);
      expect(kb.keyUp(c, 1), c).toBe(true);
    }
    expect(kb.keyDown('KeyQ', 0)).toBe(false);
    expect(kb.keyUp('KeyQ', 1)).toBe(false);
  });

  it('read with nothing held is all zero/false', () => {
    const f = frame();
    mk().read(500, f);
    expect(f).toEqual({ steer: 0, brake: false, drift: false });
  });

  it('brake: KeyS and ArrowDown', () => {
    for (const c of ['KeyS', 'ArrowDown']) {
      const kb = mk();
      kb.keyDown(c, 0);
      const f = frame();
      kb.read(10, f);
      expect(f.brake, c).toBe(true);
      expect(f.drift).toBe(false);
      kb.keyUp(c, 20);
      kb.read(20, f);
      expect(f.brake, c).toBe(false);
    }
  });

  it('drift: ShiftLeft, ShiftRight, Space', () => {
    for (const c of ['ShiftLeft', 'ShiftRight', 'Space']) {
      const kb = mk();
      kb.keyDown(c, 0);
      const f = frame();
      kb.read(10, f);
      expect(f.drift, c).toBe(true);
      expect(f.brake).toBe(false);
      kb.keyUp(c, 20);
      kb.read(20, f);
      expect(f.drift, c).toBe(false);
    }
  });

  it('repeated keyDown is harmless', () => {
    const kb = mk();
    kb.keyDown('KeyD', 0);
    kb.keyDown('KeyD', 30);
    kb.keyDown('KeyD', 60);
    expect(steerAt(kb, 60)).toBeCloseTo(0.5, 9);
  });
});

describe('keyboard: steer ramp', () => {
  // Rate 1/120 per ms: 60 ms -> 60/120 = 0.5; 120 ms -> 1; clamped at 1 afterwards.
  it.each([
    ['KeyD', 1],
    ['ArrowRight', 1],
    ['KeyA', -1],
    ['ArrowLeft', -1],
  ])('%s ramps 0 -> sign in steerRampMs', (code, sign) => {
    const kb = mk();
    kb.keyDown(code, 0);
    expect(steerAt(kb, 0)).toBeCloseTo(0, 9);
    expect(steerAt(kb, 60)).toBeCloseTo(0.5 * sign, 9);
    expect(steerAt(kb, 120)).toBeCloseTo(1 * sign, 9);
    expect(steerAt(kb, 400)).toBeCloseTo(1 * sign, 9);
  });

  // Release at 200 from 1: 30 ms later 1 - 30/120 = 0.75; 120 ms later 0.
  it('returns to 0 at the same rate after release', () => {
    const kb = mk();
    kb.keyDown('KeyD', 0);
    expect(steerAt(kb, 200)).toBeCloseTo(1, 9);
    kb.keyUp('KeyD', 200);
    expect(steerAt(kb, 230)).toBeCloseTo(0.75, 9);
    expect(steerAt(kb, 260)).toBeCloseTo(0.5, 9);
    expect(steerAt(kb, 320)).toBeCloseTo(0, 9);
    expect(steerAt(kb, 1000)).toBeCloseTo(0, 9);
  });

  // Held 0..60 (steer 0.5), released at 60, 30 ms later 0.5 - 30/120 = 0.25 (no read in between).
  it('release mid-ramp starts from the current value (no intermediate read)', () => {
    const kb = mk();
    kb.keyDown('KeyD', 0);
    kb.keyUp('KeyD', 60);
    expect(steerAt(kb, 90)).toBeCloseTo(0.25, 9);
  });

  it('left/right symmetry over a whole sequence', () => {
    const r = mk();
    const l = mk();
    r.keyDown('KeyD', 0);
    l.keyDown('KeyA', 0);
    for (const t of [0, 17, 50, 90, 120, 150]) {
      expect(steerAt(l, t)).toBeCloseTo(-steerAt(r, t), 12);
    }
    r.keyUp('KeyD', 150);
    l.keyUp('KeyA', 150);
    for (const t of [160, 200, 250, 300]) {
      expect(steerAt(l, t)).toBeCloseTo(-steerAt(r, t), 12);
    }
  });

  it('steer stays within [-1, 1] and moves at most 1/steerRampMs per ms', () => {
    const kb = mk();
    kb.keyDown('KeyD', 0);
    let prev = 0;
    for (let t = 0; t <= 400; t += 7) {
      if (t === 203) kb.keyUp('KeyD', t);
      if (t === 259) kb.keyDown('KeyA', t);
      const s = steerAt(kb, t);
      expect(Math.abs(s)).toBeLessThanOrEqual(1 + 1e-12);
      expect(Math.abs(s - prev)).toBeLessThanOrEqual(7 / RAMP + 1e-9);
      prev = s;
    }
  });

  it('monotonic non-decreasing while right is held', () => {
    const kb = mk();
    kb.keyDown('KeyD', 0);
    let prev = -1;
    for (let t = 0; t <= 300; t += 5) {
      const s = steerAt(kb, t);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});

describe('keyboard: both directions', () => {
  it('left+right together -> target 0', () => {
    const kb = mk();
    kb.keyDown('KeyA', 0);
    kb.keyDown('KeyD', 0);
    expect(steerAt(kb, 60)).toBeCloseTo(0, 9);
    expect(steerAt(kb, 300)).toBeCloseTo(0, 9);
  });

  // Right held until 120 (steer 1), left added at 120: target 0, so falls 1 -> 0 over 120 ms: at 180 -> 0.5.
  it('adding the opposite key mid-hold ramps toward 0', () => {
    const kb = mk();
    kb.keyDown('KeyD', 0);
    expect(steerAt(kb, 120)).toBeCloseTo(1, 9);
    kb.keyDown('KeyA', 120);
    expect(steerAt(kb, 180)).toBeCloseTo(0.5, 9);
    expect(steerAt(kb, 240)).toBeCloseTo(0, 9);
  });

  it('two keys for the same side: releasing one keeps steering', () => {
    const kb = mk();
    kb.keyDown('KeyD', 0);
    kb.keyDown('ArrowRight', 0);
    expect(steerAt(kb, 200)).toBeCloseTo(1, 9);
    kb.keyUp('KeyD', 200);
    expect(steerAt(kb, 300)).toBeCloseTo(1, 9);
    kb.keyUp('ArrowRight', 300);
    expect(steerAt(kb, 330)).toBeCloseTo(0.75, 9);
  });

  it('two keys for the same side on the left too', () => {
    const kb = mk();
    kb.keyDown('KeyA', 0);
    kb.keyDown('ArrowLeft', 10);
    kb.keyUp('ArrowLeft', 200);
    expect(steerAt(kb, 300)).toBeCloseTo(-1, 9);
  });
});

describe('keyboard: releaseAll', () => {
  it('clears brake, drift and steering target', () => {
    const kb = mk();
    kb.keyDown('KeyD', 0);
    kb.keyDown('KeyS', 0);
    kb.keyDown('Space', 0);
    expect(steerAt(kb, 200)).toBeCloseTo(1, 9);
    kb.releaseAll(200);
    const f = frame();
    kb.read(200, f);
    expect(f.brake).toBe(false);
    expect(f.drift).toBe(false);
    kb.read(200 + RAMP, f);
    expect(f.steer).toBeCloseTo(0, 9);
    kb.read(1000, f);
    expect(f.steer).toBeCloseTo(0, 9);
  });

  it('a key-up of a key cleared by releaseAll does not break state', () => {
    const kb = mk();
    kb.keyDown('KeyD', 0);
    kb.releaseAll(50);
    kb.keyUp('KeyD', 60);
    expect(steerAt(kb, 1000)).toBeCloseTo(0, 9);
  });
});

describe('keyboard: determinism', () => {
  it('same event sequence twice -> identical output', () => {
    const run = () => {
      const kb = mk();
      const outs: number[] = [];
      kb.keyDown('KeyD', 0);
      outs.push(steerAt(kb, 33));
      kb.keyDown('KeyA', 80);
      outs.push(steerAt(kb, 111));
      kb.keyUp('KeyD', 150);
      outs.push(steerAt(kb, 222));
      return outs;
    };
    expect(run()).toEqual(run());
  });
});

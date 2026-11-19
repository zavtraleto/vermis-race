import { describe, expect, it } from 'vitest';
import { inputConfig } from '../../src/data/input';
import { createKeyboardInput } from '../../src/input/keyboard';
import type { InputFrame } from '../../src/sim/types';

/**
 * R81 keyboard paragraph (model B). ASSUMED API: createKeyboardInput(cfg, car?) where `car` is
 * `{ readonly model: number }` read live on every call (like DriftEntryOptions.car in player.ts);
 * model 1 = B enables the drift-entry behaviour, model 0 / undefined = unchanged (model A).
 * Rule: drift key down while a steer key is held -> the first read after the press returns
 * steer 0 (drift held), the next read returns the full steer of the held keys (no ramp).
 * Steer key down while drift is held -> steer is the full value at once.
 */
const RAMP = inputConfig.keyboard.steerRampMs;
const B = { model: 1 };
const A = { model: 0 };
const mk = (car: { readonly model: number } = B) => createKeyboardInput(inputConfig.keyboard, car);
const rd = (kb: ReturnType<typeof mk>, t: number): InputFrame => {
  const f: InputFrame = { steer: 0, brake: false, drift: false };
  kb.read(t, f);
  return f;
};

describe('R81 keyboard: drift key pressed while a steer key is held (model B)', () => {
  it.each([
    ['ArrowRight', 1],
    ['KeyD', 1],
    ['ArrowLeft', -1],
    ['KeyA', -1],
  ] as const)('%s held 1 s, then Space: read 1 -> 0, read 2 -> full', (key, s) => {
    const kb = mk();
    kb.keyDown(key, 0);
    expect(rd(kb, 1000).steer).toBe(s); // ramp done long ago
    kb.keyDown('Space', 1000);
    const f1 = rd(kb, 1010);
    expect(f1.steer).toBe(0);
    expect(f1.drift).toBe(true);
    const f2 = rd(kb, 1020);
    // 10 ms after a zero would be 10/120 = 0.083 on a ramp; the rule demands the full value
    expect(f2.steer).toBe(s);
    expect(f2.drift).toBe(true);
    expect(rd(kb, 1030).steer).toBe(s);
  });

  it.each(['ShiftLeft', 'ShiftRight'])('%s works like Space', (k) => {
    const kb = mk();
    kb.keyDown('ArrowRight', 0);
    rd(kb, 500);
    kb.keyDown(k, 500);
    expect(rd(kb, 510).steer).toBe(0);
    expect(rd(kb, 520).steer).toBe(1);
  });

  it('(g) exactly one zero read per press; overlapping drift keys give no second zero read', () => {
    const kb = mk();
    kb.keyDown('ArrowRight', 0);
    rd(kb, 500);
    kb.keyDown('ShiftLeft', 500);
    expect(rd(kb, 510).steer).toBe(0);
    expect(rd(kb, 520).steer).toBe(1);
    kb.keyDown('Space', 530); // Shift still held: same hold
    expect(rd(kb, 540).steer).toBe(1);
    expect(rd(kb, 550).steer).toBe(1);
    kb.keyUp('ShiftLeft', 560); // Space still held: drift never released
    expect(rd(kb, 570).steer).toBe(1);
    expect(rd(kb, 570).drift).toBe(true);
    // a new press after a full release gives a new zero read
    kb.keyUp('Space', 580);
    expect(rd(kb, 590).drift).toBe(false);
    kb.keyDown('Space', 600);
    expect(rd(kb, 610).steer).toBe(0);
    expect(rd(kb, 620).steer).toBe(1);
  });

  it('(g) the zero is consumed by exactly one read', () => {
    const kb = mk();
    kb.keyDown('ArrowLeft', 0);
    rd(kb, 500);
    kb.keyDown('Space', 500);
    let zeros = 0;
    for (let t = 510; t < 700; t += 10) if (rd(kb, t).steer === 0) zeros++;
    expect(zeros).toBe(1);
  });

  it('(f) both steer keys held (steer 0) + Space: steer stays 0', () => {
    const kb = mk();
    kb.keyDown('ArrowLeft', 0);
    kb.keyDown('ArrowRight', 0);
    rd(kb, 500);
    kb.keyDown('Space', 500);
    for (let t = 510; t < 700; t += 10) expect(rd(kb, t).steer).toBe(0);
  });

  it('partially ramped steer still reads 0, then the full value', () => {
    const kb = mk();
    kb.keyDown('ArrowRight', 0);
    expect(rd(kb, 60).steer).toBeCloseTo(60 / RAMP, 6); // 0.5
    kb.keyDown('Space', 60);
    expect(rd(kb, 70).steer).toBe(0);
    expect(rd(kb, 80).steer).toBe(1);
  });
});

describe('R81 keyboard: steer key pressed while drift is already held (model B)', () => {
  it.each([
    ['ArrowRight', 1],
    ['KeyA', -1],
  ] as const)('%s: steer is the full value at once', (key, s) => {
    const kb = mk();
    kb.keyDown('Space', 0);
    expect(rd(kb, 500).steer).toBe(0);
    kb.keyDown(key, 500);
    const f = rd(kb, 510); // a ramp would give 10/120 = 0.083
    expect(f.steer).toBe(s);
    expect(f.drift).toBe(true);
  });

  it('(f) both arrows pressed with drift held: steer 0', () => {
    const kb = mk();
    kb.keyDown('Space', 0);
    kb.keyDown('ArrowLeft', 100);
    kb.keyDown('ArrowRight', 100);
    expect(rd(kb, 110).steer).toBe(0);
  });
});

describe('R81 keyboard: unchanged behaviour', () => {
  it('(d) no drift key: steer ramps as before (model B)', () => {
    const kb = mk();
    kb.keyDown('ArrowRight', 0);
    expect(rd(kb, 30).steer).toBeCloseTo(30 / RAMP, 9); // 0.25
    expect(rd(kb, 60).steer).toBeCloseTo(0.5, 9);
    expect(rd(kb, RAMP).steer).toBe(1);
    kb.keyUp('ArrowRight', 500);
    expect(rd(kb, 500 + RAMP / 2).steer).toBeCloseTo(0.5, 9);
  });

  it('drift pressed and released, then a steer key: ramp untouched', () => {
    const kb = mk();
    kb.keyDown('Space', 0);
    kb.keyUp('Space', 100);
    kb.keyDown('ArrowRight', 200);
    expect(rd(kb, 230).steer).toBeCloseTo(0.25, 9);
  });

  it('model A (and no car argument): today behaviour, no zero read, ramp', () => {
    for (const car of [A, undefined]) {
      const mkc = () => (car === undefined ? createKeyboardInput(inputConfig.keyboard) : mk(car));
      const kb = mkc();
      kb.keyDown('ArrowRight', 0);
      rd(kb, 60); // 0.5
      kb.keyDown('Space', 60);
      expect(rd(kb, 70).steer).toBeCloseTo(0.5 + 10 / RAMP, 9);
      const kb2 = mkc();
      kb2.keyDown('Space', 0);
      rd(kb2, 500);
      kb2.keyDown('ArrowRight', 500);
      expect(rd(kb2, 510).steer).toBeCloseTo(10 / RAMP, 9); // ramp, not full
    }
  });

  it('the model is read live: switching 0 -> 1 turns the behaviour on', () => {
    const car = { model: 0 };
    const kb = mk(car);
    car.model = 1;
    kb.keyDown('ArrowRight', 0);
    rd(kb, 500);
    kb.keyDown('Space', 500);
    expect(rd(kb, 510).steer).toBe(0);
    expect(rd(kb, 520).steer).toBe(1);
  });

  it('determinism: same events twice -> identical frames', () => {
    const run = (): number[] => {
      const kb = mk();
      const out: number[] = [];
      kb.keyDown('ArrowLeft', 0);
      for (let t = 10; t <= 400; t += 10) {
        if (t === 200) kb.keyDown('Space', t);
        if (t === 300) kb.keyUp('Space', t);
        out.push(rd(kb, t).steer);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

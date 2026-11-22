import { describe, expect, it } from 'vitest';
import { inputConfig } from '../../src/data/input';
import { createPad } from '../../src/input/pad';
import { padDot, padLayout } from '../../src/input/padLayout';
import type { PadDot, PadLayout } from '../../src/input/padLayout';
import type { PadConfig } from '../../src/input/types';
import type { InputFrame } from '../../src/sim/types';

// R214 visible control pad: pure layout in CSS px relative to the game area top-left.
// Exact numbers use a frozen copy of the current src/data/input.json pad values; the
// agreement-with-R202 checks use the live config.
const fixed: PadConfig = {
  steerSpan: 0.7,
  steerDead: 0.08,
  padHalfH: 0.4,
  liftZone: 0.3333,
  retouchWindow: 0.3,
  retouchSteer: 0.5,
};
const cfg = inputConfig.pad;

const blank = (): PadLayout => ({
  left: NaN,
  right: NaN,
  top: NaN,
  bottom: NaN,
  centerX: NaN,
  centerY: NaN,
  deadLeft: NaN,
  deadRight: NaN,
  liftY: NaN,
  brakeY: NaN,
});
const frame = (): InputFrame => ({ steer: 9, gas: 9, brake: 9, driftTap: true });

describe('R214(a) pad layout from input.json and the game area size', () => {
  it('R214(a): 390x844 area', () => {
    const L = blank();
    padLayout(fixed, 390, 844, L);
    // centre (195, 422); halfW 195, halfH 422
    expect(L.centerX).toBeCloseTo(195, 9);
    expect(L.centerY).toBeCloseTo(422, 9);
    // X edges = 195 -/+ 0.7*195 = 195 -/+ 136.5 -> 58.5, 331.5
    expect(L.left).toBeCloseTo(58.5, 9);
    expect(L.right).toBeCloseTo(331.5, 9);
    // Y edges = 422 -/+ 0.4*422 = 422 -/+ 168.8 -> 253.2, 590.8
    expect(L.top).toBeCloseTo(253.2, 9);
    expect(L.bottom).toBeCloseTo(590.8, 9);
    // dead marks = 195 -/+ 0.08*0.7*195 = 195 -/+ 10.92 -> 184.08, 205.92
    expect(L.deadLeft).toBeCloseTo(184.08, 9);
    expect(L.deadRight).toBeCloseTo(205.92, 9);
    // gas/lift = horizontal axis y = 0 -> 422
    expect(L.liftY).toBeCloseTo(422, 9);
    // lift/brake y = -liftZone (up = +) -> 422 + 0.3333*168.8 = 422 + 56.26104 = 478.26104
    expect(L.brakeY).toBeCloseTo(478.26104, 9);
  });

  it('R214(a): 1080x1920 area', () => {
    const L = blank();
    padLayout(fixed, 1080, 1920, L);
    // centre (540, 960)
    expect(L.centerX).toBeCloseTo(540, 9);
    expect(L.centerY).toBeCloseTo(960, 9);
    // X edges = 540 -/+ 0.7*540 = 540 -/+ 378 -> 162, 918
    expect(L.left).toBeCloseTo(162, 9);
    expect(L.right).toBeCloseTo(918, 9);
    // Y edges = 960 -/+ 0.4*960 = 960 -/+ 384 -> 576, 1344
    expect(L.top).toBeCloseTo(576, 9);
    expect(L.bottom).toBeCloseTo(1344, 9);
    // dead marks = 540 -/+ 0.08*378 = 540 -/+ 30.24 -> 509.76, 570.24
    expect(L.deadLeft).toBeCloseTo(509.76, 9);
    expect(L.deadRight).toBeCloseTo(570.24, 9);
    expect(L.liftY).toBeCloseTo(960, 9);
    // 960 + 0.3333*384 = 960 + 127.9872 = 1087.9872
    expect(L.brakeY).toBeCloseTo(1087.9872, 9);
  });

  it('R214(a): fills the given object in place, symmetric about the centre, deterministic', () => {
    const L = blank();
    padLayout(cfg, 390, 844, L);
    const first = JSON.stringify(L);
    padLayout(cfg, 390, 844, L);
    expect(JSON.stringify(L)).toBe(first);
    expect(L.left + L.right).toBeCloseTo(390, 9);
    expect(L.top + L.bottom).toBeCloseTo(844, 9);
    expect(L.deadLeft + L.deadRight).toBeCloseTo(390, 9);
    // order: left < deadLeft < centre < deadRight < right; top < liftY < brakeY < bottom
    expect(L.left).toBeLessThan(L.deadLeft);
    expect(L.deadLeft).toBeLessThan(L.centerX);
    expect(L.deadRight).toBeLessThan(L.right);
    expect(L.top).toBeLessThan(L.liftY);
    expect(L.liftY).toBeLessThan(L.brakeY);
    expect(L.brakeY).toBeLessThan(L.bottom);
    expect(L.liftY).toBe(L.centerY);
  });
});

describe('R214(a) layout agrees with the R202 input model (pad.ts)', () => {
  for (const [w, h] of [
    [390, 844],
    [1080, 1920],
  ] as const) {
    const L = blank();
    const at = (x: number, y: number): InputFrame => {
      const pad = createPad(cfg);
      pad.setArea(w, h);
      pad.pointerDown(1, x, y, 0);
      const out = frame();
      pad.read(10_000, out);
      return out;
    };

    it(`R214(a) ${w}x${h}: x = right is full steer, x = left is full counter-steer`, () => {
      padLayout(cfg, w, h, L);
      expect(at(L.right, L.centerY).steer).toBeCloseTo(1, 9);
      expect(at(L.left, L.centerY).steer).toBeCloseTo(-1, 9);
    });

    it(`R214(a) ${w}x${h}: dead marks are where steer leaves 0`, () => {
      padLayout(cfg, w, h, L);
      expect(at(L.deadRight, L.centerY).steer).toBeCloseTo(0, 9);
      expect(at(L.deadRight + 0.5, L.centerY).steer).toBeGreaterThan(0);
      expect(at(L.deadLeft, L.centerY).steer).toBeCloseTo(0, 9);
      expect(at(L.deadLeft - 0.5, L.centerY).steer).toBeLessThan(0);
    });

    it(`R214(a) ${w}x${h}: liftY is gas 1, brakeY separates lift from brake`, () => {
      padLayout(cfg, w, h, L);
      const onAxis = at(L.centerX, L.liftY);
      expect(onAxis.gas).toBe(1);
      expect(onAxis.brake).toBe(0);
      expect(at(L.centerX, L.liftY + 0.5).gas).toBeLessThan(1);
      const above = at(L.centerX, L.brakeY - 0.5);
      expect(above.brake).toBe(0);
      expect(above.gas).toBeLessThan(1);
      const below = at(L.centerX, L.brakeY + 0.5);
      expect(below.brake).toBeGreaterThan(0);
      expect(below.gas).toBe(0);
    });

    it(`R214(a) ${w}x${h}: top/bottom edges are the Y stops (full gas / full brake)`, () => {
      padLayout(cfg, w, h, L);
      expect(at(L.centerX, L.top).gas).toBe(1);
      expect(at(L.centerX, L.bottom).brake).toBeCloseTo(1, 9);
    });
  }
});

describe('R214(b) finger dot clamped to the pad rectangle', () => {
  const L = blank();
  padLayout(fixed, 390, 844, L); // rect x 58.5..331.5, y 253.2..590.8
  const dot = (): PadDot => ({ x: NaN, y: NaN });

  it('R214(b): inside the rectangle the dot is at the finger', () => {
    const d = dot();
    padDot(fixed, L, 250, 300, d);
    expect(d.x).toBe(250);
    expect(d.y).toBe(300);
  });

  it('R214(b): outside the rectangle the dot is clamped to the edges', () => {
    const d = dot();
    padDot(fixed, L, 0, 0, d);
    expect(d.x).toBeCloseTo(58.5, 9);
    expect(d.y).toBeCloseTo(253.2, 9);
    padDot(fixed, L, 390, 844, d);
    expect(d.x).toBeCloseTo(331.5, 9);
    expect(d.y).toBeCloseTo(590.8, 9);
    // only one axis out: the other stays
    padDot(fixed, L, 400, 500, d);
    expect(d.x).toBeCloseTo(331.5, 9);
    expect(d.y).toBe(500);
  });

  it('R214(b): mirror fingers give mirror dots (left/right symmetry)', () => {
    const a = dot();
    const b = dot();
    for (const fx of [-50, 10, 100, 180, 195]) {
      padDot(fixed, L, fx, 400, a);
      padDot(fixed, L, 390 - fx, 400, b);
      expect(a.x + b.x).toBeCloseTo(390, 9);
    }
  });
});

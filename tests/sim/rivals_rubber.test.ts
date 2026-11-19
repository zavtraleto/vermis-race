import { describe, expect, it } from 'vitest';
import { step } from '../../src/sim/race';
import type { CarParams, InputFrame, RivalConfig } from '../../src/sim/types';
import { baseCarA } from './baseCarA';
import { PB } from './modelb_helpers';
import { IDLE, RC, TRACK, mkRace } from './rivals_helpers';

// R63: d is taken from z at the START of the step, so the cap is exact (tolerance 1e-9).
// Player parked (speed 0, accel 0). The rival has a huge accel/driftBrake, so after ONE step its
// speed is exactly its cap: accel*DT = 600/120 = 5 >= any cap, driftBrake*DT = 5 pulls it down to
// the cap. The step moves the rival by at most 0.54 segments, which changes the band by at most
// 0.08 * 0.54 / 200 = 2.2e-4, so the tolerance 1e-3 is independent of whether the brief means the
// distance at the start or at the end of the step (see report).
const PLAYER: CarParams = { ...baseCarA, accel: 0 };
const SNAP: CarParams = { ...baseCarA, accel: 600, driftBrake: 600 };
const TOL = 1e-9;

/** Rival speed after one step; d > 0: rival d segments behind the player, d < 0: ahead. */
function capAt(d: number, cfg: RivalConfig | undefined, pace = 1, start = 0.5): number {
  const s = mkRace(1, 0, [
    { z: 0, x: 0, speed: 0 },
    { z: -d, x: 0.5, speed: start, pace },
  ]);
  step(s, [IDLE, IDLE], TRACK, [PLAYER, SNAP], undefined, cfg);
  return s.cars[1]!.speed;
}

describe('R62 pace scales the speed cap', () => {
  const settle = (p: CarParams, pace: number, start: number): number => {
    const s = mkRace(1, 0, [
      { z: -1000, x: 0, speed: 0 },
      { z: 0, x: 0.3, speed: start, pace },
    ]);
    for (let i = 0; i < 1500; i++) step(s, [IDLE, IDLE], TRACK, [{ ...p, accel: 0 }, p]);
    return s.cars[1]!.speed;
  };
  for (const [label, p] of [
    ['model A', baseCarA],
    ['model B', PB],
  ] as const) {
    it(`${label}: pace 1.03 settles at 1.03*vmax, pace 0.97 at 0.97*vmax, pace 1 at vmax`, () => {
      expect(settle(p, 1.03, 0)).toBeCloseTo(1.03 * p.vmax, 6);
      expect(settle(p, 0.97, 0)).toBeCloseTo(0.97 * p.vmax, 6);
      expect(settle(p, 1, 0)).toBeCloseTo(p.vmax, 6);
      // starting above the cap it brakes down to the cap
      expect(settle(p, 0.97, p.vmax)).toBeCloseTo(0.97 * p.vmax, 6);
    });
  }
  it('the same pace on the player car (pace 1) leaves vmax alone', () => {
    const s = mkRace(0, 0, [{ z: 0, x: 0, speed: 0 }]);
    for (let i = 0; i < 1500; i++) step(s, [IDLE], TRACK, [baseCarA]);
    expect(s.cars[0]!.speed).toBeCloseTo(1, 6);
  });
  it('monotonic: higher pace -> higher settled speed', () => {
    const v = [0.97, 0.99, 1, 1.01, 1.03].map((pc) => settle(baseCarA, pc, 0));
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThan(v[i - 1]!);
  });
});

describe('R63 rubber band (cap multiplier, H15 on)', () => {
  // behind d: band = 1 + 0.08 * clamp((d - 40) / 200, 0, 1); ahead d: 1 - 0.08 * clamp((d - 40) / 200, 0, 1)
  const behind: Array<[number, number]> = [
    [10, 1], // inside the dead zone
    [39, 1],
    [40, 1], // (40 - 40)/200 = 0
    [100, 1 + 0.08 * 0.3], // (100 - 40)/200 = 0.3 -> 1.024
    [140, 1.04], // 100/200 = 0.5
    [200, 1 + 0.08 * 0.8], // 160/200 = 0.8 -> 1.064
    [240, 1.08], // 200/200 = 1
    [300, 1.08], // clamp: (260)/200 = 1.3 -> 1
    [1000, 1.08],
  ];
  const ahead: Array<[number, number]> = [
    [10, 1],
    [40, 1],
    [100, 1 - 0.08 * 0.3], // 0.976
    [140, 0.96],
    [240, 0.92],
    [300, 0.92],
    [1000, 0.92],
  ];
  for (const [d, band] of behind) {
    it(`rival ${d} segments behind the player: cap = ${band} * vmax`, () => {
      expect(capAt(d, RC)).toBeCloseTo(band, 9);
    });
  }
  for (const [d, band] of ahead) {
    it(`rival ${d} segments ahead of the player: cap = ${band} * vmax`, () => {
      expect(capAt(-d, RC)).toBeCloseTo(band, 9);
    });
  }
  it('behind the player the speed never drops below vmax, ahead never rises above it (clamp at 0 on both sides)', () => {
    for (let d = 0; d <= 400; d += 20) {
      expect(capAt(d, RC)).toBeGreaterThanOrEqual(1 - TOL);
      expect(capAt(-d, RC)).toBeLessThanOrEqual(1 + TOL);
    }
  });
  it('monotonic in the distance: farther behind -> not slower, farther ahead -> not faster', () => {
    let prevB = 0;
    let prevA = 10;
    for (let d = 0; d <= 400; d += 20) {
      const b = capAt(d, RC);
      const a = capAt(-d, RC);
      expect(b).toBeGreaterThanOrEqual(prevB - TOL);
      expect(a).toBeLessThanOrEqual(prevA + TOL);
      prevB = b;
      prevA = a;
    }
  });
  it('boost and slow are independent numbers: boost 0.1, slow 0.05, dead 50, range 100', () => {
    const cfg: RivalConfig = {
      ...RC,
      rubberBoost: 0.1,
      rubberSlow: 0.05,
      rubberDead: 50,
      rubberRange: 100,
    };
    expect(capAt(100, cfg)).toBeCloseTo(1.05, 9); // 1 + 0.1 * (50/100)
    expect(capAt(-100, cfg)).toBeCloseTo(0.975, 9); // 1 - 0.05 * 0.5
    expect(capAt(150, cfg)).toBeCloseTo(1.1, 9); // clamp at 1
    expect(capAt(-150, cfg)).toBeCloseTo(0.95, 9);
    expect(capAt(50, cfg)).toBeCloseTo(1, 9);
    expect(capAt(-50, cfg)).toBeCloseTo(1, 9);
  });
  it('the band multiplies the paced cap: pace 1.02 behind 240 -> 1.02 * 1.08 = 1.1016', () => {
    expect(capAt(240, RC, 1.02)).toBeCloseTo(1.1016, 9);
    expect(capAt(-240, RC, 1.02)).toBeCloseTo(1.02 * 0.92, 9); // 0.9384
  });
  it('rubberBand = 0: off, the cap stays pace * vmax at any distance', () => {
    const off: RivalConfig = { ...RC, rubberBand: 0 };
    for (const d of [-400, -140, 0, 140, 400]) {
      expect(capAt(d, off)).toBeCloseTo(1, 6);
      expect(capAt(d, off, 1.03)).toBeCloseTo(1.03, 6);
    }
  });
  it('no rival config passed: no band', () => {
    expect(capAt(400, undefined)).toBeCloseTo(1, 6);
    expect(capAt(-400, undefined)).toBeCloseTo(1, 6);
  });
  it('the player is never affected: cap stays vmax with rivals far ahead and far behind', () => {
    for (const rivalZ of [-400, 400]) {
      const s = mkRace(1, 0, [
        { z: 0, x: 0, speed: 0 },
        { z: rivalZ, x: 0.5, speed: 0 },
      ]);
      step(s, [IDLE, IDLE], TRACK, [SNAP, PLAYER], undefined, RC);
      expect(s.cars[0]!.speed).toBeCloseTo(1, 6);
    }
  });
  it('traffic is not affected by the band either (R70 rails)', () => {
    const s = mkRace(0, 1, [
      { z: 0, x: 0, speed: 0 },
      { z: -400, x: 0.5, speed: 0.5 },
    ]);
    step(s, [IDLE, IDLE], TRACK, [PLAYER, SNAP], undefined, RC);
    expect(s.cars[1]!.speed).toBe(0.5);
  });
  it('only the cap changes: steering and lateral motion of step 1 are identical with the band on and off', () => {
    const steer: InputFrame = { steer: 0.7, brake: false, drift: false };
    const run = (cfg: RivalConfig): { x: number; vx: number; speed: number } => {
      const s = mkRace(1, 0, [
        { z: 0, x: 0, speed: 0 },
        { z: -240, x: 0.2, speed: 0.5 },
      ]);
      step(s, [IDLE, steer], TRACK, [PLAYER, SNAP], undefined, cfg);
      const c = s.cars[1]!;
      return { x: c.x, vx: c.vx, speed: c.speed };
    };
    const on = run(RC);
    const off = run({ ...RC, rubberBand: 0 });
    expect(on.x).toBe(off.x); // sp0 uses the speed before R14, which is the same 0.5
    expect(on.vx).toBe(off.vx);
    expect(on.speed).toBeGreaterThan(off.speed + 0.05); // 1.08 vs 1
  });
  it('the band follows the player as it moves: a rival that closes in loses the boost step by step', () => {
    // Player stands at z 0; rival starts 240 behind at its cap and drives 0.5 segments per tick.
    // 400 ticks later it is about 200 segments closer, so the boost must have shrunk.
    const s = mkRace(1, 0, [
      { z: 0, x: 0, speed: 0 },
      { z: -240, x: 0.5, speed: 1.08 },
    ]);
    const p: CarParams = { ...baseCarA, accel: 5, driftBrake: 5 };
    const first = capAt(240, RC);
    for (let i = 0; i < 400; i++) step(s, [IDLE, IDLE], TRACK, [PLAYER, p], undefined, RC);
    expect(first).toBeCloseTo(1.08, 9);
    expect(s.cars[1]!.speed).toBeLessThan(1.08 - 0.02);
    expect(s.cars[1]!.speed).toBeGreaterThanOrEqual(1 - TOL);
  });
});

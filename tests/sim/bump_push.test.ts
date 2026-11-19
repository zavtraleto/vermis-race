import { describe, expect, it } from 'vitest';
import base from '../../src/data/cars/base.json';
import { DT } from '../../src/sim/constants';
import { createRace, placeTraffic, step } from '../../src/sim/race';
import type { Car, CarParams } from '../../src/sim/types';
import { BP, CFG, IDLE, TRACK, setup, stepOnce } from './traffic_helpers';
import { BP as RBP, FAR_PLAYER, RC, after1, mkRace, stepAll } from './rivals_helpers';

// R41 (rewritten 2026-11-19) and R41b, checked from the brief only.
// New fields are accessed through casts so that only assertions fail before the implementation exists.
//
// Geometry as in bump.test.ts: setup() gives POST-step positions. BP: accel 0, vmax 1, carLength 1.5,
// hit half width (0.2 + 0.2)/2 = 0.2. Rear hit: z < zT - 0.75. Explicit params in BP:
// bumpSpeedLoss 0.1, bumpSideLoss 0.05, bumpFloor 0.3, bumpPush 0.1, bumpPushDecay 0.25 (all x vmax).
const cruiseOf = (c: Car): number => (c as Car & { cruise: number }).cruise;
const P = (speed: number, x = 0) => ({ z: 10, x, speed });
const DECAY = 0.25 * DT; // bumpPushDecay * vmax(1) * DT = 0.25 / 120 per step

describe('R41 rear hit', () => {
  it('hitter speed from its OWN speed, traffic pushed: 0.8 vs 0.5 -> hitter 0.7, traffic 0.9', () => {
    // dz = zT - z = 0.9 > 0.75 -> rear. v0 = 0.8.
    // hitter: min(0.8, max(0.8 - 0.1*1, 0.3*1)) = min(0.8, 0.7) = 0.7 (old rule would give 0.4)
    // traffic: max(0.5, 0.8 + 0.1*1) = 0.9
    const s = setup(P(0.8), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.7, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(0.9, 12);
  });

  it('traffic already faster than v0 + push is not slowed: v0 0.6, traffic 0.75', () => {
    // hitter: min(0.6, max(0.5, 0.3)) = 0.5; traffic: max(0.75, 0.6 + 0.1) = 0.75
    const s = setup(P(0.6), [{ z: 10.9, x: 0.1, speed: 0.75 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.5, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(0.75, 12);
  });

  it('floor: v0 0.35 -> min(0.35, max(0.25, 0.3)) = 0.3; traffic max(0.2, 0.45) = 0.45', () => {
    const s = setup(P(0.35), [{ z: 10.9, x: 0.1, speed: 0.2 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.3, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(0.45, 12);
  });

  it('hitter below the floor is never raised: v0 0.2 -> 0.2; traffic max(0.5, 0.3) = 0.5', () => {
    // min(0.2, max(0.2 - 0.1, 0.3)) = min(0.2, 0.3) = 0.2
    const s = setup(P(0.2), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.2, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(0.5, 12);
  });

  it('the hitter loss does not depend on the traffic speed', () => {
    const run = (tSpeed: number): number => {
      const s = setup(P(0.8), [{ z: 10.9, x: 0.1, speed: tSpeed }]);
      stepOnce(s);
      return s.cars[0]!.speed;
    };
    expect(run(0.4)).toBeCloseTo(0.7, 12);
    expect(run(0.7)).toBeCloseTo(0.7, 12);
  });

  it('numbers scale with vmax: vmax 0.5, v0 0.4 -> hitter 0.35, traffic 0.45', () => {
    // hitter: min(0.4, max(0.4 - 0.1*0.5, 0.3*0.5)) = min(0.4, max(0.35, 0.15)) = 0.35
    // traffic: max(0.2, 0.4 + 0.1*0.5) = 0.45
    const s = setup(P(0.4), [{ z: 10.9, x: 0.1, speed: 0.2 }]);
    step(
      s,
      s.cars.map(() => IDLE),
      TRACK,
      s.cars.map(() => ({ ...BP, vmax: 0.5 })),
    );
    expect(s.cars[0]!.speed).toBeCloseTo(0.35, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(0.45, 12);
  });

  it('left/right symmetric: traffic on either side gives identical speeds', () => {
    for (const tx of [-0.1, 0.1]) {
      const s = setup(P(0.8), [{ z: 10.9, x: tx, speed: 0.5 }]);
      stepOnce(s);
      expect(s.cars[0]!.speed).toBeCloseTo(0.7, 12);
      expect(s.cars[1]!.speed).toBeCloseTo(0.9, 12);
    }
  });

  it('bounds: hitter never gains speed and ends >= min(v0, floor); traffic ends >= max(speedT, v0 + push)', () => {
    for (const v0 of [0.1, 0.3, 0.45, 0.8, 1]) {
      for (const sT of [0.2, 0.5, 0.9]) {
        const s = setup(P(v0), [{ z: 10.9, x: 0.1, speed: sT }]);
        stepOnce(s);
        expect(s.cars[0]!.speed).toBeLessThanOrEqual(v0 + 1e-12);
        expect(s.cars[0]!.speed).toBeGreaterThanOrEqual(Math.min(v0, 0.3) - 1e-12);
        expect(s.cars[1]!.speed).toBeGreaterThanOrEqual(Math.max(sT, v0 + 0.1) - 1e-12);
      }
    }
  });

  it('determinism: the same setup twice gives identical state', () => {
    const run = () => {
      const s = setup(P(0.8), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
      for (let i = 0; i < 20; i++) stepOnce(s);
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
  });

  it('state round-trips through JSON and cruise is a plain number', () => {
    const s = setup(P(0.8), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    const back = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(back).toEqual(s);
    expect(typeof cruiseOf(back.cars[1]!)).toBe('number');
  });
});

describe('R41 side contact', () => {
  it('hitter loses 0.05*vmax, traffic untouched: 0.8 -> 0.75', () => {
    // dz = 0 -> side. 0.8 - 0.05*1 = 0.75, floor 0.3 not reached; traffic speed stays 0.5
    const s = setup(P(0.8), [{ z: 10, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.75, 12);
    expect(s.cars[1]!.speed).toBe(0.5);
  });

  it('traffic slightly ahead but within the rear threshold (zT - z = 0.5 <= 0.75) is a side contact: no push', () => {
    const s = setup(P(0.8), [{ z: 10.5, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.75, 12);
    expect(s.cars[1]!.speed).toBe(0.5);
  });

  it('floor: 0.32 - 0.05 = 0.27 -> 0.3', () => {
    const s = setup(P(0.32), [{ z: 10, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.3, 12);
  });

  it('never raised: v0 0.2 (below the floor 0.3) stays 0.2', () => {
    // v0 - 0.05 = 0.15 < floor 0.3, but the speed must not be lifted above v0
    const s = setup(P(0.2), [{ z: 10, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.2, 12);
  });

  it('left/right symmetric', () => {
    for (const tx of [-0.1, 0.1]) {
      const s = setup(P(0.8), [{ z: 10, x: tx, speed: 0.5 }]);
      stepOnce(s);
      expect(s.cars[0]!.speed).toBeCloseTo(0.75, 12);
      expect(s.cars[1]!.speed).toBe(0.5);
    }
  });
});

describe('R41b traffic cruise', () => {
  it('createRace: every car has cruise 0 (player, rivals, traffic)', () => {
    for (const c of createRace(1, 2, 3).cars) expect(cruiseOf(c)).toBe(0);
  });

  it('placeTraffic: traffic cruise = its R71 speed, player and rivals keep 0', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const s = createRace(seed, 2, CFG.trafficMax);
      placeTraffic(s, CFG, 0.9);
      expect(cruiseOf(s.cars[0]!)).toBe(0);
      expect(cruiseOf(s.cars[1]!)).toBe(0);
      for (const c of s.cars.filter((k) => k.kind === 'traffic')) {
        expect(c.speed).toBeGreaterThan(0);
        expect(cruiseOf(c)).toBe(c.speed);
      }
    }
  });

  it('respawn: the car gets a new cruise equal to its new speed (also when it was pushed)', () => {
    // Player at z 500, speed 0; traffic 35 behind (stale) respawns on tick 1.
    const s = setup({ z: 500, x: 0, speed: 0 }, [{ z: 465, x: 0.25, speed: 0.5 }]);
    const t = s.cars[1]!;
    t.speed = 0.95; // pushed earlier: above cruise 0.5
    stepOnce(s, undefined, CFG);
    expect(t.z).toBeGreaterThan(500);
    expect(t.speed).toBeGreaterThanOrEqual(0.4 - 1e-12);
    expect(t.speed).toBeLessThanOrEqual(0.7 + 1e-12);
    expect(cruiseOf(t)).toBe(t.speed);
  });

  it('a pushed car decays by bumpPushDecay*vmax*DT per step: 0.9 - k * 0.25/120', () => {
    const s = setup({ z: 500, x: 0, speed: 0 }, [{ z: 100, x: 0.25, speed: 0.5 }]);
    const t = s.cars[1]!;
    t.speed = 0.9; // cruise stays 0.5
    for (let k = 1; k <= 10; k++) {
      stepOnce(s);
      expect(t.speed).toBeCloseTo(0.9 - k * DECAY, 12);
    }
  });

  it('decay is monotone, never below cruise, and lands exactly on cruise (0.4 / (0.25/120) = 192 steps)', () => {
    const s = setup({ z: 500, x: 0, speed: 0 }, [{ z: 100, x: 0.25, speed: 0.5 }]);
    const t = s.cars[1]!;
    t.speed = 0.9;
    let prev = t.speed;
    for (let k = 1; k <= 300; k++) {
      stepOnce(s);
      expect(t.speed).toBeLessThanOrEqual(prev);
      expect(t.speed).toBeGreaterThanOrEqual(0.5);
      prev = t.speed;
      if (k <= 190) expect(t.speed).toBeGreaterThan(0.5);
      if (k >= 193) expect(t.speed).toBe(0.5);
    }
  });

  it('decay scales with the player vmax: vmax 0.5 halves the step', () => {
    const s = setup({ z: 500, x: 0, speed: 0 }, [{ z: 100, x: 0.25, speed: 0.5 }]);
    const t = s.cars[1]!;
    t.speed = 0.9;
    const p: CarParams = { ...BP, vmax: 0.5 };
    for (let k = 1; k <= 10; k++) {
      step(
        s,
        s.cars.map(() => IDLE),
        TRACK,
        s.cars.map(() => p),
      );
      expect(t.speed).toBeCloseTo(0.9 - k * 0.25 * 0.5 * DT, 12);
    }
  });

  it('traffic that was not pushed keeps speed == cruise exactly', () => {
    const s = setup({ z: 500, x: 0, speed: 0 }, [
      { z: 100, x: 0.25, speed: 0.5 },
      { z: 140, x: -0.25, speed: 0.62 },
    ]);
    for (let i = 0; i < 400; i++) stepOnce(s);
    expect(s.cars[1]!.speed).toBe(0.5);
    expect(s.cars[2]!.speed).toBe(0.62);
    expect(cruiseOf(s.cars[1]!)).toBe(0.5);
    expect(cruiseOf(s.cars[2]!)).toBe(0.62);
  });

  it('after a rear hit the pushed car decays one step at a time: hit step 0.9, next 0.9 - 0.25/120', () => {
    const s = setup(P(0.8), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[1]!.speed).toBeCloseTo(0.9, 12);
    stepOnce(s);
    expect(s.cars[1]!.speed).toBeCloseTo(0.9 - DECAY, 12);
  });

  it('player cruise stays 0 after contacts and steps', () => {
    const s = setup(P(0.8), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
    for (let i = 0; i < 5; i++) stepOnce(s);
    expect(cruiseOf(s.cars[0]!)).toBe(0);
  });
});

describe('R64 rival rear-hits traffic like the player (R41)', () => {
  it('rival 0.8 into traffic 0.6 -> rival 0.7, traffic 0.9, then decays toward cruise 0.6', () => {
    // mkRace sets the traffic cruise to its speed (0.6). Rear: zT - z = 1 > 0.75; dx = 0.3 < 0.4.
    // rival: min(0.8, max(0.8 - 0.1, 0.3)) = 0.7; traffic: max(0.6, 0.8 + 0.1) = 0.9
    const s = mkRace(1, 1, [
      FAR_PLAYER,
      after1({ z: 10, x: 0, speed: 0.8 }),
      after1({ z: 11, x: 0.3, speed: 0.6 }),
    ]);
    stepAll(s, RBP, RC);
    expect(s.cars[1]!.speed).toBeCloseTo(0.7, 12);
    expect(s.cars[2]!.speed).toBeCloseTo(0.9, 12);
    stepAll(s, RBP, RC);
    expect(s.cars[2]!.speed).toBeCloseTo(0.9 - DECAY, 12);
  });

  it('rival side contact leaves the traffic speed alone', () => {
    const s = mkRace(1, 1, [
      FAR_PLAYER,
      after1({ z: 10, x: 0.1, speed: 0.8 }),
      after1({ z: 10, x: 0, speed: 0.6 }),
    ]);
    stepAll(s, RBP, RC);
    expect(s.cars[1]!.speed).toBeCloseTo(0.75, 12);
    expect(s.cars[2]!.speed).toBe(0.6);
  });
});

describe('R41 data (base.json)', () => {
  it('bumpSpeedLoss 0.12, bumpSideLoss 0.06, bumpPush 0.1, bumpPushDecay 0.25', () => {
    const b = base as unknown as Record<string, number>;
    expect(b.bumpSpeedLoss).toBe(0.12);
    expect(b.bumpSideLoss).toBe(0.06);
    expect(b.bumpPush).toBe(0.1);
    expect(b.bumpPushDecay).toBe(0.25);
  });
});

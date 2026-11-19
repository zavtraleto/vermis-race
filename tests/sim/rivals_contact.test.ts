import { describe, expect, it } from 'vitest';
import type { Car, RivalConfig } from '../../src/sim/types';
import { BP, BUMP_TICKS, FAR_PLAYER, RC, after1, mkRace, stepAll } from './rivals_helpers';

// Geometry: speeds are constant (accel 0). Speed 0.5 moves 0.25 segments per tick (exact in binary).
// BP: carLength 1.5, carHitW 0.2 (R65 width), trafficHitW 0.6 (must NOT widen the race-car contact),
// bumpKick 0.6, bumpFloor 0.3 (times vmax = 1), rivalBumpLoss 0.1 (RC), bumpTicks 96.
type Spec = { z: number; x: number; speed: number } & Partial<Car>;

/** Two rivals A (index 1) and B (index 2), player parked far away. Positions are the post-step ones. */
function pair(a: Spec, b: Spec, rc: RivalConfig = RC) {
  const s = mkRace(2, 0, [FAR_PLAYER, { ...a, ...after1(a) }, { ...b, ...after1(b) }]);
  stepAll(s, BP, rc);
  return { a: s.cars[1]!, b: s.cars[2]!, s };
}

describe('R65 contact conditions and edges', () => {
  it('|dz| < carLength and |dx| < carHitW: both bumped (bumpTicks 96)', () => {
    const { a, b } = pair({ z: 10, x: 0, speed: 0.8 }, { z: 11, x: 0.1, speed: 0.6 });
    expect(a.bumpTicks).toBe(BUMP_TICKS);
    expect(b.bumpTicks).toBe(BUMP_TICKS);
  });
  it('dz edge: 1.49 contact, 1.5 (strict) and 1.51 none, in both directions', () => {
    for (const [dzv, hit] of [
      [1.49, true],
      [1.5, false],
      [1.51, false],
    ] as const) {
      const f = pair({ z: 10, x: 0, speed: 0.5 }, { z: 10 + dzv, x: 0.1, speed: 0.5 });
      expect(f.a.bumpTicks > 0, `dz ${dzv}`).toBe(hit);
      expect(f.b.bumpTicks > 0, `dz ${dzv}`).toBe(hit);
      const r = pair({ z: 10 + dzv, x: 0, speed: 0.5 }, { z: 10, x: 0.1, speed: 0.5 });
      expect(r.a.bumpTicks > 0, `dz -${dzv}`).toBe(hit);
    }
  });
  it('dx edge: 0.19 contact, 0.2 (strict) and 0.21 none, either side; traffic width 0.6 does not apply', () => {
    for (const [dxv, hit] of [
      [0.19, true],
      [0.2, false],
      [0.21, false],
      [0.35, false],
    ] as const) {
      for (const sign of [1, -1]) {
        const f = pair({ z: 10, x: 0, speed: 0.5 }, { z: 10, x: sign * dxv, speed: 0.5 });
        expect(f.a.bumpTicks > 0, `dx ${sign * dxv}`).toBe(hit);
        expect(f.b.bumpTicks > 0, `dx ${sign * dxv}`).toBe(hit);
      }
    }
  });
  it('no contact: speeds, vx and bumpTicks stay untouched', () => {
    const { a, b } = pair({ z: 10, x: 0, speed: 0.8 }, { z: 10, x: 0.5, speed: 0.6 });
    expect([a.speed, a.vx, a.bumpTicks]).toEqual([0.8, 0, 0]);
    expect([b.speed, b.vx, b.bumpTicks]).toEqual([0.6, 0, 0]);
  });
  it('no contact while either car has bumpTicks > 0 (the counter counts down: 5 -> 4)', () => {
    const f = pair({ z: 10, x: 0, speed: 0.8, bumpTicks: 5 }, { z: 11, x: 0.1, speed: 0.6 });
    expect(f.a.bumpTicks).toBe(4);
    expect(f.b.bumpTicks).toBe(0);
    expect(f.a.speed).toBeCloseTo(0.8, 12);
    expect(f.b.speed).toBeCloseTo(0.6, 12);
    expect([f.a.vx, f.b.vx]).toEqual([0, 0]);
    const g = pair({ z: 10, x: 0, speed: 0.8 }, { z: 11, x: 0.1, speed: 0.6, bumpTicks: 5 });
    expect(g.a.bumpTicks).toBe(0);
    expect(g.a.speed).toBeCloseTo(0.8, 12);
  });
  it('no contact while either car has crashTicks > 0', () => {
    const crashed = { crashTicks: 50, crashSpeed0: 0.5, crashX0: 0.6 };
    const f = pair({ z: 10, x: 0.6, speed: 0.5, ...crashed }, { z: 10.5, x: 0.65, speed: 0.5 });
    expect(f.b.bumpTicks).toBe(0);
    expect(f.b.speed).toBeCloseTo(0.5, 12);
    const g = pair({ z: 10, x: 0.65, speed: 0.5 }, { z: 10.5, x: 0.6, speed: 0.5, ...crashed });
    expect(g.a.bumpTicks).toBe(0);
    expect(g.a.speed).toBeCloseTo(0.5, 12);
  });
  it('traffic is never touched by R65 and does not trigger it between two traffic cars', () => {
    const s = mkRace(0, 2, [
      FAR_PLAYER,
      after1({ z: 100, x: 0.25, speed: 0.5 }),
      after1({ z: 100.2, x: 0.25, speed: 0.4 }),
    ]);
    stepAll(s, BP, RC);
    expect([s.cars[1]!.speed, s.cars[2]!.speed]).toEqual([0.5, 0.4]);
    expect(s.cars[1]!.bumpTicks + s.cars[2]!.bumpTicks).toBe(0);
  });
});

describe('R65 speed: only the rear car slows', () => {
  // rear: min(speed, max(speedFront - 0.1*vmax, 0.3*vmax)); front keeps its speed.
  it('rear 0.8, front 0.6: max(0.6 - 0.1, 0.3) = 0.5, min(0.8, 0.5) = 0.5; front stays 0.6', () => {
    const f = pair({ z: 10, x: 0, speed: 0.8 }, { z: 11, x: 0.1, speed: 0.6 });
    expect(f.a.speed).toBeCloseTo(0.5, 12);
    expect(f.b.speed).toBeCloseTo(0.6, 12);
  });
  it('mirrored indices: rear is the higher index (B behind): B 0.5, A 0.6', () => {
    const f = pair({ z: 11, x: 0, speed: 0.6 }, { z: 10, x: 0.1, speed: 0.8 });
    expect(f.b.speed).toBeCloseTo(0.5, 12);
    expect(f.a.speed).toBeCloseTo(0.6, 12);
  });
  it('floor: rear 0.8, front 0.35: max(0.25, 0.3) = 0.3 -> 0.3', () => {
    const f = pair({ z: 10, x: 0, speed: 0.8 }, { z: 11, x: 0.1, speed: 0.35 });
    expect(f.a.speed).toBeCloseTo(0.3, 12);
    expect(f.b.speed).toBeCloseTo(0.35, 12);
  });
  it('the rear car is already slower: min(0.2, max(0.5, 0.3)) = 0.2, never raised; still a contact', () => {
    const f = pair({ z: 10, x: 0, speed: 0.2 }, { z: 11, x: 0.1, speed: 0.6 });
    expect(f.a.speed).toBeCloseTo(0.2, 12);
    expect(f.a.bumpTicks).toBe(BUMP_TICKS);
    expect(f.b.bumpTicks).toBe(BUMP_TICKS);
  });
  it('rivalBumpLoss comes from the config: 0.2 -> max(0.6 - 0.2, 0.3) = 0.4', () => {
    const f = pair(
      { z: 10, x: 0, speed: 0.8 },
      { z: 11, x: 0.1, speed: 0.6 },
      { ...RC, rivalBumpLoss: 0.2 },
    );
    expect(f.a.speed).toBeCloseTo(0.4, 12);
  });
  it('the rear car decides by z, also when it is "front" in the dz < carLength/2 sense (any z difference)', () => {
    // dz = 0.3 (tiny): still the lower z is the rear car. min(0.8, max(0.5, 0.3)) = 0.5
    const f = pair({ z: 10, x: 0, speed: 0.8 }, { z: 10.3, x: 0.1, speed: 0.6 });
    expect(f.a.speed).toBeCloseTo(0.5, 12);
    expect(f.b.speed).toBeCloseTo(0.6, 12);
  });
  it('equal z: the car with the larger index is the rear one (A 0.6, B 0.8 -> B 0.5, A 0.6)', () => {
    const f = pair({ z: 10, x: 0, speed: 0.6 }, { z: 10, x: 0.1, speed: 0.8 });
    expect(f.b.speed).toBeCloseTo(0.5, 12);
    expect(f.a.speed).toBeCloseTo(0.6, 12);
  });
  it('speed never rises and never goes below min(own speed, bumpFloor*vmax)', () => {
    for (const sa of [0.2, 0.35, 0.5, 0.7, 0.9]) {
      for (const sb of [0.2, 0.35, 0.5, 0.7, 0.9]) {
        const f = pair({ z: 10, x: 0, speed: sa }, { z: 11, x: 0.1, speed: sb });
        expect(f.a.speed).toBeLessThanOrEqual(sa + 1e-12);
        expect(f.a.speed).toBeGreaterThanOrEqual(Math.min(sa, 0.3) - 1e-12);
        expect(f.b.speed).toBeCloseTo(sb, 12);
      }
    }
  });
});

describe('R65 side push (as R42)', () => {
  it('the car with the smaller x goes left (-0.6), the other right (+0.6)', () => {
    const f = pair({ z: 10, x: 0, speed: 0.5 }, { z: 10, x: 0.1, speed: 0.5 });
    expect(f.a.vx).toBeCloseTo(-0.6, 12);
    expect(f.b.vx).toBeCloseTo(0.6, 12);
  });
  it('mirror symmetry: B on the left of A swaps the directions', () => {
    for (const d of [0.05, 0.1, 0.15]) {
      const r = pair({ z: 10, x: 0, speed: 0.5 }, { z: 10, x: d, speed: 0.5 });
      const l = pair({ z: 10, x: 0, speed: 0.5 }, { z: 10, x: -d, speed: 0.5 });
      expect(l.a.vx).toBeCloseTo(-r.a.vx, 12);
      expect(l.b.vx).toBeCloseTo(-r.b.vx, 12);
      expect(r.a.vx).toBeCloseTo(-0.6, 12);
    }
  });
  it('equal x: the smaller index goes left (-0.6), the larger right (+0.6), at any x', () => {
    for (const x of [-0.5, 0, 0.5]) {
      const f = pair({ z: 10, x, speed: 0.5 }, { z: 10.5, x, speed: 0.5 });
      expect(f.a.vx, `x=${x}`).toBeCloseTo(-0.6, 12);
      expect(f.b.vx, `x=${x}`).toBeCloseTo(0.6, 12);
    }
  });
  it('the push is applied to both cars and keeps their x (R42: only vx)', () => {
    const f = pair({ z: 10, x: 0.3, speed: 0.5 }, { z: 10, x: 0.4, speed: 0.5 });
    expect(f.a.x).toBeCloseTo(0.3, 12);
    expect(f.b.x).toBeCloseTo(0.4, 12);
  });
});

describe('R65 at most one contact per car per step, pairs in index order', () => {
  it('A-B-C all overlapping: (A,B) touch; C is untouched (A and B are busy, C has no partner)', () => {
    const s = mkRace(3, 0, [
      FAR_PLAYER,
      after1({ z: 10, x: 0, speed: 0.5 }),
      after1({ z: 10, x: 0.1, speed: 0.5 }),
      after1({ z: 10, x: 0.15, speed: 0.5 }),
    ]);
    stepAll(s, BP, RC);
    const [a, b, c] = [s.cars[1]!, s.cars[2]!, s.cars[3]!];
    expect([a.bumpTicks, b.bumpTicks]).toEqual([BUMP_TICKS, BUMP_TICKS]);
    expect(c.bumpTicks).toBe(0);
    expect(c.vx).toBe(0);
    expect(c.speed).toBeCloseTo(0.5, 12);
    // A (front on the tie, smaller index) keeps 0.5; B (rear) min(0.5, max(0.4, 0.3)) = 0.4
    expect(a.speed).toBeCloseTo(0.5, 12);
    expect(b.speed).toBeCloseTo(0.4, 12);
  });
  it('player index 0 pairs first: player-rival contact comes before rival-rival', () => {
    const s = mkRace(2, 0, [
      after1({ z: 10, x: 0, speed: 0.5 }),
      after1({ z: 10, x: 0.1, speed: 0.5 }),
      after1({ z: 10, x: 0.15, speed: 0.5 }),
    ]);
    stepAll(s, BP, RC);
    expect([s.cars[0]!.bumpTicks, s.cars[1]!.bumpTicks, s.cars[2]!.bumpTicks]).toEqual([
      BUMP_TICKS,
      BUMP_TICKS,
      0,
    ]);
  });
  it('two separate pairs touch independently in one step', () => {
    const s = mkRace(4, 0, [
      FAR_PLAYER,
      after1({ z: 10, x: 0, speed: 0.5 }),
      after1({ z: 10, x: 0.1, speed: 0.5 }),
      after1({ z: 50, x: 0, speed: 0.5 }),
      after1({ z: 50, x: 0.1, speed: 0.5 }),
    ]);
    stepAll(s, BP, RC);
    for (let i = 1; i <= 4; i++) expect(s.cars[i]!.bumpTicks, `car ${i}`).toBe(BUMP_TICKS);
  });
});

describe('R65 player and rival', () => {
  it('player behind the rival: the player slows (min(0.8, max(0.6 - 0.1, 0.3)) = 0.5), the rival keeps 0.6', () => {
    const s = mkRace(1, 0, [
      after1({ z: 10, x: 0, speed: 0.8 }),
      after1({ z: 11, x: 0.1, speed: 0.6 }),
    ]);
    stepAll(s, BP, RC);
    expect(s.cars[0]!.speed).toBeCloseTo(0.5, 12);
    expect(s.cars[1]!.speed).toBeCloseTo(0.6, 12);
    expect(s.cars[0]!.vx).toBeCloseTo(-0.6, 12);
    expect(s.cars[1]!.vx).toBeCloseTo(0.6, 12);
    expect([s.cars[0]!.bumpTicks, s.cars[1]!.bumpTicks]).toEqual([BUMP_TICKS, BUMP_TICKS]);
  });
  it('rival behind the player: the rival slows, the player keeps its speed', () => {
    const s = mkRace(1, 0, [
      after1({ z: 11, x: 0, speed: 0.6 }),
      after1({ z: 10, x: 0.1, speed: 0.8 }),
    ]);
    stepAll(s, BP, RC);
    expect(s.cars[1]!.speed).toBeCloseTo(0.5, 12);
    expect(s.cars[0]!.speed).toBeCloseTo(0.6, 12);
  });
  it('equal z: the rival (larger index) is the rear car', () => {
    const s = mkRace(1, 0, [
      after1({ z: 10, x: 0, speed: 0.6 }),
      after1({ z: 10, x: 0.1, speed: 0.8 }),
    ]);
    stepAll(s, BP, RC);
    expect(s.cars[1]!.speed).toBeCloseTo(0.5, 12);
    expect(s.cars[0]!.speed).toBeCloseTo(0.6, 12);
  });
});

describe('R65 / R44 a drift is not broken by a contact', () => {
  const drifting = {
    state: 'DRIFT' as const,
    dir: 1 as const,
    angle: 0.8,
    steer: 1,
    driftHeld: true,
  };
  const run = (bx: number) => {
    const s = mkRace(2, 0, [
      FAR_PLAYER,
      { ...after1({ z: 10, x: 0, speed: 0.8 }), ...drifting },
      { ...after1({ z: 10, x: bx, speed: 0.8 }), ...drifting },
    ]);
    const f = { steer: 1, brake: false, drift: true };
    stepAll(s, BP, RC, [f, f, f]);
    return s;
  };
  it('both cars stay in DRIFT; |angle| is smaller by bumpAngleLoss 0.3 than in the same step without contact', () => {
    const touch = run(0.1);
    const free = run(0.9); // control: same step, no contact
    expect(free.cars[1]!.bumpTicks).toBe(0);
    for (const i of [1, 2]) {
      expect(touch.cars[i]!.bumpTicks, `car ${i}`).toBe(BUMP_TICKS);
      expect(touch.cars[i]!.state).toBe('DRIFT');
      expect(touch.cars[i]!.dir).toBe(1);
      expect(touch.cars[i]!.angle).toBeCloseTo(free.cars[i]!.angle - 0.3, 9);
    }
  });
});

describe('R65 properties', () => {
  it('determinism: the same setup twice gives identical JSON', () => {
    const mk = () => {
      const s = mkRace(3, 0, [
        FAR_PLAYER,
        after1({ z: 10, x: 0, speed: 0.8 }),
        after1({ z: 10.4, x: 0.1, speed: 0.6 }),
        after1({ z: 10.8, x: -0.1, speed: 0.7 }),
      ]);
      for (let i = 0; i < 50; i++) stepAll(s, BP, RC);
      return JSON.stringify(s);
    };
    expect(mk()).toBe(mk());
  });
});

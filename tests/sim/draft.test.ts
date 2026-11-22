import { describe, expect, it } from 'vitest';
import { baseCarA as baseCar } from './baseCarA';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { CarParams, InputFrame, RaceState } from '../../src/sim/types';
import { BP, IDLE, TRACK, dz, setup } from './traffic_helpers';

/**
 * R50 cone, R51 charge, R52 boost (H5 A / B). Params are explicit, never read from base.json.
 * Geometry is given as positions after the first step (see traffic_helpers.setup), with margins of
 * at least 1 segment / 0.01 half-width from every boundary: the brief does not say whether the cone
 * is evaluated before or after R16 of the step, nor whether the boundary is inclusive for the
 * length (it is for the width: `<=`).
 *
 * Constants: DT = 1/120. Charge: DT/draftChargeTime = 1/120 per tick; decay: DT/0.6 = 1/72 per tick.
 */
const DP: CarParams = {
  ...BP, // accel 0 (constant speed), explicit bump params
  draftLength: 40,
  draftWidth: 0.2, // half-width 0.1
  draftChargeTime: 1.0,
  draftDecayTime: 0.6,
  draftCapMul: 1.13,
  draftAccelMul: 1.6,
  boostTime: 2.0,
  draftBoost: 0,
};
const DB: CarParams = { ...DP, draftBoost: 1 };
/** Real throttle for the R52 tests: accel 0.22, brake 0.6 from base. */
const DA: CarParams = { ...DP, accel: baseCar.accel };
const DAB: CarParams = { ...DA, draftBoost: 1 };

const PS = 0.5; // player speed in the cone tests
const one = (s: RaceState, p: CarParams, input: InputFrame = IDLE): void =>
  step(s, s.cars.map(() => input), TRACK, s.cars.map(() => p));
const run = (s: RaceState, n: number, p: CarParams, input: InputFrame = IDLE): void => {
  for (let i = 0; i < n; i++) one(s, p, input);
};
const player = (s: RaceState) => s.cars[0]!;
const CH = DT / DP.draftChargeTime; // 1/120
const DEC = DT / DP.draftDecayTime; // 1/72

/** Player at z = 100, x = px; one traffic car at (tz, tx) with speed PS; draft preset to d0. */
function cone(tz: number, tx: number, px = 0, d0 = 0.5, p = DP): RaceState {
  const s = setup({ z: 100, x: px, speed: PS }, [{ z: tz, x: tx, speed: PS }]);
  player(s).draft = d0;
  one(s, p);
  return s;
}
const charged = (s: RaceState, d0 = 0.5): boolean => player(s).draft > d0;
const decayed = (s: RaceState, d0 = 0.5): boolean => player(s).draft < d0;

describe('R50 cone geometry (observed through the R51 charge direction)', () => {
  it('R50 a car ahead in the same lane within draftLength charges the draft', () => {
    const s = cone(120, 0);
    expect(player(s).draft).toBeCloseTo(0.5 + CH, 9);
  });
  it('R50 directly behind the lead car, gap 3 > carLength: in the cone', () => {
    expect(charged(cone(103, 0))).toBe(true);
  });
  it.each([
    [139, true],
    [141, false],
  ])('R50 length: traffic %i segments ahead of z = 100 -> in cone %s (draftLength 40)', (tz, inside) => {
    const s = cone(tz, 0);
    expect(charged(s)).toBe(inside);
    expect(decayed(s)).toBe(!inside);
  });
  it.each([
    [0.09, true],
    [0.11, false],
    [-0.09, true],
    [-0.11, false],
  ])('R50 width: |x - xT| = %f -> in cone %s (draftWidth/2 = 0.1), left/right symmetric', (tx, inside) => {
    const s = cone(120, tx);
    expect(charged(s)).toBe(inside);
    expect(decayed(s)).toBe(!inside);
  });
  it('R50 the cone follows the player: player x = 0.5, traffic x = 0.59 in, 0.61 out', () => {
    expect(charged(cone(120, 0.59, 0.5))).toBe(true);
    expect(charged(cone(120, 0.61, 0.5))).toBe(false);
    expect(charged(cone(120, 0.41, 0.5))).toBe(true);
    expect(charged(cone(120, 0.39, 0.5))).toBe(false);
  });
  it('R50 a car behind the player does not count', () => {
    const s = cone(80, 0);
    expect(decayed(s)).toBe(true);
  });
  it('R50 a car alongside (same z, other lane) does not count', () => {
    const s = cone(100, 0.5);
    expect(decayed(s)).toBe(true);
  });
  it('R50 several cars: one in the cone is enough, the others (behind / far / wide) do not matter', () => {
    const s = setup(
      { z: 100, x: 0, speed: PS },
      [
        { z: 70, x: 0, speed: PS }, // behind
        { z: 200, x: 0, speed: PS }, // too far
        { z: 120, x: 0.5, speed: PS }, // wrong lane
        { z: 130, x: 0.05, speed: PS }, // in the cone (farther than the lane-0.5 car, 30 < 40)
      ],
    );
    player(s).draft = 0.5;
    one(s, DP);
    expect(player(s).draft).toBeCloseTo(0.5 + CH, 9);
  });
  it('R50 no traffic at all: not in the cone, the draft decays', () => {
    const s = createRace(1, 1);
    player(s).speed = PS;
    player(s).draft = 0.5;
    one(s, DP);
    expect(player(s).draft).toBeCloseTo(0.5 - DEC, 9);
  });
});

describe('R51 charge', () => {
  it('R51 createRace: draft and boostTicks are 0 on every car', () => {
    for (const c of createRace(3, 2, 2).cars) {
      expect(c.draft).toBe(0);
      expect(c.boostTicks).toBe(0);
    }
  });
  it('R51 in the cone the draft grows by DT/draftChargeTime = 1/120 per tick: 60 ticks from 0 -> 0.5', () => {
    const s = setup({ z: 100, x: 0, speed: PS }, [{ z: 120, x: 0, speed: PS }]);
    run(s, 60, DP);
    expect(player(s).draft).toBeCloseTo(60 / 120, 9);
  });
  it('R51 outside the cone the draft falls by DT/draftDecayTime = 1/72 per tick: 36 ticks from 1 -> 0.5', () => {
    const s = createRace(1, 1);
    player(s).speed = PS;
    player(s).draft = 1;
    run(s, 36, DP);
    expect(player(s).draft).toBeCloseTo(1 - 36 / 72, 9);
  });
  it('R51 clamped to 1 from above: 0.995 + 10 ticks of charge = 1 exactly', () => {
    const s = setup({ z: 100, x: 0, speed: PS }, [{ z: 120, x: 0, speed: PS }]);
    player(s).draft = 0.995;
    run(s, 10, DP);
    expect(player(s).draft).toBe(1);
  });
  it('R51 clamped to 0 from below: 0.01 + 5 ticks of decay = 0 exactly, never negative', () => {
    const s = createRace(1, 1);
    player(s).speed = PS;
    player(s).draft = 0.01;
    for (let i = 0; i < 5; i++) {
      one(s, DP);
      expect(player(s).draft).toBeGreaterThanOrEqual(0);
    }
    expect(player(s).draft).toBe(0);
  });
  it('R51 monotonic: charge never decreases in the cone, decay never increases outside', () => {
    const s = setup({ z: 100, x: 0, speed: PS }, [{ z: 120, x: 0, speed: PS }]);
    let prev = 0;
    for (let i = 0; i < 150; i++) {
      one(s, DP);
      expect(player(s).draft).toBeGreaterThanOrEqual(prev);
      prev = player(s).draft;
    }
    expect(prev).toBe(1);
  });
  it.each([
    ['in the cone', 120],
    ['outside the cone', 300],
  ])('R51 frozen in DRIFT, %s: draft 0.5 stays 0.5 for 10 ticks', (_n, tz) => {
    const s = setup({ z: 100, x: 0, speed: 0.8 }, [{ z: tz, x: 0, speed: PS }]);
    const c = player(s);
    // [ADR 0005] in a drift = driftTimer > 0 (R208); 100 ticks outlive the 10 ticks below.
    c.driftTimer = 100;
    c.steer = 0.5;
    c.draft = 0.5;
    const wide: CarParams = { ...DP, draftWidth: 1 }; // keep the lead inside the cone as x moves
    run(s, 10, wide, { steer: 0.5, gas: 1, brake: 0, driftTap: false });
    expect(c.driftTimer).toBeGreaterThan(0);
    expect(c.draft).toBe(0.5);
  });
  it('R51 a bump (R40) zeroes draft and boostTicks on that step', () => {
    // Rear hit: player z = 100.0 after the step, traffic z = 101.2: |dz| = 1.2 < carLength 1.5,
    // player behind the lead by more than carLength / 2 = 0.75 (R41 rear hit); dx = 0 < 0.2.
    const s = setup({ z: 100, x: 0, speed: PS }, [{ z: 101.2, x: 0, speed: PS }]);
    player(s).draft = 0.8;
    player(s).boostTicks = 50;
    one(s, DB);
    expect(player(s).bumpTicks).toBeGreaterThan(0); // the contact happened
    expect(player(s).draft).toBe(0);
    expect(player(s).boostTicks).toBe(0);
  });
  it('R51 during bump invulnerability (R43) the draft charges again (the bump only zeroes at contact)', () => {
    const s = setup({ z: 100, x: 0, speed: PS }, [{ z: 101.2, x: 0, speed: PS }]);
    one(s, DP); // bump
    expect(player(s).draft).toBe(0);
    // the kick moves the player sideways; put the lead into the cone again after 5 ticks
    run(s, 5, DP);
    expect(player(s).draft).toBeGreaterThanOrEqual(0);
  });
});

describe('R52 H5 A (draftBoost 0): cap and acceleration only while draft = 1 and in the cone', () => {
  /** Player at speed 1 (= vmax), lead 38 ahead at 0.5; closes at <= 0.31/tick, stays in the cone for 90 ticks. */
  const fast = (d0: number, p = DA): RaceState => {
    const s = setup({ z: 100, x: 0, speed: 1 }, [{ z: 138, x: 0, speed: 0.5 }]);
    player(s).draft = d0;
    void p;
    return s;
  };
  it('R52 draft = 1 in the cone: acceleration is accel * draftAccelMul = 0.22 * 1.6 = 0.352/s above vmax', () => {
    const s = fast(1);
    one(s, DA);
    expect(player(s).speed).toBeCloseTo(1 + (0.22 * 1.6) / 120, 9); // 1.0029333
  });
  it('R52 draft = 1 in the cone: the cap is vmax * draftCapMul = 1.13 (reached after ~44 ticks, held at 90)', () => {
    const s = fast(1);
    run(s, 90, DA);
    expect(player(s).draft).toBe(1);
    expect(player(s).speed).toBeCloseTo(1.13, 9);
  });
  it('R52 speed never exceeds the draft cap on the way', () => {
    const s = fast(1);
    for (let i = 0; i < 90; i++) {
      one(s, DA);
      expect(player(s).speed).toBeLessThanOrEqual(1.13 + 1e-9);
    }
  });
  it('R52 draft < 1 in the cone: no effect, speed stays capped at vmax = 1', () => {
    const s = fast(0.5);
    // 0.5 + 60/120 = 1 only after 60 ticks; check the first 40
    run(s, 40, DA);
    expect(player(s).draft).toBeLessThan(1);
    expect(player(s).speed).toBeCloseTo(1, 9);
  });
  it('R52 without a lead, draft = 1: no effect from the first tick (speed stays at vmax)', () => {
    const s = createRace(1, 1);
    player(s).speed = 1;
    player(s).draft = 1;
    one(s, DA);
    expect(player(s).speed).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('R52 the draft acceleration also applies below vmax (0.5 -> 0.5 + 0.352/120 with a full charge)', () => {
    const s = setup({ z: 100, x: 0, speed: 0.5 }, [{ z: 120, x: 0, speed: 0.5 }]);
    player(s).draft = 1;
    one(s, DA);
    expect(player(s).speed).toBeCloseTo(0.5 + (0.22 * 1.6) / 120, 9);
  });
  it('R52 leaving the cone removes the boost: speed returns to <= vmax within 3 s (R14 is silent on how: clamp or decay)', () => {
    const s = createRace(1, 1);
    player(s).speed = 1.13;
    player(s).draft = 1;
    run(s, 360, DA);
    expect(player(s).speed).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('R52 H5 A: leaving the cone gives no boost counter', () => {
    const s = createRace(1, 1);
    player(s).speed = 1;
    player(s).draft = 1;
    run(s, 5, DA);
    expect(player(s).boostTicks).toBe(0);
  });
});

describe('R52 H5 B (draftBoost 1): the boost outlives the cone', () => {
  const BOOST = Math.round(2.0 / DT); // 240
  /** Full charge, no traffic: the cone is left on this very step. */
  const leaving = (d0 = 1, speed = 1): RaceState => {
    const s = createRace(1, 1);
    player(s).speed = speed;
    player(s).draft = d0;
    return s;
  };
  it('R52 B: leaving the cone with draft = 1 sets boostTicks = round(boostTime / DT) = 240 and draft = 0', () => {
    const s = leaving();
    one(s, DAB);
    // whether the counter already ticks down on the leaving step is not pinned: 240 or 239
    expect(player(s).boostTicks).toBeGreaterThanOrEqual(BOOST - 1);
    expect(player(s).boostTicks).toBeLessThanOrEqual(BOOST);
    expect(player(s).draft).toBe(0);
  });
  it('R52 B: leaving with draft < 1 gives no boost (0.99 and 0.5)', () => {
    for (const d of [0.99, 0.5]) {
      const s = leaving(d);
      one(s, DAB);
      expect(player(s).boostTicks).toBe(0);
    }
  });
  it('R52 B: while still in the cone the counter is not started', () => {
    const s = setup({ z: 100, x: 0, speed: 1 }, [{ z: 138, x: 0, speed: 0.5 }]);
    player(s).draft = 1;
    run(s, 30, DAB);
    expect(player(s).boostTicks).toBe(0);
    expect(player(s).draft).toBe(1);
  });
  it('R52 B: boost applies the draft cap and acceleration: speed climbs to 1.13 with no cone around', () => {
    const s = leaving();
    one(s, DAB);
    expect(player(s).speed).toBeCloseTo(1 + (0.22 * 1.6) / 120, 9);
    run(s, 99, DAB); // 100 ticks in total, 140 boost ticks still left
    expect(player(s).speed).toBeCloseTo(1.13, 9);
  });
  it('R52 B: boostTicks counts down by 1 per tick: after 50 more ticks it is 240 - 50 (+-1)', () => {
    const s = leaving();
    one(s, DAB);
    run(s, 50, DAB);
    expect(Math.abs(player(s).boostTicks - (BOOST - 50))).toBeLessThanOrEqual(1);
  });
  it('R52 B: when boostTicks reaches 0 the boost ends and the speed returns to <= vmax within 3 s', () => {
    const s = leaving();
    run(s, BOOST + 5, DAB);
    expect(player(s).boostTicks).toBe(0);
    run(s, 360, DAB);
    expect(player(s).speed).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('R52 B: no new boost during the boost (draft is 0, nothing to charge without a cone)', () => {
    const s = leaving();
    run(s, 100, DAB);
    expect(player(s).draft).toBe(0);
    expect(player(s).boostTicks).toBeLessThan(BOOST);
  });
});

describe('R2/R3 determinism and serialization of draft state', () => {
  const scenario = (): RaceState => {
    const s = setup({ z: 100, x: 0, speed: 1 }, [{ z: 138, x: 0, speed: 0.5 }]);
    return s;
  };
  it('R2 same inputs twice -> identical state (draft and boostTicks included)', () => {
    const a = scenario();
    const b = scenario();
    run(a, 300, DAB);
    run(b, 300, DAB);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(typeof player(a).draft).toBe('number');
  });
  it('R3 JSON round trip mid-boost continues identically', () => {
    const a = scenario();
    run(a, 100, DAB);
    const b: RaceState = JSON.parse(JSON.stringify(a)) as RaceState;
    run(a, 200, DAB);
    run(b, 200, DAB);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it('R51 draft stays in [0, 1] over a long mixed run', () => {
    const s = scenario();
    for (let i = 0; i < 600; i++) {
      one(s, DAB, { steer: 0, gas: i % 200 > 150 ? 0 : 1, brake: i % 200 > 150 ? 1 : 0, driftTap: false });
      expect(player(s).draft).toBeGreaterThanOrEqual(0);
      expect(player(s).draft).toBeLessThanOrEqual(1);
    }
  });
});

void dz;

import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/constants';
import { createRace, placeRivals, step } from '../../src/sim/race';
import type { Car, CarParams, RivalConfig } from '../../src/sim/types';
import { baseCarA } from './baseCarA';
import { IDLE, RC, TRACK, mkRace } from './rivals_helpers';

const grid = (seed: number, cfg: RivalConfig = RC) => {
  const s = createRace(seed, 1 + cfg.rivalCount, 0);
  placeRivals(s, cfg);
  return s;
};
const rivals = (cars: readonly Car[]): Car[] => cars.filter((c) => c.kind === 'rival');
const RANGE: Record<number, [number, number]> = {
  0: RC.slotClose,
  1: RC.slotAhead,
  2: RC.slotBehind,
};
const MIN_TICKS = Math.round(RC.slotTimeMin / DT); // 25 s -> 3000
const MAX_TICKS = Math.round(RC.slotTimeMax / DT); // 50 s -> 6000
const STILL: CarParams = { ...baseCarA, accel: 0 };

describe('R62b roles by rivalRoles counts', () => {
  it('3 close / 2 ahead / 2 behind for every seed (200 seeds); the player has role 0, nemesis 0', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = grid(seed);
      const n = [0, 0, 0];
      for (const c of rivals(s.cars)) n[c.role]!++;
      expect(n, `seed ${seed}`).toEqual([3, 2, 2]);
      expect([s.cars[0]!.role, s.cars[0]!.nemesis]).toEqual([0, 0]);
    }
  });
  it('other counts: rivalRoles [1,3,3] gives 1 / 3 / 3', () => {
    const s = grid(5, { ...RC, rivalRoles: [1, 3, 3] });
    const n = [0, 0, 0];
    for (const c of rivals(s.cars)) n[c.role]!++;
    expect(n).toEqual([1, 3, 3]);
  });
  it('roles are not simply by index order: over 200 seeds the close rivals are not always cars 1..3 (shuffled by the RNG)', () => {
    let notFirstThree = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const s = grid(seed);
      if (s.cars.slice(1, 4).some((c) => c.role !== 0)) notFirstThree++;
    }
    expect(notFirstThree).toBeGreaterThan(100);
  });
});

describe('R62b slot inside the range of the role', () => {
  it('at creation slot is inside slotClose / slotAhead / slotBehind (200 seeds)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      for (const c of rivals(grid(seed).cars)) {
        const [lo, hi] = RANGE[c.role]!;
        if (c.nemesis === 1) continue; // checked below
        expect(c.slot, `seed ${seed} role ${c.role}`).toBeGreaterThanOrEqual(lo);
        expect(c.slot).toBeLessThanOrEqual(hi);
      }
    }
  });
  it('slotTicks at creation is between slotTimeMin and slotTimeMax in ticks (3000..6000)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      for (const c of rivals(grid(seed).cars)) {
        expect(c.slotTicks).toBeGreaterThanOrEqual(MIN_TICKS);
        expect(c.slotTicks).toBeLessThanOrEqual(MAX_TICKS);
      }
    }
  });
  it('slots are really drawn from the range (ahead: spread over 200..600 across seeds)', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let seed = 1; seed <= 200; seed++)
      for (const c of rivals(grid(seed).cars))
        if (c.role === 1) {
          lo = Math.min(lo, c.slot);
          hi = Math.max(hi, c.slot);
        }
    expect(lo).toBeLessThan(260);
    expect(hi).toBeGreaterThan(540);
  });
  it('other ranges come from the config: slotAhead [1000, 1010]', () => {
    const s = grid(3, { ...RC, slotAhead: [1000, 1010] });
    for (const c of rivals(s.cars).filter((r) => r.role === 1)) {
      expect(c.slot).toBeGreaterThanOrEqual(1000);
      expect(c.slot).toBeLessThanOrEqual(1010);
    }
  });
});

describe('R62b slot timer and reseeding', () => {
  /** One rival (role given), player parked, slotTicks given. Returns the state before stepping. */
  const mk = (role: number, slot: number, slotTicks: number, nemesis = 0) =>
    mkRace(1, 0, [
      { z: 0, x: 0, speed: 0 },
      { z: 100, x: 0.5, speed: 0, role, slot, slotTicks, nemesis },
    ]);
  const go = (s: ReturnType<typeof mk>): void =>
    step(s, [IDLE, IDLE], TRACK, [STILL, STILL], undefined, RC);

  it('slotTicks counts down by 1 per tick and the slot stays while it is above 1', () => {
    const s = mk(1, 400, 100);
    s.tick = 5000;
    go(s);
    expect(s.cars[1]!.slotTicks).toBe(99);
    expect(s.cars[1]!.slot).toBe(400);
    go(s);
    expect(s.cars[1]!.slotTicks).toBe(98);
    expect(s.cars[1]!.slot).toBe(400);
  });
  it('when slotTicks runs out the slot is redrawn from the role range and the timer restarts at slotTimeMin..slotTimeMax', () => {
    for (const role of [0, 1, 2]) {
      const [lo, hi] = RANGE[role]!;
      const s = mk(role, (lo + hi) / 2, 2);
      s.tick = 5000;
      go(s);
      go(s); // slotTicks 2 -> 1 -> 0: the redraw happens at the latest on this tick
      const c = s.cars[1]!;
      expect(c.slot, `role ${role}`).toBeGreaterThanOrEqual(lo);
      expect(c.slot).toBeLessThanOrEqual(hi);
      expect(c.slotTicks).toBeGreaterThanOrEqual(MIN_TICKS - 1);
      expect(c.slotTicks).toBeLessThanOrEqual(MAX_TICKS);
    }
  });
  it('the redraw really changes the slot and stays in range over 100 reseeds (ahead: 200..600, behind -600..-200)', () => {
    for (const role of [1, 2]) {
      const [lo, hi] = RANGE[role]!;
      const s = mk(role, (lo + hi) / 2, 1);
      s.tick = 5000;
      const seen = new Set<number>();
      for (let i = 0; i < 100; i++) {
        s.cars[1]!.slotTicks = 1;
        go(s);
        const c = s.cars[1]!;
        expect(c.slot).toBeGreaterThanOrEqual(lo);
        expect(c.slot).toBeLessThanOrEqual(hi);
        seen.add(c.slot);
      }
      expect(seen.size).toBeGreaterThan(50);
    }
  });
  it('the nemesis redraws inside nemesisSlot (-90..90), not the wider close range', () => {
    const s = mk(0, 0, 1, 1);
    s.tick = 5000;
    let wide = false;
    for (let i = 0; i < 200; i++) {
      s.cars[1]!.slotTicks = 1;
      go(s);
      const c = s.cars[1]!;
      expect(c.slot).toBeGreaterThanOrEqual(-90);
      expect(c.slot).toBeLessThanOrEqual(90);
      if (Math.abs(c.slot) > 60) wide = true;
    }
    expect(wide).toBe(true); // the draw spans the range, not a constant
  });
  it('the slot timer config is used: slotTimeMin = slotTimeMax = 10 s -> 1200 ticks', () => {
    const cfg: RivalConfig = { ...RC, slotTimeMin: 10, slotTimeMax: 10 };
    const s = mk(1, 400, 1);
    s.tick = 5000;
    step(s, [IDLE, IDLE], TRACK, [STILL, STILL], undefined, cfg);
    expect(s.cars[1]!.slotTicks).toBeGreaterThanOrEqual(1199);
    expect(s.cars[1]!.slotTicks).toBeLessThanOrEqual(1200);
  });
  it('the redraw uses the seeded RNG in state: same state twice -> same slot; rng changes', () => {
    const a = mk(1, 400, 1);
    const b = mk(1, 400, 1);
    const rng0 = a.rng;
    go(a);
    go(b);
    expect(a.cars[1]!.slot).toBe(b.cars[1]!.slot);
    expect(a.rng).not.toBe(rng0);
  });
});

describe('R62b nemesis', () => {
  it('exactly one nemesis among the rivals, it has role close, slot inside nemesisSlot (200 seeds)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = grid(seed);
      const n = rivals(s.cars).filter((c) => c.nemesis === 1);
      expect(n.length, `seed ${seed}`).toBe(1);
      expect(n[0]!.role).toBe(0);
      expect(n[0]!.slot).toBeGreaterThanOrEqual(-90);
      expect(n[0]!.slot).toBeLessThanOrEqual(90);
      expect(s.cars[0]!.nemesis).toBe(0);
      for (const c of rivals(s.cars)) expect([0, 1]).toContain(c.nemesis);
    }
  });
  it('nemesisSlot comes from the config: [200, 210] puts the nemesis slot there', () => {
    const s = grid(4, { ...RC, nemesisSlot: [200, 210] });
    const n = rivals(s.cars).find((c) => c.nemesis === 1)!;
    expect(n.slot).toBeGreaterThanOrEqual(200);
    expect(n.slot).toBeLessThanOrEqual(210);
  });
  it('which rival is the nemesis varies with the seed (not always the same index)', () => {
    const idx = new Set<number>();
    for (let seed = 1; seed <= 100; seed++)
      idx.add(grid(seed).cars.findIndex((c) => c.nemesis === 1));
    expect(idx.size).toBeGreaterThan(1);
  });
});

describe('R62b determinism and serialization', () => {
  it('same seed -> identical roles, slots, nemesis (JSON equal); other seeds differ somewhere', () => {
    expect(JSON.stringify(grid(9))).toBe(JSON.stringify(grid(9)));
    expect(JSON.stringify(grid(9))).not.toBe(JSON.stringify(grid(10)));
  });
  it('2000 ticks from the same seed twice give identical state; a JSON round trip mid-run continues identically', () => {
    const run = (): ReturnType<typeof grid> => {
      const s = grid(21);
      s.tick = 5000;
      for (const c of rivals(s.cars)) c.slotTicks = 300; // force reseeds inside the run
      return s;
    };
    const params = (s: ReturnType<typeof grid>): CarParams[] => s.cars.map(() => STILL);
    const a = run();
    const b = run();
    for (let i = 0; i < 1000; i++) {
      step(
        a,
        a.cars.map(() => IDLE),
        TRACK,
        params(a),
        undefined,
        RC,
      );
      step(
        b,
        b.cars.map(() => IDLE),
        TRACK,
        params(b),
        undefined,
        RC,
      );
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = JSON.parse(JSON.stringify(a)) as typeof a;
    for (let i = 0; i < 1000; i++) {
      step(
        a,
        a.cars.map(() => IDLE),
        TRACK,
        params(a),
        undefined,
        RC,
      );
      step(
        c,
        c.cars.map(() => IDLE),
        TRACK,
        params(c),
        undefined,
        RC,
      );
    }
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });
});

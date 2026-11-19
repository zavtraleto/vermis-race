import { describe, expect, it } from 'vitest';
import { createRace, placeRivals, placeTraffic } from '../../src/sim/race';
import type { RivalConfig, TrafficConfig } from '../../src/sim/types';
import { LANES, RC, laneOf } from './rivals_helpers';

const grid = (seed: number, cfg: RivalConfig = RC) => {
  const s = createRace(seed, 1 + cfg.rivalCount, 0);
  placeRivals(s, cfg);
  return s;
};

describe('R60 rivals are cars of kind rival right after the player', () => {
  it('createRace(seed, 1 + n, m): player, n rivals, m traffic', () => {
    const s = createRace(3, 8, 4);
    expect(s.cars.map((c) => c.kind)).toEqual([
      'player',
      'rival',
      'rival',
      'rival',
      'rival',
      'rival',
      'rival',
      'rival',
      'traffic',
      'traffic',
      'traffic',
      'traffic',
    ]);
  });
  it('new fields default for the player: skill 0, pace 1, nameId -1', () => {
    const p = createRace(3, 8, 4).cars[0]!;
    expect([p.skill, p.pace, p.nameId]).toEqual([0, 1, -1]);
  });
});

describe('R61 start grid', () => {
  // z_i = gap*(i - behind - 0.5) = 12*(i - 2.5): -18, -6, 6, 18, 30, 42, 54 for i = 1..7.
  it('rival i stands on z = gap*(i - behind - 0.5), speed 0, player untouched at x 0, z 0', () => {
    const s = grid(11);
    for (let i = 1; i <= 7; i++) {
      expect(s.cars[i]!.z, `z of rival ${i}`).toBe(12 * (i - 2.5));
      expect(s.cars[i]!.speed).toBe(0);
    }
    const p = s.cars[0]!;
    expect([p.z, p.x, p.speed]).toEqual([0, 0, 0]);
    for (let i = 1; i <= 7; i++) expect(s.cars[i]!.z).not.toBe(p.z); // nobody shares the player z
  });
  it('other gap and behind values (gap 20, behind 0 -> 20*(i-0.5); gap 7, behind 3 -> 7*(i-3.5))', () => {
    const a = grid(11, { ...RC, rivalGridGap: 20, rivalGridBehind: 0 });
    for (let i = 1; i <= 7; i++) expect(a.cars[i]!.z).toBe(20 * (i - 0.5));
    const b = grid(11, { ...RC, rivalGridGap: 7, rivalGridBehind: 3 });
    for (let i = 1; i <= 7; i++) expect(b.cars[i]!.z).toBe(7 * (i - 3.5));
  });
  it('every rival stands on a lane centre; neighbours in z never share a lane (200 seeds)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = grid(seed);
      for (let i = 1; i <= 7; i++) {
        const l = laneOf(s.cars[i]!.x);
        expect(Number.isNaN(l), `seed ${seed} rival ${i} x=${s.cars[i]!.x}`).toBe(false);
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThan(LANES);
        if (i > 1)
          expect(l, `seed ${seed} rivals ${i - 1},${i}`).not.toBe(laneOf(s.cars[i - 1]!.x));
      }
    }
  });
  it('with 2 lanes neighbours must alternate (the only legal choice)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = grid(seed, { ...RC, lanes: 2 });
      for (let i = 2; i <= 7; i++) expect(s.cars[i]!.x).toBe(-s.cars[i - 1]!.x);
    }
  });
  it('lanes are chosen by the RNG: all 8 lanes show up over 200 seeds, and the choice depends on the seed', () => {
    const seen = new Set<number>();
    const sigs = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const s = grid(seed);
      sigs.add(s.cars.map((c) => c.x).join(','));
      for (let i = 1; i <= 7; i++) seen.add(laneOf(s.cars[i]!.x));
    }
    expect(seen.size).toBe(LANES);
    expect(sigs.size).toBeGreaterThan(100);
  });
  it('deterministic: same seed twice -> identical JSON; different seeds differ', () => {
    expect(JSON.stringify(grid(5))).toBe(JSON.stringify(grid(5)));
    expect(JSON.stringify(grid(5))).not.toBe(JSON.stringify(grid(6)));
  });
  it('placeRivals advances the seeded RNG (state.rng changes), tick stays 0', () => {
    const s = createRace(5, 8, 0);
    const rng0 = s.rng;
    placeRivals(s, RC);
    expect(s.rng).not.toBe(rng0);
    expect(s.tick).toBe(0);
  });
  it('traffic cars are not touched by placeRivals', () => {
    const tc: TrafficConfig = {
      trafficMax: 5,
      trafficSpawnAhead: 100,
      trafficDespawnBehind: 30,
      trafficGapMin: 20,
      trafficGapMax: 50,
      trafficSpeedMin: 0.4,
      trafficSpeedMax: 0.7,
      lanes: LANES,
    };
    const s = createRace(9, 8, 5);
    placeTraffic(s, tc, 1);
    const before = JSON.stringify(s.cars.slice(8));
    placeRivals(s, RC);
    expect(JSON.stringify(s.cars.slice(8))).toBe(before);
  });
});

describe('R62 character', () => {
  it('skill is 0, 1 or 2; frequencies follow the weights [0.3, 0.5, 0.2] over 2000 seeds x 7 rivals', () => {
    const n = [0, 0, 0];
    for (let seed = 1; seed <= 2000; seed++) {
      const s = grid(seed);
      for (let i = 1; i <= 7; i++) {
        const k = s.cars[i]!.skill;
        expect([0, 1, 2]).toContain(k);
        n[k]!++;
      }
    }
    // 14000 samples; sigma of a frequency is at most sqrt(0.25 / 14000) = 0.0042; tolerance 0.02 (about 5 sigma).
    const total = 2000 * 7;
    expect(n[0]! / total).toBeGreaterThan(0.28);
    expect(n[0]! / total).toBeLessThan(0.32);
    expect(n[1]! / total).toBeGreaterThan(0.48);
    expect(n[1]! / total).toBeLessThan(0.52);
    expect(n[2]! / total).toBeGreaterThan(0.18);
    expect(n[2]! / total).toBeLessThan(0.22);
  });
  it('degenerate weights: [1,0,0] all novice, [0,1,0] all average, [0,0,1] all expert', () => {
    const cases: Array<[[number, number, number], number]> = [
      [[1, 0, 0], 0],
      [[0, 1, 0], 1],
      [[0, 0, 1], 2],
    ];
    for (const [w, k] of cases) {
      for (let seed = 1; seed <= 50; seed++) {
        const s = grid(seed, { ...RC, rivalSkillWeights: w });
        for (let i = 1; i <= 7; i++) expect(s.cars[i]!.skill).toBe(k);
      }
    }
  });
  it('pace lies in [1 - spread, 1 + spread], is not constant, averages about 1', () => {
    let sum = 0;
    let cnt = 0;
    const distinct = new Set<number>();
    for (let seed = 1; seed <= 500; seed++) {
      const s = grid(seed);
      for (let i = 1; i <= 7; i++) {
        const p = s.cars[i]!.pace;
        expect(p).toBeGreaterThanOrEqual(0.97);
        expect(p).toBeLessThanOrEqual(1.03);
        sum += p;
        cnt++;
        distinct.add(p);
      }
    }
    expect(distinct.size).toBeGreaterThan(1000);
    expect(Math.abs(sum / cnt - 1)).toBeLessThan(0.002); // sigma about 0.0175/sqrt(3500) = 0.0003
  });
  it('spread 0 gives pace exactly 1; spread 0.1 stays within [0.9, 1.1]', () => {
    const s0 = grid(4, { ...RC, rivalPaceSpread: 0 });
    for (let i = 1; i <= 7; i++) expect(s0.cars[i]!.pace).toBe(1);
    for (let seed = 1; seed <= 100; seed++) {
      const s = grid(seed, { ...RC, rivalPaceSpread: 0.1 });
      for (let i = 1; i <= 7; i++) {
        expect(s.cars[i]!.pace).toBeGreaterThanOrEqual(0.9);
        expect(s.cars[i]!.pace).toBeLessThanOrEqual(1.1);
      }
    }
  });
  it('nameIds are unique integers in [0, rivalNameCount) (200 seeds), a full permutation when names = rivals', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = grid(seed);
      const ids = s.cars.slice(1).map((c) => c.nameId);
      expect(new Set(ids).size, `seed ${seed}`).toBe(7);
      for (const id of ids) {
        expect(Number.isInteger(id)).toBe(true);
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThan(24);
      }
    }
    for (let seed = 1; seed <= 20; seed++) {
      const s = grid(seed, { ...RC, rivalNameCount: 7 });
      expect(
        s.cars
          .slice(1)
          .map((c) => c.nameId)
          .sort((a, b) => a - b),
      ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });
  it('player and traffic keep skill 0, pace 1, nameId -1', () => {
    const s = createRace(2, 8, 3);
    placeRivals(s, RC);
    for (const c of [s.cars[0]!, ...s.cars.slice(8)])
      expect([c.skill, c.pace, c.nameId]).toEqual([0, 1, -1]);
  });
  it('the whole character depends on the seed only (deterministic) and differs between seeds', () => {
    const sig = (seed: number): string =>
      grid(seed)
        .cars.map((c) => `${c.skill}/${c.pace}/${c.nameId}`)
        .join(' ');
    expect(sig(8)).toBe(sig(8));
    expect(sig(8)).not.toBe(sig(9));
  });
});

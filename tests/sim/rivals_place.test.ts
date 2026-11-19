import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { createRace, placeRivals, placeTraffic, step } from '../../src/sim/race';
import type { InputFrame, RaceState, TrafficConfig } from '../../src/sim/types';
import { BP, LANES, RC, TRACK, mkRace, stepAll } from './rivals_helpers';

// Cars stand still (speed 0, accel 0), x spaced 0.3 apart (>= carHitW 0.2: no contacts), so z is
// exactly what the test sets and place can be computed by hand.

describe('R66 place', () => {
  it('player z5, rivals z9, z9, z2, traffic z100: places 3, 1, 2, 4 (tie 9 -> smaller index higher; traffic excluded)', () => {
    // player: cars with larger z = {9, 9} -> 1 + 2 = 3. rival 1 (z9): none larger, no equal with a smaller index -> 1.
    // rival 2 (z9): equal z with smaller index 1 -> 2. rival 3 (z2): 5, 9, 9 are larger -> 4.
    const s = mkRace(3, 1, [
      { z: 5, x: 0, speed: 0 },
      { z: 9, x: -0.6, speed: 0 },
      { z: 9, x: 0.6, speed: 0 },
      { z: 2, x: 0.9, speed: 0 },
      { z: 100, x: -0.9, speed: 0 },
    ]);
    stepAll(s, BP, RC);
    expect(s.cars.slice(0, 4).map((c) => c.place)).toEqual([3, 1, 2, 4]);
  });
  it('a traffic car far ahead does not change anyone place', () => {
    const a = mkRace(2, 0, [
      { z: 5, x: 0, speed: 0 },
      { z: 9, x: -0.6, speed: 0 },
      { z: 2, x: 0.6, speed: 0 },
    ]);
    const b = mkRace(2, 3, [
      { z: 5, x: 0, speed: 0 },
      { z: 9, x: -0.6, speed: 0 },
      { z: 2, x: 0.6, speed: 0 },
      { z: 500, x: -0.9, speed: 0 },
      { z: 600, x: 0.9, speed: 0 },
      { z: 700, x: 0, speed: 0 },
    ]);
    stepAll(a, BP, RC);
    stepAll(b, BP, RC);
    expect(a.cars.map((c) => c.place)).toEqual([2, 1, 3]);
    expect(b.cars.slice(0, 3).map((c) => c.place)).toEqual([2, 1, 3]);
  });
  it('the player leads when it is ahead of everyone; the last one has place = number of race cars', () => {
    const s = mkRace(3, 0, [
      { z: 50, x: 0, speed: 0 },
      { z: 40, x: -0.6, speed: 0 },
      { z: 30, x: 0.6, speed: 0 },
      { z: 20, x: 0.9, speed: 0 },
    ]);
    stepAll(s, BP, RC);
    expect(s.cars.map((c) => c.place)).toEqual([1, 2, 3, 4]);
  });
  it('all on the same z: place follows the index (1, 2, 3, 4)', () => {
    const s = mkRace(3, 0, [
      { z: 7, x: -0.6, speed: 0 },
      { z: 7, x: -0.3, speed: 0 },
      { z: 7, x: 0.3, speed: 0 },
      { z: 7, x: 0.6, speed: 0 },
    ]);
    stepAll(s, BP, RC);
    expect(s.cars.map((c) => c.place)).toEqual([1, 2, 3, 4]);
  });
  it('updated every step: a rival overtakes the player (tie at z 5 favours the player, then it passes)', () => {
    // rival 3 starts at z 2 with speed 0.5 (0.25 per tick, exact): after n ticks z = 2 + 0.25 n.
    const s = mkRace(3, 1, [
      { z: 5, x: 0, speed: 0 },
      { z: 9, x: -0.6, speed: 0 },
      { z: 9, x: 0.6, speed: 0 },
      { z: 2 - 0.25, x: 0.9, speed: 0.5 }, // pre-step z so that z after tick 1 is 2
      { z: 100, x: -0.9, speed: 0 },
    ]);
    const places = (): number[] => s.cars.slice(0, 4).map((c) => c.place);
    stepAll(s, BP, RC);
    expect(places()).toEqual([3, 1, 2, 4]); // z = 2
    for (let i = 0; i < 11; i++) stepAll(s, BP, RC); // 12 ticks: z = 2 + 0.25 * 11 = 4.75
    expect(places()).toEqual([3, 1, 2, 4]);
    stepAll(s, BP, RC); // z = 5.0: tie with the player, smaller index (player) stays higher
    expect(s.cars[3]!.z).toBeCloseTo(5, 12);
    expect(places()).toEqual([3, 1, 2, 4]);
    stepAll(s, BP, RC); // z = 5.25: passed the player
    expect(places()).toEqual([4, 1, 2, 3]);
    for (let i = 0; i < 20; i++) stepAll(s, BP, RC); // z = 10.25: ahead of everyone
    expect(places()).toEqual([4, 2, 3, 1]);
  });
  it('random z (many ties, 200 trials, 8 race cars): place = 1 + #(larger z) + #(equal z, smaller index); a permutation of 1..8', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 200; trial++) {
      const zs = Array.from({ length: 8 }, () => Math.floor(rnd() * 6));
      const s = mkRace(
        7,
        0,
        zs.map((z, i) => ({ z, x: -1.05 + 0.3 * i, speed: 0 })),
      );
      stepAll(s, BP, RC);
      const got = s.cars.map((c) => c.place);
      for (let i = 0; i < 8; i++) {
        let want = 1;
        for (let j = 0; j < 8; j++) if (zs[j]! > zs[i]! || (zs[j] === zs[i] && j < i)) want++;
        expect(got[i], `trial ${trial} car ${i} zs=${zs.join(',')}`).toBe(want);
      }
      expect([...got].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });
  it('place does not depend on the rubber band or other config (same cars, band on/off)', () => {
    const mk = () =>
      mkRace(2, 0, [
        { z: 5, x: 0, speed: 0 },
        { z: 400, x: -0.6, speed: 0 },
        { z: 2, x: 0.6, speed: 0 },
      ]);
    const a = mk();
    const b = mk();
    stepAll(a, BP, RC);
    stepAll(b, BP, { ...RC, rubberBand: 0 });
    expect(a.cars.map((c) => c.place)).toEqual(b.cars.map((c) => c.place));
    expect(a.cars.map((c) => c.place)).toEqual([2, 1, 3]);
  });
});

describe('R60-R66 whole race: state stays flat JSON and deterministic', () => {
  const TC: TrafficConfig = {
    trafficMax: 5,
    trafficSpawnAhead: 100,
    trafficDespawnBehind: 30,
    trafficGapMin: 20,
    trafficGapMax: 50,
    trafficSpeedMin: 0.4,
    trafficSpeedMax: 0.7,
    lanes: LANES,
  };
  const N = 8 + 5;
  const inputs: InputFrame[] = Array.from({ length: N }, () => ({
    steer: 0,
    brake: false,
    drift: false,
  }));

  function fresh(seed: number): RaceState {
    const s = createRace(seed, 8, 5);
    placeTraffic(s, TC, baseCar.vmax);
    placeRivals(s, RC);
    return s;
  }
  function advance(s: RaceState, from: number, to: number): void {
    const params = s.cars.map(() => baseCar);
    for (let t = from; t < to; t++) {
      for (let i = 0; i < N; i++) {
        const f = inputs[i]!;
        f.steer = Math.sin(t / 17 + i);
        f.brake = false;
        f.drift = i % 2 === 0 && t % 90 > 40;
      }
      step(s, inputs, TRACK, params, TC, RC);
    }
  }
  const play = (seed: number, roundTripAt?: number): RaceState => {
    let s = fresh(seed);
    if (roundTripAt === undefined) advance(s, 0, 900);
    else {
      advance(s, 0, roundTripAt);
      s = JSON.parse(JSON.stringify(s)) as RaceState;
      advance(s, roundTripAt, 900);
    }
    return s;
  };

  it('same seed and inputs twice -> identical JSON; another seed differs', () => {
    expect(JSON.stringify(play(21))).toBe(JSON.stringify(play(21)));
    expect(JSON.stringify(play(21))).not.toBe(JSON.stringify(play(22)));
  });
  it('a JSON round trip in the middle of the race changes nothing', () => {
    expect(JSON.stringify(play(21, 300))).toBe(JSON.stringify(play(21)));
  });
  it('all numbers are finite; state is plain data (a JSON round trip deep-equals it)', () => {
    const s = play(21);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const walk = (v: unknown): void => {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(s);
  });
  it('places of the player and the 7 rivals are a permutation of 1..8; characters do not change during the race', () => {
    const before = fresh(21).cars.map((c) => [c.skill, c.pace, c.nameId]);
    const s = play(21);
    expect(
      s.cars
        .slice(0, 8)
        .map((c) => c.place)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(s.cars.map((c) => [c.skill, c.pace, c.nameId])).toEqual(before);
  });
  it('the grid unfolds: the rivals leave the start (z grows, speeds positive)', () => {
    const s = play(21);
    for (let i = 1; i <= 7; i++) expect(s.cars[i]!.z).toBeGreaterThan(20);
  });
});

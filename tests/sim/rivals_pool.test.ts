import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/constants';
import { step } from '../../src/sim/race';
import type { Car, RaceState, RivalConfig } from '../../src/sim/types';
import { BP, IDLE, RC, TRACK, laneOf, mkRace, stepAll } from './rivals_helpers';

// R63b. BP has accel 0, so every car keeps its speed: player and rivals all drive 0.5 and the gaps
// stay constant (cap vmax*pace*(1+band) >= 0.87 > 0.5, nothing brakes). Player at z 5000.
const PZ = 5000;
const V = 0.5;
const JOIN = Math.round(RC.joinShowTime / DT); // 4 s -> 480 ticks

/** Player + 7 rivals; rival i at z = PZ + gaps[i-1]. Names 0..6, roles 0,0,0,1,1,2,2, nemesis = rival 1. */
function pool(gaps: readonly number[], traffic: Partial<Car>[] = []): RaceState {
  const roles = [0, 0, 0, 1, 1, 2, 2];
  const slots = [0, 50, -50, 300, 500, -300, -500];
  const place: Partial<Car>[] = [{ z: PZ, x: 0, speed: V }];
  gaps.forEach((g, i) =>
    place.push({
      z: PZ + g,
      x: -0.9 + 0.2 * i,
      speed: V,
      nameId: i,
      role: roles[i]!,
      slot: slots[i]!,
      slotTicks: 1e6,
      nemesis: i === 0 ? 1 : 0,
      skill: 1,
      pace: 1,
    }),
  );
  traffic.forEach((t) => place.push(t));
  const s = mkRace(gaps.length, traffic.length, place);
  s.tick = 5000;
  return s;
}
const FAR_OK = [-100, 60, -200, 300, 500, -300, -500]; // all inside the pool radius
const without = (s: RaceState, i: number): string =>
  JSON.stringify(
    s.cars.filter((_, j) => j !== i).map((c) => ({ ...c, place: 0 })), // place is re-ranked by the swap (R66)
  );

describe('R63b a rival beyond poolRadius is replaced on that tick', () => {
  it('1799 behind and 1799 ahead stay (not beyond 1800)', () => {
    const s = pool([-1799, 1799, -200, 300, 500, -300, -500]);
    const before = s.cars.map((c) => c.nameId);
    stepAll(s, BP, RC);
    expect(s.cars.map((c) => c.nameId)).toEqual(before);
    expect(s.cars[1]!.joinTicks).toBe(0);
  });
  for (const [label, gap] of [
    ['behind', -1900],
    ['ahead', 1900],
  ] as const) {
    describe(`rival 1900 segments ${label} the player`, () => {
      const gaps = [...FAR_OK];
      gaps[3] = gap; // rival 4: role ahead (slot 300), not the nemesis
      const run = (): RaceState => {
        const s = pool(gaps);
        // dirty state of the old car
        Object.assign(s.cars[4]!, {
          state: 'DRIFT',
          dir: 1,
          angle: 0.8,
          bumpTicks: 30,
          crashTicks: 50,
          crashSpeed0: 0.5,
          crashX0: 0.1,
          band: 0.05,
          skill: 2,
          pace: 1.02,
        });
        stepAll(s, BP, RC);
        return s;
      };
      it('new nameId free among the others, in the name list; skill and pace redrawn within bounds; same role', () => {
        const s = run();
        const c = s.cars[4]!;
        const others = s.cars.filter((o, j) => o.kind === 'rival' && j !== 4).map((o) => o.nameId);
        expect(others).not.toContain(c.nameId);
        expect(c.nameId).toBeGreaterThanOrEqual(0);
        expect(c.nameId).toBeLessThan(RC.rivalNameCount);
        expect([0, 1, 2]).toContain(c.skill);
        expect(c.pace).toBeGreaterThanOrEqual(1 - RC.rivalPaceSpread);
        expect(c.pace).toBeLessThanOrEqual(1 + RC.rivalPaceSpread);
        expect(c.role).toBe(1);
        expect(c.nemesis).toBe(0);
        expect(c.slot).toBeGreaterThanOrEqual(200);
        expect(c.slot).toBeLessThanOrEqual(600);
        expect(c.slotTicks).toBeGreaterThanOrEqual(3000 - 1);
        expect(c.slotTicks).toBeLessThanOrEqual(6000);
      });
      it('appears 60 segments behind the player (z = zPlayer - poolSpawnBehind), lane centre, at the player speed', () => {
        const s = run();
        const c = s.cars[4]!;
        // player moves V*DT*60 = 0.25 segments in the step, so allow a step either way
        expect(Math.abs(c.z - (s.cars[0]!.z - 60))).toBeLessThanOrEqual(0.5);
        expect(Number.isNaN(laneOf(c.x))).toBe(false);
        expect(c.speed).toBeCloseTo(s.cars[0]!.speed, 9);
        expect(c.speed).toBeCloseTo(V, 9);
      });
      it('clean state: GRIP, no drift angle, no bump / crash ticks', () => {
        const c = run().cars[4]!;
        expect(c.state).toBe('GRIP');
        expect(c.dir).toBe(0);
        expect(c.angle).toBe(0);
        expect(c.bumpTicks).toBe(0);
        expect(c.crashTicks).toBe(0);
        expect(c.offTicks).toBe(0);
        expect(Math.abs(c.x)).toBeLessThanOrEqual(1);
      });
      it('joinTicks = joinShowTime in ticks (480) and counts down 1 per tick to 0', () => {
        const s = run();
        const j = s.cars[4]!.joinTicks;
        expect([JOIN - 1, JOIN]).toContain(j); // whether it already counted on the swap tick
        stepAll(s, BP, RC);
        expect(s.cars[4]!.joinTicks).toBe(j - 1);
        for (let i = 0; i < JOIN + 5; i++) stepAll(s, BP, RC);
        expect(s.cars[4]!.joinTicks).toBe(0);
      });
      it('the rest of the cars are untouched: identical to the run where the gap was inside the radius', () => {
        const inside = [...FAR_OK];
        inside[3] = gap > 0 ? 1700 : -1700;
        const ctrl = pool(inside);
        stepAll(ctrl, BP, RC);
        expect(without(run(), 4)).toBe(without(ctrl, 4));
      });
      it('place (R66) of every race car is consistent after the swap', () => {
        const s = run();
        const race = s.cars.filter((c) => c.kind !== 'traffic');
        race.forEach((c, i) => {
          let p = 1;
          race.forEach((o, j) => {
            if (o.z > c.z || (o.z === c.z && j < i)) p++;
          });
          expect(c.place, `car ${i}`).toBe(p);
        });
      });
      it('determinism: the same setup twice -> identical state', () => {
        expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
      });
    });
  }

  it('the nemesis that is pooled out is replaced by a nemesis: role close, nemesis 1, slot in -90..90', () => {
    const gaps = [...FAR_OK];
    gaps[0] = -1900; // rival 1 is the nemesis
    const s = pool(gaps);
    stepAll(s, BP, RC);
    const c = s.cars[1]!;
    expect(c.role).toBe(0);
    expect(c.nemesis).toBe(1);
    expect(c.slot).toBeGreaterThanOrEqual(-90);
    expect(c.slot).toBeLessThanOrEqual(90);
    expect(s.cars.filter((o) => o.nemesis === 1).length).toBe(1);
  });
  it('a pooled-out non-nemesis close rival stays a plain close rival (nemesis 0, slot in -150..150)', () => {
    const gaps = [...FAR_OK];
    gaps[1] = 1900; // rival 2: role close, not nemesis
    const s = pool(gaps);
    stepAll(s, BP, RC);
    const c = s.cars[2]!;
    expect([c.role, c.nemesis]).toEqual([0, 0]);
    expect(c.slot).toBeGreaterThanOrEqual(-150);
    expect(c.slot).toBeLessThanOrEqual(150);
    expect(s.cars.filter((o) => o.nemesis === 1).length).toBe(1);
  });
  it('several rivals replaced on one tick get distinct names, none equal to a staying rival', () => {
    const s = pool([-1900, 1900, -2500, 300, 500, -300, -500]);
    stepAll(s, BP, RC);
    const names = s.cars.slice(1, 8).map((c) => c.nameId);
    expect(new Set(names).size).toBe(7);
    for (const n of names) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(RC.rivalNameCount);
    }
    for (const i of [1, 2, 3]) expect(s.cars[i]!.joinTicks).toBeGreaterThan(0);
    for (const i of [4, 5, 6, 7]) expect(s.cars[i]!.joinTicks).toBe(0);
  });
  it('poolRadius is a config number: radius 300 replaces a rival 500 behind', () => {
    const cfg: RivalConfig = { ...RC, poolRadius: 300 };
    const s = pool([-500, 60, -200, 100, 200, -100, -250]);
    stepAll(s, BP, cfg);
    expect(s.cars[1]!.joinTicks).toBeGreaterThan(0);
    expect(Math.abs(s.cars[1]!.z - (s.cars[0]!.z - 60))).toBeLessThanOrEqual(0.5);
    for (const i of [2, 3, 4, 5, 6, 7]) expect(s.cars[i]!.joinTicks).toBe(0);
  });
  it('poolSpawnBehind is a config number: 90 -> z = zPlayer - 90', () => {
    const cfg: RivalConfig = { ...RC, poolSpawnBehind: 90 };
    const s = pool([-1900, 60, -200, 300, 500, -300, -500]);
    stepAll(s, BP, cfg);
    expect(Math.abs(s.cars[1]!.z - (s.cars[0]!.z - 90))).toBeLessThanOrEqual(0.5);
  });
  it('without a rival config nothing is replaced', () => {
    const s = pool([-1900, 1900, -200, 300, 500, -300, -500]);
    const before = s.cars.map((c) => c.nameId);
    step(
      s,
      s.cars.map(() => IDLE),
      TRACK,
      s.cars.map(() => BP),
    );
    expect(s.cars.map((c) => c.nameId)).toEqual(before);
  });
  it('traffic far from the player is not recycled by the rival pool', () => {
    const s = pool(FAR_OK, [{ z: PZ - 3000, x: 0.3, speed: 0.4 }]);
    stepAll(s, BP, RC);
    const t = s.cars[8]!;
    expect(t.kind).toBe('traffic');
    expect(t.nameId).toBe(-1);
    expect(t.joinTicks).toBe(0);
  });
});

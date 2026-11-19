import { describe, expect, it } from 'vitest';
import { fillLeaderboard, placeChange } from '../../src/ui/leaderboardModel';
import type { LeaderRow } from '../../src/ui/leaderboardModel';
import type { Car } from '../../src/sim/types';

interface Spec {
  z: number;
  place: number;
  nameId?: number;
  nemesis?: number;
  joinTicks?: number;
  kind?: Car['kind'];
}

function mk(specs: Spec[]): Car[] {
  return specs.map((s, i) => ({
    kind: s.kind ?? (i === 0 ? 'player' : 'rival'),
    z: s.z,
    place: s.place,
    nameId: s.nameId ?? (i === 0 ? -1 : i),
    nemesis: s.nemesis ?? 0,
    joinTicks: s.joinTicks ?? 0,
  })) as unknown as Car[];
}

function rows(n: number): LeaderRow[] {
  const out: LeaderRow[] = [];
  for (let i = 0; i < n; i++)
    out.push({ place: -9, nameId: -9, gapM: -9, isPlayer: false, nemesis: false, joined: false });
  return out;
}

// 8 race cars; place p has z = 800 - 100*(p-1) (p=1 -> 800 ... p=8 -> 100). Index 0 is the player.
function field(playerPlace: number): Car[] {
  const specs: Spec[] = [];
  specs.push({ z: 800 - 100 * (playerPlace - 1), place: playerPlace });
  let p = 1;
  for (let i = 1; i < 8; i++) {
    if (p === playerPlace) p++;
    specs.push({ z: 800 - 100 * (p - 1), place: p });
    p++;
  }
  return mk(specs);
}

const places = (out: LeaderRow[], n: number): number[] => out.slice(0, n).map((r) => r.place);

describe('R67 leaderboard window', () => {
  it('player 1st: places 1..5', () => {
    const out = rows(5);
    const n = fillLeaderboard(field(1), 8, 5, 1, out);
    expect(n).toBe(5);
    expect(places(out, n)).toEqual([1, 2, 3, 4, 5]);
    expect(out[0]!.isPlayer).toBe(true);
  });
  it('player 4th: centred, places 2..6', () => {
    // start = (4 - 1) - floor(5/2) = 1 -> places 2..6
    const out = rows(5);
    const n = fillLeaderboard(field(4), 8, 5, 1, out);
    expect(n).toBe(5);
    expect(places(out, n)).toEqual([2, 3, 4, 5, 6]);
    expect(out[2]!.isPlayer).toBe(true);
  });
  it('player last: places 4..8', () => {
    // start clamped to 8 - 5 = 3 -> places 4..8
    const out = rows(5);
    const n = fillLeaderboard(field(8), 8, 5, 1, out);
    expect(places(out, n)).toEqual([4, 5, 6, 7, 8]);
    expect(out[4]!.isPlayer).toBe(true);
  });
  it('player 2nd: clamped at top, places 1..5', () => {
    const out = rows(5);
    const n = fillLeaderboard(field(2), 8, 5, 1, out);
    expect(places(out, n)).toEqual([1, 2, 3, 4, 5]);
  });
  it('property: window always has maxRows contiguous places with exactly one player', () => {
    for (let pp = 1; pp <= 8; pp++) {
      for (const maxRows of [3, 4, 5, 8]) {
        const out = rows(8);
        const n = fillLeaderboard(field(pp), 8, maxRows, 1, out);
        expect(n).toBe(maxRows);
        expect(out.slice(0, n).filter((r) => r.isPlayer).length).toBe(1);
        for (let i = 1; i < n; i++) expect(out[i]!.place).toBe(out[i - 1]!.place + 1);
      }
    }
  });
  it('fewer cars than rows: all cars, sorted by place', () => {
    const cars = mk([
      { z: 50, place: 2 },
      { z: 90, place: 1 },
      { z: 10, place: 3 },
    ]);
    const out = rows(5);
    const n = fillLeaderboard(cars, 3, 5, 1, out);
    expect(n).toBe(3);
    expect(places(out, n)).toEqual([1, 2, 3]);
  });
  it('traffic cars after raceCount are ignored', () => {
    const cars = mk([
      { z: 50, place: 1 },
      { z: 40, place: 2 },
      { z: 999, place: 1, kind: 'traffic', nameId: -1 },
      { z: 998, place: 1, kind: 'traffic', nameId: -1 },
    ]);
    const out = rows(5);
    const n = fillLeaderboard(cars, 2, 5, 1, out);
    expect(n).toBe(2);
    expect(places(out, n)).toEqual([1, 2]);
  });
});

describe('R67 leaderboard row content', () => {
  it('gapM = round((z - zPlayer) * metersPerSegment), signed, player 0', () => {
    // zPlayer 100, mps 2.5: z 110 -> 25; z 97.5 -> -6.25 -> -6
    const cars = mk([
      { z: 100, place: 2 },
      { z: 110, place: 1, nameId: 3 },
      { z: 97.5, place: 3, nameId: 4 },
    ]);
    const out = rows(3);
    const n = fillLeaderboard(cars, 3, 3, 2.5, out);
    expect(n).toBe(3);
    expect(out[0]!.gapM).toBe(25);
    expect(out[1]!.gapM).toBe(0);
    expect(out[1]!.isPlayer).toBe(true);
    expect(out[2]!.gapM).toBe(-6);
  });
  it('gap sign matches place order: ahead positive, behind negative', () => {
    const out = rows(5);
    const n = fillLeaderboard(field(3), 8, 5, 1, out);
    for (let i = 0; i < n; i++) {
      const r = out[i]!;
      if (r.place < 3) expect(r.gapM).toBeGreaterThan(0);
      else if (r.place > 3) expect(r.gapM).toBeLessThan(0);
      else expect(r.gapM).toBe(0);
    }
    // place 1: z 800, player z 600 -> +200
    expect(out[0]!.gapM).toBe(200);
  });
  it('ties in z: order follows place as given, gap 0', () => {
    const cars = mk([
      { z: 70, place: 2 },
      { z: 70, place: 1, nameId: 5 },
      { z: 70, place: 3, nameId: 6 },
    ]);
    const out = rows(3);
    fillLeaderboard(cars, 3, 3, 4, out);
    expect(out.map((r) => r.nameId)).toEqual([5, -1, 6]);
    expect(out.map((r) => r.gapM)).toEqual([0, 0, 0]);
  });
  it('nameId, nemesis and joined flags', () => {
    const cars = mk([
      { z: 10, place: 3 },
      { z: 30, place: 1, nameId: 7, nemesis: 1 },
      { z: 20, place: 2, nameId: 9, joinTicks: 5 },
    ]);
    const out = rows(3);
    fillLeaderboard(cars, 3, 3, 1, out);
    expect(out[0]).toMatchObject({
      place: 1,
      nameId: 7,
      nemesis: true,
      joined: false,
      isPlayer: false,
    });
    expect(out[1]).toMatchObject({ place: 2, nameId: 9, nemesis: false, joined: true });
    expect(out[2]).toMatchObject({
      place: 3,
      nameId: -1,
      isPlayer: true,
      nemesis: false,
      joined: false,
    });
  });
  it('joinTicks 0 is not joined', () => {
    const cars = mk([
      { z: 1, place: 1 },
      { z: 0, place: 2, joinTicks: 0 },
    ]);
    const out = rows(2);
    fillLeaderboard(cars, 2, 2, 1, out);
    expect(out[1]!.joined).toBe(false);
  });
});

describe('R67 leaderboard allocation and determinism', () => {
  it('row objects keep identity and array length', () => {
    const out = rows(5);
    const ids = out.slice();
    fillLeaderboard(field(4), 8, 5, 1, out);
    fillLeaderboard(field(8), 8, 5, 1, out);
    expect(out.length).toBe(5);
    for (let i = 0; i < 5; i++) expect(out[i]).toBe(ids[i]);
  });
  it('same input twice gives identical rows', () => {
    const a = rows(5);
    const b = rows(5);
    fillLeaderboard(field(5), 8, 5, 3.5, a);
    fillLeaderboard(field(5), 8, 5, 3.5, b);
    expect(a).toEqual(b);
  });
  it('rows beyond the returned count are left untouched', () => {
    const out = rows(5);
    const n = fillLeaderboard(
      mk([
        { z: 1, place: 1 },
        { z: 0, place: 2 },
      ]),
      2,
      5,
      1,
      out,
    );
    expect(n).toBe(2);
    expect(out[3]!.place).toBe(-9);
  });
});

describe('R67 placeChange', () => {
  it('gained (place number dropped) is -1', () => expect(placeChange(5, 3)).toBe(-1));
  it('lost is +1', () => expect(placeChange(3, 5)).toBe(1));
  it('same is 0', () => expect(placeChange(4, 4)).toBe(0));
});

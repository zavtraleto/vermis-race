import { describe, expect, it } from 'vitest';
import { fillLeaderboard, placeChange } from '../../src/ui/leaderboardModel';
import type { LeaderRow } from '../../src/ui/leaderboardModel';
import type { Car } from '../../src/sim/types';
import rivalsJson from '../../src/data/rivals.json';

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

// `total` race cars (default 8); place p has z = 800 - 100*(p-1) (p=1 -> 800 ... p=8 -> 100).
// Index 0 is the player.
function field(playerPlace: number, total = 8): Car[] {
  const specs: Spec[] = [];
  specs.push({ z: 800 - 100 * (playerPlace - 1), place: playerPlace });
  let p = 1;
  for (let i = 1; i < total; i++) {
    if (p === playerPlace) p++;
    specs.push({ z: 800 - 100 * (p - 1), place: p });
    p++;
  }
  return mk(specs);
}

const places = (out: LeaderRow[], n: number): number[] => out.slice(0, n).map((r) => r.place);

// R67 as changed by the author 2026-11-20: the player row is no longer in the table; rows are the
// nearest rivals by place. Assumption for maxRows > 2 (brief only fixes leaderboardRows = 2): take
// the maxRows rivals with the smallest |place - playerPlace|, a tie between the one ahead and the one
// behind goes to the one ahead; output sorted by place ascending. Tests below with maxRows > 2 only
// use cases where that tie rule does not matter (player at an edge, or an even split).
describe('R67 leaderboard window', () => {
  it('player 1st: no player row, the next places 2..6', () => {
    // nobody ahead -> nearest 5 behind: places 2,3,4,5,6
    const out = rows(5);
    const n = fillLeaderboard(field(1), 8, 5, 1, out);
    expect(n).toBe(5);
    expect(places(out, n)).toEqual([2, 3, 4, 5, 6]);
    expect(out[0]!.isPlayer).toBe(false);
  });
  it('player 4th, maxRows 4: two ahead and two behind, places 2,3,5,6', () => {
    // was: maxRows 5 centred window 2..6 with the player; 5 rivals around 4th needs the tie rule,
    // so the input is now the even split 4 -> |p-4| <= 2 without 4
    const out = rows(5);
    const n = fillLeaderboard(field(4), 8, 4, 1, out);
    expect(n).toBe(4);
    expect(places(out, n)).toEqual([2, 3, 5, 6]);
    expect(out.slice(0, n).some((r) => r.isPlayer)).toBe(false);
  });
  it('player last: the places before, 3..7', () => {
    // nobody behind -> nearest 5 ahead of 8th: 7,6,5,4,3 -> sorted 3..7
    const out = rows(5);
    const n = fillLeaderboard(field(8), 8, 5, 1, out);
    expect(places(out, n)).toEqual([3, 4, 5, 6, 7]);
    expect(out.slice(0, n).some((r) => r.isPlayer)).toBe(false);
  });
  it('player 2nd: 1 ahead, then behind, places 1,3,4,5,6', () => {
    // distances from 2: place1 -> 1, place3 -> 1, 4 -> 2, 5 -> 3, 6 -> 4 (no tie at the cut)
    const out = rows(5);
    const n = fillLeaderboard(field(2), 8, 5, 1, out);
    expect(places(out, n)).toEqual([1, 3, 4, 5, 6]);
  });
  it('property: min(maxRows, raceCount-1) rows, none is the player, strictly ascending places', () => {
    for (let pp = 1; pp <= 8; pp++) {
      for (const maxRows of [2, 3, 4, 5, 8]) {
        const out = rows(8);
        const n = fillLeaderboard(field(pp), 8, maxRows, 1, out);
        expect(n).toBe(Math.min(maxRows, 7));
        expect(out.slice(0, n).filter((r) => r.isPlayer).length).toBe(0);
        expect(places(out, n)).not.toContain(pp);
        for (let i = 1; i < n; i++) expect(out[i]!.place).toBeGreaterThan(out[i - 1]!.place);
      }
    }
  });
  it('fewer cars than rows: all rivals, sorted by place, no player', () => {
    // player is place 2 -> rivals 1 and 3
    const cars = mk([
      { z: 50, place: 2 },
      { z: 90, place: 1 },
      { z: 10, place: 3 },
    ]);
    const out = rows(5);
    const n = fillLeaderboard(cars, 3, 5, 1, out);
    expect(n).toBe(2);
    expect(places(out, n)).toEqual([1, 3]);
  });
  it('traffic cars after raceCount are ignored', () => {
    const cars = mk([
      { z: 50, place: 1 },
      { z: 40, place: 2 },
      { z: 999, place: 1, kind: 'traffic', nameId: -1 },
      { z: 998, place: 1, kind: 'traffic', nameId: -1 },
    ]);
    // player place 1, one rival place 2 -> one row
    const out = rows(5);
    const n = fillLeaderboard(cars, 2, 5, 1, out);
    expect(n).toBe(1);
    expect(places(out, n)).toEqual([2]);
  });
});

describe('R67 leaderboard two nearest rivals (leaderboardRows = 2, author 2026-11-20)', () => {
  it('data: rivals.json leaderboardRows is 2', () => {
    expect(rivalsJson.leaderboardRows).toBe(2);
  });
  it('middle place 4 of 8 -> [3, 5]: one ahead, one behind', () => {
    const out = rows(2);
    const n = fillLeaderboard(field(4), 8, 2, 1, out);
    expect(n).toBe(2);
    expect(places(out, n)).toEqual([3, 5]);
  });
  it('every middle place p of 8 -> [p-1, p+1]', () => {
    for (let pp = 2; pp <= 7; pp++) {
      const out = rows(2);
      const n = fillLeaderboard(field(pp), 8, 2, 1, out);
      expect(n).toBe(2);
      expect(places(out, n)).toEqual([pp - 1, pp + 1]);
    }
  });
  it('player 1st -> the next two, [2, 3]', () => {
    const out = rows(2);
    const n = fillLeaderboard(field(1), 8, 2, 1, out);
    expect(n).toBe(2);
    expect(places(out, n)).toEqual([2, 3]);
  });
  it('player last (8 of 8) -> the two before, [6, 7]', () => {
    const out = rows(2);
    const n = fillLeaderboard(field(8), 8, 2, 1, out);
    expect(n).toBe(2);
    expect(places(out, n)).toEqual([6, 7]);
  });
  it('no row is the player, for every player place', () => {
    for (let pp = 1; pp <= 8; pp++) {
      const out = rows(2);
      const n = fillLeaderboard(field(pp), 8, 2, 1, out);
      for (let i = 0; i < n; i++) {
        expect(out[i]!.isPlayer).toBe(false);
        expect(out[i]!.place).not.toBe(pp);
      }
    }
  });
  it('total 2 (one rival): one row, the rival, whether player is 1st or 2nd', () => {
    const out = rows(2);
    let n = fillLeaderboard(field(1, 2), 2, 2, 1, out);
    expect(n).toBe(1);
    expect(places(out, n)).toEqual([2]);
    n = fillLeaderboard(field(2, 2), 2, 2, 1, out);
    expect(n).toBe(1);
    expect(places(out, n)).toEqual([1]);
  });
  it('total 1 (player only): zero rows', () => {
    const out = rows(2);
    const n = fillLeaderboard(field(1, 1), 1, 2, 1, out);
    expect(n).toBe(0);
    expect(out[0]!.place).toBe(-9);
  });
  it('total 3, player 2nd -> [1, 3]; player 3rd -> [1, 2]', () => {
    const out = rows(2);
    let n = fillLeaderboard(field(2, 3), 3, 2, 1, out);
    expect(places(out, n)).toEqual([1, 3]);
    n = fillLeaderboard(field(3, 3), 3, 2, 1, out);
    expect(places(out, n)).toEqual([1, 2]);
  });
  it('gaps: player 4th z 500, place 3 z 600 -> +100 seg, place 5 z 400 -> -100 seg', () => {
    // mps 2.5: +100*2.5 = 250 m, -100*2.5 = -250 m
    const out = rows(2);
    const n = fillLeaderboard(field(4), 8, 2, 2.5, out);
    expect(n).toBe(2);
    expect(out[0]!.gapM).toBe(250);
    expect(out[1]!.gapM).toBe(-250);
  });
  it('gaps at the edges: 1st -> both negative, last -> both positive', () => {
    // 1st z 800: place 2 z 700 -> -100, place 3 z 600 -> -200
    const out = rows(2);
    fillLeaderboard(field(1), 8, 2, 1, out);
    expect(out.map((r) => r.gapM)).toEqual([-100, -200]);
    // 8th z 100: place 6 z 300 -> +200, place 7 z 200 -> +100
    fillLeaderboard(field(8), 8, 2, 1, out);
    expect(out.map((r) => r.gapM)).toEqual([200, 100]);
  });
  it('nemesis, joined and nameId carried on the rival rows', () => {
    // player place 2; rival place 1 is nemesis nameId 7, rival place 3 joined nameId 9
    const cars = mk([
      { z: 20, place: 2 },
      { z: 30, place: 1, nameId: 7, nemesis: 1 },
      { z: 10, place: 3, nameId: 9, joinTicks: 5 },
      { z: 0, place: 4, nameId: 11 },
    ]);
    const out = rows(2);
    const n = fillLeaderboard(cars, 4, 2, 1, out);
    expect(n).toBe(2);
    expect(out[0]).toMatchObject({
      place: 1,
      nameId: 7,
      nemesis: true,
      joined: false,
      isPlayer: false,
    });
    expect(out[1]).toMatchObject({
      place: 3,
      nameId: 9,
      nemesis: false,
      joined: true,
      isPlayer: false,
    });
  });
  it('cars array order does not matter, only place', () => {
    // player place 3 of 5; rivals given in scrambled index order
    const cars = mk([
      { z: 30, place: 3 },
      { z: 10, place: 5, nameId: 1 },
      { z: 40, place: 2, nameId: 2 },
      { z: 20, place: 4, nameId: 3 },
      { z: 50, place: 1, nameId: 4 },
    ]);
    const out = rows(2);
    const n = fillLeaderboard(cars, 5, 2, 1, out);
    expect(places(out, n)).toEqual([2, 4]);
    expect(out.map((r) => r.nameId)).toEqual([2, 3]);
  });
  it('maxRows 4, middle place 4 of 8 -> [2, 3, 5, 6]', () => {
    const out = rows(4);
    const n = fillLeaderboard(field(4), 8, 4, 1, out);
    expect(n).toBe(4);
    expect(places(out, n)).toEqual([2, 3, 5, 6]);
  });
  it('determinism: same input twice gives identical rows', () => {
    const a = rows(2);
    const b = rows(2);
    fillLeaderboard(field(5), 8, 2, 3.5, a);
    fillLeaderboard(field(5), 8, 2, 3.5, b);
    expect(a).toEqual(b);
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
    // player row no longer listed (R67 2026-11-20): rows are place 1 and place 3
    const out = rows(3);
    const n = fillLeaderboard(cars, 3, 3, 2.5, out);
    expect(n).toBe(2);
    expect(out[0]!.gapM).toBe(25);
    expect(out[1]!.gapM).toBe(-6);
    expect(out[1]!.isPlayer).toBe(false);
  });
  it('gap sign matches place order: ahead positive, behind negative', () => {
    const out = rows(5);
    const n = fillLeaderboard(field(3), 8, 5, 1, out);
    for (let i = 0; i < n; i++) {
      const r = out[i]!;
      expect(r.isPlayer).toBe(false);
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
    // player (nameId -1) no longer listed (R67 2026-11-20)
    const out = rows(3);
    const n = fillLeaderboard(cars, 3, 3, 4, out);
    expect(n).toBe(2);
    expect(out.slice(0, n).map((r) => r.nameId)).toEqual([5, 6]);
    expect(out.slice(0, n).map((r) => r.gapM)).toEqual([0, 0]);
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
    // was: out[2] = player row (place 3); the player row is no longer listed (R67 2026-11-20)
    expect(out[2]!.place).toBe(-9);
  });
  it('joinTicks 0 is not joined', () => {
    const cars = mk([
      { z: 1, place: 1 },
      { z: 0, place: 2, joinTicks: 0 },
    ]);
    // player is place 1, so the rival (place 2) is now row 0 (R67 2026-11-20)
    const out = rows(2);
    fillLeaderboard(cars, 2, 2, 1, out);
    expect(out[0]!.place).toBe(2);
    expect(out[0]!.joined).toBe(false);
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
    // one rival, player row not listed (R67 2026-11-20): n 2 -> 1
    expect(n).toBe(1);
    expect(out[1]!.place).toBe(-9);
    expect(out[3]!.place).toBe(-9);
  });
});

describe('R67 placeChange', () => {
  it('gained (place number dropped) is -1', () => expect(placeChange(5, 3)).toBe(-1));
  it('lost is +1', () => expect(placeChange(3, 5)).toBe(1));
  it('same is 0', () => expect(placeChange(4, 4)).toBe(0));
});

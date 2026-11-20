import type { Car } from '../sim/types';

/** R67 one leaderboard row. Preallocated by the caller and refilled in place. */
export interface LeaderRow {
  place: number;
  nameId: number;
  gapM: number; // metres relative to the player (ahead positive)
  isPlayer: boolean;
  nemesis: boolean;
  joined: boolean;
}

/**
 * R67 fills `out` with up to maxRows rivals nearest to the player by place (cars[0..raceCount),
 * cars[0] is the player, who is not listed), sorted by place; returns rows filled. Nearest first:
 * at each place distance the one ahead, then the one behind; at the edge of the field the rows
 * come from the other side (1st -> 2, 3; last -> the two before). No allocations.
 */
export function fillLeaderboard(
  cars: readonly Car[],
  raceCount: number,
  maxRows: number,
  metersPerSegment: number,
  out: LeaderRow[],
): number {
  const total = raceCount < cars.length ? raceCount : cars.length;
  if (total <= 1) return 0;
  let rows = maxRows < total - 1 ? maxRows : total - 1;
  if (rows > out.length) rows = out.length;
  const player = cars[0]!;
  const pp = player.place;
  // Rows taken ahead of (a) and behind (b) the player.
  let a = 0;
  let b = 0;
  for (let d = 1; d <= total && a + b < rows; d++) {
    if (pp - d >= 1) a++;
    if (a + b < rows && pp + d <= total) b++;
  }
  let n = 0;
  for (let place = pp - a; place <= pp + b; place++) {
    if (place === pp) continue;
    for (let i = 1; i < total; i++) {
      const c = cars[i]!;
      if (c.place !== place) continue;
      const r = out[n++]!;
      r.place = place;
      r.nameId = c.nameId;
      r.gapM = Math.round((c.z - player.z) * metersPerSegment) + 0; // + 0: no -0
      r.isPlayer = false;
      r.nemesis = c.nemesis === 1;
      r.joined = c.joinTicks > 0;
      break;
    }
  }
  return n;
}

/** R67 place change: -1 gained places (place number dropped), +1 lost places, 0 same. */
export function placeChange(prevPlace: number, place: number): -1 | 0 | 1 {
  return place < prevPlace ? -1 : place > prevPlace ? 1 : 0;
}

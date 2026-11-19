import type { Car } from '../sim/types';

/** R67 one leaderboard row. Preallocated by the caller and refilled in place. */
export interface LeaderRow {
  place: number;
  nameId: number;
  gapM: number; // metres relative to the player, 0 for the player
  isPlayer: boolean;
  nemesis: boolean;
  joined: boolean;
}

/**
 * R67 fills `out` with a window of up to maxRows race cars (cars[0..raceCount), cars[0] is the
 * player) around the player, sorted by place; returns rows filled. The window is centred on the
 * player (an even maxRows puts the extra row above) and clamped to the field. No allocations.
 */
export function fillLeaderboard(
  cars: readonly Car[],
  raceCount: number,
  maxRows: number,
  metersPerSegment: number,
  out: LeaderRow[],
): number {
  const total = raceCount < cars.length ? raceCount : cars.length;
  if (total <= 0) return 0;
  let rows = maxRows < total ? maxRows : total;
  if (rows > out.length) rows = out.length;
  const player = cars[0]!;
  let start = player.place - 1 - Math.floor(rows / 2);
  if (start > total - rows) start = total - rows;
  if (start < 0) start = 0;
  let n = 0;
  for (let k = 0; k < rows; k++) {
    const place = start + k + 1;
    for (let i = 0; i < total; i++) {
      const c = cars[i]!;
      if (c.place !== place) continue;
      const r = out[n++]!;
      r.place = place;
      r.nameId = c.nameId;
      r.gapM = i === 0 ? 0 : Math.round((c.z - player.z) * metersPerSegment) + 0; // + 0: no -0
      r.isPlayer = i === 0;
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

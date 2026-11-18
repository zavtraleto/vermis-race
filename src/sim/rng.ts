import type { RaceState } from './types';

/** Returns a number in [0, 1) and advances state.rng. mulberry32; whole state is the int state.rng (R2). */
export function nextRandom(state: RaceState): number {
  let t = (state.rng + 0x6d2b79f5) | 0;
  state.rng = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

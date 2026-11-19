import type { Segment, Track, TrackDef } from './types';

// R30: float residue allowed when the hills of a loop sum to zero (e.g. 0.1 + 0.2 - 0.3).
const LOOP_HEIGHT_EPS = 1e-9;

export function makeStraightTrack(length: number): Track {
  const segments: Segment[] = [];
  for (let i = 0; i < length; i++) segments.push({ curve: 0, y: 0 });
  return { segments };
}

/**
 * Builds a looped track from sections, like addRoad in javascript-racer:
 * enter: easeIn(0, curve, n/enter); hold: curve; leave: easeInOut(curve, 0, n/leave).
 * R30: y (end of segment) = easeInOut(startY, startY + hill, k/total) over the whole section,
 * k = 1..total; the loop must end at y = 0.
 */
export function buildTrack(def: TrackDef): Track {
  const segments: Segment[] = [];
  let startY = 0;
  for (const s of def.sections) {
    const c = s.curve;
    const hill = s.hill ?? 0;
    const total = s.enter + s.hold + s.leave;
    let k = 0;
    const yAt = (): number => {
      k += 1;
      return startY + hill * (0.5 - Math.cos((Math.PI * k) / total) / 2);
    };
    for (let n = 0; n < s.enter; n++) {
      const t = n / s.enter;
      // easeIn(0, c, t) = 0 + (c - 0) * t^2; the leading 0 + keeps +0 (not -0) at n = 0.
      segments.push({ curve: 0 + (c - 0) * t * t, y: yAt() });
    }
    for (let n = 0; n < s.hold; n++) segments.push({ curve: c, y: yAt() });
    for (let n = 0; n < s.leave; n++) {
      segments.push({
        curve: c + (0 - c) * (0.5 - Math.cos((Math.PI * n) / s.leave) / 2),
        y: yAt(),
      });
    }
    if (total > 0) startY += hill;
  }
  if (Math.abs(startY) > LOOP_HEIGHT_EPS) {
    throw new Error(`track: hills must sum to 0 over the loop (ends at y = ${startY})`);
  }
  return { segments };
}

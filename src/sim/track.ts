import type { Segment, Track, TrackDef } from './types';

export function makeStraightTrack(length: number): Track {
  const segments: Segment[] = [];
  for (let i = 0; i < length; i++) segments.push({ curve: 0 });
  return { segments };
}

/**
 * Builds a looped track from sections, like addRoad in javascript-racer:
 * enter: easeIn(0, curve, n/enter); hold: curve; leave: easeInOut(curve, 0, n/leave).
 */
export function buildTrack(def: TrackDef): Track {
  const segments: Segment[] = [];
  for (const s of def.sections) {
    const c = s.curve;
    for (let n = 0; n < s.enter; n++) {
      const t = n / s.enter;
      // easeIn(0, c, t) = 0 + (c - 0) * t^2; the leading 0 + keeps +0 (not -0) at n = 0.
      segments.push({ curve: 0 + (c - 0) * t * t });
    }
    for (let n = 0; n < s.hold; n++) segments.push({ curve: c });
    for (let n = 0; n < s.leave; n++) {
      segments.push({ curve: c + (0 - c) * (0.5 - Math.cos((Math.PI * n) / s.leave) / 2) });
    }
  }
  return { segments };
}

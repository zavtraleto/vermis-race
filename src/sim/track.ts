import type { Segment, Track } from './types';

export function makeStraightTrack(length: number): Track {
  const segments: Segment[] = [];
  for (let i = 0; i < length; i++) segments.push({ curve: 0 });
  return { segments };
}

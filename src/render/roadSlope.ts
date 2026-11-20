import type { Track } from '../sim/types';
import { roadHeightAt } from './projection';

const RAD_TO_DEG = 180 / Math.PI;

/** R30b numbers (car3d.json "slope"). */
export interface SlopeConfig {
  slopeHalfSpan: number; // segments ahead of and behind the car where the road height is read
  slopePitchGain: number; // body pitch per degree of road slope
  playerPitchGain: number; // extra factor for the player car (its own, flatter camera)
  eyeClearance: number; // world units the eye stays above the road under it (cameraLineOffset)
}

/**
 * R30b (c, d): body pitch along the road slope at track position z, degrees, climb = nose up (> 0):
 * gain * atan of the height difference between z + halfSpan and z - halfSpan over 2 * halfSpan
 * (heights and z in segment lengths). No allocations.
 */
export function slopePitchDeg(track: Track, z: number, halfSpan: number, gain: number): number {
  const dh = roadHeightAt(track, z + halfSpan) - roadHeightAt(track, z - halfSpan);
  return gain * Math.atan(dh / (2 * halfSpan)) * RAD_TO_DEG;
}

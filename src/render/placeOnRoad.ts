import type { Projection } from './projection';

/** Screen placement of a sprite standing on the road. Screen px, origin top-left, y down. */
export interface Placement {
  x: number; // centre x of the sprite's base, px
  y: number; // y of the sprite's base (where it touches the road), px
  w: number; // width, px
  h: number; // height, px
  depth: number; // NDC z in (-1, 1); smaller = nearer
}

/**
 * Places an object standing on the road using the buffers of the last project() call.
 *
 * - `z`: track position of the object's base, in segments (any real; wrapped by proj.length).
 * - `offset`: lateral position in road half-widths, measured from the road centre (+ = right).
 * - `worldW`, `worldH`: object size in world units (same units as RoadConfig.halfWidth).
 *
 * Writes `out` and returns true when the object lies inside the drawn range; otherwise
 * returns false and leaves `out` untouched. No allocations.
 */
export function placeOnRoad(
  out: Placement,
  proj: Projection,
  z: number,
  offset: number,
  worldW: number,
  worldH: number,
): boolean {
  const len = proj.length;
  // Add len only when negative: (r + len) % len would round r just below an integer up to it.
  let r = (z - proj.base) % len;
  if (r < 0) r += len;
  if (!(r >= 0 && r < proj.count - 1)) return false;
  let i = Math.floor(r);
  if (i > proj.count - 2) i = proj.count - 2;
  const t = r - i;
  const j = i + 1;
  const px = proj.x;
  const py = proj.y;
  const pw = proj.w;
  const ps = proj.scale;
  const s = ps[i]! + (ps[j]! - ps[i]!) * t;
  const w = pw[i]! + (pw[j]! - pw[i]!) * t;
  out.x = px[i]! + (px[j]! - px[i]!) * t + offset * w;
  out.y = py[i]! + (py[j]! - py[i]!) * t;
  out.w = worldW * s;
  out.h = worldH * s;
  // Sits between strip i-1's farthest road layer (i-0.5) and strip i's nearest (i+0.3).
  const step = 2 / (proj.count - 1);
  out.depth = -1 + step * (i + 0.05 + 0.2 * t);
  return true;
}

import type { Placement } from './placeOnRoad';
import type { Projection } from './projection';

/** R24c tyre marks of the player in DRIFT (render only; numbers in src/data/sprites.json "tyreMarks"). */
export interface TyreMarksConfig {
  marks: string; // "on" | "off"
  capacity: number; // samples kept (one sample = both rear wheels), fixed
  spacing: number; // segments travelled between samples
  width: number; // mark width, world units
  length: number; // segments behind the rear wheels where a mark is gone
  fadeFrom: number; // fraction of length where the mark starts fading into the asphalt
  maxGap: number; // segments; a longer jump between samples (crash return, respawn) breaks the mark
  stepPx: number; // a piece between two samples is drawn as sub-pieces about this tall on screen
  maxSub: number; // at most this many sub-pieces per piece
}

/** A point on the road surface: track z (segments, wrapped) and offset (road half-widths, + = right). */
export interface RoadPoint {
  z: number;
  x: number;
}

/** Segments travelled forward from track z `a` to `b` on a loop of `len` segments, in [0, len). */
export function forwardDist(a: number, b: number, len: number): number {
  let d = (b - a) % len;
  if (d < 0) d += len;
  return d;
}

/**
 * Inverse of placeOnRoad at height 0 with the buffers of the last project() call: screen point
 * (px, y down) -> road point. Searches the nearest strip whose lines enclose sy (lines behind a
 * crest skipped), interpolates linearly inside it like placeOnRoad. Writes `out` and returns true
 * when found; otherwise false and `out` untouched. No allocations.
 */
export function roadPointAt(out: RoadPoint, proj: Projection, sx: number, sy: number): boolean {
  const py = proj.y;
  for (let n = 0; n < proj.count - 1; n++) {
    if (proj.clipped[n + 1] === 1) continue;
    const y0 = py[n]!;
    const y1 = py[n + 1]!;
    if (!(y0 > y1 && sy <= y0 && sy >= y1)) continue;
    const t = (y0 - sy) / (y0 - y1);
    const x = proj.x[n]! + (proj.x[n + 1]! - proj.x[n]!) * t;
    const w = proj.w[n]! + (proj.w[n + 1]! - proj.w[n]!) * t;
    if (w <= 0) return false;
    out.z = (proj.base + n + t) % proj.length;
    out.x = (sx - x) / w;
    return true;
  }
  return false;
}

// Line position r (0..count-1) of track z in the last projection, or -1 outside it / behind a crest.
function lineOf(proj: Projection, z: number): number {
  let r = (z - proj.base) % proj.length;
  if (r < 0) r += proj.length;
  if (!(r >= 0 && r < proj.count - 1)) return -1;
  const i = Math.floor(r);
  if (proj.clipped[i] === 1 || proj.clipped[i + 1] === 1) return -1;
  return r;
}

/**
 * Screen rectangle of one mark piece between road points (z0, x0) and (z1, x1), `worldW` wide, in
 * the SpriteBatch convention (x = centre of the base, y = base = the nearer end, px). Depth is the
 * nearer end's, as placeOnRoad gives it: in front of the road strips the piece lies on, behind
 * anything standing nearer. False (out untouched) when either end is outside the drawn range or
 * behind a crest. No allocations.
 */
export function markRect(
  out: Placement,
  proj: Projection,
  z0: number,
  x0: number,
  z1: number,
  x1: number,
  worldW: number,
): boolean {
  const r0 = lineOf(proj, z0);
  const r1 = lineOf(proj, z1);
  if (r0 < 0 || r1 < 0) return false;
  const near = r0 <= r1 ? r0 : r1;
  const i0 = Math.floor(r0);
  const t0 = r0 - i0;
  const i1 = Math.floor(r1);
  const t1 = r1 - i1;
  const sx0 = lerp(proj.x, i0, t0) + x0 * lerp(proj.w, i0, t0);
  const sy0 = lerp(proj.y, i0, t0);
  const sx1 = lerp(proj.x, i1, t1) + x1 * lerp(proj.w, i1, t1);
  const sy1 = lerp(proj.y, i1, t1);
  const ni = Math.floor(near);
  const s = lerp(proj.scale, ni, near - ni);
  out.x = (sx0 + sx1) * 0.5;
  out.y = sy0 > sy1 ? sy0 : sy1;
  out.w = worldW * s;
  out.h = Math.abs(sy0 - sy1);
  const step = 2 / (proj.count - 1);
  out.depth = -1 + step * (ni + 0.05 + 0.2 * (near - ni));
  return true;
}

function lerp(a: Float32Array, i: number, t: number): number {
  return a[i]! + (a[i + 1]! - a[i]!) * t;
}

/**
 * R24c ring of mark samples: both rear wheels' road points per sample and a link flag (1 = the
 * sample continues the mark of the previous, older one). Fixed capacity, the oldest is overwritten.
 * k = 0 is the newest sample. No allocations after construction.
 */
export class TyreMarkRing {
  readonly zL: Float64Array;
  readonly xL: Float64Array;
  readonly zR: Float64Array;
  readonly xR: Float64Array;
  readonly link: Uint8Array;
  private head = 0;
  private n = 0;

  constructor(readonly capacity: number) {
    this.zL = new Float64Array(capacity);
    this.xL = new Float64Array(capacity);
    this.zR = new Float64Array(capacity);
    this.xR = new Float64Array(capacity);
    this.link = new Uint8Array(capacity);
  }

  get count(): number {
    return this.n;
  }

  /** Buffer index of the k-th newest sample (0 = newest), k < count. */
  at(k: number): number {
    return (this.head - 1 - k + 2 * this.capacity) % this.capacity;
  }

  push(zL: number, xL: number, zR: number, xR: number, link: boolean): void {
    if (this.capacity <= 0) return;
    const i = this.head;
    this.zL[i] = zL;
    this.xL[i] = xL;
    this.zR[i] = zR;
    this.xR[i] = xR;
    this.link[i] = link ? 1 : 0;
    this.head = (i + 1) % this.capacity;
    if (this.n < this.capacity) this.n += 1;
  }

  clear(): void {
    this.n = 0;
    this.head = 0;
  }
}

/**
 * R24c: records the rear wheels' road points while the player is in DRIFT on the asphalt. The
 * live wheel points (`left`, `right`) are updated on every call, so the newest mark piece runs up
 * to the tyres; a new sample is stored every `spacing` segments travelled. Leaving DRIFT, leaving
 * the asphalt or a jump longer than maxGap ends the current mark.
 */
export class TyreMarks {
  readonly ring: TyreMarkRing;
  readonly left: RoadPoint = { z: 0, x: 0 };
  readonly right: RoadPoint = { z: 0, x: 0 };
  /** The live wheel points continue the newest sample (a mark is being laid now). */
  open = false;
  private lastZ = 0;

  constructor(private readonly cfg: TyreMarksConfig) {
    this.ring = new TyreMarkRing(cfg.capacity);
  }

  /**
   * `found` = both wheel points were found on the road surface this frame (left / right written).
   * `len` = track length in segments.
   */
  track(drifting: boolean, found: boolean, len: number): void {
    const c = this.cfg;
    if (c.marks !== 'on') {
      this.ring.clear();
      this.open = false;
      return;
    }
    const l = this.left;
    const r = this.right;
    if (!drifting || !found || Math.abs(l.x) > 1 || Math.abs(r.x) > 1) {
      this.open = false;
      return;
    }
    const z = (l.z + r.z) * 0.5;
    if (this.open && forwardDist(this.lastZ, z, len) > c.maxGap) this.open = false;
    if (!this.open) {
      this.ring.push(l.z, l.x, r.z, r.x, false);
      this.lastZ = z;
      this.open = true;
      return;
    }
    if (forwardDist(this.lastZ, z, len) >= c.spacing) {
      this.ring.push(l.z, l.x, r.z, r.x, true);
      this.lastZ = z;
    }
  }
}

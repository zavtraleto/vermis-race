import { SEG_PER_UNIT } from '../sim/constants';
import type { Track } from '../sim/types';

/**
 * ribbonMap: top-zone strip with the road ahead for the next few seconds (kickoff brief,
 * "Трассы и читаемость", item 1). Pure: no DOM, no three.js, no allocations per update.
 */
export interface RibbonMapConfig {
  lookaheadSeconds: number; // seconds of road ahead at the current speed
  minDistance: number; // segments, lower bound so the ribbon is not empty at standstill
  points: number; // polyline intervals; arrays hold points + 1 vertices
  substeps: number; // integration steps per interval
  headingPerCurve: number; // map heading (rad) per segment per curve unit
  maxHeadingDeg: number; // heading is softly compressed below this, so the ribbon never turns back down
}

export interface RibbonThresholds {
  straight: number; // |curve| below this -> straight
  easy: number; // below this -> easy
  medium: number; // below this -> medium, otherwise hard
}

export const RIBBON_STRAIGHT = 0;
export const RIBBON_EASY = 1;
export const RIBBON_MEDIUM = 2;
export const RIBBON_HARD = 3;

export interface RibbonMap {
  count: number; // vertices written
  distance: number; // lookahead, segments
  x: Float64Array; // lateral offset from the car, segments, + right
  y: Float64Array; // forward offset from the car, segments
  cls: Uint8Array; // steepness class at each vertex (RIBBON_*)
  carX: number; // car lateral position, half-widths
}

export interface RibbonZone {
  width: number; // px, zone starts at the top-left of the screen
  height: number; // px
  padding: number; // px kept free on every side
  xStretch: number; // horizontal scale relative to vertical
}

export interface RibbonLayout {
  count: number;
  scale: number; // px per segment (vertical)
  px: Float64Array; // screen x, px
  py: Float64Array; // screen y, px, y down
}

/** Class boundaries from the class values (curves.json): half of easy, then midpoints. */
export function ribbonThresholds(classes: {
  easy: number;
  medium: number;
  hard: number;
}): RibbonThresholds {
  return {
    straight: classes.easy / 2,
    easy: (classes.easy + classes.medium) / 2,
    medium: (classes.medium + classes.hard) / 2,
  };
}

export function classifyCurve(curve: number, t: RibbonThresholds): number {
  const a = Math.abs(curve);
  if (a < t.straight) return RIBBON_STRAIGHT;
  if (a < t.easy) return RIBBON_EASY;
  if (a < t.medium) return RIBBON_MEDIUM;
  return RIBBON_HARD;
}

/** Segments ahead: lookaheadSeconds at speed (R16: speed * SEG_PER_UNIT segments/s), at least minDistance. */
export function lookaheadDistance(speed: number, cfg: RibbonMapConfig): number {
  const d = speed * SEG_PER_UNIT * cfg.lookaheadSeconds;
  return d > cfg.minDistance ? d : cfg.minDistance;
}

export function createRibbonMap(cfg: RibbonMapConfig): RibbonMap {
  const n = cfg.points + 1;
  return {
    count: 0,
    distance: 0,
    x: new Float64Array(n),
    y: new Float64Array(n),
    cls: new Uint8Array(n),
    carX: 0,
  };
}

export function createRibbonLayout(cfg: RibbonMapConfig): RibbonLayout {
  const n = cfg.points + 1;
  return { count: 0, scale: 0, px: new Float64Array(n), py: new Float64Array(n) };
}

// Exact heading integral over piecewise-constant segment curves, walked forward monotonically.
// Module-level cursor: no per-call allocation.
let curSeg = 0;
let curStart = 0; // distance from the car where the current segment starts (<= 0 for the first)
let curH = 0; // heading integral at curStart
let curCurve = 0;

function wrap(seg: number, len: number): number {
  const s = seg % len;
  return s < 0 ? s + len : s;
}

/** Heading integral (curve * segments) at distance s ahead; s must not decrease between calls. */
function headingAt(track: Track, s: number): number {
  const segs = track.segments;
  const len = segs.length;
  while (s > curStart + 1) {
    curH += curCurve * (curStart + 1 - Math.max(curStart, 0));
    curStart += 1;
    curSeg = wrap(curSeg + 1, len);
    curCurve = segs[curSeg]!.curve;
  }
  return curH + curCurve * (s - Math.max(curStart, 0));
}

/** Fills `out` with the polyline of the road ahead of a car at z with the given speed. */
export function updateRibbonMap(
  out: RibbonMap,
  track: Track,
  z: number,
  speed: number,
  carX: number,
  cfg: RibbonMapConfig,
  t: RibbonThresholds,
): void {
  const segs = track.segments;
  const len = segs.length;
  const zFloor = Math.floor(z);
  const frac = z - zFloor;
  curSeg = wrap(zFloor, len);
  curStart = -frac;
  curH = 0;
  curCurve = segs[curSeg]!.curve;

  const distance = lookaheadDistance(speed, cfg);
  const n = cfg.points;
  const sub = cfg.substeps;
  const ds = distance / (n * sub);
  const maxH = (cfg.maxHeadingDeg * Math.PI) / 180;
  const k = cfg.headingPerCurve;

  let x = 0;
  let y = 0;
  out.x[0] = 0;
  out.y[0] = 0;
  out.cls[0] = classifyCurve(curCurve, t);
  for (let i = 1; i <= n; i++) {
    for (let j = 0; j < sub; j++) {
      const sMid = ((i - 1) * sub + j + 0.5) * ds;
      // Soft compression keeps the map heading inside +-maxH, odd and monotonic.
      const h = maxH * Math.tanh((k * headingAt(track, sMid)) / maxH);
      x += Math.sin(h) * ds;
      y += Math.cos(h) * ds;
    }
    const s = i * ds * sub;
    headingAt(track, s); // moves the cursor to the segment under the vertex
    out.x[i] = x;
    out.y[i] = y;
    out.cls[i] = classifyCurve(curCurve, t);
  }
  out.count = n + 1;
  out.distance = distance;
  out.carX = carX;
}

/**
 * Maps the ribbon into the top zone: car at the bottom centre, the full lookahead spans the
 * inner height, x is stretched and then softly clamped to the inner width (never clipped).
 */
export function layoutRibbon(out: RibbonLayout, map: RibbonMap, zone: RibbonZone): void {
  const innerH = zone.height - 2 * zone.padding;
  const scale = map.distance > 0 ? innerH / map.distance : 0;
  const cx = zone.width / 2;
  const lim = cx - zone.padding;
  const bottom = zone.height - zone.padding;
  const sx = scale * zone.xStretch;
  for (let i = 0; i < map.count; i++) {
    out.px[i] = cx + lim * Math.tanh((map.x[i]! * sx) / lim);
    out.py[i] = bottom - map.y[i]! * scale;
  }
  out.count = map.count;
  out.scale = scale;
}

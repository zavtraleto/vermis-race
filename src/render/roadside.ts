// R32 roadside objects: placement built once at load from the track length and a seed.
export const ROADSIDE_LAMP = 0,
  ROADSIDE_BILLBOARD = 1,
  ROADSIDE_BUILDING = 2;

export interface RoadsideConfig {
  lamps: { every: number; offset: number };
  billboards: { everyMin: number; everyMax: number; offset: number };
  buildings: {
    everyMin: number;
    everyMax: number;
    offsetMin: number;
    offsetMax: number;
    variants: number;
  };
}

export interface Roadside {
  count: number;
  seg: Int32Array; // ascending track segment of the object's base
  x: Float32Array; // lateral position, road half-widths from the centre (+ = right)
  kind: Uint8Array; // ROADSIDE_*
  variant: Uint8Array; // billboard colour / building shape
}

export type BuildRoadside = (segmentCount: number, cfg: RoadsideConfig, seed: number) => Roadside;

// mulberry32, the same generator as the sim RNG; local state, load time only.
function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    let t = (s + 0x6d2b79f5) | 0;
    s = t;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gapIn(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Billboard variant = a raw pick over the whole Uint8 storage range; the drawing takes it modulo
 * the palette size (worldSprites: variant % panels), so no count is duplicated here.
 */
const BILLBOARD_VARIANTS = 2 ** (8 * Uint8Array.BYTES_PER_ELEMENT);

export const buildRoadside: BuildRoadside = (segmentCount, cfg, seed) => {
  const rng = makeRng(seed);
  const n = Math.max(0, Math.floor(segmentCount));
  const lampEvery = Math.max(1, Math.floor(cfg.lamps.every));
  const onLamp = (s: number): boolean => s % lampEvery === 0;

  // Billboards: gaps in [everyMin, everyMax]; a gap landing on a lamp segment is nudged by one
  // inside the range (R32: a billboard never shares a segment with a lamp pair).
  const bb = cfg.billboards;
  const bbSeg: number[] = [];
  const bbSide: number[] = [];
  const bbVar: number[] = [];
  const bMin = Math.max(1, Math.floor(bb.everyMin));
  const bMax = Math.max(bMin, Math.floor(bb.everyMax));
  for (let at = 0; ;) {
    let g = gapIn(rng, bMin, bMax);
    if (onLamp(at + g)) {
      if (g + 1 <= bMax && !onLamp(at + g + 1)) g += 1;
      else if (g - 1 >= bMin && !onLamp(at + g - 1)) g -= 1;
    }
    at += g;
    if (at >= n) break;
    const side = rng() < 0.5 ? -1 : 1;
    const variant = Math.floor(rng() * BILLBOARD_VARIANTS);
    if (onLamp(at)) continue; // degenerate range (everyMin = everyMax on a lamp multiple): skip
    bbSeg.push(at);
    bbSide.push(side);
    bbVar.push(variant);
  }

  // Buildings: one sequence for both sides, gaps in [everyMin, everyMax].
  const bd = cfg.buildings;
  const bdSeg: number[] = [];
  const bdX: number[] = [];
  const bdVar: number[] = [];
  const dMin = Math.max(1, Math.floor(bd.everyMin));
  const dMax = Math.max(dMin, Math.floor(bd.everyMax));
  const variants = Math.max(1, Math.floor(bd.variants));
  for (let at = gapIn(rng, 0, dMax); at < n; at += gapIn(rng, dMin, dMax)) {
    const side = rng() < 0.5 ? -1 : 1;
    const off = bd.offsetMin + rng() * (bd.offsetMax - bd.offsetMin);
    bdSeg.push(at);
    bdX.push(side * off);
    bdVar.push(Math.min(variants - 1, Math.floor(rng() * variants)));
  }

  const lampCount = n > 0 ? Math.floor((n - 1) / lampEvery) + 1 : 0;
  const cap = Math.max(1, lampCount * 2 + bbSeg.length + bdSeg.length);
  const out: Roadside = {
    count: 0,
    seg: new Int32Array(cap),
    x: new Float32Array(cap),
    kind: new Uint8Array(cap),
    variant: new Uint8Array(cap),
  };
  const emit = (s: number, x: number, kind: number, variant: number): void => {
    const i = out.count++;
    out.seg[i] = s;
    out.x[i] = x;
    out.kind[i] = kind;
    out.variant[i] = variant;
  };
  // Merge in ascending segment order (each list is ascending already).
  let bi = 0;
  let di = 0;
  for (let s = 0; s < n; s++) {
    if (onLamp(s)) {
      emit(s, -cfg.lamps.offset, ROADSIDE_LAMP, 0);
      emit(s, cfg.lamps.offset, ROADSIDE_LAMP, 0);
    }
    while (bi < bbSeg.length && bbSeg[bi] === s) {
      emit(s, bbSide[bi]! * bb.offset, ROADSIDE_BILLBOARD, bbVar[bi]!);
      bi++;
    }
    while (di < bdSeg.length && bdSeg[di] === s) {
      emit(s, bdX[di]!, ROADSIDE_BUILDING, bdVar[di]!);
      di++;
    }
  }
  return out;
};

/** CSR index: objects of segment s are [first[s], first[s + 1]). Built at load. */
export function indexBySegment(r: Roadside, segmentCount: number): Int32Array {
  const first = new Int32Array(segmentCount + 1);
  let i = 0;
  for (let s = 0; s <= segmentCount; s++) {
    while (i < r.count && r.seg[i]! < s) i++;
    first[s] = i;
  }
  return first;
}

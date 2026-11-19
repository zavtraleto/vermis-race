import { describe, expect, it } from 'vitest';
import sprites from '../../src/data/sprites.json';
import {
  ROADSIDE_BILLBOARD,
  ROADSIDE_BUILDING,
  ROADSIDE_LAMP,
  buildRoadside,
} from '../../src/render/roadside';
import type { Roadside, RoadsideConfig } from '../../src/render/roadside';

const CFG: RoadsideConfig = {
  lamps: { every: 4, offset: 1.4 },
  billboards: { everyMin: 40, everyMax: 90, offset: 2.2 },
  buildings: { everyMin: 6, everyMax: 14, offsetMin: 3, offsetMax: 6, variants: 4 },
};
const N = 4000;
const SEED = 12345;

function ofKind(r: Roadside, kind: number): { seg: number[]; x: number[]; variant: number[] } {
  const out = { seg: [] as number[], x: [] as number[], variant: [] as number[] };
  for (let i = 0; i < r.count; i++) {
    if (r.kind[i] !== kind) continue;
    out.seg.push(r.seg[i] as number);
    out.x.push(r.x[i] as number);
    out.variant.push(r.variant[i] as number);
  }
  return out;
}
function gaps(seg: number[]): number[] {
  const g: number[] = [];
  for (let i = 1; i < seg.length; i++) g.push((seg[i] as number) - (seg[i - 1] as number));
  return g;
}
function snapshot(r: Roadside): unknown {
  return {
    count: r.count,
    seg: Array.from(r.seg.subarray(0, r.count)),
    x: Array.from(r.x.subarray(0, r.count)),
    kind: Array.from(r.kind.subarray(0, r.count)),
    variant: Array.from(r.variant.subarray(0, r.count)),
  };
}

describe('R32 roadside objects: determinism and layout', () => {
  it('same inputs twice give identical arrays', () => {
    expect(snapshot(buildRoadside(N, CFG, SEED))).toEqual(snapshot(buildRoadside(N, CFG, SEED)));
  });

  it('a different seed changes billboards and buildings but not lamps', () => {
    const a = buildRoadside(N, CFG, SEED);
    const b = buildRoadside(N, CFG, SEED + 1);
    expect(ofKind(a, ROADSIDE_LAMP)).toEqual(ofKind(b, ROADSIDE_LAMP));
    expect(ofKind(a, ROADSIDE_BILLBOARD)).not.toEqual(ofKind(b, ROADSIDE_BILLBOARD));
    expect(ofKind(a, ROADSIDE_BUILDING)).not.toEqual(ofKind(b, ROADSIDE_BUILDING));
  });

  it('seg is ascending, all < segmentCount, typed arrays are long enough', () => {
    const r = buildRoadside(N, CFG, SEED);
    expect(r.count).toBeGreaterThan(0);
    for (const arr of [r.seg, r.x, r.kind, r.variant])
      expect(arr.length).toBeGreaterThanOrEqual(r.count);
    for (let i = 0; i < r.count; i++) {
      expect(r.seg[i]).toBeGreaterThanOrEqual(0);
      expect(r.seg[i]).toBeLessThan(N);
      if (i > 0) expect(r.seg[i]).toBeGreaterThanOrEqual(r.seg[i - 1] as number);
    }
  });

  it('a track shorter than everyMin does not throw', () => {
    for (const n of [0, 1, 5, CFG.billboards.everyMin - 1]) {
      expect(() => buildRoadside(n, CFG, SEED)).not.toThrow();
    }
  });
});

describe('R32 roadside objects: lamps', () => {
  it('exactly one lamp at +offset and one at -offset on every segment divisible by every, none elsewhere', () => {
    const r = buildRoadside(N, CFG, SEED);
    const lamps = ofKind(r, ROADSIDE_LAMP);
    // segments 0, 4, ..., 3996 => N / every = 1000 pairs = 2000 lamps
    expect(lamps.seg.length).toBe((N / CFG.lamps.every) * 2);
    const plus = new Map<number, number>();
    const minus = new Map<number, number>();
    lamps.seg.forEach((s, i) => {
      expect(s % CFG.lamps.every).toBe(0);
      if ((lamps.x[i] as number) > 0) {
        expect(lamps.x[i]).toBeCloseTo(CFG.lamps.offset, 5);
        plus.set(s, (plus.get(s) ?? 0) + 1);
      } else {
        expect(lamps.x[i]).toBeCloseTo(-CFG.lamps.offset, 5);
        minus.set(s, (minus.get(s) ?? 0) + 1);
      }
    });
    for (let s = 0; s < N; s += CFG.lamps.every) {
      expect(plus.get(s)).toBe(1);
      expect(minus.get(s)).toBe(1);
    }
  });
});

describe('R32 roadside objects: billboards', () => {
  it('consecutive gaps lie in [everyMin, everyMax], |x| equals offset, both sides occur', () => {
    const b = ofKind(buildRoadside(N, CFG, SEED), ROADSIDE_BILLBOARD);
    expect(b.seg.length).toBeGreaterThan(20);
    for (const g of gaps(b.seg)) {
      expect(g).toBeGreaterThanOrEqual(CFG.billboards.everyMin);
      expect(g).toBeLessThanOrEqual(CFG.billboards.everyMax);
    }
    for (const x of b.x) expect(Math.abs(x)).toBeCloseTo(CFG.billboards.offset, 5);
    expect(b.x.some((x) => x > 0)).toBe(true);
    expect(b.x.some((x) => x < 0)).toBe(true);
  });

  it('never lands on a lamp segment (segment divisible by lamps.every)', () => {
    const b = ofKind(buildRoadside(N, CFG, SEED), ROADSIDE_BILLBOARD);
    for (const s of b.seg) expect(s % CFG.lamps.every).not.toBe(0);
  });
});

describe('R32 roadside objects: buildings', () => {
  it('gaps in range, |x| in [offsetMin, offsetMax], variant < variants, both sides occur', () => {
    const b = ofKind(buildRoadside(N, CFG, SEED), ROADSIDE_BUILDING);
    const c = CFG.buildings;
    expect(b.seg.length).toBeGreaterThan(100);
    for (const g of gaps(b.seg)) {
      expect(g).toBeGreaterThanOrEqual(c.everyMin);
      expect(g).toBeLessThanOrEqual(c.everyMax);
    }
    b.x.forEach((x) => {
      expect(Math.abs(x)).toBeGreaterThanOrEqual(c.offsetMin);
      expect(Math.abs(x)).toBeLessThanOrEqual(c.offsetMax);
    });
    b.variant.forEach((v) => {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(c.variants);
    });
    expect(b.x.some((x) => x > 0)).toBe(true);
    expect(b.x.some((x) => x < 0)).toBe(true);
  });
});

describe('R32 roadside config in src/data/sprites.json', () => {
  const cfg = (sprites as unknown as { roadside?: RoadsideConfig }).roadside;

  it('has a roadside block with all RoadsideConfig fields as numbers', () => {
    expect(cfg).toBeDefined();
    const c = cfg as RoadsideConfig;
    for (const v of [
      c.lamps.every,
      c.lamps.offset,
      c.billboards.everyMin,
      c.billboards.everyMax,
      c.billboards.offset,
      c.buildings.everyMin,
      c.buildings.everyMax,
      c.buildings.offsetMin,
      c.buildings.offsetMax,
      c.buildings.variants,
    ]) {
      expect(typeof v).toBe('number');
    }
  });

  it('lamps stand outside the asphalt and the offsets are ordered lamps < billboards < buildings', () => {
    const c = cfg as RoadsideConfig;
    expect(c.lamps.offset).toBeGreaterThan(1);
    expect(c.billboards.offset).toBeGreaterThan(c.lamps.offset);
    expect(c.buildings.offsetMin).toBeGreaterThan(c.billboards.offset);
    expect(c.buildings.offsetMax).toBeGreaterThanOrEqual(c.buildings.offsetMin);
    expect(c.billboards.everyMax).toBeGreaterThanOrEqual(c.billboards.everyMin);
    expect(c.buildings.everyMax).toBeGreaterThanOrEqual(c.buildings.everyMin);
  });
});

describe('R33 free strip under the car', () => {
  // Interpretation: player.baseY is the ground point (rear axle) of the car as a fraction of screen
  // height from the top (carModel.ts carCameraPose uses baseY * h as the screen y of that point),
  // i.e. the car's bottom edge. Free strip = 1 - baseY, about a quarter => baseY in [0.70, 0.78].
  it('player.baseY puts the car bottom edge between 0.70 and 0.78 of screen height', () => {
    expect(sprites.player.baseY).toBeGreaterThanOrEqual(0.7);
    expect(sprites.player.baseY).toBeLessThanOrEqual(0.78);
  });
});

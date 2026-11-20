import { describe, expect, it } from 'vitest';
import nsx from '../../src/data/models/nsx.json';

// R25: invariants of the converted NSX model (art/cars/nsx/nsx_v1.glb -> src/data/models/nsx.json).
// Game car space: Y up, front = -Z, +X = car's right, origin on the ground at the centre of length.
// Blender (x, y, z) -> game (-x, z, y). Tolerances in metres.

interface CarModelPart {
  positions: number[];
  colors: number[];
}
interface CarModelData {
  unit: number;
  palette: string[];
  parts: { body: CarModelPart; wheelFL: CarModelPart; wheelFR: CarModelPart };
  pivots: { wheelFL: [number, number, number]; wheelFR: [number, number, number] };
  rearAxleZ: number;
  rearWheelX: number;
}

const M = nsx as unknown as CarModelData;
const PARTS = ['body', 'wheelFL', 'wheelFR'] as const;

/** Element i of an array; throws if out of range (noUncheckedIndexedAccess). */
function at<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error(`index ${i} out of range (length ${a.length})`);
  return v;
}

/** Vertices of a part in metres, as [x, y, z] triples. */
function verts(part: CarModelPart): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < part.positions.length; i += 3) {
    out.push([
      at(part.positions, i) * M.unit,
      at(part.positions, i + 1) * M.unit,
      at(part.positions, i + 2) * M.unit,
    ]);
  }
  return out;
}

/** Axis-aligned bounds of a vertex list along one axis. */
function span(w: [number, number, number][], axis: 0 | 1 | 2): { min: number; max: number } {
  const c = w.map((v) => v[axis]);
  return { min: Math.min(...c), max: Math.max(...c) };
}

function mean(a: number[]): number {
  return a.reduce((s, v) => s + v, 0) / a.length;
}

const body = verts(M.parts.body);

describe('R25 car model data: array shapes', () => {
  it('R25 every part has 9 integers per triangle and one valid colour index per triangle', () => {
    for (const name of PARTS) {
      const p = M.parts[name];
      expect(p.positions.length % 9).toBe(0);
      expect(p.colors.length).toBe(p.positions.length / 9);
      for (const v of p.positions) expect(Number.isInteger(v)).toBe(true);
      for (const c of p.colors) {
        expect(Number.isInteger(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(M.palette.length);
      }
    }
  });

  it('R25 unit is a positive metre step', () => {
    expect(M.unit).toBeGreaterThan(0);
  });

  it('R25 palette is lower-case #rrggbb and unique', () => {
    for (const c of M.palette) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(M.palette).size).toBe(M.palette.length);
  });

  it('R25 triangle counts: 4000..6000 in total, 200..400 per front wheel', () => {
    const tri = (p: CarModelPart): number => p.positions.length / 9;
    const total = tri(M.parts.body) + tri(M.parts.wheelFL) + tri(M.parts.wheelFR);
    expect(total).toBeGreaterThanOrEqual(4000);
    expect(total).toBeLessThanOrEqual(6000);
    for (const w of ['wheelFL', 'wheelFR'] as const) {
      expect(tri(M.parts[w])).toBeGreaterThanOrEqual(200);
      expect(tri(M.parts[w])).toBeLessThanOrEqual(400);
    }
  });
});

describe('R25 car model data: body bounds', () => {
  const xs = body.map((v) => v[0]);
  const ys = body.map((v) => v[1]);
  const zs = body.map((v) => v[2]);

  it('R25 length: nose at z = -2.215, tail at z = +2.215 (4.43 m, origin at centre)', () => {
    // 4.43 / 2 = 2.215
    expect(Math.abs(Math.min(...zs) - -2.215)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(Math.max(...zs) - 2.215)).toBeLessThanOrEqual(0.02);
  });

  it('R25 height: tyres on the ground (y min in [0, 0.02]), roof at 1.15 +- 0.02', () => {
    const yMin = Math.min(...ys);
    expect(yMin).toBeGreaterThanOrEqual(0);
    expect(yMin).toBeLessThanOrEqual(0.02);
    expect(Math.abs(Math.max(...ys) - 1.15)).toBeLessThanOrEqual(0.02);
  });

  it('R25 width with mirrors: |x| max in [0.92, 0.97]', () => {
    // 1.86 / 2 = 0.93 with mirrors
    const xMax = Math.max(...xs.map(Math.abs));
    expect(xMax).toBeGreaterThanOrEqual(0.92);
    expect(xMax).toBeLessThanOrEqual(0.97);
  });
});

describe('R25 car model data: orientation (front = -Z)', () => {
  it('R25 nose is low and tail is high', () => {
    const nose = body.filter((v) => v[2] < -1.9).map((v) => v[1]);
    const tail = body.filter((v) => v[2] > 1.9).map((v) => v[1]);
    expect(nose.length).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThan(0);
    expect(mean(nose)).toBeLessThan(mean(tail));
  });

  it('R25 roof (y > 1.0) lies in z between -0.3 and 0.9', () => {
    const roof = body.filter((v) => v[1] > 1.0);
    expect(roof.length).toBeGreaterThan(0);
    for (const v of roof) {
      expect(v[2]).toBeGreaterThanOrEqual(-0.3);
      expect(v[2]).toBeLessThanOrEqual(0.9);
    }
  });
});

describe('R25 car model data: left-right symmetry', () => {
  it('R25 every 7th body vertex has a mirrored-x twin within 2 mm', () => {
    let missing = 0;
    for (let i = 0; i < body.length; i += 7) {
      const [x, y, z] = at(body, i);
      const found = body.some((w) => Math.hypot(w[0] + x, w[1] - y, w[2] - z) <= 0.002);
      if (!found) missing++;
    }
    expect(missing).toBe(0);
  });
});

describe('R25b car model data: front wheel pivots', () => {
  const cases = [
    ['wheelFL', -0.755], // front-LEFT = Blender +X = game -X
    ['wheelFR', 0.755],
  ] as const;

  for (const [name, x] of cases) {
    it(`R25b ${name} pivot at [${x}, 0.31, -1.215] +- 0.005`, () => {
      const p = M.pivots[name];
      expect(Math.abs(p[0] - x)).toBeLessThanOrEqual(0.005);
      expect(Math.abs(p[1] - 0.31)).toBeLessThanOrEqual(0.005);
      expect(Math.abs(p[2] - -1.215)).toBeLessThanOrEqual(0.005);
    });

    it(`R25b ${name} geometry is centred on its pivot and within radius 0.32 of the axle`, () => {
      const w = verts(M.parts[name]);
      // Bounding-box centre on the pivot (vertex mean is off-centre in x because
      // rim/spokes/hub sit on the outer face). Tyre width 0.22, diameter 2 * 0.31 = 0.62.
      const extent = [0.22, 0.62, 0.62] as const;
      for (const axis of [0, 1, 2] as const) {
        const { min, max } = span(w, axis);
        expect(Math.abs((min + max) / 2)).toBeLessThanOrEqual(0.005);
        expect(Math.abs(max - min - extent[axis])).toBeLessThanOrEqual(0.01);
      }
      // axle line along x through the pivot -> distance in the y-z plane; 0.31 + 0.01
      for (const v of w) expect(Math.hypot(v[1], v[2])).toBeLessThanOrEqual(0.32);
    });
  }
});

describe('R25 car model data: rear axle', () => {
  it('R25 rearAxleZ = 1.315 and rearWheelX = 0.765 (+- 0.005)', () => {
    expect(Math.abs(M.rearAxleZ - 1.315)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(M.rearWheelX - 0.765)).toBeLessThanOrEqual(0.005);
  });

  it('R25 body contains both rear wheels around (+-0.765, 0.33, 1.315)', () => {
    const near = (side: number): number =>
      body.filter(
        (v) =>
          Math.sign(v[0]) === side &&
          Math.abs(v[0]) >= 0.6 &&
          Math.abs(v[0]) <= 0.9 &&
          Math.hypot(v[1] - 0.33, v[2] - 1.315) <= 0.34,
      ).length;
    expect(near(1)).toBeGreaterThan(0);
    expect(near(-1)).toBeGreaterThan(0);
  });
});

describe('R25 car model data: colours', () => {
  it('R25 palette has body yellow #e8a21c and tail-lamp red #d93a2b', () => {
    expect(M.palette).toContain('#e8a21c');
    expect(M.palette).toContain('#d93a2b');
  });

  it('R25 #d93a2b triangles exist only in the body and only at the tail (z > 2.0)', () => {
    const red = M.palette.indexOf('#d93a2b');
    expect(M.parts.wheelFL.colors).not.toContain(red);
    expect(M.parts.wheelFR.colors).not.toContain(red);
    const p = M.parts.body;
    let count = 0;
    for (let t = 0; t < p.colors.length; t++) {
      if (p.colors[t] !== red) continue;
      count++;
      for (let k = 0; k < 3; k++)
        expect(at(p.positions, t * 9 + k * 3 + 2) * M.unit).toBeGreaterThan(2.0);
    }
    expect(count).toBeGreaterThan(0);
  });
});

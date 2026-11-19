import { describe, expect, it } from 'vitest';
import camera from '../../src/data/camera.json';
import road from '../../src/data/road.json';
import { createProjection, project } from '../../src/render/projection';
import type { CameraConfig, Projection, RoadConfig } from '../../src/render/projection';
import type { Segment, Track } from '../../src/sim/types';

// Same round-number config as projection.test.ts.
// f = 100 px, horizonY = 50, d0 = 200, scale_n = 100 / (200 + (n - frac) * 100).
const ICAM: CameraConfig = {
  fovDeg: 90,
  height: 100,
  drawDistance: 8,
  horizon: 0.5,
  screenWidth: 200,
  screenHeight: 100,
};
const IROAD: RoadConfig = {
  segmentLength: 100,
  halfWidth: 40,
  rumbleLength: 3,
  lanes: 3,
  rumbleWidth: 0.15,
  laneMarkerWidth: 0.03,
};

// Segment.y = height at the END of the segment, units of segment length. Edge n of the
// projection = start of segment base+n = y of segment base+n-1. Start of segment 0 is 0.
const seg = (curve: number, y?: number): Segment =>
  (y === undefined ? { curve } : { curve, y }) as unknown as Segment;
const trackY = (heights: number[], curves?: number[]): Track => ({
  segments: heights.map((y, i) => seg(curves?.[i] ?? 0, y)),
});
const flatNoY = (len: number): Track => ({ segments: Array.from({ length: len }, () => seg(0)) });
const flatY0 = (len: number): Track => trackY(new Array<number>(len).fill(0));

function run(track: Track, z: number, x = 0, cam = ICAM, rd = IROAD): Projection {
  const p = createProjection(cam, rd);
  project(p, track, z, x, cam, rd);
  return p;
}
const clippedOf = (p: Projection): Uint8Array => (p as unknown as { clipped: Uint8Array }).clipped;
const near = (a: number, b: number, tol = 1e-3): void => {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
};

// Slope s per segment: end heights s * (i + 1) for i = 0..10, rest 0 (edge 0 = last segment = 0).
const SLOPE = (s: number): Track => {
  const h = new Array<number>(20).fill(0);
  for (let i = 0; i <= 10; i++) h[i] = s * (i + 1);
  return trackY(h);
};
// Crest: edges 0..8 heights 0,1,2,3,4,3,2,1,0 (units of segment length).
const CREST = (): Track => {
  const h = new Array<number>(20).fill(0);
  [1, 2, 3, 4, 3, 2, 1, 0].forEach((v, i) => (h[i] = v));
  return trackY(h);
};

describe('R30 projection: flat track unchanged', () => {
  it('y = 0 everywhere is bit-identical to a track literal without y (all fields, several z, x)', () => {
    for (const [z, x] of [
      [0, 0],
      [3.37, 0.4],
      [11.9, -0.8],
    ] as const) {
      const a = run(flatNoY(30), z, x);
      const b = run(flatY0(30), z, x);
      for (const k of ['x', 'y', 'w', 'scale', 'segment'] as const) {
        expect(Array.from(b[k])).toEqual(Array.from(a[k]));
      }
      expect([b.count, b.base, b.frac, b.length]).toEqual([a.count, a.base, a.frac, a.length]);
    }
  });

  it('pinned hand values: screen y_n = horizonY + scale_n * height (frac 0.5)', () => {
    // z = 0.5: scale_n = 100/(150 + 100n). n=0: 50 + (2/3)*100 = 116.667; n=2: 50 + 100*100/350 = 78.571
    const p = run(flatY0(30), 0.5);
    near(p.y[0]!, 116.6667);
    near(p.y[2]!, 78.5714);
  });

  it('real config: flat y = 0 track gives y = horizonY + scale * height', () => {
    const p = createProjection(camera, road);
    const t = trackY(new Array<number>(50).fill(0));
    project(p, t, 4.3, 0, camera, road);
    const hy = camera.horizon * camera.screenHeight;
    for (let n = 0; n < p.count; n++) near(p.y[n]!, hy + p.scale[n]! * camera.height, 1e-3);
  });

  it('a hill never changes scale, w, x or the segment indices (straight track)', () => {
    const f = run(flatY0(20), 0.3);
    const h = run(SLOPE(0.5), 0.3);
    for (const k of ['x', 'w', 'scale', 'segment'] as const) {
      expect(Array.from(h[k])).toEqual(Array.from(f[k]));
    }
  });
});

describe('R30 projection: slopes', () => {
  it('uphill ahead (0.5 per segment): far edges project higher (smaller y) than flat, hand values', () => {
    // z = 0, camera road height 0 -> camera world y = 100. Edge n height = 50n world units.
    // y_n = 50 + scale_n * (100 - 50n), scale_n = 100/(200+100n)
    //   n=0: 50 + 0.5*100 = 100 (same as flat)
    //   n=1: 50 + (1/3)*50 = 66.667
    //   n=4: 50 + (1/6)*(100-200) = -116.667   (flat: 50 + 100/6 = 66.667)
    const up = run(SLOPE(0.5), 0);
    const flat = run(flatY0(20), 0);
    near(up.y[0]!, 100);
    near(up.y[1]!, 66.6667);
    near(up.y[4]!, -116.6667);
    near(flat.y[4]!, 66.6667);
    for (let n = 1; n < up.count; n++) expect(up.y[n]!).toBeLessThan(flat.y[n]!);
  });

  it('downhill ahead (-0.5 per segment): far edges project lower (larger y) than flat, hand values', () => {
    // edge n height = -50n. y_4 = 50 + (1/6)*(100 + 200) = 100 (flat 66.667)
    const down = run(SLOPE(-0.5), 0);
    const flat = run(flatY0(20), 0);
    near(down.y[4]!, 100);
    for (let n = 1; n < down.count; n++) expect(down.y[n]!).toBeGreaterThan(flat.y[n]!);
  });

  it('symmetry: up and down slopes deviate from flat by equal and opposite amounts', () => {
    // y_n(up) - y_n(flat) = -scale_n * h_n ; y_n(down) - y_n(flat) = +scale_n * h_n
    const up = run(SLOPE(0.5), 0);
    const down = run(SLOPE(-0.5), 0);
    const flat = run(flatY0(20), 0);
    for (let n = 0; n < up.count; n++) {
      near(up.y[n]! - flat.y[n]!, -(down.y[n]! - flat.y[n]!), 1e-3);
    }
  });

  it('camera interpolates road height inside the segment (z = 0.5)', () => {
    // Camera road height = 0 + 0.5*(0.5 - 0) = 0.25 -> world 25; camera y = 125.
    // scale_n = 100/(150 + 100n); edge n height 50n.
    //   n=0: 50 + (2/3)*125 = 133.333;  n=2: 50 + (100/350)*(125 - 100) = 57.143
    const p = run(SLOPE(0.5), 0.5);
    near(p.y[0]!, 133.3333);
    near(p.y[2]!, 57.1429);
  });

  it('camera follows the road: no jump of the same edge across a segment boundary', () => {
    const t = SLOPE(0.5);
    const a = run(t, 3.999999);
    const b = run(t, 4.000001);
    // edge 1 of a (start of seg 4) is edge 0 of b
    near(a.y[1]!, b.y[0]!, 0.01);
  });
});

describe('R30 projection: camera follows height', () => {
  it('adding a constant to every y changes nothing (away from the loop start)', () => {
    const h = [0, 1, 2, 3, 2.5, 4, 1, 0.5, 2, 3, 1, 0, 1, 2, 0];
    const c = [1, -2, 3, 0, 2, -1, 4, 0, 0, 1, -3, 2, 0, 1, -1];
    const base = trackY(h, c);
    const shifted = trackY(
      h.map((v) => v + 10),
      c,
    );
    // z = 3.5: camera in segment 3, edges 0..8 are starts of segments 3..11 -> y of 2..10.
    const a = run(base, 3.5, 0.3);
    const b = run(shifted, 3.5, 0.3);
    for (const k of ['x', 'y', 'w', 'scale'] as const) {
      for (let n = 0; n < a.count; n++) near(b[k][n]!, a[k][n]!, 1e-3);
    }
    expect(Array.from(b.segment)).toEqual(Array.from(a.segment));
  });
});

describe('R30 projection: crest clipping (observable: proj.clipped, Uint8Array, 1 = hidden)', () => {
  it('exists, one entry per line', () => {
    const p = run(CREST(), 0);
    expect(clippedOf(p)).toBeInstanceOf(Uint8Array);
    expect(clippedOf(p).length).toBeGreaterThanOrEqual(p.count);
  });

  it('flat and constant slopes hide nothing', () => {
    for (const t of [flatY0(20), SLOPE(0.5), SLOPE(-0.1)]) {
      const c = clippedOf(run(t, 0));
      expect(c).toBeInstanceOf(Uint8Array);
      for (let n = 0; n < 9; n++) expect(c[n]).toBe(0);
    }
  });

  it('edges beyond the crest are hidden, edges up to the crest are not', () => {
    // camera y = 100, edge heights (segment units) n=0..8: 0,1,2,3,4,3,2,1,0
    // screen y_n = 50 + 100*(1 - h_n)/(2 + n):
    //   100, 50, 25, 10, 0 (crest), 21.43, 37.5, 50, 60
    // clipped[n] = 1 when y_n >= min(y_0..y_{n-1}): n=5..8 (21.43, 37.5, 50, 60 >= 0).
    const p = run(CREST(), 0);
    const exp = [100, 50, 25, 10, 0, 21.4286, 37.5, 50, 60];
    exp.forEach((v, n) => near(p.y[n]!, v, 1e-3));
    const c = clippedOf(p);
    expect(c).toBeInstanceOf(Uint8Array);
    expect(Array.from(c.slice(0, 9))).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('is recomputed per call (stale flags are cleared)', () => {
    const p = createProjection(ICAM, IROAD);
    project(p, CREST(), 0, 0, ICAM, IROAD);
    expect(clippedOf(p)[6]).toBe(1);
    project(p, flatY0(20), 0, 0, ICAM, IROAD);
    expect(clippedOf(p)[6]).toBe(0);
  });
});

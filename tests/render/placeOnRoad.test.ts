import { describe, expect, it } from 'vitest';
import camera from '../../src/data/camera.json';
import road from '../../src/data/road.json';
import { placeOnRoad } from '../../src/render/placeOnRoad';
import type { Placement } from '../../src/render/placeOnRoad';
import { createProjection, project } from '../../src/render/projection';
import type { CameraConfig, Projection, RoadConfig } from '../../src/render/projection';
import { makeStraightTrack } from '../../src/sim/track';
import type { Track } from '../../src/sim/types';

const CAM: CameraConfig = camera;
const ROAD: RoadConfig = road;

// Inline config with round numbers: f = 100 px, horizonY = 50, d0 = 200 (see projection tests).
const ICAM: CameraConfig = {
  fovDeg: 90,
  height: 100,
  drawDistance: 4,
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

const TOL = 1e-3; // px; projection buffers are Float32

function trackOf(curves: number[]): Track {
  return { segments: curves.map((curve) => ({ curve })) };
}
const CURVES = [20, -10, 35, 5, -25, 15, 30, -5, 10, -20, 25, -35];
const curvy12 = (): Track => trackOf(CURVES);
// Long curvy track (> drawDistance of the real config) built by repeating CURVES.
const curvyLong = (): Track => trackOf(Array.from({ length: 400 }, (_, i) => CURVES[i % 12]!));
const negate = (t: Track): Track => trackOf(t.segments.map((s) => -s.curve));

function run(track: Track, z: number, x: number, cam: CameraConfig, rd: RoadConfig): Projection {
  const p = createProjection(cam, rd);
  project(p, track, z, x, cam, rd);
  return p;
}
const blank = (): Placement => ({ x: 0, y: 0, w: 0, h: 0, depth: 0 });
const near = (a: number, b: number, tol: number, msg = ''): void => {
  expect(Math.abs(a - b), `${msg} got ${a}, want ${b}`).toBeLessThanOrEqual(tol);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// r in segments relative to line 0; z = base + r.
function place(p: Projection, r: number, offset: number, ww = 10, wh = 20): Placement | null {
  const out = blank();
  return placeOnRoad(out, p, p.base + r, offset, ww, wh) ? out : null;
}

const SETUPS: { name: string; cam: CameraConfig; rd: RoadConfig; track: () => Track; z: number }[] =
  [
    { name: 'inline straight', cam: ICAM, rd: IROAD, track: () => makeStraightTrack(20), z: 3.25 },
    { name: 'inline curvy', cam: ICAM, rd: IROAD, track: curvy12, z: 3.25 },
    { name: 'real straight', cam: CAM, rd: ROAD, track: () => makeStraightTrack(400), z: 7.6 },
    { name: 'real curvy', cam: CAM, rd: ROAD, track: curvyLong, z: 7.6 },
  ];

describe('PL1 scale falls with distance, consistent with road width', () => {
  it('out.w strictly decreases with z (offset 0)', () => {
    for (const s of SETUPS) {
      const p = run(s.track(), s.z, 0, s.cam, s.rd);
      let prev = Infinity;
      for (let k = 0; k < 40; k++) {
        const r = (k / 40) * (p.count - 1 - 1e-6);
        const o = place(p, r, 0);
        expect(o, `${s.name} r=${r}`).not.toBeNull();
        expect(o!.w, `${s.name} r=${r}`).toBeLessThan(prev);
        prev = o!.w;
      }
    }
  });
  it('worldW = 2*halfWidth at an exact line gives out.w = 2*proj.w[i]; aspect kept', () => {
    // At t = 0: s = scale[i], out.w = 2*halfWidth*scale[i] = 2*w[i]
    for (const s of SETUPS) {
      const p = run(s.track(), s.z, 0, s.cam, s.rd);
      for (const i of [0, 1, 2, p.count - 2]) {
        const ww = 2 * s.rd.halfWidth;
        const wh = 3 * s.rd.halfWidth;
        const o = place(p, i, 0, ww, wh);
        expect(o).not.toBeNull();
        near(o!.w, 2 * p.w[i]!, TOL, `${s.name} i=${i}`);
        near(o!.h / o!.w, wh / ww, 1e-6, `${s.name} i=${i} aspect`);
      }
    }
  });
  it('inline hand value: line 1 at frac 0.25', () => {
    // frac .25: dz_1 = 200 + (1-0.25)*100 = 275, scale = 100/275 = 0.363636; w = 40*scale = 14.5454
    // object worldW 80 -> out.w = 80*0.363636 = 29.0909 ; worldH 40 -> 14.5454
    const p = run(makeStraightTrack(20), 3.25, 0, ICAM, IROAD);
    const o = place(p, 1, 0, 80, 40)!;
    near(o.w, 80 / 2.75, TOL);
    near(o.h, 40 / 2.75, TOL);
  });
});

describe('PL2 sprite at the road edge', () => {
  const rs = [0, 0.4, 1, 1.5, 2.75, 3.9];
  it('offset +/-1 lands on interpolated road edge; y is the interpolated line y', () => {
    for (const s of SETUPS) {
      for (const camX of [0, 0.5, -0.8]) {
        const p = run(s.track(), s.z, camX, s.cam, s.rd);
        for (const r of rs) {
          const i = Math.floor(r);
          const t = r - i;
          const right = lerp(p.x[i]! + p.w[i]!, p.x[i + 1]! + p.w[i + 1]!, t);
          const left = lerp(p.x[i]! - p.w[i]!, p.x[i + 1]! - p.w[i + 1]!, t);
          const y = lerp(p.y[i]!, p.y[i + 1]!, t);
          const msg = `${s.name} camX=${camX} r=${r}`;
          const a = place(p, r, 1)!;
          const b = place(p, r, -1)!;
          near(a.x, right, TOL, msg + ' right');
          near(b.x, left, TOL, msg + ' left');
          near(a.y, y, TOL, msg + ' y');
          near(b.y, y, TOL, msg + ' y');
        }
      }
    }
  });
  it('offset 0 is the interpolated road centre; offsets are linear in half-widths', () => {
    // x(off) = centre + off * w_interp, so x(0.5) = (x(0) + x(1)) / 2
    for (const s of SETUPS) {
      const p = run(s.track(), s.z, 0.3, s.cam, s.rd);
      const c = place(p, 1.4, 0)!;
      const e = place(p, 1.4, 1)!;
      const m = place(p, 1.4, 0.5)!;
      near(m.x, (c.x + e.x) / 2, TOL, s.name);
    }
  });
});

describe('PL3 left/right symmetry', () => {
  it('straight track, camera x = 0: offsets +a and -a mirror around W/2', () => {
    for (const s of SETUPS.filter((q) => q.name.includes('straight'))) {
      const p = run(s.track(), s.z, 0, s.cam, s.rd);
      for (const r of [0, 0.3, 1.5, 3.7]) {
        for (const a of [0.25, 0.8, 1.5]) {
          const R = place(p, r, a)!;
          const L = place(p, r, -a)!;
          near(R.x + L.x, s.cam.screenWidth, TOL, `${s.name} r=${r} a=${a}`);
          near(R.y, L.y, 1e-6);
          near(R.w, L.w, 1e-6);
          near(R.h, L.h, 1e-6);
          near(R.depth, L.depth, 1e-9);
        }
      }
    }
  });
  it('curve +c vs -c track, offset +a vs -a mirror (camera x = 0)', () => {
    const pairs: [CameraConfig, RoadConfig, Track][] = [
      [ICAM, IROAD, curvy12()],
      [CAM, ROAD, curvyLong()],
    ];
    for (const [cam, rd, track] of pairs) {
      const pa = run(track, 5.4, 0, cam, rd);
      const pb = run(negate(track), 5.4, 0, cam, rd);
      for (const r of [0, 0.6, 2.2, 3.9]) {
        const A = place(pa, r, 0.7)!;
        const B = place(pb, r, -0.7)!;
        near(A.x + B.x, cam.screenWidth, TOL, `r=${r}`);
        near(A.y, B.y, 1e-6);
        near(A.w, B.w, 1e-6);
        near(A.h, B.h, 1e-6);
        near(A.depth, B.depth, 1e-9);
      }
    }
  });
});

describe('PL4 draw range and wrapping', () => {
  const SENTINEL: Placement = { x: -111, y: -222, w: -333, h: -444, depth: -555 };

  it('r >= count-1 is not emitted and out is untouched', () => {
    for (const s of SETUPS) {
      const p = run(s.track(), s.z, 0, s.cam, s.rd);
      for (const r of [p.count - 1, p.count - 0.5, p.count + 2]) {
        const out = { ...SENTINEL };
        expect(placeOnRoad(out, p, p.base + r, 0, 10, 10), `${s.name} r=${r}`).toBe(false);
        expect(out).toEqual(SENTINEL);
      }
    }
  });
  it('just inside the far limit is emitted; r = 0 is emitted', () => {
    for (const s of SETUPS) {
      const p = run(s.track(), s.z, 0, s.cam, s.rd);
      expect(place(p, p.count - 1 - 1e-6, 0), s.name).not.toBeNull();
      expect(place(p, 0, 0), s.name).not.toBeNull();
    }
  });
  it('behind the camera (z slightly below base) is not emitted, out untouched', () => {
    for (const s of SETUPS) {
      const p = run(s.track(), s.z, 0, s.cam, s.rd);
      for (const dz of [0.01, 0.5, 1, 3]) {
        const out = { ...SENTINEL };
        expect(placeOnRoad(out, p, p.base - dz, 0, 10, 10), `${s.name} dz=${dz}`).toBe(false);
        expect(out).toEqual(SENTINEL);
      }
    }
  });
  it('z wrapped by +/- track length gives identical output', () => {
    for (const s of SETUPS) {
      const p = run(s.track(), s.z, 0.2, s.cam, s.rd);
      for (const r of [0, 0.7, 2.5]) {
        const z = p.base + r;
        const ref = blank();
        expect(placeOnRoad(ref, p, z, 0.6, 12, 30)).toBe(true);
        for (const k of [-2, -1, 1, 3]) {
          const o = blank();
          expect(placeOnRoad(o, p, z + k * p.length, 0.6, 12, 30), `${s.name} k=${k}`).toBe(true);
          near(o.x, ref.x, 1e-6);
          near(o.y, ref.y, 1e-6);
          near(o.w, ref.w, 1e-6);
          near(o.h, ref.h, 1e-6);
          near(o.depth, ref.depth, 1e-9);
        }
      }
    }
  });
  it('object near the end of the track wraps onto the start of the next lap', () => {
    // track length 20, camera in segment 18 (z = 18.5): base 18, line 2 is segment 0.
    // z = 0.4 -> r = ((0.4 - 18) mod 20) = 2.4 -> emitted, t = 0.4
    const p = run(makeStraightTrack(20), 18.5, 0, ICAM, IROAD);
    expect(p.base).toBe(18);
    const o = blank();
    expect(placeOnRoad(o, p, 0.4, 0, 10, 10)).toBe(true);
    near(o.y, lerp(p.y[2]!, p.y[3]!, 0.4), TOL);
  });
});

describe('PL5 depth ordering against RoadMesh layers', () => {
  it('depth stays inside the strip band, inside (-1, 1)', () => {
    // strips = count-1 = drawDistance; step = 2/strips
    // strip i band: -1 + step*(i-0.5) < depth < -1 + step*(i+0.3)
    for (const s of SETUPS) {
      const p = run(s.track(), s.z, 0, s.cam, s.rd);
      const strips = p.count - 1;
      const step = 2 / strips;
      const N = strips <= 10 ? 200 : 1500;
      for (let k = 0; k < N; k++) {
        const r = (k / N) * strips;
        // Judge against the r the function actually receives (base + r rounds in float64).
        const i = Math.floor(p.base + r - p.base);
        const o = place(p, r, 0.3)!;
        const msg = `${s.name} r=${r}`;
        expect(o.depth, msg).toBeGreaterThan(-1);
        expect(o.depth, msg).toBeLessThan(1);
        expect(o.depth, msg).toBeGreaterThan(-1 + step * (i - 0.5));
        expect(o.depth, msg).toBeLessThan(-1 + step * (i + 0.3));
      }
    }
  });
  it('depth strictly increases with r, including across strip boundaries', () => {
    for (const s of SETUPS) {
      const p = run(s.track(), s.z, 0, s.cam, s.rd);
      const strips = p.count - 1;
      const N = strips <= 10 ? 400 : 3000;
      let prev = -Infinity;
      for (let k = 0; k < N; k++) {
        const r = (k / N) * strips;
        const d = place(p, r, 0)!.depth;
        expect(d, `${s.name} r=${r}`).toBeGreaterThan(prev);
        prev = d;
      }
      // straddle each boundary tightly (first 4 boundaries)
      for (let b = 1; b <= Math.min(4, strips - 1); b++) {
        const lo = place(p, b - 1e-4, 0)!.depth;
        const hi = place(p, b + 1e-4, 0)!.depth;
        expect(hi, `${s.name} boundary ${b}`).toBeGreaterThan(lo);
      }
    }
  });
  it('depth does not depend on lateral offset or object size', () => {
    const p = run(makeStraightTrack(20), 3.25, 0, ICAM, IROAD);
    const a = place(p, 1.6, 0, 10, 10)!;
    const b = place(p, 1.6, -1.4, 50, 90)!;
    near(a.depth, b.depth, 1e-9);
  });
});

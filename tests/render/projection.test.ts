import { describe, expect, it } from 'vitest';
import camera from '../../src/data/camera.json';
import road from '../../src/data/road.json';
import { createProjection, project } from '../../src/render/projection';
import type { CameraConfig, RoadConfig } from '../../src/render/projection';
import { makeStraightTrack } from '../../src/sim/track';
import type { Track } from '../../src/sim/types';

const CAM: CameraConfig = camera;
const ROAD: RoadConfig = road;

// Inline config with round numbers.
// fov 90 deg -> tan(45 deg) = 1 -> f = (W/2)/1 = 100 px (W = 200).
// horizonY = 0.5 * 100 = 50. d0 = f*height/(H-horizonY) = 100*100/50 = 200.
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

const horizonYReal = CAM.horizon * CAM.screenHeight;

function trackOf(curves: number[]): Track {
  return { segments: curves.map((curve) => ({ curve })) };
}
function constTrack(len: number, c: number): Track {
  return trackOf(new Array<number>(len).fill(c));
}
// Deliberately large, varying curves.
const CURVES = [20, -10, 35, 5, -25, 15, 30, -5, 10, -20, 25, -35];
const curvy = (): Track => trackOf(CURVES);

function run(track: Track, z: number, x: number, cam = CAM, rd = ROAD) {
  const p = createProjection(cam, rd);
  project(p, track, z, x, cam, rd);
  return p;
}
const near = (a: number, b: number, tol: number): void => {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
};

describe('P1 straight track, camera centred', () => {
  it('every x_n equals W/2 (real config)', () => {
    const p = run(makeStraightTrack(50), 3.37, 0);
    expect(p.count).toBe(CAM.drawDistance + 1);
    for (let n = 0; n < p.count; n++) near(p.x[n]!, CAM.screenWidth / 2, 1e-4);
  });
  it('every x_n equals W/2 (inline config)', () => {
    const p = run(makeStraightTrack(20), 0.25, 0, ICAM, IROAD);
    for (let n = 0; n < p.count; n++) near(p.x[n]!, 100, 1e-4);
  });
});

describe('P2 monotonic projection', () => {
  it('w and y strictly decrease, y stays below the horizon', () => {
    const p = run(makeStraightTrack(50), 7.6, 0);
    for (let n = 0; n < p.count; n++) {
      expect(p.y[n]!).toBeGreaterThan(horizonYReal);
      if (n > 0) {
        expect(p.w[n]!).toBeLessThan(p.w[n - 1]!);
        expect(p.y[n]!).toBeLessThan(p.y[n - 1]!);
      }
    }
  });
  it('last line is within 5 px below the horizon (real config)', () => {
    // f = 180/tan(40deg) = 214.5; d0 = 214.5*320/339.2 = 202.4
    // n=300: dz = 202.4 + 300*200 = 60202; y-horizonY = 214.5*320/60202 = 1.14 px
    const p = run(makeStraightTrack(50), 0, 0);
    const last = p.y[p.count - 1]! - horizonYReal;
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(5);
  });
  it('arrays have drawDistance+1 entries', () => {
    const p = createProjection(CAM, ROAD);
    for (const a of [p.x, p.y, p.w, p.scale, p.segment])
      expect(a.length).toBe(CAM.drawDistance + 1);
  });
});

describe('P3 frac = 0 exact values', () => {
  it('y_0 = H and w_0 = halfWidth*(H-horizonY)/height (real config)', () => {
    // w_0 = 500*(640-300.8)/320 = 530 (author's second feedback 2026-11-19: camera barely above the roof)
    const p = run(makeStraightTrack(50), 5, 0);
    near(p.y[0]!, CAM.screenHeight, 1e-3);
    near(p.w[0]!, (ROAD.halfWidth * (CAM.screenHeight - horizonYReal)) / CAM.height, 1e-3);
    near(p.w[0]!, 530, 1e-3);
  });
  it('inline config hand values', () => {
    // dz_n = 200 + 100n; scale_n = 100/dz_n; y = 50 + scale*100; w = scale*40
    // n=0: scale 0.5  -> y 100,        w 20
    // n=1: scale 1/3  -> y 83.33333,   w 13.33333
    // n=2: scale 0.25 -> y 75,         w 10
    const p = run(makeStraightTrack(20), 3, 0, ICAM, IROAD);
    near(p.scale[0]!, 0.5, 1e-5);
    near(p.y[0]!, 100, 1e-3);
    near(p.w[0]!, 20, 1e-3);
    near(p.y[1]!, 50 + 100 / 3, 1e-3);
    near(p.w[1]!, 40 / 3, 1e-3);
    near(p.y[2]!, 75, 1e-3);
    near(p.w[2]!, 10, 1e-3);
  });
  it('inline config with frac = 0.5', () => {
    // dz_0 = 200 - 0.5*100 = 150 -> scale 2/3 -> y = 50 + 66.6667 = 116.6667, w = 26.6667
    const p = run(makeStraightTrack(20), 3.5, 0, ICAM, IROAD);
    near(p.y[0]!, 50 + 200 / 3, 1e-3);
    near(p.w[0]!, 80 / 3, 1e-3);
  });
  it('inline camera x = 0.5 and curve hand values', () => {
    // x_n = 100 + scale_n*(off_n - 0.5*40); straight: off = 0
    // n=0: 100 - 0.5*20 = 90 ; n=1: 100 - (1/3)*20 = 93.33333
    const p = run(makeStraightTrack(20), 3, 0.5, ICAM, IROAD);
    near(p.x[0]!, 90, 1e-3);
    near(p.x[1]!, 100 - 20 / 3, 1e-3);
    // constant curve 2, frac 0, x 0: off = 0,0,2,6 ; dz = 200,300,400,500 ; scale = .5,1/3,.25,.2
    // x_1 = 100 ; x_2 = 100 + 0.25*2 = 100.5 ; x_3 = 100 + 0.2*6 = 101.2
    const q = run(constTrack(20, 2), 3, 0, ICAM, IROAD);
    near(q.x[0]!, 100, 1e-3);
    near(q.x[1]!, 100, 1e-3);
    near(q.x[2]!, 100.5, 1e-3);
    near(q.x[3]!, 101.2, 1e-3);
    // frac 0.5: off_0 = c*frac = 1, dx_0 = -1; off_1 = 0, dx_1 = 1; off_2 = 1
    // dz_0 = 150 -> scale 2/3 -> x_0 = 100 + 2/3 = 100.66667
    // dz_1 = 250 -> scale 0.4 -> x_1 = 100 ; dz_2 = 350 -> scale 2/7 -> x_2 = 100 + 2/7
    const r = run(constTrack(20, 2), 3.5, 0, ICAM, IROAD);
    near(r.x[0]!, 100 + 2 / 3, 1e-3);
    near(r.x[1]!, 100, 1e-3);
    near(r.x[2]!, 100 + 2 / 7, 1e-3);
  });
});

describe('P4 camera offset on a straight', () => {
  it('road shifts opposite to camera, near lines shift more', () => {
    const p = run(makeStraightTrack(50), 2.4, 0.5);
    for (let n = 0; n < p.count; n++) {
      expect(p.x[n]!).toBeLessThan(CAM.screenWidth / 2);
      if (n > 0) {
        expect(Math.abs(p.x[n]! - CAM.screenWidth / 2)).toBeLessThan(
          Math.abs(p.x[n - 1]! - CAM.screenWidth / 2),
        );
      }
    }
  });
});

describe('P5 left/right symmetry', () => {
  it('camera x = +a vs -a mirrors around W/2 on a straight; y and w identical', () => {
    const t = makeStraightTrack(30);
    const a = run(t, 2.3, 0.6);
    const b = run(t, 2.3, -0.6);
    for (let n = 0; n < a.count; n++) {
      near(a.x[n]! - CAM.screenWidth / 2, -(b.x[n]! - CAM.screenWidth / 2), 1e-3);
      near(a.y[n]!, b.y[n]!, 1e-6);
      near(a.w[n]!, b.w[n]!, 1e-6);
    }
  });
  it('curve +c vs -c mirrors; y and w identical', () => {
    const pos = curvy();
    const neg = trackOf(CURVES.map((c) => -c));
    const a = run(pos, 4.7, 0);
    const b = run(neg, 4.7, 0);
    for (let n = 0; n < a.count; n++) {
      near(a.x[n]! - CAM.screenWidth / 2, -(b.x[n]! - CAM.screenWidth / 2), 1e-3);
      near(a.y[n]!, b.y[n]!, 1e-6);
      near(a.w[n]!, b.w[n]!, 1e-6);
    }
  });
});

describe('P6 curve sign', () => {
  it('positive curve bends far lines to the right (x_n > W/2)', () => {
    // frac = 0: off_n = c*n(n-1)/2 > 0 for n >= 2
    // frac = 0.5: off_0 = 1.5, dx_0 = -1.5, off_1 = 0, dx_1 = 1.5, off_2 = 1.5 > 0 (c = 3)
    for (const z of [0, 0.5]) {
      const p = run(constTrack(40, 3), z, 0);
      for (let n = 2; n < p.count; n++) expect(p.x[n]!).toBeGreaterThan(CAM.screenWidth / 2);
    }
  });
  it('negative curve bends far lines to the left', () => {
    const p = run(constTrack(40, -3), 0, 0);
    for (let n = 2; n < p.count; n++) expect(p.x[n]!).toBeLessThan(CAM.screenWidth / 2);
  });
});

describe('P7 continuity across a segment boundary', () => {
  it('same world edge matches before/after the boundary within 0.05 px', () => {
    // At z = k - 1e-4: base = k-1. At z = k + 1e-4: base = k.
    // World edge k+n is line n+1 before and line n after.
    // Residual from the 2e-4*segmentLength = 0.04 world-unit depth shift is < 0.03 px
    // (y: height*f*0.04/dz^2 = 1000*214.5*0.04/536^2 = 0.03 at n = 0, smaller further).
    // An uncorrected scheme (off_0 = 0) would err by about c*scale_0 = 35*0.4 = 14 px.
    const t = curvy();
    // eps 1e-5 (was 1e-4): with the camera at 320 (d0 = 202) a 1e-4 sample shift alone moves y by 0.067 px.
    for (const k of [3, 4, 7, 11]) {
      const a = run(t, k - 1e-5, 0);
      const b = run(t, k + 1e-5, 0);
      for (let n = 0; n < CAM.drawDistance; n++) {
        near(a.x[n + 1]!, b.x[n]!, 0.05);
        near(a.y[n + 1]!, b.y[n]!, 0.05);
        near(a.w[n + 1]!, b.w[n]!, 0.05);
        expect(a.segment[n + 1]!).toBe(b.segment[n]!);
      }
    }
  });
  it('a fixed world edge moves smoothly as z sweeps across the boundary', () => {
    // Track edge e = 8 while z goes 3.5 .. 4.5 in 0.01 steps (boundary at z = 4: line 5 -> line 4).
    // Bound: the step that crosses the boundary may not exceed 1.5x the largest
    // step observed away from the boundary, plus 0.05 px. An uncorrected scheme jumps
    // by ~c*scale = several px against steps of ~0.2 px.
    const t = curvy();
    const e = 8;
    const xs: number[] = [];
    const ys: number[] = [];
    const ws: number[] = [];
    for (let i = 0; i <= 100; i++) {
      const z = 3.5 + i * 0.01;
      const p = run(t, z, 0);
      const n = e - Math.floor(z);
      xs.push(p.x[n]!);
      ys.push(p.y[n]!);
      ws.push(p.w[n]!);
    }
    for (const arr of [xs, ys, ws]) {
      let maxOther = 0;
      let maxCross = 0;
      for (let i = 1; i < arr.length; i++) {
        const d = Math.abs(arr[i]! - arr[i - 1]!);
        if (i >= 49 && i <= 51) maxCross = Math.max(maxCross, d);
        else maxOther = Math.max(maxOther, d);
      }
      expect(maxCross).toBeLessThanOrEqual(maxOther * 1.5 + 0.05);
    }
  });
});

describe('P8 wrap around the track end', () => {
  it('z, z+len and z-len give identical output; segments are wrapped', () => {
    const t = trackOf(CURVES.slice(0, 10));
    const a = run(t, 2.25, 0.2);
    const b = run(t, 12.25, 0.2);
    const c = run(t, -7.75, 0.2);
    for (let n = 0; n < a.count; n++) {
      for (const q of [b, c]) {
        near(a.x[n]!, q.x[n]!, 1e-3);
        near(a.y[n]!, q.y[n]!, 1e-3);
        near(a.w[n]!, q.w[n]!, 1e-3);
        expect(q.segment[n]).toBe(a.segment[n]);
      }
      expect(a.segment[n]!).toBeGreaterThanOrEqual(0);
      expect(a.segment[n]!).toBeLessThan(10);
    }
  });
  it('z = 9.5: segment[0] = 9, segment[1] = 0', () => {
    const p = run(trackOf(CURVES.slice(0, 10)), 9.5, 0);
    expect(p.segment[0]).toBe(9);
    expect(p.segment[1]).toBe(0);
  });
});

describe('P9 finiteness', () => {
  it('no NaN or Infinity over a sweep of z and x', () => {
    const t = curvy();
    const p = createProjection(CAM, ROAD);
    let bad = 0;
    let first: { z: number; x: number; n: number; field: string } | undefined;
    for (let z = -20; z <= 40; z += 0.37) {
      for (let x = -2; x <= 2; x += 0.5) {
        project(p, t, z, x, CAM, ROAD);
        for (let n = 0; n < p.count; n++) {
          if (!Number.isFinite(p.x[n]!)) {
            bad++;
            first ??= { z, x, n, field: 'x' };
          }
          if (!Number.isFinite(p.y[n]!)) {
            bad++;
            first ??= { z, x, n, field: 'y' };
          }
          if (!Number.isFinite(p.w[n]!)) {
            bad++;
            first ??= { z, x, n, field: 'w' };
          }
          if (!Number.isFinite(p.scale[n]!)) {
            bad++;
            first ??= { z, x, n, field: 'scale' };
          }
        }
      }
    }
    expect(first).toBeUndefined();
    expect(bad).toBe(0);
  });
});

describe('P10 low camera (d0 <= segmentLength) never throws', () => {
  // Low camera, round numbers: f = 100, height 50 -> d0 = 100*50/(100-50) = 100; segmentLength 200 > d0.
  const LCAM: CameraConfig = { ...ICAM, height: 50 };
  const LROAD: RoadConfig = { ...IROAD, segmentLength: 200 };

  it('does not throw when d0 <= segmentLength, inline and real', () => {
    expect(() => createProjection(LCAM, LROAD)).not.toThrow();
    expect(() => createProjection(ICAM, { ...IROAD, segmentLength: 200 })).not.toThrow(); // d0 == seg
    expect(() => createProjection(ICAM, { ...IROAD, segmentLength: 300 })).not.toThrow(); // d0 < seg
    expect(() => run(makeStraightTrack(20), 3.5, 0, LCAM, LROAD)).not.toThrow();
    expect(() => createProjection(CAM, ROAD)).not.toThrow();
  });

  it('frac = 0: line 0 sits exactly on the near plane (not clamped, depth == d0)', () => {
    // dz_n = 100 + 200n; scale = 1, 1/3, 0.2; camX = 0.5*40 = 20; straight
    // n=0: y = 50 + 1*50 = 100 = H; x = 100 + 1*(0-20) = 80; w = 40
    // n=1: y = 50 + 50/3 = 66.6667; x = 100 - 20/3 = 93.3333; w = 40/3
    const p = run(makeStraightTrack(20), 3, 0.5, LCAM, LROAD);
    near(p.y[0]!, 100, 1e-3);
    near(p.x[0]!, 80, 1e-3);
    near(p.w[0]!, 40, 1e-3);
    near(p.y[1]!, 50 + 50 / 3, 1e-3);
    near(p.x[1]!, 100 - 20 / 3, 1e-3);
    near(p.w[1]!, 40 / 3, 1e-3);
  });

  it('frac = 0.25: line 0 is clamped onto the near plane and interpolated by depth', () => {
    // true depths: dz_0 = 100 - 0.25*200 = 50 ; dz_1 = 100 + 0.75*200 = 250 ; dz_2 = 450
    // true line 0: scale 2   -> x = 100 + 2*(0-20) = 60 ; w = 2*40 = 80
    // line 1:      scale 0.4 -> x = 100 + 0.4*(-20) = 92 ; w = 16 ; y = 50 + 0.4*50 = 70
    // clamp line 0 to depth d0 = 100: t = (100-50)/(250-50) = 0.25
    // x_0 = 60 + 0.25*(92-60) = 68 ; w_0 = 80 + 0.25*(16-80) = 64 ; y_0 = H = 100
    // line 2: scale 2/9 -> y = 50 + 100/9 = 61.1111 (unchanged formula)
    const p = run(makeStraightTrack(20), 3.25, 0.5, LCAM, LROAD);
    expect(p.count).toBe(LCAM.drawDistance + 1);
    near(p.y[0]!, 100, 1e-3);
    near(p.x[0]!, 68, 1e-3);
    near(p.w[0]!, 64, 1e-3);
    near(p.y[1]!, 70, 1e-3);
    near(p.x[1]!, 92, 1e-3);
    near(p.w[1]!, 16, 1e-3);
    near(p.y[2]!, 50 + 100 / 9, 1e-3);
    // line indices fixed: line n = base + n
    expect(p.base).toBe(3);
    for (let n = 0; n < p.count; n++) expect(p.segment[n]).toBe(3 + n);
  });

  it('camera x mirrors left/right for the clamped line 0', () => {
    const t = makeStraightTrack(20);
    const a = run(t, 3.25, 0.5, LCAM, LROAD);
    const b = run(t, 3.25, -0.5, LCAM, LROAD);
    near(a.x[0]! - 100, -(b.x[0]! - 100), 1e-3);
    near(a.y[0]!, b.y[0]!, 1e-6);
    near(a.w[0]!, b.w[0]!, 1e-6);
  });

  it('sweep fov 60..100, horizon .25..0.5, height >= 200, real road: no throw, finite, y non-increasing, strip 0 starts at the bottom', () => {
    const t = makeStraightTrack(50);
    for (const fovDeg of [60, 80, 100])
      for (const horizon of [0.25, 0.35, 0.5])
        for (const height of [200, 250, 320])
          for (const frac of [0, 0.01, 0.3, 0.5, 0.99]) {
            const cfg: CameraConfig = { ...CAM, fovDeg, horizon, height };
            const tag = `fov ${fovDeg} hz ${horizon} h ${height} frac ${frac}`;
            const p = createProjection(cfg, ROAD);
            project(p, t, 5 + frac, 0.3, cfg, ROAD);
            const d0 =
              ((cfg.screenWidth / 2 / Math.tan((fovDeg * Math.PI) / 360)) * height) /
              (cfg.screenHeight * (1 - horizon));
            for (let n = 0; n < p.count; n++) {
              for (const a of [p.x, p.y, p.w, p.scale])
                expect(Number.isFinite(a[n]!), `${tag} n ${n}`).toBe(true);
              if (n > 0) expect(p.y[n]!, `${tag} n ${n}`).toBeLessThanOrEqual(p.y[n - 1]! + 1e-4);
              expect(p.segment[n]).toBe(5 + n);
            }
            if (d0 <= ROAD.segmentLength) near(p.y[0]!, cfg.screenHeight, 1e-3);
          }
  });

  it('d0 > segmentLength: unchanged formula (frac 0.5 inline pinned value)', () => {
    // dz_0 = 200 - 50 = 150 -> y = 50 + (100/150)*100 = 116.6667 (nothing is clamped)
    const p = run(makeStraightTrack(20), 3.5, 0, ICAM, IROAD);
    near(p.y[0]!, 50 + 200 / 3, 1e-3);
  });
});

describe('P11 buffer reuse', () => {
  it('project does not replace the typed arrays', () => {
    const t = curvy();
    const p = createProjection(CAM, ROAD);
    const refs = [p.x, p.y, p.w, p.scale, p.segment];
    project(p, t, 1.5, 0.1, CAM, ROAD);
    project(p, t, 2.5, -0.1, CAM, ROAD);
    expect(p.x).toBe(refs[0]);
    expect(p.y).toBe(refs[1]);
    expect(p.w).toBe(refs[2]);
    expect(p.scale).toBe(refs[3]);
    expect(p.segment).toBe(refs[4]);
  });
});

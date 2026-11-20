import { describe, expect, it } from 'vitest';
import camera from '../../src/data/camera.json';
import road from '../../src/data/road.json';
import { placeOnRoad, type Placement } from '../../src/render/placeOnRoad';
import { createProjection, project } from '../../src/render/projection';
import type { CameraConfig, Projection, RoadConfig } from '../../src/render/projection';
import {
  forwardDist,
  markRect,
  roadPointAt,
  TyreMarkRing,
  TyreMarks,
  type RoadPoint,
  type TyreMarksConfig,
} from '../../src/render/tyreMarks';
import { makeStraightTrack } from '../../src/sim/track';
import type { Track } from '../../src/sim/types';

// Spec: docs/brief.md R24c (tyre marks of the player in DRIFT, render only). The helpers under test:
// forwardDist (travel along the loop), roadPointAt (inverse projection of a wheel point onto the
// road), markRect (screen rectangle of a mark piece, same projection as roadside objects),
// TyreMarkRing (fixed ring buffer, capacity from data), TyreMarks.track (sampling every `spacing`
// segments while in DRIFT with both rear tyres on the asphalt; DRIFT exit, off-asphalt or a jump
// longer than maxGap break the mark).

const CAM: CameraConfig = camera;
const ROAD: RoadConfig = road;

const CURVES = [20, -10, 35, 5, -25, 15, 30, -5, 10, -20, 25, -35];
const curvyLong = (): Track => ({
  segments: Array.from({ length: 400 }, (_, i) => ({ curve: CURVES[i % 12]! })),
});

function run(track: Track, z: number, x = 0): Projection {
  const p = createProjection(CAM, ROAD);
  project(p, track, z, x, CAM, ROAD);
  return p;
}
const blank = (): Placement => ({ x: 0, y: 0, w: 0, h: 0, depth: 0 });
const pt = (): RoadPoint => ({ z: -7, x: -7 });
const near = (a: number, b: number, tol: number, msg = ''): void => {
  expect(Math.abs(a - b), `${msg} got ${a}, want ${b}`).toBeLessThanOrEqual(tol);
};
// Signed shortest distance on the loop (for comparing wrapped z).
const loopDiff = (a: number, b: number, len: number): number => {
  let d = (a - b) % len;
  if (d > len / 2) d -= len;
  if (d < -len / 2) d += len;
  return d;
};

// ------------------------------------------------------------------------------------------------
describe('R24c forwardDist: segments travelled forward on the loop, in [0, len)', () => {
  it('plain forward distance', () => {
    expect(forwardDist(10, 12, 100)).toBe(2);
    expect(forwardDist(10.25, 10.75, 100)).toBeCloseTo(0.5, 12);
  });
  it('wraps through the lap end', () => {
    expect(forwardDist(98, 2, 100)).toBe(4);
    expect(forwardDist(99.5, 0.25, 100)).toBeCloseTo(0.75, 12);
  });
  it('same point is 0; one step back is almost a lap', () => {
    expect(forwardDist(5, 5, 100)).toBe(0);
    expect(forwardDist(12, 10, 100)).toBe(98);
  });
  it('always in [0, len) and a + d lands on b (mod len)', () => {
    const len = 37;
    for (let a = -40; a <= 80; a += 3.7) {
      for (let b = -40; b <= 80; b += 5.3) {
        const d = forwardDist(a, b, len);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(len);
        near(loopDiff(a + d, b, len), 0, 1e-9, `a=${a} b=${b}`);
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe('R24c roadPointAt: screen point -> road point (inverse of placeOnRoad at height 0)', () => {
  const setups: { name: string; track: Track; z: number; camX: number }[] = [
    { name: 'straight', track: makeStraightTrack(400), z: 12.3, camX: 0 },
    { name: 'curvy', track: curvyLong(), z: 30.6, camX: 0.2 },
    { name: 'curvy, near the lap end', track: curvyLong(), z: 398.7, camX: -0.3 },
  ];
  for (const s of setups) {
    it(`${s.name}: round trip placeOnRoad -> roadPointAt recovers z and offset`, () => {
      const p = run(s.track, s.z, s.camX);
      const len = p.length;
      let checked = 0;
      for (const r of [0.3, 0.9, 1.5, 2.2, 3.7, 6.4, 10.1]) {
        if (r >= p.count - 1) continue;
        for (const off of [-1, -0.6, 0, 0.45, 1]) {
          const pl = blank();
          expect(placeOnRoad(pl, p, p.base + r, off, 1, 1)).toBe(true);
          const out = pt();
          expect(roadPointAt(out, p, pl.x, pl.y), `r=${r} off=${off}`).toBe(true);
          // Float32 buffers: tolerances in segments / half-widths.
          near(loopDiff(out.z, p.base + r, len), 0, 2e-3, `z r=${r} off=${off}`);
          near(out.x, off, 2e-3, `x r=${r} off=${off}`);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(20);
    });
  }
  it('returned z is wrapped into [0, len)', () => {
    const p = run(curvyLong(), 398.7, 0);
    for (const r of [0.5, 1.5, 2.5, 4.5]) {
      const pl = blank();
      placeOnRoad(pl, p, p.base + r, 0, 1, 1);
      const out = pt();
      expect(roadPointAt(out, p, pl.x, pl.y)).toBe(true);
      expect(out.z).toBeGreaterThanOrEqual(0);
      expect(out.z).toBeLessThan(p.length);
    }
  });
  it('a point above every drawn line (sky) returns false and leaves out untouched', () => {
    const p = run(makeStraightTrack(400), 5, 0);
    let top = Infinity;
    for (let n = 0; n < p.count; n++) top = Math.min(top, p.y[n]!);
    const out = pt();
    expect(roadPointAt(out, p, CAM.screenWidth / 2, top - 5)).toBe(false);
    expect(out).toEqual({ z: -7, x: -7 });
  });
  it('a strip whose far line is behind a crest is skipped (no hit there)', () => {
    const p = run(makeStraightTrack(400), 5, 0);
    const pl = blank();
    placeOnRoad(pl, p, p.base + 2.5, 0, 1, 1);
    for (let n = 0; n < p.count; n++) p.clipped[n] = 1;
    const out = pt();
    expect(roadPointAt(out, p, pl.x, pl.y)).toBe(false);
    expect(out).toEqual({ z: -7, x: -7 });
  });
});

// ------------------------------------------------------------------------------------------------
describe('R24c markRect: screen rectangle of a mark piece in the roadside-object projection', () => {
  const W = 18; // R24c width in world units (sprites.json tyreMarks.width start value)
  it('straight: base at the nearer end, height = screen span, width from the nearer scale, x = mid', () => {
    const p = run(makeStraightTrack(400), 5.4, 0);
    const z0 = p.base + 1.2;
    const z1 = p.base + 1.7;
    const a = blank();
    const b = blank();
    placeOnRoad(a, p, z0, 0.3, W, 0);
    placeOnRoad(b, p, z1, 0.3, W, 0);
    const out = blank();
    expect(markRect(out, p, z0, 0.3, z1, 0.3, W)).toBe(true);
    near(out.x, (a.x + b.x) / 2, 1e-3, 'x');
    near(out.y, Math.max(a.y, b.y), 1e-3, 'y = nearer end (lower on screen)');
    near(out.h, Math.abs(a.y - b.y), 1e-3, 'h');
    near(out.w, a.w, 1e-3, 'w = worldW * scale at the nearer end');
    near(out.depth, a.depth, 1e-6, 'depth = placeOnRoad depth of the nearer end');
    expect(out.h).toBeGreaterThan(0);
  });
  it('the order of the two ends does not matter', () => {
    const p = run(curvyLong(), 40.2, 0.1);
    const z0 = p.base + 2.1;
    const z1 = p.base + 2.9;
    const f = blank();
    const g = blank();
    expect(markRect(f, p, z0, -0.4, z1, -0.2, W)).toBe(true);
    expect(markRect(g, p, z1, -0.2, z0, -0.4, W)).toBe(true);
    near(f.x, g.x, 1e-6, 'x');
    near(f.y, g.y, 1e-6, 'y');
    near(f.w, g.w, 1e-6, 'w');
    near(f.h, g.h, 1e-6, 'h');
    near(f.depth, g.depth, 1e-9, 'depth');
  });
  it('curvy: the ends land where placeOnRoad puts the two road points', () => {
    const p = run(curvyLong(), 40.2, 0.1);
    const z0 = p.base + 3.25;
    const z1 = p.base + 3.5;
    const a = blank();
    const b = blank();
    placeOnRoad(a, p, z0, -0.5, W, 0);
    placeOnRoad(b, p, z1, 0.5, W, 0);
    const out = blank();
    expect(markRect(out, p, z0, -0.5, z1, 0.5, W)).toBe(true);
    near(out.x, (a.x + b.x) / 2, 1e-3, 'x');
    near(out.y, Math.max(a.y, b.y), 1e-3, 'y');
    near(out.h, Math.abs(a.y - b.y), 1e-3, 'h');
  });
  it('a mark piece lies in front of the road but behind an object standing nearer', () => {
    const p = run(makeStraightTrack(400), 5.4, 0);
    const out = blank();
    markRect(out, p, p.base + 4.2, 0, p.base + 4.6, 0, W);
    const nearer = blank();
    placeOnRoad(nearer, p, p.base + 3.9, 0, 10, 10);
    const farther = blank();
    placeOnRoad(farther, p, p.base + 5.5, 0, 10, 10);
    expect(out.depth).toBeGreaterThan(nearer.depth);
    expect(out.depth).toBeLessThan(farther.depth);
    expect(out.depth).toBeGreaterThan(-1);
    expect(out.depth).toBeLessThan(1);
  });
  it('an end outside the drawn range returns false and leaves out untouched', () => {
    const p = run(makeStraightTrack(400), 5.4, 0);
    const out = blank();
    out.x = 123;
    expect(markRect(out, p, p.base + 1, 0, p.base + p.count + 3, 0, W)).toBe(false);
    expect(markRect(out, p, p.base - 0.5, 0, p.base + 1, 0, W)).toBe(false);
    expect(out).toEqual({ x: 123, y: 0, w: 0, h: 0, depth: 0 });
  });
  it('an end behind a crest returns false', () => {
    const p = run(makeStraightTrack(400), 5.4, 0);
    p.clipped[4] = 1;
    const out = blank();
    expect(markRect(out, p, p.base + 1.5, 0, p.base + 3.5, 0, W)).toBe(false); // line 4 clipped
    expect(markRect(out, p, p.base + 1.5, 0, p.base + 2.5, 0, W)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
describe('R24c TyreMarkRing: fixed-capacity ring, oldest overwritten, k = 0 newest', () => {
  it('count grows to capacity and stays there', () => {
    const ring = new TyreMarkRing(4);
    expect(ring.count).toBe(0);
    for (let i = 0; i < 7; i++) {
      ring.push(i, i + 0.1, i + 0.2, i + 0.3, i % 2 === 0);
      expect(ring.count).toBe(Math.min(i + 1, 4));
    }
  });
  it('at(k) walks from the newest to the oldest kept sample with all fields', () => {
    const ring = new TyreMarkRing(4);
    for (let i = 0; i < 7; i++) ring.push(i, i + 0.1, i + 0.2, i + 0.3, i % 2 === 0);
    // kept: 6, 5, 4, 3 (newest first)
    for (let k = 0; k < 4; k++) {
      const v = 6 - k;
      const i = ring.at(k);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(4);
      expect(ring.zL[i]).toBeCloseTo(v, 12);
      expect(ring.xL[i]).toBeCloseTo(v + 0.1, 12);
      expect(ring.zR[i]).toBeCloseTo(v + 0.2, 12);
      expect(ring.xR[i]).toBeCloseTo(v + 0.3, 12);
      expect(ring.link[i]).toBe(v % 2 === 0 ? 1 : 0);
    }
  });
  it('buffers are preallocated at the capacity and never grow', () => {
    const ring = new TyreMarkRing(3);
    const zL = ring.zL;
    for (let i = 0; i < 10; i++) ring.push(i, 0, i, 0, true);
    expect(ring.zL).toBe(zL);
    expect(ring.zL.length).toBe(3);
    expect(ring.link.length).toBe(3);
  });
  it('clear empties it; pushes after clear start over', () => {
    const ring = new TyreMarkRing(3);
    for (let i = 0; i < 5; i++) ring.push(i, 0, i, 0, true);
    ring.clear();
    expect(ring.count).toBe(0);
    ring.push(42, 0, 42, 0, false);
    expect(ring.count).toBe(1);
    expect(ring.zL[ring.at(0)]).toBe(42);
    expect(ring.link[ring.at(0)]).toBe(0);
  });
  it('capacity 0 is a no-op ring', () => {
    const ring = new TyreMarkRing(0);
    ring.push(1, 0, 1, 0, true);
    expect(ring.count).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------
describe('R24c TyreMarks.track: sampling in DRIFT on the asphalt', () => {
  const LEN = 100;
  const CFG: TyreMarksConfig = {
    marks: 'on',
    capacity: 32,
    spacing: 0.25,
    width: 18,
    length: 1.6,
    fadeFrom: 0.25,
    maxGap: 4,
    stepPx: 3,
    maxSub: 24,
  };
  // Live wheel points at track z (both wheels at the same z), offsets xl / xr.
  function at(m: TyreMarks, z: number, xl = -0.2, xr = 0.2): void {
    m.left.z = z;
    m.left.x = xl;
    m.right.z = z;
    m.right.x = xr;
  }
  const newest = (m: TyreMarks) => {
    const i = m.ring.at(0);
    return { zL: m.ring.zL[i]!, zR: m.ring.zR[i]!, xL: m.ring.xL[i]!, link: m.ring.link[i]! };
  };

  it('not in DRIFT: nothing is recorded, no open mark', () => {
    const m = new TyreMarks(CFG);
    for (let k = 0; k < 20; k++) {
      at(m, 10 + k * 0.3);
      m.track(false, true, LEN);
    }
    expect(m.ring.count).toBe(0);
    expect(m.open).toBe(false);
  });
  it('first DRIFT frame starts a mark: one sample, unlinked, open', () => {
    const m = new TyreMarks(CFG);
    at(m, 10, -0.3, 0.1);
    m.track(true, true, LEN);
    expect(m.ring.count).toBe(1);
    expect(m.open).toBe(true);
    expect(newest(m)).toEqual({ zL: 10, zR: 10, xL: -0.3, link: 0 });
  });
  it('a new linked sample every `spacing` segments travelled (0.25), none in between', () => {
    const m = new TyreMarks(CFG);
    at(m, 10);
    m.track(true, true, LEN);
    // frames of 0.1 segment: samples at travel >= 0.25 from the last sample
    for (let k = 1; k <= 20; k++) {
      at(m, 10 + k * 0.1);
      m.track(true, true, LEN);
    }
    // travel 2.0 in 0.1 steps: samples at 0.3, 0.6, 0.9, 1.2, 1.5, 1.8 (each >= 0.25 after the last)
    expect(m.ring.count).toBe(7);
    for (let k = 0; k < m.ring.count - 1; k++) {
      const i = m.ring.at(k);
      const j = m.ring.at(k + 1);
      expect(m.ring.link[i]).toBe(1);
      const d = forwardDist(
        (m.ring.zL[j]! + m.ring.zR[j]!) / 2,
        (m.ring.zL[i]! + m.ring.zR[i]!) / 2,
        LEN,
      );
      expect(d).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(d).toBeLessThan(0.25 + 0.1 + 1e-9);
    }
    expect(m.ring.link[m.ring.at(m.ring.count - 1)]).toBe(0);
    expect(m.open).toBe(true);
  });
  it('the live wheel points are what the newest piece runs to (left/right kept as written)', () => {
    const m = new TyreMarks(CFG);
    at(m, 10);
    m.track(true, true, LEN);
    at(m, 10.1, -0.25, 0.15);
    m.track(true, true, LEN);
    expect(m.ring.count).toBe(1);
    expect(m.left).toEqual({ z: 10.1, x: -0.25 });
    expect(m.right).toEqual({ z: 10.1, x: 0.15 });
    expect(m.open).toBe(true);
  });
  it('leaving DRIFT ends the mark; the next DRIFT starts an unlinked one', () => {
    const m = new TyreMarks(CFG);
    at(m, 10);
    m.track(true, true, LEN);
    at(m, 10.5);
    m.track(true, true, LEN);
    at(m, 10.8);
    m.track(false, true, LEN);
    expect(m.open).toBe(false);
    const n = m.ring.count;
    at(m, 11.0);
    m.track(true, true, LEN);
    expect(m.ring.count).toBe(n + 1);
    expect(newest(m).link).toBe(0);
  });
  it('a wheel off the asphalt (|x| > 1) ends the mark; |x| = 1 still counts', () => {
    const m = new TyreMarks(CFG);
    at(m, 10, -1, 1);
    m.track(true, true, LEN);
    expect(m.open).toBe(true);
    expect(m.ring.count).toBe(1);
    at(m, 10.5, -0.5, 1.01);
    m.track(true, true, LEN);
    expect(m.open).toBe(false);
    expect(m.ring.count).toBe(1);
    at(m, 11, -1.2, 0.3);
    m.track(true, true, LEN);
    expect(m.open).toBe(false);
    at(m, 11.5, -0.5, 0.5);
    m.track(true, true, LEN);
    expect(m.open).toBe(true);
    expect(newest(m).link).toBe(0);
  });
  it('wheel points not found on the road end the mark', () => {
    const m = new TyreMarks(CFG);
    at(m, 10);
    m.track(true, true, LEN);
    at(m, 10.5);
    m.track(true, false, LEN);
    expect(m.open).toBe(false);
    expect(m.ring.count).toBe(1);
  });
  it('a jump longer than maxGap (4 segments) breaks the mark; up to maxGap stays linked', () => {
    const m = new TyreMarks(CFG);
    at(m, 10);
    m.track(true, true, LEN);
    at(m, 14); // exactly maxGap: linked
    m.track(true, true, LEN);
    expect(newest(m).link).toBe(1);
    at(m, 18.5); // 4.5 > maxGap: new mark
    m.track(true, true, LEN);
    expect(newest(m).link).toBe(0);
    expect(m.open).toBe(true);
    expect(m.ring.count).toBe(3);
  });
  it('a jump backwards (respawn behind) breaks the mark', () => {
    const m = new TyreMarks(CFG);
    at(m, 50);
    m.track(true, true, LEN);
    at(m, 45);
    m.track(true, true, LEN);
    expect(newest(m).link).toBe(0);
  });
  it('the mark continues through the lap end', () => {
    const m = new TyreMarks(CFG);
    at(m, 99.8);
    m.track(true, true, LEN);
    at(m, 0.1); // 0.3 forward through the wrap
    m.track(true, true, LEN);
    expect(m.ring.count).toBe(2);
    expect(newest(m).link).toBe(1);
  });
  it('marks "off": the ring is cleared and nothing is recorded', () => {
    const on = new TyreMarks(CFG);
    at(on, 10);
    on.track(true, true, LEN);
    const cfg = { ...CFG };
    const m = new TyreMarks(cfg);
    at(m, 10);
    m.track(true, true, LEN);
    expect(m.ring.count).toBe(1);
    cfg.marks = 'off';
    at(m, 10.5);
    m.track(true, true, LEN);
    expect(m.ring.count).toBe(0);
    expect(m.open).toBe(false);
  });
  it('capacity comes from the config and the ring never holds more', () => {
    const m = new TyreMarks({ ...CFG, capacity: 5 });
    at(m, 0);
    m.track(true, true, LEN);
    for (let k = 1; k <= 40; k++) {
      at(m, k * 0.25);
      m.track(true, true, LEN);
    }
    expect(m.ring.capacity).toBe(5);
    expect(m.ring.count).toBe(5);
    expect(newest(m).zL).toBeCloseTo(10, 12);
  });
});

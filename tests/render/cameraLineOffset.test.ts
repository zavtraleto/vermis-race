import { describe, expect, it } from 'vitest';
import camera from '../../src/data/camera.json';
import car3d from '../../src/data/car3d.json';
import road from '../../src/data/road.json';
import scenarios from '../../src/data/scenarios.json';
import sprites from '../../src/data/sprites.json';
import driftRun from '../../src/data/tracks/drift-run.json';
import { curveClasses, resolveSections, trackSections } from '../../src/data/tracks';
import { playerLineOffset } from '../../src/render/bumpFeedback';
import {
  cameraLineOffset,
  createProjection,
  focalPx,
  nearDistance,
  project,
} from '../../src/render/projection';
import type { CameraConfig, Projection } from '../../src/render/projection';
import { buildTrack, makeStraightTrack } from '../../src/sim/track';
import type { Segment, Track, TrackDef } from '../../src/sim/types';

// R30b (b): the road reaches the bottom of the screen on any slope. cameraLineOffset is the guard
// for descents too steep for the camera riding above the road at z + lineOffset: it pulls the
// camera's road point back toward z so the eye (nearDistance behind z) stays minClear above the
// road under it.

const seg = (y?: number): Segment => (y === undefined ? { curve: 0 } : { curve: 0, y });
const CREST = buildTrack({ sections: scenarios['hill-crest'].sections } as unknown as TrackDef);
// Closed hill across the loop end: climb +20 over 0..40, descent -20 over 40..80.
const LOOP = buildTrack({
  sections: [
    { enter: 0, hold: 40, leave: 0, curve: 0, hill: 20 },
    { enter: 0, hold: 40, leave: 0, curve: 0, hill: -20 },
  ],
} as unknown as TrackDef);
const DRIFT_RUN = buildTrack(resolveSections(trackSections(driftRun as never), curveClasses));

// Linear ramp: flat 0..20, then the road drops `slope` segment lengths per segment (ends y of
// segment i = -slope*(i-19) for i >= 20), so it is exactly linear for z in [20, len].
function ramp(slope: number, len = 100): Track {
  const s: Segment[] = [];
  for (let i = 0; i < len; i++) s.push(i < 20 ? seg(0) : seg(-slope * (i - 19)));
  return { segments: s };
}
// Linear climb of `slope` per segment from z = 20 on.
function climb(slope: number, len = 100): Track {
  return ramp(-slope, len);
}

// Reference road height (contract, not implementation): start of segment i = y[i-1] (0 for
// i = 0), linear inside, z wraps.
function startH(t: Track, i: number): number {
  return i === 0 ? 0 : (t.segments[i - 1]!.y ?? 0);
}
function refHeight(t: Track, z: number): number {
  const len = t.segments.length;
  const zf = Math.floor(z);
  const fr = z - zf;
  const b = ((zf % len) + len) % len;
  return startH(t, b) + fr * ((t.segments[b]!.y ?? 0) - startH(t, b));
}

// f = 180/tan(40 deg) = 214.52; d0 = f*320/(640 - 0.47*640) = 214.52*320/339.2 = 202.38;
// the eye is d0/200 = 1.0119 segments behind z.
const F = focalPx(camera);
const D0 = nearDistance(camera, F);
const SL = road.segmentLength;
const E = D0 / SL;
// playerLineOffset (real config) = 0.974 segments (see projectionLineOffset.test.ts).
const L = playerLineOffset(camera, road, sprites.player.baseY);
const CLEAR = car3d.slope.eyeClearance; // 64 world units

// Eye clearance above the road under it, world units, with the camera camera.height above the road
// at z + off (contract): height + (h(z + off) - h(z - E)) * SL.
function clearance(t: Track, z: number, off: number): number {
  return camera.height + (refHeight(t, z + off) - refHeight(t, z - E)) * SL;
}

const cam = (t: Track, z: number, off = L, minClear = CLEAR): number =>
  cameraLineOffset(t, z, off, camera, road, minClear);

const zs = (from: number, to: number, step: number): number[] => {
  const a: number[] = [];
  for (let z = from; z < to - 1e-9; z += step) a.push(z);
  return a;
};

describe('R30b (b) cameraLineOffset: unchanged when the eye already clears the road', () => {
  it('sanity of the real config', () => {
    expect(E).toBeGreaterThan(1.01);
    expect(E).toBeLessThan(1.015);
    expect(CLEAR).toBe(64);
  });

  it('flat track: returns lineOffset (clearance = height 320 >= 64)', () => {
    const t = makeStraightTrack(50);
    for (const z of [0, 0.37, 10, 25.5, 49.9]) {
      expect(cam(t, z)).toBe(L);
      expect(cam(t, z, 2.5)).toBe(2.5);
    }
  });

  it('climb: returns lineOffset (clearance grows: 320 + slope*(L+E)*SL)', () => {
    // slope 1.5: 320 + 1.5*1.986*200 = 916 >= 64
    const t = climb(1.5);
    for (const z of zs(22, 95, 0.37)) expect(cam(t, z)).toBe(L);
  });

  it('mild descent: returns lineOffset', () => {
    // slope 0.5: clearance = 320 - 0.5*(0.974 + 1.012)*200 = 320 - 198.6 = 121.4 >= 64
    const t = ramp(0.5);
    for (const z of zs(22, 95, 0.37)) {
      expect(clearance(t, z, L)).toBeGreaterThanOrEqual(CLEAR);
      expect(cam(t, z)).toBe(L);
    }
  });

  it('drift-run (real track, real configs, eyeClearance): inactive at every z, step 0.25', () => {
    const len = DRIFT_RUN.segments.length;
    const bad: number[] = [];
    for (let z = 0; z < len; z += 0.25) if (cam(DRIFT_RUN, z) !== L) bad.push(z);
    expect(bad).toEqual([]);
  });
});

describe('R30b (b) cameraLineOffset: 0 when even the road at z is too low', () => {
  it('steep linear descent slope 1.5: clearance at offset 0 = 320 - 1.5*1.012*200 = 16.4 < 64', () => {
    const t = ramp(1.5);
    for (const z of zs(22, 95, 0.37)) {
      expect(clearance(t, z, 0)).toBeLessThan(CLEAR);
      expect(cam(t, z)).toBe(0);
    }
  });

  it('slope 3 (clearance at z = 320 - 3*1.012*200 = -287): 0', () => {
    const t = ramp(3);
    for (const z of [30, 41.3, 77.77]) expect(cam(t, z)).toBe(0);
  });
});

describe('R30b (b) cameraLineOffset: partial pull-back in between', () => {
  it('linear descent slope 1: hand value off = -E + (64 - 320)/(200*(-1)) = 1.28 - 1.0119 = 0.268', () => {
    // Full offset: clearance = 320 - (0.974 + 1.012)*200 = -77 < 64. Offset 0: 320 - 202.4 =
    // 117.6 >= 64. On a linear road the camera height is linear in off, so
    // 320 + (-off - E)*200 = 64  =>  off = 1.28 - E.
    const t = ramp(1);
    const want = (CLEAR - camera.height) / (SL * -1) - E;
    expect(want).toBeCloseTo(0.268, 3);
    for (const z of zs(22, 95, 0.37)) {
      const off = cam(t, z);
      expect(off).toBeCloseTo(want, 9);
      expect(off).toBeGreaterThan(0);
      expect(off).toBeLessThan(L);
      // Exactly minClear left under the eye on a linear road.
      expect(clearance(t, z, off)).toBeCloseTo(CLEAR, 6);
    }
  });

  it('monotone in steepness on a linear descent: steeper -> smaller offset', () => {
    let prev = L;
    for (const s of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5]) {
      const off = cam(ramp(s), 50.5);
      expect(off).toBeLessThanOrEqual(prev);
      prev = off;
    }
    expect(prev).toBe(0);
  });

  it('hill-crest: strictly inside (0, L) on the steep descent, continuous in z', () => {
    // Descent -40 over 100..160, max slope 40*pi/2/60 = 1.05: full offset leaves
    // 320 - 1.05*1.986*200 = -97 < 64; offset 0 leaves 320 - 1.05*1.012*200 = 107 >= 64.
    let inside = 0;
    let maxJump = 0;
    let jumpZ = 0;
    let prev = cam(CREST, 95);
    for (const z of zs(95.01, 170, 0.01)) {
      const off = cam(CREST, z);
      expect(Number.isFinite(off)).toBe(true);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThanOrEqual(L);
      if (off > 0 && off < L) inside++;
      const j = Math.abs(off - prev);
      if (j > maxJump) {
        maxJump = j;
        jumpZ = z;
      }
      prev = off;
    }
    expect(inside).toBeGreaterThan(100); // active over at least one segment of the descent
    expect(maxJump, `largest jump at z=${jumpZ}`).toBeLessThan(0.05);
    // Mid-descent (slope ~1.05 at z = 130) is strictly inside.
    const mid = cam(CREST, 130);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(L);
  });

  it('hill-crest climb and flats stay at lineOffset', () => {
    for (const z of zs(0, 100, 0.25)) expect(cam(CREST, z)).toBe(L);
    for (const z of zs(175, CREST.segments.length, 0.25)) expect(cam(CREST, z)).toBe(L);
  });

  it('deterministic: same inputs twice give the same value', () => {
    for (const z of [101.3, 130, 147.77]) expect(cam(CREST, z)).toBe(cam(CREST, z));
  });
});

describe('R30b (b) cameraLineOffset: loop end and no NaN', () => {
  it('periodic across the loop end (z, z + len, z - len)', () => {
    const len = LOOP.segments.length;
    for (const z of [0, 0.3, 0.99, 1.5, 55.5, 79.2, 79.99]) {
      const a = cam(LOOP, z);
      expect(cam(LOOP, z + len)).toBeCloseTo(a, 9);
      expect(cam(LOOP, z - len)).toBeCloseTo(a, 9);
    }
  });

  it('no NaN anywhere on hill-crest and the loop (step 0.05), bounds 0..lineOffset', () => {
    for (const t of [CREST, LOOP]) {
      for (const z of zs(-2, t.segments.length + 2, 0.05)) {
        const off = cam(t, z);
        expect(Number.isNaN(off), `z=${z}`).toBe(false);
        expect(off).toBeGreaterThanOrEqual(0);
        expect(off).toBeLessThanOrEqual(L);
      }
    }
  });
});

describe('R30b (b) cameraLineOffset + project: the near road under the car is not clipped', () => {
  const run = (t: Track, z: number, off: number): Projection => {
    const p = createProjection(camera, road);
    project(p, t, z, 0, camera, road, off);
    return p;
  };

  it('hill-crest descent: clipped[1] and clipped[2] are 0 for every sampled z', () => {
    const bad: number[] = [];
    for (const z of zs(95, 175, 0.05)) {
      const p = run(CREST, z, cam(CREST, z));
      if (p.clipped[1] !== 0 || p.clipped[2] !== 0) bad.push(z);
    }
    expect(bad).toEqual([]);
  });

  it('the check bites: with the full lineOffset some z of the descent clip line 1 or 2', () => {
    let hits = 0;
    for (const z of zs(95, 175, 0.05)) {
      const p = run(CREST, z, L);
      if (p.clipped[1] !== 0 || p.clipped[2] !== 0) hits++;
    }
    expect(hits).toBeGreaterThan(0);
  });
});

describe('R30b project: low-camera clamp of line 0 with a lineOffset', () => {
  // height 300: d0 = 214.52*300/339.2 = 189.7 < segmentLength 200 -> low camera.
  const low: CameraConfig = { ...camera, height: 300 };
  const fL = focalPx(low);
  const d0L = nearDistance(low, fL);
  const HY = low.horizon * low.screenHeight;

  it('the config is low', () => {
    expect(d0L).toBeLessThan(SL);
    expect(d0L).toBeCloseTo(189.7, 0);
  });

  it('line 0 sits on the near plane at the road height at z, camera above z + lineOffset', () => {
    // y0 = horizonY + s*(height + (h(z + off) - h(z))*SL), s = f/d0.
    for (const z of [55.3, 72.6, 99.7, 120.45, 140.9]) {
      for (const off of [L, 0.5, 2.5]) {
        const p = createProjection(low, road);
        project(p, CREST, z, 0, low, road, off);
        expect(p.frac).toBeGreaterThan(0);
        const s = fL / d0L;
        expect(p.scale[0]).toBeCloseTo(s, 5);
        const want = HY + s * (low.height + (refHeight(CREST, z + off) - refHeight(CREST, z)) * SL);
        // y is a Float32Array: compare with the float32 rounding of the exact value.
        expect(Math.abs(p.y[0]! - Math.fround(want))).toBeLessThan(1e-6);
        // Steep part (slope ~1 at mid-climb 70 and mid-descent 130): the offset actually moves
        // line 0 away from the flat value (~0.6 px/unit * 0.5 seg * 200 = 60 px at off 0.5).
        if (z === 72.6 || z === 120.45 || z === 140.9) {
          expect(Math.abs(want - (HY + s * low.height))).toBeGreaterThan(10);
        }
      }
    }
  });

  it('with lineOffset 0 line 0 is exactly horizonY + s*height', () => {
    for (const z of [55.3, 72.6, 99.7, 120.45, 140.9]) {
      const p = createProjection(low, road);
      project(p, CREST, z, 0, low, road, 0);
      expect(p.y[0]).toBe(Math.fround(HY + (fL / d0L) * low.height));
    }
  });
});

import { describe, expect, it } from 'vitest';
import camera from '../../src/data/camera.json';
import road from '../../src/data/road.json';
import scenarios from '../../src/data/scenarios.json';
import sprites from '../../src/data/sprites.json';
import { playerLineOffset } from '../../src/render/bumpFeedback';
import {
  createProjection,
  focalPx,
  nearDistance,
  project,
  roadHeightAt,
} from '../../src/render/projection';
import type { Projection } from '../../src/render/projection';
import { buildTrack, makeStraightTrack } from '../../src/sim/track';
import type { Segment, Track, TrackDef } from '../../src/sim/types';

// R30b (a): "under the car" (R30) is the line where the player car is drawn, playerLineOffset
// segments ahead of the projection point, not the projection point itself.

const seg = (y?: number): Segment => (y === undefined ? { curve: 0 } : { curve: 0, y });
const trackY = (ends: number[]): Track => ({ segments: ends.map((y) => seg(y)) });
const scen = (name: 'hill-crest' | 'hill-dip'): Track =>
  buildTrack({ sections: scenarios[name].sections } as unknown as TrackDef);

// hill-crest: flat 0..40, climb +40 over 40..100 (max slope 40*pi/2/60 = 1.05 per segment),
// descent -40 over 100..160, flat after. hill-dip: dip -40 over 40..130, climb back 130..220.
const CREST = scen('hill-crest');
const DIP = scen('hill-dip');
// Hill across the loop end: climb +20 over 0..40, descent -20 over 40..80 (back to 0 at 80 = 0).
const LOOP = buildTrack({
  sections: [
    { enter: 0, hold: 40, leave: 0, curve: 0, hill: 20 },
    { enter: 0, hold: 40, leave: 0, curve: 0, hill: -20 },
  ],
} as unknown as TrackDef);

// Reference road height from the contract (not from the implementation): height at the start of
// segment i is y of segment i-1 (0 for i = 0), linear inside the segment, z wraps.
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

const F = focalPx(camera);
const D0 = nearDistance(camera, F);
const HY = camera.horizon * camera.screenHeight;
const SL = road.segmentLength;
const L = playerLineOffset(camera, road, sprites.player.baseY);
const ANCHOR = sprites.player.baseY * camera.screenHeight;

// Documented formula for an unclamped line n (contract item 2):
// y[n] = horizonY + scale[n] * (camera.height + roadHeightAt(z + off)*SL - startHeight(seg)*SL),
// scale[n] = f / (d0 + (n - frac) * SL).
function refY(t: Track, z: number, n: number, off: number): number {
  const zf = Math.floor(z);
  const fr = z - zf;
  const len = t.segments.length;
  const s = (((zf + n) % len) + len) % len;
  const scale = F / (D0 + (n - fr) * SL);
  return HY + scale * (camera.height + refHeight(t, z + off) * SL - startH(t, s) * SL);
}

function run(t: Track, z: number, off?: number): Projection {
  const p = createProjection(camera, road);
  if (off === undefined) project(p, t, z, 0, camera, road);
  else project(p, t, z, 0, camera, road, off);
  return p;
}

// Screen y of the road at track position z + depth (depth in segments from the projection point),
// read from the projection buffers. Perspective-correct between neighbouring lines i, j: inverse
// scale (= depth) and (y - horizonY)/scale (= camY - road world height) are both linear in z.
function roadYAt(p: Projection, depth: number): number {
  const r = p.frac + depth;
  const i = Math.floor(r);
  const t = r - i;
  const j = i + 1;
  const si = p.scale[i]!;
  const sj = p.scale[j]!;
  const qi = (p.y[i]! - HY) / si;
  const qj = (p.y[j]! - HY) / sj;
  const s = 1 / (1 / si + t * (1 / sj - 1 / si));
  return HY + s * (qi + t * (qj - qi));
}

const zs = (from: number, to: number, step: number): number[] => {
  const a: number[] = [];
  for (let z = from; z < to; z += step) a.push(z);
  return a;
};

describe('R30b roadHeightAt (road height in segment lengths at fractional z)', () => {
  it('flat tracks give 0 (no y, y = 0), any z including negative', () => {
    const noY: Track = { segments: Array.from({ length: 12 }, () => seg()) };
    const zeros = makeStraightTrack(12);
    for (const z of [0, 0.3, 5.5, 11.99, 12, 37.2, -0.4, -13.7]) {
      expect(roadHeightAt(noY, z)).toBe(0);
      expect(roadHeightAt(zeros, z)).toBe(0);
    }
  });

  it('hand values: start of segment i = y[i-1], linear inside, wraps (also negative z)', () => {
    // ends y = [1, 3, 2, 0] -> starts: seg0 0, seg1 1, seg2 3, seg3 2
    const t = trackY([1, 3, 2, 0]);
    const cases: [number, number][] = [
      [0, 0],
      [0.5, 0.5], // 0 + 0.5*(1-0)
      [1, 1],
      [1.25, 1.5], // 1 + 0.25*(3-1)
      [2, 3],
      [2.5, 2.5], // 3 + 0.5*(2-3)
      [3.5, 1], // 2 + 0.5*(0-2)
      [4, 0], // wraps to segment 0
      [5.25, 1.5], // = 1.25
      [-0.5, 1], // = 3.5
      [-2.75, 1.5], // = 1.25
      [-8, 0], // = 0
    ];
    for (const [z, h] of cases) expect(roadHeightAt(t, z)).toBeCloseTo(h, 9);
  });

  it('equals segments[i].y at the end of segment i and is continuous across boundaries', () => {
    for (const t of [CREST, DIP]) {
      for (let i = 0; i < t.segments.length - 1; i++) {
        expect(roadHeightAt(t, i + 1)).toBeCloseTo(t.segments[i]!.y ?? 0, 9);
        expect(
          Math.abs(roadHeightAt(t, i + 1 - 1e-7) - roadHeightAt(t, i + 1 + 1e-7)),
        ).toBeLessThan(1e-5);
      }
    }
  });

  it('periodic: z and z + k*len give the same height', () => {
    const len = LOOP.segments.length;
    for (const z of [0.2, 13.7, 39.5, 79.9]) {
      const h = roadHeightAt(LOOP, z);
      expect(roadHeightAt(LOOP, z + len)).toBeCloseTo(h, 9);
      expect(roadHeightAt(LOOP, z - len)).toBeCloseTo(h, 9);
      expect(roadHeightAt(LOOP, z - 3 * len)).toBeCloseTo(h, 9);
    }
  });
});

describe("R30b project lineOffset: default 0 is today's projection", () => {
  it('real config is not a low camera (no line 0 clamp), so the formula holds for n >= 1', () => {
    // d0 = f*height/(H - horizonY) = 214.5*320/339.2 = 202.4 > segmentLength 200
    expect(D0).toBeGreaterThan(SL);
  });

  it('omitted and explicit 0 give identical buffers on a hill track', () => {
    for (const z of [20, 55.3, 72, 99.7, 101.2, 130.9, 159.4]) {
      const a = run(CREST, z);
      const b = run(CREST, z, 0);
      for (const k of ['x', 'y', 'w', 'scale', 'segment', 'clipped'] as const) {
        expect(Array.from(b[k])).toEqual(Array.from(a[k]));
      }
      expect([b.count, b.base, b.frac, b.length]).toEqual([a.count, a.base, a.frac, a.length]);
    }
  });

  it('lineOffset 0 pins y[n] to the documented formula with roadHeightAt(z) (n >= 1)', () => {
    for (const t of [CREST, DIP]) {
      for (const z of zs(30, 230, 3.37)) {
        const p = run(t, z);
        for (let n = 1; n < p.count; n++) {
          expect(Math.abs(p.y[n]! - refY(t, z, n, 0))).toBeLessThan(0.01);
        }
      }
    }
  });
});

describe('R30b project lineOffset: the camera rides above the road at z + lineOffset', () => {
  it('y[n] follows the formula with roadHeightAt(z + lineOffset) (n >= 1)', () => {
    for (const t of [CREST, DIP, LOOP]) {
      for (const z of zs(0.1, t === LOOP ? 80 : 230, 2.71)) {
        for (const off of [L, 2.5]) {
          const p = run(t, z, off);
          for (let n = 1; n < p.count; n++) {
            expect(Math.abs(p.y[n]! - refY(t, z, n, off))).toBeLessThan(0.01);
          }
        }
      }
    }
  });

  it('lineOffset changes only y and clipping: x, w, scale, segment, base, frac are unchanged', () => {
    for (const z of [55.3, 99.7, 130.9]) {
      const a = run(CREST, z, 0);
      const b = run(CREST, z, L);
      for (const k of ['x', 'w', 'scale', 'segment'] as const) {
        expect(Array.from(b[k])).toEqual(Array.from(a[k]));
      }
      expect([b.count, b.base, b.frac, b.length]).toEqual([a.count, a.base, a.frac, a.length]);
    }
  });

  it('flat track: lineOffset does not change anything', () => {
    const t = makeStraightTrack(400);
    for (const z of [10, 10.37, 250.9]) {
      const a = run(t, z, 0);
      const b = run(t, z, L);
      expect(Array.from(b.y)).toEqual(Array.from(a.y));
    }
  });

  it('deterministic: same inputs twice give identical buffers', () => {
    const a = run(CREST, 88.8, L);
    const b = run(CREST, 88.8, L);
    expect(Array.from(b.y)).toEqual(Array.from(a.y));
    expect(Array.from(b.clipped)).toEqual(Array.from(a.clipped));
  });
});

describe('R30b (a) the road at the player line passes through sprites.player.baseY on any slope', () => {
  // playerLineOffset (real config): f = 180/tan(40 deg) = 214.5, horizonY = 0.47*640 = 300.8,
  // anchor = 0.74*640 = 473.6, scale = (473.6-300.8)/320 = 0.54, f/scale = 397.3,
  // L = (397.3 - 202.4)/200 = 0.974 segments.
  it('player line offset is about one segment (sanity of the real config)', () => {
    expect(L).toBeGreaterThan(0.9);
    expect(L).toBeLessThan(1.05);
  });

  it('climb, crest, descent, dip, loop end: road y at depth lineOffset = anchor within 1.5 px', () => {
    const tracks: [string, Track, number, number][] = [
      ['hill-crest', CREST, 30, 175],
      ['hill-dip', DIP, 30, 235],
      ['loop', LOOP, 0, 80],
    ];
    for (const [name, t, from, to] of tracks) {
      let worst = 0;
      let worstZ = 0;
      for (const z of zs(from, to, 0.13)) {
        const p = run(t, z, L);
        const e = Math.abs(roadYAt(p, L) - ANCHOR);
        if (e > worst) {
          worst = e;
          worstZ = z;
        }
      }
      expect(worst, `${name} worst at z=${worstZ}`).toBeLessThanOrEqual(1.5);
    }
  });

  it('the check bites: with lineOffset 0 the steep part of hill-crest misses by tens of px', () => {
    // Camera height taken at z instead of z + 0.97: on slope ~1 the road under the car is
    // ~1 segment-length (200 world units) off, about 0.54 px/unit * 200 = 100 px on screen.
    let worst = 0;
    for (const z of zs(55, 150, 0.13)) {
      const p = run(CREST, z, 0);
      worst = Math.max(worst, Math.abs(roadYAt(p, L) - ANCHOR));
    }
    expect(worst).toBeGreaterThan(30);
  });

});

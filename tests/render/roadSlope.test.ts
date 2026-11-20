import { describe, expect, it } from 'vitest';
import scenarios from '../../src/data/scenarios.json';
import { slopePitchDeg } from '../../src/render/roadSlope';
import { buildTrack, makeStraightTrack } from '../../src/sim/track';
import type { Segment, Track, TrackDef } from '../../src/sim/types';

// R30b (c): pitch = slopePitchGain * atan((h(z + halfSpan) - h(z - halfSpan)) / (2 * halfSpan)),
// degrees, heights and z in segment lengths; climb = nose up (positive).

const seg = (y: number): Segment => ({ curve: 0, y });
const trackY = (ends: number[]): Track => ({ segments: ends.map(seg) });
const DEG = 180 / Math.PI;

const CREST = buildTrack({ sections: scenarios['hill-crest'].sections } as unknown as TrackDef);
const DIP = buildTrack({ sections: scenarios['hill-dip'].sections } as unknown as TrackDef);
// Hill across the loop end: climb +20 over 0..40, descent -20 over 40..80.
const LOOP = buildTrack({
  sections: [
    { enter: 0, hold: 40, leave: 0, curve: 0, hill: 20 },
    { enter: 0, hold: 40, leave: 0, curve: 0, hill: -20 },
  ],
} as unknown as TrackDef);
const negate = (t: Track): Track => ({
  segments: t.segments.map((s) => ({ curve: s.curve, y: -(s.y ?? 0) })),
});
// Constant slope k per segment over segments 0..39 (ends k*(i+1)), the rest of the 60 flat at 40k.
const RAMP = (k: number): Track =>
  trackY(Array.from({ length: 60 }, (_, i) => (i < 40 ? k * (i + 1) : 40 * k)));

describe('R30b (c) slopePitchDeg', () => {
  it('flat road gives 0 for any z, halfSpan, gain', () => {
    const t = makeStraightTrack(50);
    for (const z of [0, 3.3, 25, 49.9, -2]) {
      for (const [hs, g] of [
        [0.5, 1],
        [2, 0.6],
        [5, 3],
      ] as const) {
        expect(slopePitchDeg(t, z, hs, g)).toBeCloseTo(0, 12);
      }
    }
  });

  it('slope of 1 segment-length per segment gives 45 * gain', () => {
    // z = 10, halfSpan 2: (h(12) - h(8)) / 4 = (12 - 8) / 4 = 1 -> atan(1) = 45 deg
    const t = RAMP(1);
    expect(slopePitchDeg(t, 10, 2, 1)).toBeCloseTo(45, 9);
    expect(slopePitchDeg(t, 10, 2, 0.5)).toBeCloseTo(22.5, 9);
    expect(slopePitchDeg(t, 20.37, 1.5, 2)).toBeCloseTo(90, 9);
  });

  it('hand value: slope 0.5 -> atan(0.5) = 26.565 deg; descent -0.5 -> -26.565 deg', () => {
    // (h(13) - h(7)) / 6 = (6.5 - 3.5) / 6 = 0.5
    expect(slopePitchDeg(RAMP(0.5), 10, 3, 1)).toBeCloseTo(26.56505118, 6);
    expect(slopePitchDeg(RAMP(-0.5), 10, 3, 1)).toBeCloseTo(-26.56505118, 6);
  });

  it('sign: climb is nose up (positive), descent negative (hill-crest and hill-dip)', () => {
    // hill-crest climbs over 40..100, descends over 100..160; hill-dip descends 40..130, climbs 130..220
    for (const z of [50, 70, 90]) expect(slopePitchDeg(CREST, z, 2, 1)).toBeGreaterThan(0);
    for (const z of [110, 130, 150]) expect(slopePitchDeg(CREST, z, 2, 1)).toBeLessThan(0);
    for (const z of [60, 85, 120]) expect(slopePitchDeg(DIP, z, 2, 1)).toBeLessThan(0);
    for (const z of [140, 175, 210]) expect(slopePitchDeg(DIP, z, 2, 1)).toBeGreaterThan(0);
  });

  it('steepest point of hill-crest: max easeInOut slope 40*pi/2/60 = 1.0472 -> about 46.3 deg', () => {
    // At z = 70 (mid climb) the slope is ~pi/3; with halfSpan 1 the chord is within 0.1% of it.
    // atan(1.0472) = 46.32 deg
    expect(slopePitchDeg(CREST, 70, 1, 1)).toBeCloseTo(Math.atan((40 * Math.PI) / 2 / 60) * DEG, 1);
  });

  it('symmetric at the top of a crest and the bottom of a dip: 0', () => {
    for (const hs of [1, 2, 5, 10]) {
      expect(Math.abs(slopePitchDeg(CREST, 100, hs, 1))).toBeLessThan(1e-9);
      expect(Math.abs(slopePitchDeg(DIP, 130, hs, 1))).toBeLessThan(1e-9);
    }
  });

  it('mirror: crest at 100 - d and 100 + d give opposite pitch', () => {
    for (const d of [3.3, 17, 41.5]) {
      expect(slopePitchDeg(CREST, 100 + d, 2, 1)).toBeCloseTo(
        -slopePitchDeg(CREST, 100 - d, 2, 1),
        9,
      );
    }
  });

  it('negating the heights negates the pitch', () => {
    const neg = negate(CREST);
    for (const z of [45.5, 70, 99, 123.4]) {
      expect(slopePitchDeg(neg, z, 2, 1)).toBeCloseTo(-slopePitchDeg(CREST, z, 2, 1), 9);
    }
  });

  it('linear in gain (gain 0 -> 0)', () => {
    for (const z of [55, 80, 140]) {
      const one = slopePitchDeg(CREST, z, 2, 1);
      expect(slopePitchDeg(CREST, z, 2, 0)).toBeCloseTo(0, 12);
      expect(slopePitchDeg(CREST, z, 2, 0.35)).toBeCloseTo(0.35 * one, 9);
      expect(slopePitchDeg(CREST, z, 2, 2)).toBeCloseTo(2 * one, 9);
    }
  });

  it('bounded: |pitch| < 90 * gain', () => {
    for (let z = 0; z < 240; z += 1.7) {
      expect(Math.abs(slopePitchDeg(DIP, z, 0.5, 1))).toBeLessThan(90);
    }
  });

  it('wraps around the loop end (hand value)', () => {
    // ends [1, 2, 3, 4, 0]: starts 0, 1, 2, 3, 4; last segment drops 4 -> 0.
    // z = 0, halfSpan 0.5: h(0.5) = 0.5, h(-0.5) = h(4.5) = 4 + 0.5*(0-4) = 2
    // (0.5 - 2) / 1 = -1.5 -> atan(-1.5) = -56.3099 deg
    const t = trackY([1, 2, 3, 4, 0]);
    expect(slopePitchDeg(t, 0, 0.5, 1)).toBeCloseTo(-56.30993247, 6);
    // z = 4.5, halfSpan 1: h(5.5) = h(0.5) = 0.5, h(3.5) = 3.5 -> -3/2 -> atan(-1.5)
    expect(slopePitchDeg(t, 4.5, 1, 1)).toBeCloseTo(-56.30993247, 6);
  });

  it('periodic: z, z + len, z - len give the same pitch; symmetric at the loop seam of LOOP', () => {
    const len = LOOP.segments.length;
    for (const z of [0, 0.4, 39.2, 79.6]) {
      const a = slopePitchDeg(LOOP, z, 3, 1);
      expect(slopePitchDeg(LOOP, z + len, 3, 1)).toBeCloseTo(a, 9);
      expect(slopePitchDeg(LOOP, z - len, 3, 1)).toBeCloseTo(a, 9);
    }
    // The loop is a bump with its foot at z = 0 (= 80): easeInOut is symmetric there.
    expect(Math.abs(slopePitchDeg(LOOP, 0, 3, 1))).toBeLessThan(1e-9);
    // Peak at 40: also symmetric.
    expect(Math.abs(slopePitchDeg(LOOP, 40, 3, 1))).toBeLessThan(1e-9);
  });

  it('deterministic and does not mutate the track', () => {
    const before = JSON.stringify(CREST);
    const a = slopePitchDeg(CREST, 77.7, 2, 0.8);
    const b = slopePitchDeg(CREST, 77.7, 2, 0.8);
    expect(b).toBe(a);
    expect(JSON.stringify(CREST)).toBe(before);
  });
});

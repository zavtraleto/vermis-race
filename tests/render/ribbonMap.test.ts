import { describe, expect, it } from 'vitest';
import curves from '../../src/data/tracks/curves.json';
import {
  RIBBON_EASY,
  RIBBON_HARD,
  RIBBON_MEDIUM,
  RIBBON_STRAIGHT,
  classifyCurve,
  createRibbonLayout,
  createRibbonMap,
  layoutRibbon,
  lookaheadDistance,
  ribbonThresholds,
  updateRibbonMap,
  type RibbonMap,
  type RibbonMapConfig,
  type RibbonZone,
} from '../../src/render/ribbonMap';
import { SEG_PER_UNIT } from '../../src/sim/constants';
import { buildTrack, makeStraightTrack } from '../../src/sim/track';
import type { Track } from '../../src/sim/types';

// Inline config so the tests do not move when the JSON is tuned.
const CFG: RibbonMapConfig = {
  lookaheadSeconds: 5,
  minDistance: 90,
  points: 40,
  substeps: 4,
  headingPerCurve: 0.005,
  maxHeadingDeg: 85,
};
const TH = ribbonThresholds(curves);

function constantTrack(length: number, curve: number): Track {
  const segments = [];
  for (let i = 0; i < length; i++) segments.push({ curve });
  return { segments };
}

function ribbon(track: Track, z: number, speed: number, carX = 0): RibbonMap {
  const m = createRibbonMap(CFG);
  updateRibbonMap(m, track, z, speed, carX, CFG, TH);
  return m;
}

describe('ribbonMap lookahead distance', () => {
  it('is lookaheadSeconds at the current speed (segments, R16 units)', () => {
    expect(lookaheadDistance(1, CFG)).toBeCloseTo(5 * SEG_PER_UNIT, 9);
    expect(lookaheadDistance(0.5, CFG)).toBeCloseTo(2.5 * SEG_PER_UNIT, 9);
  });
  it('scales linearly with speed above the minimum', () => {
    expect(lookaheadDistance(0.8, CFG) / lookaheadDistance(0.4, CFG)).toBeCloseTo(2, 9);
  });
  it('never drops below minDistance, also at standstill', () => {
    expect(lookaheadDistance(0, CFG)).toBe(90);
    expect(lookaheadDistance(0.1, CFG)).toBe(90);
  });
  it('the ribbon length equals the lookahead distance on a straight track', () => {
    for (const speed of [0, 0.3, 1]) {
      const m = ribbon(makeStraightTrack(1000), 10, speed);
      expect(m.distance).toBeCloseTo(lookaheadDistance(speed, CFG), 9);
      expect(m.y[m.count - 1]!).toBeCloseTo(m.distance, 6);
    }
  });
});

describe('ribbonMap straight track', () => {
  it('is a straight vertical line from the car upward', () => {
    const m = ribbon(makeStraightTrack(1000), 12.3, 1);
    expect(m.count).toBe(CFG.points + 1);
    expect(m.x[0]).toBe(0);
    expect(m.y[0]).toBe(0);
    for (let i = 0; i < m.count; i++) {
      expect(m.x[i]).toBe(0);
      expect(m.cls[i]).toBe(RIBBON_STRAIGHT);
      if (i > 0) expect(m.y[i]!).toBeGreaterThan(m.y[i - 1]!);
    }
  });
});

describe('ribbonMap constant curve', () => {
  it('right curve bends right monotonically and keeps going forward', () => {
    const m = ribbon(constantTrack(1000, 2.5), 5, 1);
    let prevDx = 0;
    for (let i = 1; i < m.count; i++) {
      const dx = m.x[i]! - m.x[i - 1]!;
      const dy = m.y[i]! - m.y[i - 1]!;
      expect(dx).toBeGreaterThan(0); // always to the right
      expect(dx).toBeGreaterThanOrEqual(prevDx - 1e-9); // bending more and more
      expect(dy).toBeGreaterThan(0); // never turns back toward the car
      prevDx = dx;
    }
    expect(m.cls[m.count - 1]).toBe(RIBBON_MEDIUM);
  });
  it('left curve is the exact mirror of the right curve', () => {
    const r = ribbon(constantTrack(1000, 4.5), 5, 0.7);
    const l = ribbon(constantTrack(1000, -4.5), 5, 0.7);
    for (let i = 0; i < r.count; i++) {
      expect(l.x[i]!).toBeCloseTo(-r.x[i]!, 9);
      expect(l.y[i]!).toBeCloseTo(r.y[i]!, 9);
      expect(l.cls[i]).toBe(r.cls[i]);
    }
    expect(l.x[l.count - 1]!).toBeLessThan(0);
  });
  it('a straight then a right corner: ribbon is straight until the corner, then bends right', () => {
    const segs = [];
    for (let i = 0; i < 100; i++) segs.push({ curve: 0 });
    for (let i = 0; i < 400; i++) segs.push({ curve: 2.5 });
    const m = ribbon({ segments: segs }, 0, 1); // 300 segments ahead, corner at 100
    for (let i = 0; i < m.count; i++) {
      if (m.y[i]! <= 100) expect(m.x[i]).toBe(0);
    }
    expect(m.x[m.count - 1]!).toBeGreaterThan(0);
  });
});

describe('ribbonMap steepness classes', () => {
  it('thresholds lie between the classes of curves.json', () => {
    expect(TH.straight).toBeGreaterThan(0);
    expect(TH.straight).toBeLessThan(curves.easy);
    expect(TH.easy).toBeGreaterThan(curves.easy);
    expect(TH.easy).toBeLessThan(curves.medium);
    expect(TH.medium).toBeGreaterThan(curves.medium);
    expect(TH.medium).toBeLessThan(curves.hard);
  });
  it('each class value maps to its own class, both signs', () => {
    for (const side of [1, -1]) {
      expect(classifyCurve(0, TH)).toBe(RIBBON_STRAIGHT);
      expect(classifyCurve(side * curves.easy, TH)).toBe(RIBBON_EASY);
      expect(classifyCurve(side * curves.medium, TH)).toBe(RIBBON_MEDIUM);
      expect(classifyCurve(side * curves.hard, TH)).toBe(RIBBON_HARD);
    }
  });
  it('switches exactly at the thresholds (below -> lower class, at or above -> higher)', () => {
    const eps = 1e-6;
    expect(classifyCurve(TH.straight - eps, TH)).toBe(RIBBON_STRAIGHT);
    expect(classifyCurve(TH.straight, TH)).toBe(RIBBON_EASY);
    expect(classifyCurve(TH.easy - eps, TH)).toBe(RIBBON_EASY);
    expect(classifyCurve(TH.easy, TH)).toBe(RIBBON_MEDIUM);
    expect(classifyCurve(TH.medium - eps, TH)).toBe(RIBBON_MEDIUM);
    expect(classifyCurve(TH.medium, TH)).toBe(RIBBON_HARD);
    expect(classifyCurve(100, TH)).toBe(RIBBON_HARD);
  });
  it('per-point class follows the curve of the segment at that point', () => {
    const segs = [];
    for (let i = 0; i < 100; i++) segs.push({ curve: 0 });
    for (let i = 0; i < 100; i++) segs.push({ curve: -curves.hard });
    for (let i = 0; i < 200; i++) segs.push({ curve: curves.easy });
    const m = ribbon({ segments: segs }, 0, 1);
    // Point i sits at distance i * 300 / 40 = 7.5 i.
    expect(m.cls[4]).toBe(RIBBON_STRAIGHT); // 30
    expect(m.cls[20]).toBe(RIBBON_HARD); // 150
    expect(m.cls[36]).toBe(RIBBON_EASY); // 270
  });
});

describe('ribbonMap loop seam', () => {
  it('wraps around the end of the track like an unrolled copy of it', () => {
    const lap = [];
    for (let i = 0; i < 100; i++) lap.push({ curve: i < 20 ? 3 : i > 70 ? -1.5 : 0 });
    const looped: Track = { segments: lap };
    const unrolled: Track = { segments: [...lap, ...lap, ...lap, ...lap, ...lap] };
    const a = ribbon(looped, 85.4, 1);
    const b = ribbon(unrolled, 85.4, 1);
    const c = ribbon(looped, 85.4 + 200, 1); // z past several laps
    for (let i = 0; i < a.count; i++) {
      expect(a.x[i]!).toBeCloseTo(b.x[i]!, 6);
      expect(a.y[i]!).toBeCloseTo(b.y[i]!, 6);
      expect(a.cls[i]).toBe(b.cls[i]);
      expect(c.x[i]!).toBeCloseTo(b.x[i]!, 3);
      expect(c.y[i]!).toBeCloseTo(b.y[i]!, 3);
    }
    // The corner after the seam is visible: bends right.
    expect(a.x[a.count - 1]!).toBeGreaterThan(0);
  });
});

describe('ribbonMap continuity', () => {
  const track = buildTrack({
    sections: [
      { enter: 10, hold: 20, leave: 10, curve: 4.5 },
      { enter: 7, hold: 13, leave: 9, curve: -2.5 },
      { enter: 5, hold: 30, leave: 5, curve: 1.25 },
    ],
  });
  it('no jump when the car crosses a segment boundary', () => {
    for (const boundary of [1, 10, 17, 30, 41, 55, 99]) {
      const a = ribbon(track, boundary - 1e-7, 1);
      const b = ribbon(track, boundary + 1e-7, 1);
      for (let i = 0; i < a.count; i++) {
        expect(Math.abs(a.x[i]! - b.x[i]!)).toBeLessThan(1e-3);
        expect(Math.abs(a.y[i]! - b.y[i]!)).toBeLessThan(1e-3);
      }
    }
  });
  it('a small move of the car moves every point by a small amount', () => {
    for (let z = 0; z < 120; z += 0.37) {
      const a = ribbon(track, z, 1);
      const b = ribbon(track, z + 0.01, 1);
      for (let i = 0; i < a.count; i++) {
        expect(Math.abs(a.x[i]! - b.x[i]!)).toBeLessThan(0.1);
        expect(Math.abs(a.y[i]! - b.y[i]!)).toBeLessThan(0.1);
      }
    }
  });
});

describe('ribbonMap car marker and buffers', () => {
  it('carries the car lateral position', () => {
    expect(ribbon(makeStraightTrack(500), 0, 1, -0.6).carX).toBe(-0.6);
    expect(ribbon(makeStraightTrack(500), 0, 1, 1.4).carX).toBe(1.4);
  });
  it('reuses its preallocated arrays across updates', () => {
    const m = createRibbonMap(CFG);
    const { x, y, cls } = m;
    updateRibbonMap(m, makeStraightTrack(500), 3, 1, 0, CFG, TH);
    updateRibbonMap(m, constantTrack(500, 2), 7, 0.4, 0.2, CFG, TH);
    expect(m.x).toBe(x);
    expect(m.y).toBe(y);
    expect(m.cls).toBe(cls);
  });
});

describe('ribbonMap layout in the top zone', () => {
  const ZONE: RibbonZone = { width: 360, height: 77, padding: 5, xStretch: 1.5 };
  it('the car is at the bottom centre, a straight ribbon runs up to the top padding', () => {
    const m = ribbon(makeStraightTrack(1000), 0, 1);
    const l = createRibbonLayout(CFG);
    layoutRibbon(l, m, ZONE);
    expect(l.px[0]).toBeCloseTo(180, 6);
    expect(l.py[0]).toBeCloseTo(77 - 5, 6);
    expect(l.py[m.count - 1]!).toBeCloseTo(5, 6);
    for (let i = 0; i < m.count; i++) expect(l.px[i]).toBeCloseTo(180, 6);
  });
  it('a full lookahead of hard corner stays inside the zone at vmax, and right is right', () => {
    for (const curve of [curves.hard, -curves.hard, 20, -20]) {
      const m = ribbon(constantTrack(1000, curve), 0, 1);
      const l = createRibbonLayout(CFG);
      layoutRibbon(l, m, ZONE);
      for (let i = 0; i < m.count; i++) {
        expect(l.px[i]!).toBeGreaterThanOrEqual(ZONE.padding);
        expect(l.px[i]!).toBeLessThanOrEqual(ZONE.width - ZONE.padding);
        expect(l.py[i]!).toBeGreaterThanOrEqual(ZONE.padding);
        expect(l.py[i]!).toBeLessThanOrEqual(ZONE.height - ZONE.padding);
      }
      expect(Math.sign(l.px[m.count - 1]! - 180)).toBe(Math.sign(curve));
    }
  });
});

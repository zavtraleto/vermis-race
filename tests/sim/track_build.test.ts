import { describe, expect, it } from 'vitest';
import { cameraConfig, roadConfig } from '../../src/data/render';
import {
  curveClasses,
  loadTestTwisty,
  parseSections,
  resolveSections,
} from '../../src/data/tracks';
import twistyRaw from '../../src/data/tracks/test-twisty.json';
import { createProjection, project } from '../../src/render/projection';
import { SEG_PER_UNIT } from '../../src/sim/constants';
import { buildTrack } from '../../src/sim/track';
import type { TrackSection } from '../../src/sim/types';

const sec = (enter: number, hold: number, leave: number, curve: number): TrackSection => ({
  enter,
  hold,
  leave,
  curve,
});

describe('T10 buildTrack', () => {
  it('length is the sum of enter+hold+leave', () => {
    const t = buildTrack({ sections: [sec(4, 2, 4, 2), sec(10, 20, 5, -3), sec(0, 7, 0, 1)] });
    expect(t.segments.length).toBe(10 + 35 + 7);
  });

  it('matches hand-computed values (enter 4, hold 2, leave 4, curve 2)', () => {
    const t = buildTrack({ sections: [sec(4, 2, 4, 2)] });
    // enter n=0..3: 2*(n/4)^2 = 0, 0.125, 0.5, 1.125
    // hold: 2, 2
    // leave n=0..3: 2 + (0-2)*(0.5 - cos(pi*n/4)/2) = 1 + cos(pi*n/4) = 2, 1.70711, 1, 0.29289
    const expected = [0, 0.125, 0.5, 1.125, 2, 2, 2, 1 + Math.SQRT1_2, 1, 1 - Math.SQRT1_2];
    expect(t.segments.length).toBe(10);
    expected.forEach((v, i) => expect(t.segments[i]!.curve).toBeCloseTo(v, 12));
  });

  it('hold equals the declared curve exactly, for both signs', () => {
    for (const c of [2.5, -4.5, 0.3]) {
      const t = buildTrack({ sections: [sec(6, 9, 6, c)] });
      for (let i = 6; i < 15; i++) expect(t.segments[i]!.curve).toBe(c);
    }
  });

  it('every segment of a section has the sign of its curve or is 0', () => {
    for (const c of [3, -3]) {
      const t = buildTrack({ sections: [sec(12, 5, 12, c)] });
      for (const s of t.segments) expect(s.curve * c).toBeGreaterThanOrEqual(0);
    }
  });

  it('neighbour jumps stay within the continuity bound, incl. section joins and loop closure', () => {
    const secs = [sec(30, 90, 30, 2.5), sec(25, 60, 25, -4.5), sec(40, 10, 20, 1.25)];
    const t = buildTrack({ sections: secs });
    const n = t.segments.length;
    const bound = (s: TrackSection): number =>
      Math.abs(s.curve) * Math.max(2 / s.enter, Math.PI / (2 * s.leave));
    const owner: TrackSection[] = [];
    for (const s of secs) for (let i = 0; i < s.enter + s.hold + s.leave; i++) owner.push(s);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const d = Math.abs(t.segments[j]!.curve - t.segments[i]!.curve);
      const b = Math.max(bound(owner[i]!), bound(owner[j]!));
      expect(d).toBeLessThanOrEqual(b + 1e-12);
    }
    // enter starts at exactly 0
    expect(t.segments[0]!.curve).toBe(0);
    expect(t.segments[150]!.curve).toBe(0);
  });

  it('zero-length enter or leave is allowed', () => {
    const t = buildTrack({ sections: [sec(0, 5, 0, 2), sec(3, 4, 0, -1), sec(0, 2, 6, 1)] });
    expect(t.segments.length).toBe(5 + 7 + 8);
  });
});

describe('T10 test-twisty data', () => {
  const tw = loadTestTwisty();

  it('def curve = side * curveClasses[class], lengths copied', () => {
    expect(tw.sections.length).toBeGreaterThan(0);
    expect(tw.def.sections.length).toBe(tw.sections.length);
    tw.sections.forEach((s, i) => {
      const d = tw.def.sections[i]!;
      expect(d.curve).toBe(s.side * curveClasses[s.curveClass]);
      expect([d.enter, d.hold, d.leave]).toEqual([s.enter, s.hold, s.leave]);
    });
  });

  it('curve classes are positive and ordered easy < medium < hard', () => {
    expect(curveClasses.easy).toBeGreaterThan(0);
    expect(curveClasses.medium).toBeGreaterThan(curveClasses.easy);
    expect(curveClasses.hard).toBeGreaterThan(curveClasses.medium);
  });

  it('lap lasts 60..90 s at vmax', () => {
    const t = buildTrack(tw.def);
    const seconds = t.segments.length / SEG_PER_UNIT;
    expect(seconds).toBeGreaterThanOrEqual(60);
    expect(seconds).toBeLessThanOrEqual(90);
  });

  it('no straight longer than 1.5 s (90 segments), also across the loop wrap', () => {
    const segs = buildTrack(tw.def).segments;
    const n = segs.length;
    let run = 0;
    let best = 0;
    for (let i = 0; i < 2 * n; i++) {
      if (Math.abs(segs[i % n]!.curve) < 0.1) {
        run++;
        if (run > best) best = run;
      } else run = 0;
    }
    expect(Math.min(best, n)).toBeLessThanOrEqual(90);
  });

  it('side sequence is not strictly alternating: at least 4 pairs of consecutive sections share a side', () => {
    const sides = tw.sections.map((x) => x.side);
    let same = 0;
    for (let i = 1; i < sides.length; i++) if (sides[i] === sides[i - 1]) same++;
    expect(same).toBeGreaterThanOrEqual(4);
  });

  it('R22b at least 70% of corner segments have |curve| >= medium (drift-only)', () => {
    const segs = buildTrack(tw.def).segments;
    let corner = 0;
    let strong = 0;
    for (const sg of segs) {
      if (sg.curve === 0) continue;
      corner++;
      // small epsilon: enter/leave ramps are interpolated, hold is exactly the class value
      if (Math.abs(sg.curve) >= curveClasses.medium) strong++;
    }
    expect(corner).toBeGreaterThan(0);
    expect(strong / corner).toBeGreaterThanOrEqual(0.7);
  });

  it('easy corners still exist on both sides (hold segments)', () => {
    for (const side of [-1, 1])
      expect(
        tw.def.sections.some((d) => d.hold > 0 && d.curve === side * curveClasses.easy),
      ).toBe(true);
  });

  it('all three classes appear on both sides', () => {
    for (const side of [-1, 1])
      for (const c of ['easy', 'medium', 'hard'])
        expect(tw.sections.some((s) => s.side === side && s.curveClass === c)).toBe(true);
  });

  it('has an S-combination and a long arc', () => {
    const s = tw.sections;
    const strong = (i: number): boolean => s[i]!.curveClass !== 'easy';
    let sCombo = false;
    for (let i = 0; i < s.length; i++) {
      const j = (i + 1) % s.length;
      if (
        s[i]!.side !== s[j]!.side &&
        strong(i) &&
        strong(j) &&
        s[i]!.hold <= 90 &&
        s[j]!.hold <= 90
      )
        sCombo = true;
    }
    expect(sCombo).toBe(true);
    expect(s.some((x) => x.hold >= 300)).toBe(true);
  });

  it('max |delta curve| between neighbours over the loop (with wrap) <= 0.35', () => {
    const segs = buildTrack(tw.def).segments;
    const n = segs.length;
    let m = 0;
    for (let i = 0; i < n; i++)
      m = Math.max(m, Math.abs(segs[(i + 1) % n]!.curve - segs[i]!.curve));
    expect(m).toBeLessThanOrEqual(0.35);
  });

  it('resolveSections applies the given classes', () => {
    const def = resolveSections([{ enter: 1, hold: 2, leave: 3, curveClass: 'hard', side: -1 }], {
      easy: 1,
      medium: 2,
      hard: 3,
    });
    expect(def.sections).toEqual([{ enter: 1, hold: 2, leave: 3, curve: -3 }]);
  });
});

describe('T10 parseSections validation', () => {
  const ok = { enter: 1, hold: 2, leave: 3, curveClass: 'easy', side: 1 };
  it('accepts the shipped data unchanged', () => {
    expect(parseSections(twistyRaw.sections)).toEqual(twistyRaw.sections);
  });
  it('throws on unknown curveClass', () => {
    expect(() => parseSections([{ ...ok, curveClass: 'insane' }])).toThrow();
  });
  it('throws on side 0', () => {
    expect(() => parseSections([{ ...ok, side: 0 }])).toThrow();
  });
  it('throws on negative length', () => {
    expect(() => parseSections([{ ...ok, hold: -1 }])).toThrow();
  });
  it('throws on non-integer length', () => {
    expect(() => parseSections([{ ...ok, enter: 1.5 }])).toThrow();
  });
});

describe('T10 curve classes vs screen', () => {
  const W = cameraConfig.screenWidth;
  // hand calc: about 158.9 px per curve unit for the current camera, screenWidth 360
  const shiftFor = (c: number): number => {
    const t = buildTrack({ sections: [sec(0, 1000, 0, c)] });
    const proj = createProjection(cameraConfig, roadConfig);
    project(proj, t, 0, 0, cameraConfig, roadConfig);
    return proj.x[cameraConfig.drawDistance]! - W / 2;
  };
  // TODO(director): re-derive readability bounds after the 2026-11-19 playtest
  it('screen shift is finite, > 0 and ordered easy < medium < hard (regression pin)', () => {
    const e = shiftFor(curveClasses.easy);
    const m = shiftFor(curveClasses.medium);
    const h = shiftFor(curveClasses.hard);
    for (const v of [e, m, h]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(e).toBeLessThan(m);
    expect(m).toBeLessThan(h);
  });
});

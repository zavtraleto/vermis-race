import { describe, expect, it } from 'vitest';
import {
  curveClasses,
  expandFigures,
  loadTestTwisty,
  parseSections,
  resolveSections,
} from '../../src/data/tracks';
import type { FigureDef, FigureRef } from '../../src/data/tracks';
import figuresRaw from '../../src/data/tracks/figures.json';
import twistyRaw from '../../src/data/tracks/test-twisty.json';
import { buildTrack } from '../../src/sim/track';

const dict = figuresRaw as unknown as Record<string, FigureDef>;
const NAMES = [
  'straight',
  'kink',
  'sweeper',
  'hairpin',
  'flick',
  'esses',
  'tightening',
  'opening',
  'carousel',
  'double',
];
const parts = (name: string): FigureDef['parts'] => {
  const f = dict[name];
  if (!f) throw new Error(`figure ${name} missing from figures.json`);
  return f.parts;
};
const len = (p: { enter: number; hold: number; leave: number }): number =>
  p.enter + p.hold + p.leave;
const total = (name: string): number => parts(name).reduce((a, p) => a + len(p), 0);

describe('R31 dictionary contents', () => {
  it('R31 contains exactly the ten named figures', () => {
    expect(Object.keys(dict).sort()).toEqual([...NAMES].sort());
  });
});

describe('R31 figure shapes', () => {
  it('R31 straight is one straight part', () => {
    const p = parts('straight');
    expect(p.length).toBe(1);
    expect(p[0]!.curveClass).toBe('straight');
  });
  it('R31 kink is one easy part, shorter than the sweeper', () => {
    const p = parts('kink');
    expect(p.length).toBe(1);
    expect(p[0]!.curveClass).toBe('easy');
    expect(total('kink')).toBeLessThan(total('sweeper'));
  });
  it('R31 sweeper is one medium part', () => {
    const p = parts('sweeper');
    expect(p.length).toBe(1);
    expect(p[0]!.curveClass).toBe('medium');
  });
  it('R31 hairpin is one hard part with hold >= 150', () => {
    const p = parts('hairpin');
    expect(p.length).toBe(1);
    expect(p[0]!.curveClass).toBe('hard');
    expect(p[0]!.hold).toBeGreaterThanOrEqual(150);
  });
  it('R31 flick is two medium/hard parts on opposite sides with transition <= 40', () => {
    const p = parts('flick');
    expect(p.length).toBe(2);
    for (const x of p) expect(['medium', 'hard']).toContain(x.curveClass);
    expect(p[0]!.side).toBe(-p[1]!.side);
    expect(p[0]!.leave + p[1]!.enter).toBeLessThanOrEqual(40);
  });
  it('R31 esses is 3 or 4 medium parts, alternating sides, transitions <= 50', () => {
    const p = parts('esses');
    expect([3, 4]).toContain(p.length);
    for (let i = 0; i < p.length; i++) {
      expect(p[i]!.curveClass).toBe('medium');
      if (i > 0) {
        expect(p[i]!.side).toBe(-p[i - 1]!.side);
        expect(p[i - 1]!.leave + p[i]!.enter).toBeLessThanOrEqual(50);
      }
    }
  });
  it('R31 tightening is medium then hard, same side, no straightening between', () => {
    const p = parts('tightening');
    expect(p.length).toBe(2);
    expect(p[0]!.curveClass).toBe('medium');
    expect(p[1]!.curveClass).toBe('hard');
    expect(p[0]!.side).toBe(p[1]!.side);
    expect(p[0]!.leave).toBe(0);
    expect(p[1]!.enter).toBeLessThanOrEqual(15);
  });
  it('R31 opening is hard then medium, same side, no straightening between', () => {
    const p = parts('opening');
    expect(p.length).toBe(2);
    expect(p[0]!.curveClass).toBe('hard');
    expect(p[1]!.curveClass).toBe('medium');
    expect(p[0]!.side).toBe(p[1]!.side);
    expect(p[0]!.leave).toBe(0);
    expect(p[1]!.enter).toBeLessThanOrEqual(15);
  });
  it('R31 carousel is one constant-class part with hold >= 400', () => {
    const p = parts('carousel');
    expect(p.length).toBe(1);
    expect(['easy', 'medium', 'hard']).toContain(p[0]!.curveClass);
    expect(p[0]!.hold).toBeGreaterThanOrEqual(400);
  });
  it('R31 double is two hard parts, same side, gap 20..80', () => {
    const p = parts('double');
    expect(p.length).toBe(2);
    expect(p[0]!.curveClass).toBe('hard');
    expect(p[1]!.curveClass).toBe('hard');
    expect(p[0]!.side).toBe(p[1]!.side);
    const gap = p[0]!.leave + p[1]!.enter;
    expect(gap).toBeGreaterThanOrEqual(20);
    expect(gap).toBeLessThanOrEqual(80);
  });
});

describe('R31 expandFigures', () => {
  // hand-made dictionary so expansion is tested independently of figures.json
  const d: Record<string, FigureDef> = {
    zig: {
      parts: [
        { enter: 10, hold: 20, leave: 10, curveClass: 'medium', side: 1 }, // length 40
        { enter: 10, hold: 40, leave: 10, curveClass: 'hard', side: -1 }, // length 60
      ],
    },
    flat: { parts: [{ enter: 0, hold: 50, leave: 0, curveClass: 'straight', side: 1 }] },
  };

  it('R31 side 1 keeps relative sides, side -1 mirrors every part', () => {
    const a = expandFigures([{ figure: 'zig', side: 1 }], d);
    const b = expandFigures([{ figure: 'zig', side: -1 }], d);
    expect(a.map((s) => s.side)).toEqual([1, -1]);
    expect(b.map((s) => s.side)).toEqual([-1, 1]);
    expect(b.map((s) => [s.enter, s.hold, s.leave, s.curveClass])).toEqual(
      a.map((s) => [s.enter, s.hold, s.leave, s.curveClass]),
    );
  });
  it('R31 hill is split proportionally to part length and sums to the figure hill', () => {
    // lengths 40 and 60, hill 30 -> 12 and 18 (30 * 40/100, 30 * 60/100)
    const out = expandFigures([{ figure: 'zig', side: 1, hill: 30 }], d);
    expect(out[0]!.hill).toBeCloseTo(12, 9);
    expect(out[1]!.hill).toBeCloseTo(18, 9);
    expect((out[0]!.hill ?? 0) + (out[1]!.hill ?? 0)).toBeCloseTo(30, 9);
  });
  it('R31 negative hill keeps the proportion', () => {
    const out = expandFigures([{ figure: 'zig', side: -1, hill: -50 }], d);
    expect(out[0]!.hill).toBeCloseTo(-20, 9);
    expect(out[1]!.hill).toBeCloseTo(-30, 9);
  });
  it('R31 a single-part figure gets the whole hill', () => {
    const out = expandFigures([{ figure: 'flat', side: 1, hill: 7 }], d);
    expect(out[0]!.hill).toBeCloseTo(7, 9);
  });
  it('R31 unknown figure throws with its name in the message', () => {
    expect(() =>
      expandFigures(
        [
          { figure: 'zig', side: 1 },
          { figure: 'corkscrew', side: 1 },
        ],
        d,
      ),
    ).toThrow(/corkscrew/);
  });
  it('R31 output order follows input order', () => {
    const out = expandFigures(
      [
        { figure: 'flat', side: 1 },
        { figure: 'zig', side: 1 },
        { figure: 'flat', side: -1 },
      ],
      d,
    );
    expect(out.map((s) => s.curveClass)).toEqual(['straight', 'medium', 'hard', 'straight']);
  });
  it('R31 does not mutate the dictionary or the refs', () => {
    const dBefore = JSON.stringify(d);
    const refs: FigureRef[] = [{ figure: 'zig', side: -1, hill: 10 }];
    const rBefore = JSON.stringify(refs);
    expandFigures(refs, d);
    expect(JSON.stringify(d)).toBe(dBefore);
    expect(JSON.stringify(refs)).toBe(rBefore);
  });
  it('R31 is deterministic: same inputs twice give equal output', () => {
    const refs: FigureRef[] = [{ figure: 'zig', side: 1, hill: 5 }];
    expect(expandFigures(refs, d)).toEqual(expandFigures(refs, d));
  });
});

describe('R31 straight through the real loader', () => {
  it('R31 a straight part builds segments with curve 0 only', () => {
    const d: Record<string, FigureDef> = {
      s: { parts: [{ enter: 5, hold: 40, leave: 5, curveClass: 'straight', side: 1 }] },
    };
    const sections = parseSections(expandFigures([{ figure: 's', side: -1 }], d));
    const t = buildTrack(resolveSections(sections, curveClasses));
    expect(t.segments.length).toBe(50);
    for (const sg of t.segments) expect(sg.curve).toBe(0);
  });
});

describe('R31 default track from figures', () => {
  const refs = (twistyRaw as unknown as { figures?: FigureRef[] }).figures;
  const placements = (): FigureRef[] => {
    if (!refs) throw new Error('test-twisty.json has no "figures" array');
    return refs;
  };
  const sections = (): ReturnType<typeof expandFigures> => expandFigures(placements(), dict);
  const sumLen = (xs: ReturnType<typeof expandFigures>): number =>
    xs.reduce((a, s) => a + len(s), 0);

  it('R31 uses every figure at least once', () => {
    const used = new Set(placements().map((r) => r.figure));
    for (const n of NAMES) expect(used.has(n), n).toBe(true);
  });
  it('R31 has at least two flicks and one esses', () => {
    const count = (n: string): number => placements().filter((r) => r.figure === n).length;
    expect(count('flick')).toBeGreaterThanOrEqual(2);
    expect(count('esses')).toBeGreaterThanOrEqual(1);
  });
  it('R31 builds a closed loop: buildTrack does not throw, hills sum to 0, ends at y = 0', () => {
    const secs = sections();
    const hills = secs.reduce((a, s) => a + (s.hill ?? 0), 0);
    expect(Math.abs(hills)).toBeLessThanOrEqual(1e-9);
    const t = buildTrack(resolveSections(parseSections(secs), curveClasses));
    expect(Math.abs(t.segments[t.segments.length - 1]!.y ?? 0)).toBeLessThanOrEqual(1e-9);
  });
  it('R31 straights are at most 15% of the total length', () => {
    const secs = sections();
    const straight = sumLen(secs.filter((s) => s.curveClass === 'straight'));
    expect(straight / sumLen(secs)).toBeLessThanOrEqual(0.15);
  });
  it('R31 medium and hard parts are at least 60% of the total length', () => {
    const secs = sections();
    const strong = sumLen(secs.filter((s) => s.curveClass === 'medium' || s.curveClass === 'hard'));
    expect(strong / sumLen(secs)).toBeGreaterThanOrEqual(0.6);
  });
  it('R31 no more than 3 consecutive placements on the same side (circular)', () => {
    const sides = placements().map((r) => r.side);
    const n = sides.length;
    let run = 0;
    let best = 0;
    for (let i = 0; i < 2 * n; i++) {
      if (i > 0 && sides[i % n] === sides[(i - 1) % n]) run++;
      else run = 1;
      best = Math.max(best, Math.min(run, n));
    }
    expect(best).toBeLessThanOrEqual(3);
  });
  it('R31 total length is 3000..6000 segments', () => {
    const n = buildTrack(resolveSections(parseSections(sections()), curveClasses)).segments.length;
    expect(n).toBeGreaterThanOrEqual(3000);
    expect(n).toBeLessThanOrEqual(6000);
  });
  it('R31 loadTestTwisty returns the figure-built sections', () => {
    expect(loadTestTwisty().sections).toEqual(sections());
  });
});

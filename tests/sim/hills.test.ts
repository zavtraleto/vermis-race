import { describe, expect, it } from 'vitest';
import { baseCarA as baseCar } from './baseCarA';
import { parseSections, resolveSections } from '../../src/data/tracks';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { InputFrame, Segment, Track, TrackDef, TrackSection } from '../../src/sim/types';

// Types for hill/y are not in src yet: local casts.
type HillSection = TrackSection & { hill?: number };
const sec = (
  enter: number,
  hold: number,
  leave: number,
  curve: number,
  hill?: number,
): TrackSection =>
  (hill === undefined
    ? { enter, hold, leave, curve }
    : { enter, hold, leave, curve, hill }) as HillSection;
const ys = (t: Track): number[] => t.segments.map((s) => (s as Segment & { y: number }).y);
const ease = (p: number): number => 0.5 - Math.cos(Math.PI * p) / 2;

describe('R30 buildTrack heights', () => {
  it('no hill means y = 0 on every segment (a real number, not undefined)', () => {
    const t = buildTrack({ sections: [sec(3, 2, 3, 2), sec(2, 2, 2, -1)] });
    expect(ys(t)).toEqual(new Array<number>(t.segments.length).fill(0));
  });

  it('matches hand-computed easeInOut over the whole section (2/2/2 hill +3, then 1/2/1 hill -3)', () => {
    // Section A, L = 6, end of segment i: 3 * ease((i+1)/6), ease(p) = 0.5 - cos(pi p)/2
    //   i=0: p=1/6, cos = 0.8660254 -> 0.0669873*3 = 0.2009619
    //   i=1: p=1/3, cos = 0.5       -> 0.25*3 = 0.75
    //   i=2: p=1/2                  -> 1.5
    //   i=3: p=2/3                  -> 0.75*3 = 2.25
    //   i=4: p=5/6                  -> 0.9330127*3 = 2.7990381
    //   i=5: p=1                    -> 3
    // Section B starts at 3, L = 4, end of segment: 3 - 3*ease((i+1)/4)
    //   p=.25: ease = 0.5 - 0.7071068/2 = 0.1464466 -> 3 - 0.4393398 = 2.5606602
    //   p=.5: 1.5;  p=.75: 0.4393398;  p=1: 0
    const t = buildTrack({ sections: [sec(2, 2, 2, 0, 3), sec(1, 2, 1, 0, -3)] });
    const exp = [0.2009619, 0.75, 1.5, 2.25, 2.7990381, 3, 2.5606602, 1.5, 0.4393398, 0];
    const got = ys(t);
    expect(got.length).toBe(10);
    exp.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 6));
  });

  it('profile uses one easeInOut over enter+hold+leave, independent of the phase split', () => {
    const a = ys(buildTrack({ sections: [sec(0, 10, 0, 1, 5), sec(0, 10, 0, 1, -5)] }));
    const b = ys(buildTrack({ sections: [sec(7, 1, 2, 1, 5), sec(3, 3, 4, 1, -5)] }));
    expect(b.length).toBe(20);
    b.forEach((v, i) => expect(v).toBeCloseTo(a[i]!, 9));
    for (let i = 0; i < 10; i++) expect(a[i]).toBeCloseTo(5 * ease((i + 1) / 10), 9);
  });

  it('a hill section is monotone from its start height to start + hill, and ends exactly there', () => {
    const t = buildTrack({ sections: [sec(5, 5, 5, 0, 4), sec(5, 5, 5, 0, -4)] });
    const y = ys(t);
    for (let i = 1; i < 15; i++) expect(y[i]!).toBeGreaterThanOrEqual(y[i - 1]!);
    for (let i = 16; i < 30; i++) expect(y[i]!).toBeLessThanOrEqual(y[i - 1]!);
    expect(y[14]).toBeCloseTo(4, 9);
    expect(y[29]).toBeCloseTo(0, 9);
  });

  it('heights do not change curves', () => {
    const flat = buildTrack({ sections: [sec(4, 4, 4, 2.5), sec(3, 3, 3, -1)] });
    const hilly = buildTrack({ sections: [sec(4, 4, 4, 2.5, 6), sec(3, 3, 3, -1, -6)] });
    expect(hilly.segments.map((s) => s.curve)).toEqual(flat.segments.map((s) => s.curve));
  });

  it('throws when the loop does not return to height 0', () => {
    expect(() => buildTrack({ sections: [sec(2, 2, 2, 0, 3)] })).toThrow();
    expect(() => buildTrack({ sections: [sec(2, 2, 2, 0, 3), sec(2, 2, 2, 0, -2)] })).toThrow();
  });

  it('does not throw when hills sum to zero (also a tiny float residue)', () => {
    expect(() => buildTrack({ sections: [sec(2, 2, 2, 0, 3), sec(2, 2, 2, 0, -3)] })).not.toThrow();
    expect(() =>
      buildTrack({ sections: [sec(2, 2, 2, 0, 0.1 + 0.2), sec(2, 2, 2, 0, -0.3)] }),
    ).not.toThrow();
  });

  it('a track without any hill never throws (backward compatible)', () => {
    expect(() => buildTrack({ sections: [sec(2, 2, 2, 1)] })).not.toThrow();
  });
});

describe('R30 track data hill field', () => {
  const ok = { enter: 1, hold: 2, leave: 3, curveClass: 'easy', side: 1 };
  it('parseSections keeps a numeric hill and rejects a non-number', () => {
    const parsed = parseSections([{ ...ok, hill: 12 }]);
    expect((parsed[0] as unknown as { hill?: number }).hill).toBe(12);
    expect(() => parseSections([{ ...ok, hill: 'high' }])).toThrow();
  });
  it('resolveSections copies hill into the TrackDef; absent hill stays absent or 0', () => {
    const secs = parseSections([{ ...ok, hill: -7 }, ok]);
    const def = resolveSections(secs, { easy: 1, medium: 2, hard: 3 });
    expect((def.sections[0] as HillSection).hill).toBe(-7);
    expect((def.sections[1] as HillSection).hill ?? 0).toBe(0);
  });
});

describe('R30 hills are visual only: sim state unchanged', () => {
  it('same car state on a hilly track and on the same track with hills 0 (600 ticks, steer + drift)', () => {
    const base: TrackSection[] = [
      { enter: 20, hold: 40, leave: 20, curve: 2 },
      { enter: 20, hold: 40, leave: 20, curve: -3 },
      { enter: 20, hold: 40, leave: 20, curve: 0 },
    ];
    const hills = [8, -3, -5];
    const flat: TrackDef = { sections: base };
    const hilly: TrackDef = {
      sections: base.map((s, i) => ({ ...s, hill: hills[i] }) as HillSection),
    };
    const a = createRace(7, 1);
    const b = createRace(7, 1);
    const tf = buildTrack(flat);
    const th = buildTrack(hilly);
    const input = (tick: number): InputFrame => ({
      steer: tick < 300 ? 0.8 : -0.6,
      brake: tick > 500,
      drift: tick > 150,
    });
    for (let i = 0; i < 600; i++) {
      step(a, [input(a.tick)], tf, [baseCar]);
      step(b, [input(b.tick)], th, [baseCar]);
    }
    expect(b).toEqual(a);
    expect(a.cars[0]!.z).toBeGreaterThan(0);
  });
});

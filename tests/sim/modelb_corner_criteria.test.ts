import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import driftRun from '../../src/data/tracks/drift-run.json';
import twisty from '../../src/data/tracks/test-twisty.json';
import {
  curveClasses,
  expandFigures,
  figureDict,
  parseSections,
  resolveSections,
  trackSections,
} from '../../src/data/tracks';
import { DT } from '../../src/sim/constants';
import { buildTrack } from '../../src/sim/track';
import type { CarParams, Track } from '../../src/sim/types';
import { Lcg, Rig, T71 } from './corner_helpers';
import { NO_T77 } from './pinT77';

// Spec: docs/brief.md R81f "Критерии" (a)-(e), R83c criterion, R86f criterion, named before the
// implementation and measured by tools/spike/corner-drift.ts (real step + variant 5 wrapper,
// cornerSpan 0.5). Here the same runs go through the real step on variant 5.
// Car: the real base car with every T71 number spread in explicitly (docs/balance.md T71), driftTurbo 0,
// lamps on where the brief runs real tracks, `free` (no walls, no off-road loss, no lamps) elsewhere.
// Geometry by hand (buildTrack: enter curve = c*(n/enter)^2, leave curve = c*(0.5 + cos(pi*n/leave)/2)):
//   first corner segment of a 30-segment enter (|curve| >= 0.5): (n/30)^2 >= 0.5/c
//     easy 2: n >= 15; medium 4.5: n >= 10; hard 7: n >= 8.02 -> 9; sharp 8.3: n >= 7.36 -> 8
//   last corner segment of a 30-segment leave: 0.5 + cos(pi*n/30)/2 >= 0.5/c
//     easy: n <= 20; medium: n <= 23; hard: n <= 24; sharp: n <= 25
//   The first curved segment (n = 1 of the enter) is the corner start `a`; the end of the leave is a + 59.

// T77: H20 (R85f) off: variant 5 was measured without the release memory (R84c does not act in variant 5).
const P = { ...baseCar, ...T71, driftTurbo: 0, model: 1, ...NO_T77 } as CarParams;
const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  crashMinSpeed: 1e9,
});
const FP = free(P);
const C = curveClasses as Record<string, number>;
const CLS = ['easy', 'medium', 'hard', 'sharp'] as const;

const cache = new Map<string, Track>();
/** Straight `pre`, one section (enter/hold/leave, curve), straight 8000 (as the spike). */
function cornerTrack(
  curve: number,
  pre: number,
  enter: number,
  hold: number,
  leave: number,
): Track {
  const key = `${curve}/${pre}/${enter}/${hold}/${leave}`;
  let t = cache.get(key);
  if (!t) {
    t = buildTrack({
      sections: [
        { enter: 0, hold: pre, leave: 0, curve: 0 },
        { enter, hold, leave, curve },
        { enter: 0, hold: 8000, leave: 0, curve: 0 },
      ],
    });
    cache.set(key, t);
  }
  return t;
}
function figureTrack(name: string, side: 1 | -1): Track {
  const key = `fig/${name}/${side}`;
  let t = cache.get(key);
  if (!t) {
    const def = resolveSections(
      parseSections(expandFigures([{ figure: name, side }], figureDict)),
      curveClasses,
    );
    t = buildTrack({
      sections: [
        { enter: 0, hold: 240, leave: 0, curve: 0 },
        ...def.sections,
        { enter: 0, hold: 2000, leave: 0, curve: 0 },
      ],
    });
    cache.set(key, t);
  }
  return t;
}
/** First and last segment with curve != 0. */
function span(t: Track): [number, number] {
  let a = -1;
  let b = -1;
  t.segments.forEach((s, i) => {
    if (s.curve !== 0) {
      if (a < 0) a = i;
      b = i;
    }
  });
  return [a, b];
}
/** The spike's GRIP line keeper (feed-forward hold steer + PD to x = 0): used only while in GRIP. */
function gripCtl(r: Rig, t: Track): number {
  const c = r.car;
  const p = r.p;
  const sp = c.speed / p.vmax;
  const n = t.segments.length;
  const g = t.segments[((Math.floor(c.z) % n) + n) % n];
  const A = (g ? g.curve : NaN) * sp * p.kYaw;
  const f = Math.min(1, sp / p.yawFullSpeed);
  const ff = (A * (1 + p.yawAlign / p.velGrip)) / (p.yawRateMax * f);
  return Math.max(-1, Math.min(1, ff + 1.5 * (0 - c.x) - 0.4 * c.vx));
}
const SHAPE = [30, 240, 30] as const;

interface CornerOut {
  t: number;
  vIn: number;
  vMin: number;
  vOut: number;
  xMin: number;
  xMax: number;
  changes: number;
}
/** The spike's runCorner: start 0.3 s before the corner at sp0, autogas, timing from a to b + 1. */
function runCorner(
  t: Track,
  sp0: number,
  steer: (r: Rig) => number,
  held: boolean,
  p = FP,
): CornerOut {
  const [a, b] = span(t);
  const r = new Rig(p, sp0, a - 0.3 * 60 * sp0, 0);
  let t0 = NaN;
  let t1 = NaN;
  const o: CornerOut = {
    t: NaN,
    vIn: NaN,
    vMin: Infinity,
    vOut: NaN,
    xMin: Infinity,
    xMax: -Infinity,
    changes: 0,
  };
  for (let i = 0; i < 30 / DT && Number.isNaN(t1); i++) {
    const z0 = r.car.z;
    r.tick(t, steer(r), held);
    const z = r.car.z;
    const sp = r.car.speed / p.vmax;
    if (z0 < a && z >= a) {
      t0 = i * DT;
      o.vIn = sp;
    }
    if (!Number.isNaN(t0)) {
      o.vMin = Math.min(o.vMin, sp);
      o.xMin = Math.min(o.xMin, r.car.x);
      o.xMax = Math.max(o.xMax, r.car.x);
    }
    if (z0 < b + 1 && z >= b + 1) {
      t1 = i * DT;
      o.vOut = sp;
    }
  }
  o.t = t1 - t0;
  o.changes = r.changes.length;
  return o;
}

// ------------------------------------------------------------------------------------------------
describe('R81f criterion (a): straights never drift on drift-run and test-twisty, finger always down', () => {
  const tracks: ReadonlyArray<readonly [string, Track]> = [
    ['drift-run', buildTrack(resolveSections(trackSections(driftRun as never), curveClasses))],
    ['test-twisty', buildTrack(resolveSections(trackSections(twisty as never), curveClasses))],
  ];
  /** Segments that have a corner segment (|curve| >= 0.5) at most cornerGap 30 behind (current included). */
  const nearOf = (t: Track): Uint8Array => {
    const s = t.segments;
    const n = s.length;
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++)
      for (let k = 0; k <= 30; k++)
        if (Math.abs(s[(i - k + n) % n]!.curve) >= 0.5) {
          near[i] = 1;
          break;
        }
    return near;
  };
  type Drv = (r: Rig, t: Track, rng: Lcg, st: { v: number; until: number; tt: number }) => number;
  const random: Drv = (r, t, rng, st) => {
    if (st.tt >= st.until) {
      st.v = rng.next() * 2 - 1;
      st.until = st.tt + 0.05 + rng.next();
    }
    return r.car.state === 'DRIFT' ? st.v : Math.max(-1, Math.min(1, gripCtl(r, t) + 0.5 * st.v));
  };
  const drivers: ReadonlyArray<readonly [string, Drv, number, number]> = [
    // name, driver, seconds, seeds
    ['random steer (spike part d)', random, 120, 5],
    ['full lock +1', () => 1, 40, 1],
    ['full lock -1', () => -1, 40, 1],
    ['weave ±1, 0.3 s', (_r, _t, _g, st) => (Math.floor(st.tt / 0.3 + 1e-9) % 2 ? 1 : -1), 40, 1],
    ['steer 0', () => 0, 40, 1],
    ['line keeper', (r, t) => gripCtl(r, t), 60, 1],
  ];
  for (const [tn, track] of tracks) {
    const near = nearOf(track);
    const segs = track.segments;
    for (const [dn, drv, secs, seeds] of drivers) {
      it(`${tn}, ${dn}, ${secs} s x ${seeds}: 0 DRIFT ticks off the corners, every entry on a corner segment of its side`, () => {
        let drifted = 0;
        for (let seed = 1; seed <= seeds; seed++) {
          const r = new Rig(P, 0.5, 0, 0); // real lamps and walls (crashMinSpeed from base)
          const rng = new Lcg(seed * 7919);
          const st = { v: 0, until: 0, tt: 0 };
          let bad = 0;
          for (let i = 0; i < secs / DT; i++) {
            st.tt = i * DT;
            if (!(Number.isFinite(r.car.z) && r.car.z >= 0))
              expect(r.car.z).toBeGreaterThanOrEqual(0);
            r.tick(track, drv(r, track, rng, st), true);
            if (r.car.state === 'DRIFT') {
              drifted++;
              if (!near[r.lastSeg]) bad++;
            }
          }
          expect(bad).toBe(0);
          for (const ch of r.changes)
            if (ch.to === 'DRIFT') {
              const cv = segs[ch.seg]?.curve ?? NaN;
              expect(Math.abs(cv)).toBeGreaterThanOrEqual(0.5);
              expect(Math.sign(cv)).toBe(ch.dir);
            }
        }
        if (dn.startsWith('random') || dn === 'line keeper') expect(drifted).toBeGreaterThan(0);
      });
    }
  }
});

// ------------------------------------------------------------------------------------------------
describe('R81f criterion (b): entry and exit by the road, the same segment at any speed', () => {
  const ENTRY_N: Record<string, number> = { easy: 15, medium: 10, hard: 9, sharp: 8 };
  const LAST_N: Record<string, number> = { easy: 20, medium: 23, hard: 24, sharp: 25 };
  const MS_IN: Record<string, number> = { easy: 250, medium: 167, hard: 150, sharp: 133 };
  const MS_OUT: Record<string, number> = { easy: 142, medium: 92, hard: 75, sharp: 58 };
  for (const cls of CLS) {
    for (const side of [1, -1] as const) {
      it(`${cls} 30/240/30 side ${side}, steer 0, finger down: exactly 2 changes; entry on enter n = ${ENTRY_N[cls]}, exit on leave n = ${LAST_N[cls]! + 1} (sp 0.6, 0.8, 1.0)`, () => {
        const t = cornerTrack(side * C[cls]!, 300, ...SHAPE);
        const enterStart = 300;
        const leaveStart = 300 + 30 + 240;
        for (const sp0 of [0.6, 0.8, 1.0]) {
          const r = new Rig(FP, sp0, enterStart - 60, 0);
          for (let i = 0; i < 12 / DT && r.car.z < leaveStart + 200; i++) r.tick(t, 0, true);
          expect(r.changes.map((c) => [c.to, c.seg, c.dir])).toEqual([
            ['DRIFT', enterStart + ENTRY_N[cls]!, side],
            ['GRIP', leaveStart + LAST_N[cls]! + 1, 0],
          ]);
        }
      });
    }
    it(`${cls} at vmax: entry ${MS_IN[cls]} ms after the first curved segment, exit ${MS_OUT[cls]} ms before the end of the leave (one tick)`, () => {
      const t = cornerTrack(C[cls]!, 300, ...SHAPE);
      const [a, b] = span(t);
      const r = new Rig(FP, 1, a - 60, 0);
      const zs: number[] = [];
      for (let i = 0; i < 12 / DT && r.car.z < b + 200; i++) {
        r.tick(t, 0, true);
        zs.push(r.car.z);
      }
      const tAt = (z: number): number => zs.findIndex((v) => v >= z) + 1;
      const e = r.changes.find((c) => c.to === 'DRIFT');
      const x = r.changes.find((c) => c.to === 'GRIP');
      expect(e).toBeDefined();
      expect(x).toBeDefined();
      expect(Math.abs((e!.tick - tAt(a)) * DT * 1000 - MS_IN[cls]!)).toBeLessThanOrEqual(DT * 1000);
      expect(Math.abs((tAt(b + 1) - x!.tick) * DT * 1000 - MS_OUT[cls]!)).toBeLessThanOrEqual(
        DT * 1000,
      );
    });
  }
});

// ------------------------------------------------------------------------------------------------
describe('R81f criterion (c): no flicker, one entry and one exit per same-side corner run', () => {
  const runs = (name: string): number => {
    if (['flick', 'chicane', 'scurve', 'switchback'].includes(name)) return 2;
    if (name === 'esses') return 4;
    return 1;
  };
  const names = Object.keys(figureDict).filter((n) => n !== 'straight');
  it('all figures of figures.json + figures-sharp.json except straight: 14', () => {
    expect(names.length).toBe(14);
  });
  for (const name of names) {
    for (const side of [1, -1] as const) {
      it(`${name} side ${side}, sp 0.7 and 1.0, steer 0 and the GRIP line keeper: exactly ${2 * runs(name)} changes, |x| <= 0.15`, () => {
        const t = figureTrack(name, side);
        for (const sp0 of [0.7, 1.0]) {
          for (const mode of ['zero', 'ctl'] as const) {
            const o = runCorner(
              t,
              sp0,
              (r) => (mode === 'zero' || r.car.state === 'DRIFT' ? 0 : gripCtl(r, t)),
              true,
            );
            expect(o.changes).toBe(2 * runs(name));
            expect(Math.max(-o.xMin, o.xMax)).toBeLessThanOrEqual(0.15);
          }
        }
      });
    }
  }
  // S-bends through a short GRIP: the GRIP stretch is exactly the segments with |curve| < 0.5 at the sign change.
  // chicane: sharp leave 15 -> n 13, 14 below (2) + sharp enter 15 -> n 0..3 below (4) = 6
  // scurve: hard leave 15 -> cos(pi*n/15) < 1/7 - 1 -> n >= 13 (2) + hard enter 15 -> n < 4.01 -> 0..4 (5) = 7
  // flick: hard leave 20 -> n >= 17 (3) + hard enter 20 -> n < 5.35 -> 0..5 (6) = 9
  // esses: medium leave 22 -> n >= 18 (4) + medium enter 26 -> n < 8.67 -> 0..8 (9) = 13 (three times)
  const GAP: Record<string, number> = { chicane: 6, scurve: 7, flick: 9, esses: 13 };
  for (const [name, gap] of Object.entries(GAP)) {
    it(`${name}: every flip goes through GRIP on exactly the ${gap} low-curve segments, nowhere else`, () => {
      const t = figureTrack(name, 1);
      for (const sp0 of [0.7, 1.0]) {
        const [a] = span(t);
        const r = new Rig(FP, sp0, a - 60, 0);
        const gripSegs: number[][] = [];
        let cur: number[] | null = null;
        let entered = false;
        const [, b] = span(t);
        for (let i = 0; i < 30 / DT && r.car.z < b + 10; i++) {
          r.tick(t, 0, true);
          const s = r.lastSeg;
          if (r.car.state === 'DRIFT') {
            entered = true;
            if (cur) {
              gripSegs.push(cur);
              cur = null;
            }
          } else if (entered && s < b) {
            if (!cur) cur = [];
            if (!cur.includes(s)) cur.push(s);
          }
        }
        expect(gripSegs.length).toBe(name === 'esses' ? 3 : 1);
        for (const g of gripSegs) {
          expect(g.length).toBe(gap);
          for (const s of g) expect(Math.abs(t.segments[s]!.curve)).toBeLessThan(0.5);
        }
      }
    });
  }
  it('double (gap 17 < cornerGap 30) never goes through GRIP between its two parts', () => {
    const t = figureTrack('double', 1);
    const o = runCorner(t, 1, () => 0, true);
    expect(o.changes).toBe(2);
  });
});

// ------------------------------------------------------------------------------------------------
describe('R81f criterion (d) / R83c: steer 0 keeps the lane', () => {
  // brief: x in the corner easy 0...0.03, medium 0...0.07, hard 0...0.11, sharp -0.06...0.13; bound |x| <= 0.15
  const X: Record<string, [number, number]> = {
    easy: [0, 0.03],
    medium: [0, 0.07],
    hard: [0, 0.11],
    sharp: [-0.06, 0.13],
  };
  for (const cls of CLS) {
    for (const side of [1, -1] as const) {
      it(`${cls} side ${side}, 30/240/30 from x 0 at 0.6 / 0.8 / 1.0 vmax: x within the measured range (±0.02) and |x| <= 0.15`, () => {
        const t = cornerTrack(side * C[cls]!, 300, ...SHAPE);
        for (const sp0 of [0.6, 0.8, 1.0]) {
          const o = runCorner(t, sp0, (r) => (r.car.state === 'DRIFT' ? 0 : gripCtl(r, t)), true);
          const lo = side > 0 ? o.xMin : -o.xMax;
          const hi = side > 0 ? o.xMax : -o.xMin;
          expect(lo).toBeGreaterThanOrEqual(X[cls]![0] - 0.02);
          expect(hi).toBeLessThanOrEqual(X[cls]![1] + 0.02);
          expect(Math.max(Math.abs(lo), Math.abs(hi))).toBeLessThanOrEqual(0.15);
        }
      });
    }
  }
});

describe('R83c criterion: line authority in a steady drift at vmax (steer 0 for 2 s, then ±1)', () => {
  const LANE = 0.25;
  // [inward s or NaN (not reached in 4 s), outward s] from the brief (spike, cornerSpan 0.5)
  const T: Record<string, [number, number]> = {
    easy: [0.79, 3.34],
    medium: [0.95, 0.88],
    hard: [NaN, 0.79],
    sharp: [NaN, 0.74],
  };
  for (const cls of CLS) {
    it(`${cls}: one lane inward ${Number.isNaN(T[cls]![0]) ? 'not reached in 4 s' : `in ${T[cls]![0]} s`}, outward in ${T[cls]![1]} s (±0.03 s); back to steer 0 stops within 0.45 s`, () => {
      const t = cornerTrack(C[cls]!, 300, 30, 900, 30);
      const [a] = span(t);
      for (const [k, s] of [
        [0, 1],
        [1, -1],
      ] as const) {
        const r = new Rig(FP, 1, a - 18, 0);
        for (let i = 0; i < 2 / DT; i++) r.tick(t, 0, true);
        expect(r.car.state).toBe('DRIFT');
        const x0 = r.car.x;
        let tl = NaN;
        for (let i = 1; i <= 4 / DT && Number.isNaN(tl); i++) {
          r.tick(t, s, true);
          if (Math.abs(r.car.x - x0) >= LANE) tl = i * DT;
        }
        const want = T[cls]![k];
        if (Number.isNaN(want)) expect(Number.isNaN(tl)).toBe(true);
        else expect(Math.abs(tl - want)).toBeLessThanOrEqual(0.03);
        let last = -1;
        for (let i = 0; i < 1.5 / DT; i++) {
          r.tick(t, 0, true);
          if (Math.abs(r.car.vx) > 0.02) last = i;
        }
        expect((last + 1) * DT).toBeLessThanOrEqual(0.45);
        expect(r.car.state).toBe('DRIFT');
      }
    });
  }
});

// ------------------------------------------------------------------------------------------------
describe('R81f criterion (e): release and re-touch in a steady drift at vmax, steer 0', () => {
  // brief: outward in 0.1 s 0.09 / 0.14 / 0.17, in 0.3 s 0.29 / 0.43 / 0.49, in 0.6 s 0.60 / 0.83 / 0.90
  // (medium / hard / sharp); re-touch -> DRIFT after one tick for any pause 0.05-0.6 s; speed at the end
  // of a 0.3 s pause 0.999 / 0.943 / 0.901 vmax, 1 s after the re-touch 1.00.
  const OUT: Record<string, Record<string, number>> = {
    medium: { '0.1': 0.09, '0.3': 0.29, '0.6': 0.6 },
    hard: { '0.1': 0.14, '0.3': 0.43, '0.6': 0.83 },
    sharp: { '0.1': 0.17, '0.3': 0.49, '0.6': 0.9 },
  };
  const V03: Record<string, number> = { medium: 0.999, hard: 0.943, sharp: 0.901 };
  for (const cls of ['medium', 'hard', 'sharp'] as const) {
    it(`${cls}: GRIP at once on release, outward as measured (±0.015), DRIFT one tick after the touch, speed as measured`, () => {
      const t = cornerTrack(C[cls]!, 300, 30, 900, 30);
      const [a] = span(t);
      for (const T of [0.05, 0.1, 0.3, 0.6]) {
        const r = new Rig(FP, 1, a - 60, 0);
        for (let i = 0; i < 2.5 / DT; i++) r.tick(t, 0, true);
        expect(r.car.state).toBe('DRIFT');
        const x0 = r.car.x;
        for (let i = 0; i < Math.round(T / DT); i++) {
          r.tick(t, 0, false);
          expect(r.car.state).toBe('GRIP');
        }
        const want = OUT[cls]![String(T)];
        if (want !== undefined) expect(Math.abs(x0 - r.car.x - want)).toBeLessThanOrEqual(0.015);
        if (T === 0.3)
          expect(Math.abs(r.car.speed / P.vmax - V03[cls]!)).toBeLessThanOrEqual(0.003);
        r.tick(t, 0, true);
        expect(r.car.state).toBe('DRIFT');
        expect(r.car.dir).toBe(1);
        for (let i = 0; i < 1 / DT; i++) r.tick(t, 0, true);
        expect(r.car.speed / P.vmax).toBeGreaterThanOrEqual(0.998);
      }
    });
  }
});

// ------------------------------------------------------------------------------------------------
describe('R86f criterion: in DRIFT the lowest speed in the corner is the entry speed', () => {
  // brief: all classes at 0.6 / 0.8 / 1.0 vmax, 30/240/30, steer 0, autogas: min = entry speed, 1.00 at the
  // end; time against GRIP with the ideal driver: easy 0.0%, medium 0.0...-0.3%, hard -17...-19%, sharp -28...-29%
  const DT_GRIP: Record<string, [number, number]> = {
    easy: [-0.1, 0.1],
    medium: [-0.4, 0.1],
    hard: [-19.5, -16.7],
    sharp: [-29.5, -27.6],
  };
  for (const cls of CLS) {
    it(`${cls}: min speed >= entry speed (-0.001), 1.00 at the end; time vs GRIP within ${DT_GRIP[cls]!.join('...')}%`, () => {
      const t = cornerTrack(C[cls]!, 300, ...SHAPE);
      for (const sp0 of [0.6, 0.8, 1.0]) {
        const v = runCorner(t, sp0, (r) => (r.car.state === 'DRIFT' ? 0 : gripCtl(r, t)), true);
        expect(v.vMin).toBeGreaterThanOrEqual(v.vIn - 0.001);
        expect(v.vOut).toBeGreaterThanOrEqual(0.995);
        const g = runCorner(t, sp0, (r) => gripCtl(r, t), false);
        const d = (100 * (v.t - g.t)) / g.t;
        expect(d).toBeGreaterThanOrEqual(DT_GRIP[cls]![0]);
        expect(d).toBeLessThanOrEqual(DT_GRIP[cls]![1]);
      }
    });
  }
});

// Model C data (docs/brief.md R150-R162, H14 = C; written before the data lands - these fail until
// the implementer adds the numbers). Start numbers: tests/sim/modelc_helpers.ts MC_START (brief).
import { describe, expect, it } from 'vitest';
import bots from '../../src/data/bots.json';
import base from '../../src/data/cars/base.json';
import { baseCar } from '../../src/data/cars';
import hypotheses from '../../src/data/hypotheses.json';
import input from '../../src/data/input.json';
import sprites from '../../src/data/sprites.json';
import {
  curveClasses,
  loadTrackByName,
  resolveSections,
  trackSections,
} from '../../src/data/tracks';
import tunables from '../../src/data/tunables.json';
import { buildTrack } from '../../src/sim/track';
import { MC_START } from './modelc_helpers';

const B = base as unknown as Record<string, number>;
const T = tunables as unknown as {
  numbers: Record<string, { min: number; max: number; step: number }>;
  flags: Record<string, string[]>;
  meta: Record<
    string,
    { rule?: string; group?: string; tier?: string; model?: string; options?: string[] }
  >;
};

describe('R150 / H14 = C is the default', () => {
  it('hypotheses.json H14_model = "C"', () => {
    expect((hypotheses as Record<string, string>).H14_model).toBe('C');
  });
  it('cars/base.json model 2; the app car (baseCar) and the rivals copy of it are model 2', () => {
    expect(B.model).toBe(2);
    expect(baseCar.model).toBe(2);
  });
  it('the dev panel offers C: car.model range 0..2 step 1, H14 options A, B, C', () => {
    expect(T.numbers['car.model']).toEqual({ min: 0, max: 2, step: 1 });
    expect(T.flags['hypotheses.H14_model']).toEqual(['A', 'B', 'C']);
    expect(T.meta['car.model']?.options).toEqual(['A', 'B', 'C']);
  });
});

describe('R153-R159 model C numbers in cars/base.json', () => {
  for (const [k, v] of Object.entries(MC_START))
    it(`${k} = ${v}`, () => {
      expect(B[k]).toBe(v);
    });
  it('slipDeg reaches the sim car (R156/R158 use R89 slipDeg 17 of sprites.json)', () => {
    expect((baseCar as { slipDeg?: number }).slipDeg).toBe(
      (sprites as { weight: { slipDeg: number } }).weight.slipDeg,
    );
  });
});

describe('R151 / R155 touch numbers in input.json', () => {
  const t = (input as { touch: Record<string, number> }).touch;
  for (const [k, v] of Object.entries({
    thrDead: 0.5,
    thrFull: 1.3,
    thrExp: 1.4,
    edgeMargin: 8,
    thrTauMs: 25,
    driftSteerMul: 1.5, // [решение директора 2026-11-22]: hold 0.5 at 43.2 px
  }))
    it(`touch.${k} = ${v}`, () => {
      expect(t[k]).toBe(v);
    });
});

describe('R160 bodyMul in sprites.json', () => {
  it('weight.bodyMul = 1', () => {
    expect((sprites as { weight: Record<string, number> }).weight.bodyMul).toBe(1);
  });
});

describe('R162 driver levels in bots.json', () => {
  const L = bots as unknown as Record<string, Record<string, unknown>>;
  it('expert: cLead 0.15, cErr 0, cUseThr true, cKx 0.15, cRelease false', () => {
    expect(L.expert).toMatchObject({
      cLead: 0.15,
      cErr: 0,
      cUseThr: true,
      cKx: 0.15,
      cRelease: false,
    });
  });
  it('average: cLead -0.15, cErr 0.3, cErrPeriod 1.6, cUseThr false, cKx 0, cRelease true', () => {
    expect(L.average).toMatchObject({
      cLead: -0.15,
      cErr: 0.3,
      cErrPeriod: 1.6,
      cUseThr: false,
      cKx: 0,
      cRelease: true,
    });
  });
  it('novice: no drift (drift "never"); expert / average driftMinCurve 4', () => {
    expect(L.novice!.drift).toBe('never');
    expect(L.expert!.driftMinCurve).toBe(4);
    expect(L.average!.driftMinCurve).toBe(4);
  });
});

describe('R150-R160 sliders in tunables.json', () => {
  // Core for model C (decision of the test-writer for the director, P13 limit 14 with the 6 unscoped
  // core items): the [вкус автора] numbers that change the feel most - degrees, spin limit, sharpness,
  // the price of a miss and of the full steer (decision 4), gas width, entry window, drift steer travel.
  const CORE_C = [
    'car.betaPerA',
    'car.betaMax',
    'car.betaTau',
    'car.missLoss',
    'car.missCap',
    'car.thrLat',
    'car.driftWindow',
    'input.touch.driftSteerMul',
  ];
  const paths = [
    ...Object.keys(MC_START).map((k) => `car.${k}`),
    ...['thrDead', 'thrFull', 'thrExp', 'edgeMargin', 'thrTauMs', 'driftSteerMul'].map(
      (k) => `input.touch.${k}`,
    ),
    'sprites.weight.bodyMul',
  ];
  for (const p of paths)
    it(`${p}: a range and meta with model "C" and a rule id R15x/R16x`, () => {
      expect(T.numbers[p]).toBeDefined();
      const m = T.meta[p];
      expect(m).toBeDefined();
      expect(m!.model).toBe('C');
      expect(m!.rule).toMatch(/^R1(5\d|6[0-4])/);
    });
  it('core items of model C are exactly CORE_C; the rest are "more"', () => {
    for (const p of paths) expect(T.meta[p]?.tier).toBe(CORE_C.includes(p) ? 'core' : 'more');
  });
  it('P13 for model C: 6..14 core items (C-scoped + unscoped), at most 8 per group', () => {
    const core = Object.keys(T.meta).filter((p) => {
      const x = T.meta[p]!;
      return x.tier === 'core' && (!x.model || x.model === 'C');
    });
    expect(core.length).toBeGreaterThanOrEqual(6);
    expect(core.length).toBeLessThanOrEqual(14);
    const per = new Map<string, number>();
    for (const p of core)
      per.set(T.meta[p]!.group ?? '', (per.get(T.meta[p]!.group ?? '') ?? 0) + 1);
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(8);
  });
});

describe('drift-lab track (docs/research/model-c.md section 4)', () => {
  const FIG = [
    'straight',
    'straight',
    'sweeper',
    'straight',
    'hairpin',
    'straight',
    'kink',
    'straight',
    'esses',
    'straight',
    'scurve',
    'straight',
    'hook',
    'straight',
    'chicane',
    'straight',
    'straight',
  ];
  const SIDE_LEFT = [4, 10, 14];
  it('loadTrackByName("drift-lab") loads it (not the default track)', () => {
    expect(loadTrackByName('drift-lab').name).toBe('drift-lab');
  });
  it('same sections as the research JSON; 2554 segments; no hills', () => {
    const want = {
      name: 'drift-lab',
      figures: FIG.map((figure, i) => ({ figure, side: SIDE_LEFT.includes(i) ? -1 : 1 })),
    };
    const got = loadTrackByName('drift-lab');
    expect(got.sections).toEqual(trackSections(want));
    const tr = buildTrack(resolveSections(trackSections(want), curveClasses));
    expect(tr.segments.length).toBe(2554);
    expect(buildTrack(got.def).segments.every((s) => (s.y ?? 0) === 0)).toBe(true);
  });
});

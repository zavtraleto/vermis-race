import { describe, expect, it } from 'vitest';
import { driftEntryOf } from '../../src/app/driftEntryProbe';
import base from '../../src/data/cars/base.json';
import hypotheses from '../../src/data/hypotheses.json';
import rivalsJson from '../../src/data/rivals.json';
import tunables from '../../src/data/tunables.json';
import { createRace } from '../../src/sim/race';
import type { RaceState } from '../../src/sim/types';

// Spec: docs/brief.md R81f "Параметры машины", R83c, R86f, R86e (withdrawn), R85c / R89c (gripDodge),
// H16 table row; numbers from docs/balance.md T71.
const B = base as unknown as Record<string, number>;

describe('T71 data: H16 = F, driftEntry 5 for player, rivals and bots', () => {
  it('hypotheses.json H16_driftEntry is "F"', () => {
    expect((hypotheses as Record<string, string>).H16_driftEntry).toBe('F');
  });
  it('driftEntryOf maps F -> 5; E, D, C, B, A stay 4, 3, 2, 1, 0', () => {
    expect(driftEntryOf('F')).toBe(5);
    expect(driftEntryOf('E')).toBe(4);
    expect(driftEntryOf('D')).toBe(3);
    expect(driftEntryOf('C')).toBe(2);
    expect(driftEntryOf('B')).toBe(1);
    expect(driftEntryOf('A')).toBe(0);
  });
  it('cars/base.json driftEntry 5; rivals.json rivalDriftEntry 5', () => {
    expect(B.driftEntry).toBe(5);
    expect((rivalsJson as Record<string, unknown>).rivalDriftEntry).toBe(5);
  });
  it('dev panel: H16 offers F (every hypothesis is a runtime flag)', () => {
    const flags = (tunables as { flags: Record<string, string[]> }).flags;
    expect(flags['hypotheses.H16_driftEntry']).toContain('F');
  });
});

describe('T71 data: R81f / R83c parameters in cars/base.json', () => {
  it('cornerCurve 0.5, cornerGap 30 segments', () => {
    expect(B.cornerCurve).toBe(0.5);
    expect(B.cornerGap).toBe(30);
  });
  it('cornerSpan 0.5, cornerMinU 0.1', () => {
    expect(B.cornerSpan).toBe(0.5);
    expect(B.cornerMinU).toBe(0.1);
  });
  it('cornerGap: larger than the largest same-side gap on the tracks (17, double), smaller than straight (60)', () => {
    expect(B.cornerGap).toBeGreaterThan(17);
    expect(B.cornerGap).toBeLessThan(60);
  });
  it('cornerCurve is a quarter of easy (2) and above 0 (straights are exactly 0)', () => {
    expect(B.cornerCurve).toBeGreaterThan(0);
    expect(B.cornerCurve).toBeLessThanOrEqual(2 / 4);
  });
});

describe('T71 data: R86f, R86e withdrawn, R85c', () => {
  it('R86f: driftSpeedLoss 0 (was 0.08)', () => expect(B.driftSpeedLoss).toBe(0));
  it('R86e withdrawn: debtTime 0 (was 0.5)', () => expect(B.debtTime).toBe(0));
  it('R85c / R89c: gripDodge 0.1 (was 0.45); dodgeFadeA 4 unchanged', () => {
    expect(B.gripDodge).toBe(0.1);
    expect(B.dodgeFadeA).toBe(4);
  });
  it('R86e fields stay: driftTicks (R85d) and scrubDebt (always 0) exist on a new car and survive JSON', () => {
    const s = createRace(1, 3, 2);
    for (const c of s.cars) {
      expect(c.driftTicks).toBe(0);
      expect(c.scrubDebt).toBe(0);
    }
    const t = JSON.parse(JSON.stringify(s)) as RaceState;
    for (const c of t.cars) {
      expect(c.driftTicks).toBe(0);
      expect(c.scrubDebt).toBe(0);
    }
  });
});

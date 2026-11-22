import { describe, expect, it } from 'vitest';
import { botInput, createBot } from '../../src/bot/driver';
import { botParams } from '../../src/data/bots';
import { baseCar } from '../../src/data/cars';
import driftRun from '../../src/data/tracks/drift-run.json';
import { curveClasses, resolveSections, trackSections } from '../../src/data/tracks';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { CarParams, InputFrame } from '../../src/sim/types';

// Spec: docs/brief.md R81g "Боты и соперники": with the default car (driftEntry 3) bots drive their
// pre-T71 variant-3 behaviour (finger down with a full steer toward a corner GRIP cannot hold, released
// otherwise); the "finger down all lap" mode is variant 5 only (tests/bot/driver_v5.test.ts pins it).
// Not new expectations: the contrast with driver_v5.test.ts (held === ticks under variant 5).
const P = { ...baseCar, model: 1, crashMinSpeed: 1e9 } as CarParams; // H14 pin [2026-11-22]: model B explicitly (data default is model C, R150)
const track = buildTrack(resolveSections(trackSections(driftRun as never), curveClasses));

function drive(name: 'novice' | 'average' | 'expert', seconds: number) {
  const s = createRace(1, 1);
  const c = s.cars[0]!;
  const bot = createBot(1);
  const out: InputFrame = { steer: 0, brake: false, drift: false };
  let held = 0;
  let drift = 0;
  let ticks = 0;
  for (let i = 0; i < seconds * 120; i++) {
    botInput(bot, botParams[name], c, track, P, out);
    if (out.drift) held++;
    step(s, [out], track, [P]);
    if (c.state === 'DRIFT') drift++;
    ticks++;
  }
  return { held, drift, ticks };
}

describe('R81g bots on the default car (variant 3 driver, as before T71)', () => {
  it('default car is driftEntry 3', () => expect(P.driftEntry).toBe(3));
  for (const name of ['average', 'expert'] as const) {
    it(`${name}: drifts, but the drift input is not held all lap (released between corners)`, () => {
      const r = drive(name, 60);
      expect(r.drift).toBeGreaterThan(0);
      expect(r.held).toBeGreaterThan(0);
      expect(r.held).toBeLessThan(r.ticks);
    });
  }
  it('novice (drift never): never holds the drift input, never in DRIFT', () => {
    const r = drive('novice', 60);
    expect(r.held).toBe(0);
    expect(r.drift).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { botInput, createBot } from '../../src/bot/driver';
import { botParams } from '../../src/data/bots';
import { baseCar } from '../../src/data/cars';
import driftRun from '../../src/data/tracks/drift-run.json';
import { curveClasses, resolveSections, trackSections } from '../../src/data/tracks';
import { createRace } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { CarParams, InputFrame } from '../../src/sim/types';
import { T71, stepV } from '../sim/corner_helpers';

// Spec: docs/brief.md R81f "Боты и соперники" (driftEntry 5): (1) out.drift = (bp.drift === 'corners')
// the whole lap - a drifting bot keeps the finger down; novice (drift: never) false, GRIP only;
// (4) a bot with drift 'corners' does not brake. (2) "no flick plan" and (3) the drift steer law are
// internal to the driver; they are left to the implementer and checked only through (1) and the gate.
const P = { ...baseCar, ...T71, model: 1, driftTurbo: 0, crashMinSpeed: 1e9 } as CarParams;
const track = buildTrack(resolveSections(trackSections(driftRun as never), curveClasses));

function drive(name: 'novice' | 'average' | 'expert', seconds: number) {
  const s = createRace(1, 1);
  const c = s.cars[0]!;
  const bot = createBot(1);
  const out: InputFrame = { steer: 0, brake: false, drift: false };
  let held = 0;
  let braked = 0;
  let drift = 0;
  let ticks = 0;
  for (let i = 0; i < seconds * 120; i++) {
    botInput(bot, botParams[name], c, track, P, out);
    if (out.drift) held++;
    if (out.brake) braked++;
    stepV(s, [out], track, [P]);
    if (c.state === 'DRIFT') drift++;
    ticks++;
  }
  return { held, braked, drift, ticks };
}

describe('R81f bots under variant 5 (driver)', () => {
  for (const name of ['average', 'expert'] as const) {
    it(`${name} (drift 'corners'): drift input held on every tick, never brakes, and drifts`, () => {
      expect(botParams[name].drift).toBe('corners');
      const r = drive(name, 60);
      expect(r.held).toBe(r.ticks);
      expect(r.braked).toBe(0);
      expect(r.drift).toBeGreaterThan(0);
    });
  }
  it("novice (drift 'never'): drift input never held, never in DRIFT", () => {
    expect(botParams.novice.drift).toBe('never');
    const r = drive('novice', 60);
    expect(r.held).toBe(0);
    expect(r.drift).toBe(0);
  });
});

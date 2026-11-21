// R86e / R85d anti-cheese criterion (docs/brief.md R86e, named in advance): the expert bot without
// noise; corner windows of tools/spike/drift-feel.ts --part 4 (240 straight + figure + 300 straight,
// start at vmax). Tap-drift 0.15 s every 0.6 s (and 0.10/0.4, 0.25/1.0) is not faster than pure GRIP by
// more than 0.5% in any window (T77, was: strictly slower); the held-drift lap (expert) on drift-run
// and test-twisty changes by at most 0.5%.
// Real car data (base.json, model B), driftTurbo 0 (R86c postponed). Driver and windows follow the spike:
// GRIP = bot drift 'never', best clean time over the GRIP margins; tap = the same bot plus a drift input
// for tapS every periodS while |bot steer| >= 0.5 (steer then full, keyboard-like); clean = finished,
// no crash, <= 1% of ticks off the asphalt.
import { describe, expect, it } from 'vitest';
import { botInput, createBot, type BotParams } from '../../src/bot/driver';
import { botParams } from '../../src/data/bots';
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
  type ClassedSection,
} from '../../src/data/tracks';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { CarParams, InputFrame, Track } from '../../src/sim/types';
import { ENTRY_D, T70_NUMBERS } from './pinT70';

// T71: R86e is withdrawn (debtTime 0) but its code path stays; the criterion is kept on the T70 state
// it was measured on (variant 3 zone entry, debtTime 0.5, driftSpeedLoss 0.08, gripDodge 0.45).
const P: CarParams = {
  ...baseCar,
  model: 1,
  driftTurbo: 0,
  ...ENTRY_D,
  ...T70_NUMBERS,
} as CarParams;
const CLEAN: BotParams = { ...botParams.expert, noiseAmp: 0, reactionDelay: 0 };
const MARGINS = [0.8, 1.0, 1.2, 1.45, 1.8, 2.4, 3.5];
const LEAD = 240;
const TAIL = 300;

interface Tap {
  periodS: number;
  tapS: number;
}
const TAPS: Tap[] = [
  { periodS: 0.6, tapS: 0.15 },
  { periodS: 0.4, tapS: 0.1 },
  { periodS: 1.0, tapS: 0.25 },
];

const straightSec = (len: number): ClassedSection => ({
  enter: 0,
  hold: len,
  leave: 0,
  curveClass: 'straight',
  side: 1,
});
function windowTrack(fig: ClassedSection[]) {
  const secs = [straightSec(LEAD), ...fig, straightSec(TAIL)];
  const figLen = fig.reduce((s, x) => s + x.enter + x.hold + x.leave, 0);
  return {
    track: buildTrack(resolveSections(parseSections(secs), curveClasses)),
    total: LEAD + figLen + TAIL,
  };
}
const WINDOWS: [string, ClassedSection[]][] = [
  ['hard 120', [{ enter: 30, hold: 120, leave: 30, curveClass: 'hard', side: 1 }]],
  ['hard 240', [{ enter: 30, hold: 240, leave: 30, curveClass: 'hard', side: 1 }]],
  ['sharp 120', [{ enter: 30, hold: 120, leave: 30, curveClass: 'sharp', side: 1 }]],
  ['hairpin', expandFigures([{ figure: 'hairpin', side: 1 }], figureDict)],
  ['switchback', expandFigures([{ figure: 'switchback', side: 1 }], figureDict)],
  ['chicane', expandFigures([{ figure: 'chicane', side: 1 }], figureDict)],
];

interface RunOut {
  T: number;
  ok: boolean;
  entries: number;
}
/** laps null: one window run from vmax to `total` segments, T = its time; else mean flying lap 2..laps. */
function drive(
  track: Track,
  p: CarParams,
  bp: BotParams,
  tap: Tap | null,
  laps: number | null,
  total: number,
): RunOut {
  const race = createRace(1, 1);
  const c = race.cars[0]!;
  c.speed = laps === null ? p.vmax : 0;
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const bot = createBot(1);
  const n = track.segments.length;
  const goal = laps === null ? total : laps * n;
  let tapT = Infinity;
  let sinceTap = Infinity;
  let off = 0;
  let crash = 0;
  let wasCrash = false;
  let entries = 0;
  let wasDrift = false;
  const lapT: number[] = [];
  let lapStart = 0;
  const maxT = Math.ceil((laps === null ? 60 : laps * 200) / DT);
  while (c.z < goal && race.tick < maxT) {
    botInput(bot, bp, c, track, p, frame);
    if (tap) {
      const want = Math.abs(frame.steer) >= 0.5;
      sinceTap += DT;
      tapT += DT;
      if (want && sinceTap >= tap.periodS) {
        sinceTap = 0;
        tapT = 0;
      }
      frame.drift = tapT < tap.tapS;
      if (frame.drift || want) frame.steer = frame.steer > 0 ? 1 : -1;
    }
    step(race, [frame], track, [p]);
    if (Math.abs(c.x) > 1) off++;
    if (c.crashTicks > 0 && !wasCrash) crash++;
    wasCrash = c.crashTicks > 0;
    const dr = c.state === 'DRIFT';
    if (dr && !wasDrift) entries++;
    wasDrift = dr;
    if (laps !== null && Math.floor(c.z / n) > lapT.length) {
      lapT.push((race.tick - lapStart) * DT);
      lapStart = race.tick;
    }
  }
  const done = c.z >= goal;
  const ticks = race.tick;
  const T = !done
    ? NaN
    : laps === null
      ? ticks * DT
      : lapT.slice(1).reduce((s, x) => s + x, 0) / (lapT.length - 1);
  return { T, ok: done && crash === 0 && off / ticks <= 0.01, entries };
}
/** Best clean time over the GRIP margins (NaN if no margin gives a clean run). */
function bestGrip(track: Track, p: CarParams, tap: Tap | null, total: number) {
  let best: RunOut | null = null;
  for (const m of MARGINS) {
    const o = drive(track, p, { ...CLEAN, drift: 'never', bGripMargin: m }, tap, null, total);
    if (o.ok && (!best || o.T < best.T)) best = o;
  }
  return best;
}

describe('R86e criterion: tap-drift is not faster than pure GRIP (by > 0.5%) in any spike window (expert, no noise)', () => {
  for (const [name, fig] of WINDOWS) {
    it(`${name}: taps 0.15/0.6, 0.10/0.4, 0.25/1.0 are none faster than GRIP by more than 0.5%`, () => {
      const w = windowTrack(fig);
      const g = bestGrip(w.track, P, null, w.total);
      expect(g).not.toBeNull();
      for (const t of TAPS) {
        const b = bestGrip(w.track, P, t, w.total);
        // no clean tap run at all also means the tap does not pay
        if (b) {
          expect(b.entries).toBeGreaterThan(0); // the taps really entered a drift
          // [T77: after R85e the tap-drift cost is gone; closed by the next rule, drift outside a corner
          // brakes, author's decision 2026-11-21] Meaning: tap-drift gives no gain - not faster than
          // GRIP by more than 0.5% of the window time (measured chicane 0.10/0.4: 12.708 = 12.708 s).
          expect(b.T).toBeGreaterThanOrEqual(g!.T * (1 - 0.005));
        }
      }
    }, 120_000);
  }
});

describe('R86e criterion: held drift lap (expert) changes by at most 0.5%', () => {
  // Baseline = the same real car with the T68 tap measures off (debtTime 0, leadRamp 0).
  const OFF = { ...P, debtTime: 0, leadRamp: 0 } as CarParams;
  for (const [name, raw] of [
    ['drift-run', driftRun],
    ['test-twisty', twisty],
  ] as const) {
    it(`${name}: mean flying lap (laps 2-3) within 0.5% of debtTime 0 / leadRamp 0`, () => {
      const track = buildTrack(
        resolveSections(
          trackSections(raw as { figures?: unknown; sections?: unknown }),
          curveClasses,
        ),
      );
      const a = drive(track, P, CLEAN, null, 3, 0);
      const b = drive(track, OFF, CLEAN, null, 3, 0);
      expect(Number.isFinite(a.T)).toBe(true);
      expect(Number.isFinite(b.T)).toBe(true);
      expect(Math.abs(a.T / b.T - 1)).toBeLessThanOrEqual(0.005);
    }, 120_000);
  }
});

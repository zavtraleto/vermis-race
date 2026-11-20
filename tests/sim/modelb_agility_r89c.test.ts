// R89c agility without drift, on the REAL car data (src/data/cars/base.json pinned to model 1),
// H17/H18 (gripScrub, driftTurbo) left as in base.json. Style of modelb_calibration.test.ts:
// speed pinned at vmax before and after every tick, straight road, drift input false (finger inside
// the stick zone, R81c). Lane = 0.25 half-widths (R89b, R22c: 8 lanes over 2 half-widths).
import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import road from '../../src/data/road.json';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { CarParams, InputFrame } from '../../src/sim/types';

const P: CarParams = { ...baseCar, model: 1, crashMinSpeed: 1e9 }; // lamps off: this test is about R89c
// One lane in half-widths from the road data: 2 / lanes = 2 / 8 = 0.25; 10% of it = 0.025.
const LANE = 2 / (road as { lanes: number }).lanes;
const TRACK = makeStraightTrack(4000);

/** Full steer `side` from rest at vmax until one lane is crossed, then steer 0 for `after` s. */
function laneChange(side: 1 | -1, after = 1.5) {
  const s = createRace(1, 1);
  const c = s.cars[0]!;
  const f: InputFrame = { steer: side, brake: false, drift: false };
  const tick = (): number => {
    c.speed = P.vmax;
    const x0 = c.x;
    step(s, [f], TRACK, [P]);
    c.speed = P.vmax;
    return (c.x - x0) / DT;
  };
  let tLane = NaN;
  for (let i = 1; i <= 240 && Number.isNaN(tLane); i++) {
    tick();
    if (c.x * side >= LANE) tLane = i * DT;
  }
  f.steer = 0;
  const xs: number[] = [];
  const vs: number[] = [];
  for (let i = 0; i < after / DT; i++) {
    vs.push(tick() * side);
    xs.push(c.x * side);
  }
  return { tLane, xs, vs, state: c.state };
}

describe('R89c agility: full-steer lane change at vmax (no drift)', () => {
  it.each([1, -1] as const)('side %i: one lane in at most 0.30 s', (side) => {
    const m = laneChange(side);
    expect(m.state).toBe('GRIP');
    expect(m.tLane).toBeLessThanOrEqual(0.3);
  });
  it.each([1, -1] as const)(
    'side %i: overshoot past the target lane at most 10% of a lane (0.025)',
    (side) => {
      const m = laneChange(side);
      expect(Number.isNaN(m.tLane)).toBe(false);
      // overshoot = farthest x after the steer returns to 0, minus the lane: <= 0.1*0.25 = 0.025
      expect(Math.max(...m.xs) - LANE).toBeLessThanOrEqual(0.1 * LANE);
    },
  );
  it.each([1, -1] as const)(
    'side %i: lateral motion stops within 0.15 s after the steer returns to 0',
    (side) => {
      const m = laneChange(side);
      // "stops" = |dx/dt| <= 0.02 half-widths/s (2% of the full-steer 1.0 hw/s of R89b) and stays there
      const STOP = 0.02;
      let last = -1;
      for (let i = 0; i < m.vs.length; i++) if (Math.abs(m.vs[i]!) > STOP) last = i;
      const tStop = (last + 1) * DT;
      expect(tStop).toBeLessThanOrEqual(0.15);
    },
  );
  it('lane width comes from road.json: 2 / 8 = 0.25 half-widths', () => {
    expect(LANE).toBe(0.25);
  });
  it('left/right mirror: identical times and traces', () => {
    const r = laneChange(1);
    const l = laneChange(-1);
    expect(l.tLane).toBe(r.tLane);
    for (let i = 0; i < r.xs.length; i++) expect(l.xs[i]!).toBeCloseTo(r.xs[i]!, 12);
  });
  it('deterministic: same run twice is identical', () => {
    expect(JSON.stringify(laneChange(1))).toBe(JSON.stringify(laneChange(1)));
  });
});

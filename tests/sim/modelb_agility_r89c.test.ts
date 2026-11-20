// R89c agility without drift, on the REAL car data (src/data/cars/base.json pinned to model 1),
// H17/H18 (gripScrub, driftTurbo) left as in base.json. Style of modelb_calibration.test.ts:
// speed pinned at vmax (or 0.6 vmax) before and after every tick, straight road, drift input false
// (finger inside the stick zone, R81c). Lane = 0.25 half-widths (R89b, R22c: 8 lanes over 2 half-widths).
// [T68, 2026-11-20] bounds tightened by the brief: lane at vmax <= 0.19 s (was 0.30), new 0.6 vmax
// <= 0.31 s, overshoot <= 8% of a lane = 0.02 (was 10%), stop <= 0.15 s unchanged; the same overshoot
// and stop also when the finger leaves the zone stick (R81c, zoneReleaseMs 0).
import { beforeAll, describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { inputConfig } from '../../src/data/input';
import road from '../../src/data/road.json';
import type { TouchStick } from '../../src/input/touchStick';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { CarParams, InputFrame } from '../../src/sim/types';

const P: CarParams = { ...baseCar, model: 1, crashMinSpeed: 1e9 }; // lamps off: this test is about R89c
// One lane in half-widths from the road data: 2 / lanes = 2 / 8 = 0.25; 8% of it = 0.02.
const LANE = 2 / (road as { lanes: number }).lanes;
const OVERSHOOT = 0.08 * LANE; // 0.02
const TRACK = makeStraightTrack(4000);

/** Steer source per tick: constant steer, or the zone stick read at the tick's time. */
type Source = { set(steer: number, t: number): void; get(t: number): number };
const direct = (): Source => {
  let s = 0;
  return { set: (v) => (s = v), get: () => s };
};

let createZoneStick: ((c: typeof inputConfig.touch) => TouchStick) | null = null;
beforeAll(async () => {
  const m = (await import('../../src/input/zoneStick')) as {
    createZoneStick: (c: typeof inputConfig.touch) => TouchStick;
  };
  createZoneStick = m.createZoneStick;
});
/** R81c zone stick on a 360x640 area: finger at +-1 R (full steer, inside the drift edge), then up. */
const zone = (): Source => {
  const st = createZoneStick!(inputConfig.touch);
  st.setArea(360, 640);
  const R = inputConfig.touch.stickRadius * 360;
  const f: InputFrame = { steer: 0, brake: false, drift: false };
  st.pointerDown(1, 180, 560, 0);
  return {
    set(v, t) {
      if (v === 0) st.pointerUp(1, t);
      else st.pointerMove(1, 180 + v * R, 560, t);
    },
    get(t) {
      st.read(t, f);
      expect(f.drift).toBe(false); // the finger never leaves the zone: GRIP only
      return f.steer;
    },
  };
};

/** Full steer `side` from rest at `sp` until one lane is crossed, then steer 0 / release for `after` s. */
function laneChange(side: 1 | -1, sp = 1, src: Source = direct(), after = 1.5) {
  const s = createRace(1, 1);
  const c = s.cars[0]!;
  const f: InputFrame = { steer: 0, brake: false, drift: false };
  const tick = (i: number): number => {
    f.steer = src.get(i * DT * 1000);
    c.speed = sp * P.vmax;
    const x0 = c.x;
    step(s, [f], TRACK, [P]);
    c.speed = sp * P.vmax;
    return (c.x - x0) / DT;
  };
  src.set(side, 0);
  let tLane = NaN;
  let i = 1;
  for (; i <= 240 && Number.isNaN(tLane); i++) {
    tick(i);
    if (c.x * side >= LANE) tLane = i * DT;
  }
  src.set(0, i * DT * 1000);
  const xs: number[] = [];
  const vs: number[] = [];
  for (let k = 0; k < after / DT; k++, i++) {
    vs.push(tick(i) * side);
    xs.push(c.x * side);
  }
  return { tLane, xs, vs, state: c.state };
}
/** "stops" = |dx/dt| <= 0.02 half-widths/s and stays there; time after the steer returns to 0. */
function tStop(vs: number[]): number {
  let last = -1;
  for (let i = 0; i < vs.length; i++) if (Math.abs(vs[i]!) > 0.02) last = i;
  return (last + 1) * DT;
}

describe('R89c agility: full-steer lane change (no drift)', () => {
  it.each([1, -1] as const)('side %i: one lane at vmax in at most 0.19 s', (side) => {
    const m = laneChange(side);
    expect(m.state).toBe('GRIP');
    expect(m.tLane).toBeLessThanOrEqual(0.19);
  });
  it.each([1, -1] as const)('side %i: one lane at 0.6 vmax in at most 0.31 s', (side) => {
    const m = laneChange(side, 0.6);
    expect(m.state).toBe('GRIP');
    expect(m.tLane).toBeLessThanOrEqual(0.31);
  });
  it.each([1, -1] as const)(
    'side %i: overshoot past the target lane at most 8% of a lane (0.02)',
    (side) => {
      const m = laneChange(side);
      expect(Number.isNaN(m.tLane)).toBe(false);
      expect(Math.max(...m.xs) - LANE).toBeLessThanOrEqual(OVERSHOOT);
    },
  );
  it.each([1, -1] as const)(
    'side %i: lateral motion stops within 0.15 s after the steer returns to 0',
    (side) => {
      expect(tStop(laneChange(side).vs)).toBeLessThanOrEqual(0.15);
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

describe('R89c agility: finger released from the zone stick (R81c, zoneReleaseMs from input.json)', () => {
  it.each([1, -1] as const)('side %i: overshoot at most 0.02 after pointerup', (side) => {
    const m = laneChange(side, 1, zone());
    expect(m.state).toBe('GRIP');
    expect(Math.max(...m.xs) - LANE).toBeLessThanOrEqual(OVERSHOOT);
  });
  it.each([1, -1] as const)('side %i: stops within 0.15 s after pointerup', (side) => {
    expect(tStop(laneChange(side, 1, zone()).vs)).toBeLessThanOrEqual(0.15);
  });
});

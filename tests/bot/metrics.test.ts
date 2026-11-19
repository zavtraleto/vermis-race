// speed.longHardMin: the LOWEST of the per-corner minimum speeds over all long hard corners,
// so every long hard corner must be slowed below the bound, not only the best one.
import { describe, expect, it } from 'vitest';
import type { MeasureConfig, RunResult } from '../../src/bot/run';
import type { ClassedSection } from '../../src/data/tracks';
import { SEG_PER_UNIT } from '../../src/sim/constants';
import type { Track } from '../../src/sim/types';
import { summarize, type LoadedTrack } from '../../tools/botlib';

const m: MeasureConfig = {
  laps: 3,
  maxSecondsPerLap: 180,
  saturationSteer: 0.95,
  deadSteer: 0.05,
  straightCurveMax: 0.1,
  longHoldSeconds: 3,
};
// a corner is long when hold / SEG_PER_UNIT >= longHoldSeconds
const longHold = Math.ceil(m.longHoldSeconds * SEG_PER_UNIT) + 1;
const shortHold = Math.max(1, Math.floor(m.longHoldSeconds * SEG_PER_UNIT) - 2);

const sec = (curveClass: ClassedSection['curveClass'], hold: number): ClassedSection => ({
  enter: 5,
  hold,
  leave: 5,
  curveClass,
  side: 1,
});

function run(minSpeeds: number[]): RunResult {
  return {
    seed: 1,
    finished: true,
    ticks: 1000,
    lapTimes: [10, 10, 10],
    offroadTicks: 0,
    offroadEvents: 0,
    offroadEventsByClass: { easy: 0, medium: 0, hard: 0 },
    saturationTicks: 0,
    brakeTicks: 0,
    driftTicks: 0,
    driftEntries: 0,
    straightTicks: 0,
    deadTicks: 0,
    speedSum: 500,
    minSpeedFlying: 0.5,
    wallHits: 0,
    nan: false,
    corners: minSpeeds.map((minSpeed) => ({
      entrySpeed: [],
      maxAbsX: 0,
      minSpeed,
      offroadEvents: 0,
    })),
    fingerprint: '00000000',
  };
}

function track(sections: ClassedSection[]): LoadedTrack {
  return { name: 't', sections, track: { segments: [] } as unknown as Track };
}

describe('run metric speed.longHardMin', () => {
  // sections: 0 long hard, 1 long hard, 2 short hard, 3 long medium
  const t = track([
    sec('hard', longHold),
    sec('hard', longHold),
    sec('hard', shortHold),
    sec('medium', longHold),
  ]);

  it('is the lowest per-corner minimum over long hard corners (slow in one corner)', () => {
    // corner minima 0.98 and 0.60 -> lowest = 0.60 (the highest would be 0.98)
    const e = summarize('expert', t, [run([0.98, 0.6, 0.1, 0.2])], m);
    expect(e.speed.longHardMin).toBeCloseTo(0.6, 12);
  });

  it('does not depend on corner order', () => {
    const e = summarize('expert', t, [run([0.6, 0.98, 0.1, 0.2])], m);
    expect(e.speed.longHardMin).toBeCloseTo(0.6, 12);
  });

  it('ignores short hard and non-hard corners', () => {
    const e = summarize('expert', t, [run([0.9, 0.95, 0.05, 0.01])], m);
    expect(e.speed.longHardMin).toBeCloseTo(0.9, 12);
  });

  it('takes each corner minimum over all seeds before taking the lowest corner', () => {
    // corner 0 over seeds: min(0.99, 0.7) = 0.7; corner 1: min(0.8, 0.85) = 0.8 -> lowest 0.7
    const e = summarize('expert', t, [run([0.99, 0.8, 1, 1]), run([0.7, 0.85, 1, 1])], m);
    expect(e.speed.longHardMin).toBeCloseTo(0.7, 12);
  });

  it('is null when there is no long hard corner', () => {
    const none = track([sec('medium', longHold), sec('hard', shortHold)]);
    const e = summarize('expert', none, [run([0.5, 0.5])], m);
    expect(e.speed.longHardMin).toBeNull();
  });
});

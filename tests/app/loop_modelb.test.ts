import { describe, expect, it } from 'vitest';
import { copyRaceState, createLoop } from '../../src/app/loop';
import type { InputSource } from '../../src/app/loop';
import { STEER_HIST } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { InputFrame, RaceState } from '../../src/sim/types';
import { PB } from '../sim/modelb_helpers';

const track = makeStraightTrack(2000);

/** Flicks and holds, so yaw, vel, recover and the steer ring buffer all get non-trivial values. */
const source: InputSource = (t, out) => {
  const f = out[0]!;
  f.steer = Math.max(-1, Math.min(1, 1.2 * Math.sin(t / 9)));
  f.brake = false;
  f.drift = t % 200 > 30;
};

function played(n: number): RaceState {
  const s = createRace(5, 1);
  s.cars[0]!.speed = 0.8;
  const f: InputFrame[] = [{ steer: 0, brake: false, drift: false }];
  for (let t = 0; t < n; t++) {
    source(t, f);
    step(s, f, track, [PB]);
  }
  return s;
}

describe('copyRaceState with model B fields', () => {
  it('copies yaw, yawRate, vel, recover and the steerHist contents; src untouched', () => {
    const src = played(400);
    const c = src.cars[0]!;
    expect(c.yaw).not.toBe(0);
    expect(c.steerHist.some((v) => v !== 0)).toBe(true);
    const before = JSON.stringify(src);
    const dst = createRace(999, 1);
    copyRaceState(src, dst);
    expect(JSON.stringify(dst)).toBe(JSON.stringify(src));
    expect(JSON.stringify(src)).toBe(before);
    expect(dst.cars[0]!.steerHist).not.toBe(c.steerHist); // a copy, not a shared array
    dst.cars[0]!.steerHist[0] = 123;
    expect(c.steerHist[0]).not.toBe(123);
  });
  it('the loop keeps prev = the state one tick earlier, buffer included', () => {
    const loop = createLoop(createRace(5, 1), { track, params: [PB], readInput: source });
    loop.curr.cars[0]!.speed = 0.8;
    loop.stepTicks(300);
    const ref = played(0);
    ref.cars[0]!.speed = 0.8;
    const f: InputFrame[] = [{ steer: 0, brake: false, drift: false }];
    for (let t = 0; t < 299; t++) {
      source(t, f);
      step(ref, f, track, [PB]);
    }
    expect(JSON.stringify(loop.prev)).toBe(JSON.stringify(ref));
    expect(loop.prev.cars[0]!.steerHistCount).toBe(STEER_HIST);
  });
});

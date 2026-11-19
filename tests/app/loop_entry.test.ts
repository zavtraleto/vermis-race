import { describe, expect, it } from 'vitest';
import { copyRaceState } from '../../src/app/loop';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { InputFrame } from '../../src/sim/types';
import { PB } from '../sim/modelb_helpers';

// R81b (C): deflectTicks is part of the flat state, so copyRaceState must copy it.
describe('copyRaceState with deflectTicks (R81b)', () => {
  it('copies a mid-count deflectTicks; src untouched', () => {
    const src = createRace(5, 1);
    src.cars[0]!.speed = 0.8;
    const f: InputFrame[] = [{ steer: 0.3, brake: false, drift: true }];
    for (let t = 0; t < 7; t++) step(src, f, makeStraightTrack(2000), [PB]);
    src.cars[0]!.deflectTicks = 7; // set directly: this test is about the copy, not the counter
    const before = JSON.stringify(src);
    const dst = createRace(999, 1);
    dst.cars[0]!.deflectTicks = 99;
    copyRaceState(src, dst);
    expect(dst.cars[0]!.deflectTicks).toBe(src.cars[0]!.deflectTicks);
    expect(JSON.stringify(dst)).toBe(JSON.stringify(src));
    expect(JSON.stringify(src)).toBe(before);
  });
});

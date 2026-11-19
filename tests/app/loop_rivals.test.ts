import { describe, expect, it } from 'vitest';
import { copyRaceState } from '../../src/app/loop';
import { createRace } from '../../src/sim/race';

describe('copyRaceState with rival fields (R62, R66)', () => {
  it('copies skill, pace, nameId, place, role, slot, slotTicks, nemesis, band, joinTicks; src untouched', () => {
    const src = createRace(5, 4, 1);
    src.cars[1]!.skill = 2;
    src.cars[1]!.pace = 1.02;
    src.cars[1]!.nameId = 5;
    src.cars[1]!.place = 3;
    src.cars[2]!.skill = 1;
    src.cars[2]!.pace = 0.97;
    src.cars[2]!.nameId = 17;
    src.cars[2]!.place = 2;
    src.cars[0]!.place = 4;
    Object.assign(src.cars[1]!, { role: 2, slot: -433.5, slotTicks: 4321, nemesis: 0, band: -0.037, joinTicks: 77 });
    Object.assign(src.cars[2]!, { role: 0, slot: 12.25, slotTicks: 3100, nemesis: 1, band: 0.041, joinTicks: 5 });
    const before = JSON.stringify(src);
    const dst = createRace(999, 4, 1);
    copyRaceState(src, dst);
    expect(JSON.stringify(dst)).toBe(JSON.stringify(src));
    expect(JSON.stringify(src)).toBe(before);
    expect(dst.cars[1]!.nameId).toBe(5);
    expect(dst.cars[2]!.pace).toBe(0.97);
    expect(dst.cars[0]!.place).toBe(4);
    expect(dst.cars[1]!.role).toBe(2);
    expect(dst.cars[1]!.slot).toBe(-433.5);
    expect(dst.cars[1]!.slotTicks).toBe(4321);
    expect(dst.cars[1]!.band).toBe(-0.037);
    expect(dst.cars[1]!.joinTicks).toBe(77);
    expect(dst.cars[2]!.nemesis).toBe(1);
  });
});

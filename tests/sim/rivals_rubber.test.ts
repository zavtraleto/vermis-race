import { describe, expect, it } from 'vitest';
import { step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RivalConfig } from '../../src/sim/types';
import { baseCarA } from './baseCarA';
import { DT } from '../../src/sim/constants';
import { IDLE, RC, TRACK, mkRace } from './rivals_helpers';

const PLAYER: CarParams = { ...baseCarA, accel: 0 };
/** Rival that does not move by itself (speed 0, accel 0), so d is the same at start and end of the step. */
const STILL: CarParams = { ...baseCarA, accel: 0 };
/** Rival whose speed after one step is exactly its cap (accel huge; R204 clamps to the cap). */
const SNAP: CarParams = { ...baseCarA, accel: 600 };
const LATE = 1900; // race tick after bandStartDelay (15 s = 1800 ticks)

describe('R62 pace scales the speed cap', () => {
  const settle = (p: CarParams, pace: number, start: number): number => {
    const s = mkRace(1, 0, [
      { z: -1000, x: 0, speed: 0 },
      { z: 0, x: 0.3, speed: start, pace },
    ]);
    for (let i = 0; i < 1500; i++) step(s, [IDLE, IDLE], TRACK, [{ ...p, accel: 0 }, p]);
    return s.cars[1]!.speed;
  };
  // [ADR 0005] one driving model.
  for (const [label, p] of [['R200 model', baseCarA]] as const) {
    it(`${label}: pace 1.03 settles at 1.03*vmax, pace 0.97 at 0.97*vmax, pace 1 at vmax`, () => {
      expect(settle(p, 1.03, 0)).toBeCloseTo(1.03 * p.vmax, 6);
      expect(settle(p, 0.97, 0)).toBeCloseTo(0.97 * p.vmax, 6);
      expect(settle(p, 1, 0)).toBeCloseTo(p.vmax, 6);
      // starting above the cap it brakes down to the cap
      expect(settle(p, 0.97, p.vmax)).toBeCloseTo(0.97 * p.vmax, 6);
    });
  }
  it('the same pace on the player car (pace 1) leaves vmax alone', () => {
    const s = mkRace(0, 0, [{ z: 0, x: 0, speed: 0 }]);
    for (let i = 0; i < 1500; i++) step(s, [IDLE], TRACK, [baseCarA]);
    expect(s.cars[0]!.speed).toBeCloseTo(1, 6);
  });
  it('monotonic: higher pace -> higher settled speed', () => {
    const v = [0.97, 0.99, 1, 1.01, 1.03].map((pc) => settle(baseCarA, pc, 0));
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThan(v[i - 1]!);
  });
});

/**
 * R63 band tests. Player parked at z 0 (speed 0). Rival at z = d (d = z - zPlayer), given slot,
 * smoothed band b0 at the start. `slotTicks` is huge so R62b never redraws the slot, |d| < poolRadius.
 */
interface Setup {
  d: number;
  slot: number;
  b0?: number;
  tick?: number;
  nemesis?: number;
  pace?: number;
  cfg?: RivalConfig | undefined;
  params?: CarParams;
  speed?: number;
  role?: number;
}
function one(o: Setup): Car {
  const s = mkRace(1, 0, [
    { z: 0, x: 0, speed: 0 },
    {
      z: o.d,
      x: 0.5,
      speed: o.speed ?? 0,
      pace: o.pace ?? 1,
      slot: o.slot,
      slotTicks: 1e6,
      band: o.b0 ?? 0,
      nemesis: o.nemesis ?? 0,
      role: o.role ?? (o.nemesis ? 0 : 1),
    },
  ]);
  s.tick = o.tick ?? LATE;
  const cfg = 'cfg' in o ? o.cfg : RC;
  step(s, [IDLE, IDLE], TRACK, [PLAYER, o.params ?? STILL], undefined, cfg);
  return s.cars[1]!;
}
const attack = 1 - Math.exp(-2 * DT); // bandAttack 2 1/s
const release = 1 - Math.exp(-0.5 * DT); // bandRelease 0.5 1/s

describe('R63 target (formula, sign conventions d = z - zPlayer, err = slot - d)', () => {
  // With b0 = target the smoothing is at rest, so the stored band after one step equals the target
  // whether the brief means band before or after the smoothing; the cap check uses the same trick.
  const cases: Array<[string, number, number, number]> = [
    // [label, d, slot, target]
    // d -100 (rival 100 behind), slot 200: err 300, raw min(300/300,1) = 1, target 0.06*1 = 0.06
    ['behind, slot ahead, saturated: err 300 -> raw 1 -> +0.06', -100, 200, 0.06],
    // slot 50: err 150, raw 0.5, target 0.06*0.5 = 0.03
    ['err 150 -> raw 0.5 -> +0.03', -100, 50, 0.03],
    // slot 600: err 700, raw clamp 1 -> 0.06
    ['err 700 clamps at raw 1 -> +0.06', -100, 600, 0.06],
    // d -100, slot -250: err -150, raw -0.5, target = bandSlow*raw = 0.10*(-0.5) = -0.05
    ['err -150 -> raw -0.5 -> -0.05 (slow, stronger)', -100, -250, -0.05],
    // slot -500: err -400, raw clamp -1 -> -0.10
    ['err -400 clamps at raw -1 -> -0.10', -100, -500, -0.1],
    ['err 0 -> 0', -100, -100, 0],
    // d 250 (ahead, outside view 200), slot 100: err -150, raw -0.5 -> -0.05
    ['ahead beyond view distance: d 250, slot 100 -> -0.05', 250, 100, -0.05],
    // d 250, slot 600: err 350, raw 1 -> +0.06 (ahead but wants more distance)
    ['ahead beyond view, slot farther ahead: +0.06', 250, 600, 0.06],
  ];
  for (const [label, d, slot, target] of cases) {
    it(`${label}: stored band and speed cap 1 + target = ${1 + target}`, () => {
      expect(one({ d, slot, b0: target }).band).toBeCloseTo(target, 12);
      expect(one({ d, slot, b0: target, params: SNAP, speed: 0.5 }).speed).toBeCloseTo(1 + target, 9);
    });
  }
  it('the cap multiplies pace: pace 1.02, target +0.06 -> 1.02 * 1.06 = 1.0812', () => {
    expect(one({ d: -100, slot: 200, b0: 0.06, pace: 1.02, params: SNAP, speed: 0.5 }).speed).toBeCloseTo(1.0812, 9);
    // target -0.10: 1.02 * 0.9 = 0.918
    expect(one({ d: -100, slot: -500, b0: -0.1, pace: 1.02, params: SNAP, speed: 0.5 }).speed).toBeCloseTo(0.918, 9);
  });
  it('bandBoost, bandSlow and bandRange are independent config numbers (boost 0.1, slow 0.05, range 100)', () => {
    const cfg: RivalConfig = { ...RC, bandBoost: 0.1, bandSlow: 0.05, bandRange: 100 };
    // d -100 slot 0: err 100, raw 1 -> 0.1
    expect(one({ d: -100, slot: 0, b0: 0.1, cfg }).band).toBeCloseTo(0.1, 12);
    // slot -50: err 50, raw 0.5 -> 0.05
    expect(one({ d: -100, slot: -50, b0: 0.05, cfg }).band).toBeCloseTo(0.05, 12);
    // slot -150: err -50, raw -0.5 -> 0.05 * -0.5 = -0.025
    expect(one({ d: -100, slot: -150, b0: -0.025, cfg }).band).toBeCloseTo(-0.025, 12);
  });
  it('monotonic: target never decreases as the slot moves ahead (fixed d), bounded in [-bandSlow, +bandBoost]', () => {
    let prev = -Infinity;
    for (let slot = -700; slot <= 700; slot += 50) {
      // from rest band1 = target*attack
      const t = one({ d: -100, slot }).band / attack;
      expect(t).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(t).toBeGreaterThanOrEqual(-0.1 - 1e-9);
      expect(t).toBeLessThanOrEqual(0.06 + 1e-9);
      prev = t;
    }
  });
});

describe('R63 view window (0 < d < bandViewDist: rival ahead and visible)', () => {
  // d 100 (inside), slot -200: err -300, raw -1, target -0.10
  it('inside the window the target is multiplied by bandViewMul = 0: no pull-back on screen', () => {
    expect(one({ d: 100, slot: -200, b0: 0 }).band).toBeCloseTo(0, 12);
  });
  it('bandViewMul 0.3: target -0.10 * 0.3 = -0.03', () => {
    const cfg: RivalConfig = { ...RC, bandViewMul: 0.3 };
    expect(one({ d: 100, slot: -200, b0: -0.03, cfg }).band).toBeCloseTo(-0.03, 12);
  });
  it('the multiplier also applies to a boost target: d 100, slot 500: err 400 -> +0.06 * 0.3 = 0.018', () => {
    const cfg: RivalConfig = { ...RC, bandViewMul: 0.3 };
    expect(one({ d: 100, slot: 500, b0: 0.018, cfg }).band).toBeCloseTo(0.018, 12);
  });
  it('d = 199 is inside, d = 200 (not < 200) and d = 201 are outside: full -0.10', () => {
    const cfg: RivalConfig = { ...RC, bandViewMul: 0.3 };
    expect(one({ d: 199, slot: -300, b0: -0.03, cfg }).band).toBeCloseTo(-0.03, 12); // err -499 -> -1
    expect(one({ d: 201, slot: -300, b0: -0.1, cfg }).band).toBeCloseTo(-0.1, 12);
    expect(one({ d: 200, slot: -300, b0: -0.1, cfg }).band).toBeCloseTo(-0.1, 12);
  });
  it('behind the player (d < 0) is never in the window', () => {
    const cfg: RivalConfig = { ...RC, bandViewMul: 0.3 };
    expect(one({ d: -1, slot: 300, b0: 0.06, cfg }).band).toBeCloseTo(0.06, 12);
    expect(one({ d: -150, slot: 200, b0: 0.06, cfg }).band).toBeCloseTo(0.06, 12);
  });
  it('bandViewDist is a config number: dist 50 makes d 100 outside', () => {
    const cfg: RivalConfig = { ...RC, bandViewDist: 50, bandViewMul: 0.3 };
    expect(one({ d: 100, slot: -200, b0: -0.1, cfg }).band).toBeCloseTo(-0.1, 12);
  });
  it('the nemesis uses nemesisViewMul 0.5 inside the window: -0.10 * 0.5 = -0.05', () => {
    expect(one({ d: 100, slot: -200, b0: -0.05, nemesis: 1 }).band).toBeCloseTo(-0.05, 12);
    expect(one({ d: 100, slot: -200, b0: 0, nemesis: 0 }).band).toBeCloseTo(0, 12);
  });
  it('the nemesis outside the window gets the full target', () => {
    expect(one({ d: 300, slot: -100, b0: -0.1, nemesis: 1 }).band).toBeCloseTo(-0.1, 12);
  });
  it('speed cap in the window: viewMul 0 -> cap exactly vmax (no slowdown on screen)', () => {
    expect(one({ d: 100, slot: -200, b0: 0, params: SNAP, speed: 0.5 }).speed).toBeCloseTo(1, 9);
  });
});

describe('R63 exponential smoothing', () => {
  it('rising from rest: band1 = target*(1 - exp(-bandAttack*DT)); target 0.06', () => {
    expect(one({ d: -100, slot: 200 }).band).toBeCloseTo(0.06 * attack, 12);
  });
  it('|target| < |band| uses bandRelease: b0 0.06, target 0.03 -> 0.06 + (0.03 - 0.06)*release', () => {
    expect(one({ d: -100, slot: 50, b0: 0.06 }).band).toBeCloseTo(0.06 - 0.03 * release, 12);
  });
  it('decay to zero uses release: b0 0.06, target 0 -> 0.06*exp(-0.5*DT)', () => {
    expect(one({ d: -100, slot: -100, b0: 0.06 }).band).toBeCloseTo(0.06 * Math.exp(-0.5 * DT), 12);
  });
  it('sign flip is judged by magnitude: b0 0.03, target -0.10 -> attack', () => {
    expect(one({ d: -100, slot: -500, b0: 0.03 }).band).toBeCloseTo(0.03 - 0.13 * attack, 12);
  });
  it('sign flip, smaller magnitude: b0 -0.10, target +0.06 -> release', () => {
    expect(one({ d: -100, slot: 200, b0: -0.1 }).band).toBeCloseTo(-0.1 + 0.16 * release, 12);
  });
  it('bandAttack / bandRelease come from the config (attack 8, release 3)', () => {
    const cfg: RivalConfig = { ...RC, bandAttack: 8, bandRelease: 3 };
    expect(one({ d: -100, slot: 200, cfg }).band).toBeCloseTo(0.06 * (1 - Math.exp(-8 * DT)), 12);
    expect(one({ d: -100, slot: 50, b0: 0.06, cfg }).band).toBeCloseTo(0.06 - 0.03 * (1 - Math.exp(-3 * DT)), 12);
  });
  it('the cap uses the band: after a step from rest the speed is within [1, 1.06]', () => {
    const sp = one({ d: -100, slot: 200, params: SNAP, speed: 0.5 }).speed;
    expect(sp).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(sp).toBeLessThanOrEqual(1.06 + 1e-9);
  });
  it('long run to a fixed target: monotone, no overshoot, converges (10 s, target +0.06)', () => {
    const s = mkRace(1, 0, [
      { z: 0, x: 0, speed: 0 },
      { z: -100, x: 0.5, speed: 0, slot: 200, slotTicks: 1e9, band: 0, role: 1 },
    ]);
    s.tick = LATE;
    let prev = 0;
    for (let i = 0; i < 1200; i++) {
      step(s, [IDLE, IDLE], TRACK, [PLAYER, STILL], undefined, RC);
      const b = s.cars[1]!.band;
      expect(b).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(b).toBeLessThanOrEqual(0.06 + 1e-12);
      prev = b;
    }
    expect(prev).toBeCloseTo(0.06, 6); // 1 - exp(-2*10) ~ 1
  });
  it('magnitudes: err +300 gives +0.06, err -300 gives -0.10 (asymmetry bandBoost : bandSlow)', () => {
    expect(one({ d: -100, slot: 200 }).band / attack).toBeCloseTo(0.06, 9);
    expect(one({ d: -100, slot: -400 }).band / attack).toBeCloseTo(-0.1, 9);
  });
});

describe('R63 bandStartDelay (first 15 s of the race: target 0)', () => {
  it('race tick 0: target 0 even with err 300; band from b0 0.06 decays by release', () => {
    expect(one({ d: -100, slot: 200, b0: 0.06, tick: 0 }).band).toBeCloseTo(0.06 * Math.exp(-0.5 * DT), 12);
  });
  it('tick 0 from rest: band stays 0', () => {
    expect(one({ d: -100, slot: 200, b0: 0, tick: 0 }).band).toBe(0);
  });
  it('tick 1700 (14.2 s, < 15 s = 1800 ticks) still delayed; tick 1900 (15.8 s) active', () => {
    expect(one({ d: -100, slot: 200, tick: 1700 }).band).toBe(0);
    expect(one({ d: -100, slot: 200, tick: 1900 }).band).toBeCloseTo(0.06 * attack, 12);
  });
  it('bandStartDelay 0: active from tick 0; bandStartDelay 30: tick 1900 still delayed (3600 ticks)', () => {
    expect(one({ d: -100, slot: 200, tick: 0, cfg: { ...RC, bandStartDelay: 0 } }).band).toBeCloseTo(0.06 * attack, 12);
    expect(one({ d: -100, slot: 200, tick: 1900, cfg: { ...RC, bandStartDelay: 30 } }).band).toBe(0);
  });
});

describe('R63 off switches, player and traffic', () => {
  it('rubberBand 0 (H15 B): band forced to 0, cap = pace*vmax', () => {
    const c = one({ d: -100, slot: 200, b0: 0.05, cfg: { ...RC, rubberBand: 0 }, pace: 1.02, params: SNAP, speed: 0.5 });
    expect(c.band).toBe(0);
    expect(c.speed).toBeCloseTo(1.02, 9);
  });
  it('no rival config: band 0, cap pace*vmax', () => {
    const c = one({ d: -100, slot: 200, b0: 0.05, cfg: undefined, params: SNAP, speed: 0.5 });
    expect(c.band).toBe(0);
    expect(c.speed).toBeCloseTo(1, 9);
  });
  it('the player is never affected: band 0 and cap vmax even with a slot written on it', () => {
    const s = mkRace(1, 0, [
      { z: 0, x: 0, speed: 0, band: 0, slot: 500 },
      { z: -400, x: 0.5, speed: 0, slotTicks: 1e6 },
    ]);
    s.tick = LATE;
    for (let i = 0; i < 600; i++) step(s, [IDLE, IDLE], TRACK, [SNAP, PLAYER], undefined, RC);
    expect(s.cars[0]!.band).toBe(0);
    expect(s.cars[0]!.speed).toBeCloseTo(1, 6);
  });
  it('traffic is not affected (R70 rails): speed unchanged, band stays 0', () => {
    const s = mkRace(0, 1, [
      { z: 0, x: 0, speed: 0 },
      { z: -400, x: 0.5, speed: 0.5 },
    ]);
    s.tick = LATE;
    step(s, [IDLE, IDLE], TRACK, [PLAYER, SNAP], undefined, RC);
    expect(s.cars[1]!.speed).toBe(0.5);
    expect(s.cars[1]!.band).toBe(0);
  });
  it('only the cap changes: lateral motion of step 1 is identical with the band on and off', () => {
    const steer: InputFrame = { steer: 0.7, gas: 1, brake: 0, driftTap: false };
    const run = (cfg: RivalConfig): { x: number; travel: number; speed: number } => {
      const s = mkRace(1, 0, [
        { z: 0, x: 0, speed: 0 },
        { z: -240, x: 0.2, speed: 0.5, slot: 400, slotTicks: 1e6, band: 0.06, role: 1 },
      ]);
      s.tick = LATE;
      step(s, [IDLE, steer], TRACK, [PLAYER, SNAP], undefined, cfg);
      const c = s.cars[1]!;
      return { x: c.x, travel: c.travel, speed: c.speed };
    };
    const on = run(RC);
    const off = run({ ...RC, rubberBand: 0 });
    expect(on.x).toBe(off.x);
    expect(on.travel).toBe(off.travel);
    expect(on.speed).toBeGreaterThan(off.speed + 0.03); // ~1.06 vs 1
  });
  it('determinism: the same race run twice gives identical JSON (band, slot included)', () => {
    const run = (): string => {
      const s = mkRace(2, 0, [
        { z: 0, x: 0, speed: 0.5 },
        { z: -300, x: 0.5, speed: 0.4, slot: 300, slotTicks: 1e6, role: 1 },
        { z: 300, x: -0.5, speed: 0.6, slot: -300, slotTicks: 1e6, role: 2 },
      ]);
      s.tick = LATE;
      for (let i = 0; i < 500; i++) step(s, [IDLE, IDLE, IDLE], TRACK, [baseCarA, baseCarA, baseCarA], undefined, RC);
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
  });
});

import { describe, expect, it } from 'vitest';
import { step } from '../../src/sim/race';
import type { CarParams, InputFrame } from '../../src/sim/types';
import { baseCarA } from './baseCarA';
import { PB } from './modelb_helpers';
import {
  BP,
  BUMP_TICKS,
  FAR_PLAYER,
  IDLE,
  RC,
  TRACK,
  after1,
  mkRace,
  stepAll,
} from './rivals_helpers';

const WILD: InputFrame = { steer: 1, brake: true, drift: true };

describe('R64 a rival is driven by the same step as the player', () => {
  for (const [label, p] of [
    ['model A', baseCarA],
    ['model B', PB],
  ] as const) {
    it(`${label}: same state and same input give the same motion (x, vx, speed, z, angle, yaw, state)`, () => {
      const s = mkRace(1, 0, [
        { z: 0, x: 0.2, speed: 0.6 },
        { z: 400, x: 0.2, speed: 0.6 }, // far apart: no contact, no band (no rival config)
      ]);
      for (let t = 0; t < 400; t++) {
        const f: InputFrame = { steer: Math.sin(t / 15), brake: false, drift: t % 120 > 40 };
        step(s, [f, f], TRACK, [p, p]);
        const a = s.cars[0]!;
        const b = s.cars[1]!;
        expect(b.x, `tick ${t}`).toBe(a.x);
        expect(b.vx).toBe(a.vx);
        expect(b.speed).toBe(a.speed);
        expect(b.z - 400).toBeCloseTo(a.z, 9);
        expect(b.angle).toBe(a.angle);
        expect(b.yaw).toBe(a.yaw);
        expect(b.state).toBe(a.state);
      }
    });
  }
});

describe('R64 off road (R15) works for a rival like for the player', () => {
  // offroadMul 0.9: speed *= 0.9^(60*DT) = 0.9^0.5 = 0.9486833 per step. x = 1.5 > 1, xLimit 2, accel 0.
  // 0.5 * 0.9486833 = 0.4743416
  const P: CarParams = { ...BP, offroadMul: 0.9 };
  it('one step: speed 0.5 -> 0.5 * 0.9^0.5 = 0.47434; a rival on the road keeps 0.5', () => {
    const s = mkRace(2, 0, [FAR_PLAYER, { z: 0, x: 1.5, speed: 0.5 }, { z: 50, x: 0, speed: 0.5 }]);
    stepAll(s, P);
    expect(s.cars[1]!.speed).toBeCloseTo(0.4743416, 6);
    expect(s.cars[2]!.speed).toBeCloseTo(0.5, 12);
  });
  it('mirror: x = -1.5 gives the same loss', () => {
    const s = mkRace(1, 0, [FAR_PLAYER, { z: 0, x: -1.5, speed: 0.5 }]);
    stepAll(s, P);
    expect(s.cars[1]!.speed).toBeCloseTo(0.4743416, 6);
  });
  it('rival and player lose exactly the same speed over 100 ticks off road', () => {
    const s = mkRace(1, 0, [
      { z: 0, x: 1.5, speed: 0.8 },
      { z: 300, x: 1.5, speed: 0.8 },
    ]);
    for (let i = 0; i < 100; i++) stepAll(s, P);
    expect(s.cars[1]!.speed).toBe(s.cars[0]!.speed);
    expect(s.cars[1]!.speed).toBeCloseTo(0.8 * Math.pow(0.9, 50), 9); // 0.9^(0.5*100)
  });
});

describe('R64 rival and traffic: R40-R43 numbers', () => {
  // Geometry after step 1 (see after1). Traffic hit half width (0.2 + 0.6)/2 = 0.4; R65 width would be 0.2.
  // R41 rewritten 2026-11-19: the hitter loses from its own speed; traffic is pushed forward.
  // (Old version expected rival speed max(speedT - 0.1, 0.3) = 0.5 and traffic unchanged.)
  it('rear hit: rival speed = min(0.8, max(0.8 - 0.1, 0.3)) = 0.7; traffic max(0.6, 0.8 + 0.1) = 0.9', () => {
    // dz = zT - z = 11 - 10 = 1 > carLength/2 = 0.75 -> rear. dx = 0.3 < 0.4 (and > 0.2: only R40 width).
    // rivalBumpLoss 0.3 is R65 (rival-rival) and must not apply here: R65 would give 0.3 for the rival.
    const rc = { ...RC, rivalBumpLoss: 0.3 };
    const s = mkRace(1, 1, [
      FAR_PLAYER,
      after1({ z: 10, x: 0, speed: 0.8 }),
      after1({ z: 11, x: 0.3, speed: 0.6 }),
    ]);
    stepAll(s, BP, rc);
    const r = s.cars[1]!;
    expect(r.speed).toBeCloseTo(0.7, 12);
    expect(r.bumpTicks).toBe(BUMP_TICKS);
    expect(r.vx).toBeCloseTo(-0.6, 12); // R42: side = sign(x - xT) = sign(-0.3) = -1
    expect(s.cars[2]!.speed).toBeCloseTo(0.9, 12); // R41 push
    expect(s.cars[2]!.bumpTicks).toBe(0);
  });
  it('side contact: speed 0.8 - 0.05 = 0.75, kick toward the side away from the traffic car', () => {
    const s = mkRace(1, 1, [
      FAR_PLAYER,
      after1({ z: 10, x: 0.1, speed: 0.8 }),
      after1({ z: 10, x: 0, speed: 0.6 }),
    ]);
    stepAll(s, BP, RC);
    const r = s.cars[1]!;
    expect(r.speed).toBeCloseTo(0.75, 12);
    expect(r.vx).toBeCloseTo(0.6, 12);
    expect(r.bumpTicks).toBe(BUMP_TICKS);
  });
  it('R43: no second contact while bumpTicks > 0 (the counter just counts down)', () => {
    const s = mkRace(1, 1, [
      FAR_PLAYER,
      { ...after1({ z: 10, x: 0.1, speed: 0.8 }), bumpTicks: 5 },
      after1({ z: 10, x: 0, speed: 0.6 }),
    ]);
    stepAll(s, BP, RC);
    expect(s.cars[1]!.speed).toBeCloseTo(0.8, 12);
    expect(s.cars[1]!.bumpTicks).toBe(4);
  });
  it('rival-traffic contact does not touch the player and the player-traffic R40 still works', () => {
    const s = mkRace(1, 1, [
      after1({ z: 10, x: 0.1, speed: 0.8 }),
      { z: 500, x: 0.5, speed: 0 },
      after1({ z: 10, x: 0, speed: 0.6 }),
    ]);
    stepAll(s, BP, RC);
    expect(s.cars[0]!.bumpTicks).toBe(BUMP_TICKS);
    expect(s.cars[1]!.bumpTicks).toBe(0);
  });
  it('rival with traffic in an adjacent lane is not bumped (|dx| 0.5 > 0.4)', () => {
    const s = mkRace(1, 1, [
      FAR_PLAYER,
      after1({ z: 10, x: 0.5, speed: 0.8 }),
      after1({ z: 10, x: 0, speed: 0.6 }),
    ]);
    stepAll(s, BP, RC);
    expect(s.cars[1]!.bumpTicks).toBe(0);
    expect(s.cars[1]!.speed).toBeCloseTo(0.8, 12);
  });
});

describe('R64 lamp crash (R47-R48) of a rival', () => {
  // Same geometry as crash.test.ts: speed 0.5 gives dz 0.25, 15.75 -> 16.0 stands on boundary 16.
  // crashTicks = 1.6 * 120 = 192; hit band |x| in (1.28, 1.52).
  const L: CarParams = {
    ...BP,
    lampEvery: 16,
    lampOffset: 1.4,
    lampHitW: 0.08,
    crashMinSpeed: 0.3,
    crashTime: 1.6,
    crashReturnX: 0.6,
    carHitW: 0.16,
    offroadMul: 1,
    vmax: 1,
  };
  const start = (x: number, speed = 0.5, z = 15.75) => mkRace(1, 0, [FAR_PLAYER, { z, x, speed }]);

  it('crossing boundary 16 at |x| = 1.4 on either side: crashTicks 192, crashSpeed0 = speed, crashX0 = x', () => {
    for (const x of [1.4, -1.4]) {
      const s = start(x);
      stepAll(s, L);
      const c = s.cars[1]!;
      expect(c.crashTicks, `x=${x}`).toBe(192);
      expect(c.crashSpeed0).toBeCloseTo(0.5, 12);
      expect(c.crashX0).toBeCloseTo(x, 12);
      expect(s.cars[0]!.crashTicks).toBe(0);
    }
  });
  it('no crash on the road, outside the band, below crashMinSpeed*vmax, or at a non-lamp boundary', () => {
    for (const [x, sp, z] of [
      [0.6, 0.5, 15.75],
      [1.53, 0.5, 15.75],
      [1.4, 0.3, 15.9],
      [1.4, 0.5, 16.75],
    ] as const) {
      const s = start(x, sp, z);
      stepAll(s, L);
      expect(s.cars[1]!.crashTicks, `x=${x} sp=${sp} z=${z}`).toBe(0);
    }
  });
  it('input is ignored during the crash: full steer + drift + brake equals idle, tick by tick', () => {
    const a = start(1.4);
    const b = start(1.4);
    stepAll(a, L);
    stepAll(b, L);
    for (let i = 0; i < 192; i++) {
      stepAll(a, L, RC, [IDLE, WILD]);
      stepAll(b, L, RC, [IDLE, IDLE]);
      expect(JSON.stringify(a), `tick ${i}`).toBe(JSON.stringify(b));
    }
  });
  it('the crash ends on the road: x = 0.6, speed 0, bumpTicks 96, crashTicks 0', () => {
    const s = start(1.4);
    stepAll(s, L);
    for (let i = 0; i < 192; i++) stepAll(s, L, RC, [IDLE, WILD]);
    const c = s.cars[1]!;
    expect(c.crashTicks).toBe(0);
    expect(c.x).toBeCloseTo(0.6, 9);
    expect(c.speed).toBeCloseTo(0, 9);
    expect(c.bumpTicks).toBe(BUMP_TICKS);
  });
  it('speed falls linearly from crashSpeed0 to 0 over the crash', () => {
    const s = start(-1.4);
    stepAll(s, L);
    for (let i = 1; i <= 191; i++) {
      stepAll(s, L, RC, [IDLE, WILD]);
      expect(s.cars[1]!.speed).toBeCloseTo(0.5 * (1 - i / 192), 9);
    }
  });
  it('another rival driving into a crashed rival makes no contact (R65: crashTicks > 0)', () => {
    const s = mkRace(2, 0, [
      FAR_PLAYER,
      { z: 100, x: 0.6, speed: 0, crashTicks: 50, crashSpeed0: 0.5, crashX0: 0.6 }, // x stays 0.6 (return point)
      { z: 100.2, x: 0.65, speed: 0.5 },
    ]);
    stepAll(s, L, RC);
    expect(s.cars[2]!.bumpTicks).toBe(0);
    expect(s.cars[2]!.speed).toBeCloseTo(0.5, 12);
  });
});

describe('R64 slipstream (R50-R52) is only for the player', () => {
  // Traffic 10 segments ahead in the same x, slower; 40 ticks of approach: the gap closes by about 6 segments.
  const D: CarParams = {
    ...baseCarA,
    accel: 0,
    draftLength: 30,
    draftWidth: 0.4,
    draftChargeTime: 0.5,
    carLength: 1.5,
  };
  const run = (index: 0 | 1): { draft: number; boost: number } => {
    const cars =
      index === 0
        ? [
            { z: 0, x: 0.3, speed: 0.5 },
            { z: 900, x: 0, speed: 0 },
            { z: 10, x: 0.3, speed: 0.2 },
          ]
        : [
            { z: 900, x: 0, speed: 0 },
            { z: 0, x: 0.3, speed: 0.5 },
            { z: 10, x: 0.3, speed: 0.2 },
          ];
    const s = mkRace(1, 1, cars);
    for (let i = 0; i < 40; i++) stepAll(s, D, RC);
    return { draft: s.cars[index]!.draft, boost: s.cars[index]!.boostTicks };
  };
  it('control: the player behind traffic charges the slipstream', () => {
    expect(run(0).draft).toBeGreaterThan(0.5);
  });
  it('a rival in exactly the same spot gets draft 0 and no boost', () => {
    const r = run(1);
    expect(r.draft).toBe(0);
    expect(r.boost).toBe(0);
  });
  it('the player right behind a rival gets no slipstream from it (only traffic is a source)', () => {
    const s = mkRace(1, 0, [
      { z: 0, x: 0.3, speed: 0.5 },
      { z: 10, x: 0.3, speed: 0.2 },
    ]);
    for (let i = 0; i < 40; i++) stepAll(s, D, RC);
    expect(s.cars[0]!.draft).toBe(0);
    expect(s.cars[0]!.boostTicks).toBe(0);
  });
});

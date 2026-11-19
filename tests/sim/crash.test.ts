import { describe, expect, it } from 'vitest';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState } from '../../src/sim/types';
import { baseCarA } from './baseCarA';
import { PB, STRAIGHT, car, inp, mk, stepB } from './modelb_helpers';

// Geometry: z advances by speed * DT * SEG_PER_UNIT = speed * 0.5 per tick. Speed 0.5 gives dz = 0.25
// (exact in binary), so z 15.75 -> 16.0 stands exactly on the boundary 16 and 15.7 -> 15.95 does not
// reach it. Params are explicit (accel 0, offroadMul 1, xLimit 2): speed and x stay constant on a
// straight road with zero input, so every expected number is hand-computable.
// Hit band: | |x| - 1.4 | < (carHitW + lampHitW)/2 = (0.16 + 0.08)/2 = 0.12 -> |x| in (1.28, 1.52).
// crashTicks = 1.6 * 120 = 192. bumpTicks after the crash = 0.8 * 120 = 96.
const LAMP = {
  lampEvery: 16,
  lampOffset: 1.4,
  lampHitW: 0.08,
  crashMinSpeed: 0.3,
  crashTime: 1.6,
  crashReturnX: 0.6,
  carHitW: 0.16,
  bumpInvulnTime: 0.8,
  offroadMul: 1,
  xLimit: 2,
  vmax: 1,
};
const CRASH_TICKS = 192;
const BUMP_TICKS = 96;

const MODELS: ReadonlyArray<readonly [string, CarParams]> = [
  ['model B', { ...PB, ...LAMP, accel: 0, slipDrag: 0 }],
  ['model A', { ...baseCarA, ...LAMP, accel: 0 }],
];

const IDLE: InputFrame = inp(0);
const WILD: InputFrame = inp(1, true, true);

/** One step from the given pre-step position; returns the player. */
function hit(p: CarParams, z: number, x: number, speed: number): Car {
  const s = mk({ z, x, speed });
  stepB(s, IDLE, p);
  return car(s);
}

/** Runs the crash to its last tick from a standard hit (z 15.75 -> 16.0 at speed 0.5). */
function startCrash(p: CarParams, x = 1.4, over: Partial<Car> = {}): RaceState {
  const s = mk({ z: 15.75, x, speed: 0.5, ...over });
  stepB(s, IDLE, p);
  expect(car(s).crashTicks).toBe(CRASH_TICKS);
  return s;
}

for (const [label, P] of MODELS) {
  describe(`R47 lamp post hit (${label})`, () => {
    it('crossing boundary 16 inside the band hits, on either side', () => {
      for (const x of [1.4, -1.4, 1.5, -1.5, 1.3, -1.3]) {
        expect(hit(P, 15.75, x, 0.5).crashTicks, `x=${x}`).toBe(CRASH_TICKS);
      }
    });

    it('standing exactly on the boundary counts as crossing (z 15.75 -> 16.0)', () => {
      expect(hit(P, 15.75, 1.4, 0.5).crashTicks).toBe(CRASH_TICKS);
    });

    it('crossing a later multiple of lampEvery (32) also hits', () => {
      expect(hit(P, 31.75, 1.4, 0.5).crashTicks).toBe(CRASH_TICKS);
    });

    it('starting exactly on the boundary and moving away does not hit (not crossed this step)', () => {
      // 16.0 -> 16.25
      expect(hit(P, 16, 1.4, 0.5).crashTicks).toBe(0);
    });

    it('band edge: |x| = 1.4 +- 0.119 hits, 1.4 +- 0.121 does not (outer and inner edge, both sides)', () => {
      for (const sign of [1, -1]) {
        expect(hit(P, 15.75, sign * 1.519, 0.5).crashTicks, 'outer in').toBe(CRASH_TICKS);
        expect(hit(P, 15.75, sign * 1.521, 0.5).crashTicks, 'outer out').toBe(0);
        expect(hit(P, 15.75, sign * 1.281, 0.5).crashTicks, 'inner in').toBe(CRASH_TICKS);
        expect(hit(P, 15.75, sign * 1.279, 0.5).crashTicks, 'inner out').toBe(0);
      }
    });

    it('no hit at a boundary whose index is not a multiple of lampEvery (8, 17); state untouched', () => {
      for (const z0 of [7.75, 16.75]) {
        const c = hit(P, z0, 1.4, 0.5);
        expect(c.crashTicks).toBe(0);
        expect(c.speed).toBeCloseTo(0.5, 12);
        expect(c.x).toBeCloseTo(1.4, 12);
        expect(c.bumpTicks).toBe(0);
      }
    });

    it('no hit on the road (x = 0, 0.6, 1.0) at a lamp boundary', () => {
      for (const x of [0, 0.6, -0.6, 1.0, -1.0]) {
        expect(hit(P, 15.75, x, 0.5).crashTicks, `x=${x}`).toBe(0);
      }
    });

    it('no hit when z does not reach the boundary (15.7 -> 15.95)', () => {
      expect(hit(P, 15.7, 1.4, 0.5).crashTicks).toBe(0);
    });

    it('speed threshold: speed > crashMinSpeed*vmax strictly', () => {
      // 0.3 is not > 0.3; 0.31 is. z 15.9 + 0.5*speed >= 16 for both.
      expect(hit(P, 15.9, 1.4, 0.3).crashTicks).toBe(0);
      expect(hit(P, 15.9, 1.4, 0.31).crashTicks).toBe(CRASH_TICKS);
      expect(hit(P, 15.9, 1.4, 0.2).crashTicks).toBe(0);
    });

    it('speed threshold scales with vmax (vmax 0.5: threshold 0.15)', () => {
      const p = { ...P, vmax: 0.5 };
      expect(hit(p, 15.9, 1.4, 0.14).crashTicks).toBe(0);
      expect(hit(p, 15.9, 1.4, 0.2).crashTicks).toBe(CRASH_TICKS);
    });

    it('no new hit while crashTicks > 0 (counter keeps counting down, is not reset)', () => {
      const s = mk({
        z: 15.75,
        x: 1.4,
        speed: 0.5,
        crashTicks: 100,
        crashSpeed0: 0.5,
        crashX0: 1.4,
      });
      stepB(s, IDLE, P);
      expect(car(s).crashTicks).toBe(99);
    });

    it('a hit is mirror-symmetric: crashX0 keeps the sign of x', () => {
      expect(Math.sign(hit(P, 15.75, 1.4, 0.5).crashX0)).toBe(1);
      expect(Math.sign(hit(P, 15.75, -1.4, 0.5).crashX0)).toBe(-1);
    });

    it('traffic never crashes; a rival crashes like the player (R64)', () => {
      for (const kind of ['rival', 'traffic'] as const) {
        const s = createRace(1, kind === 'rival' ? 2 : 1, kind === 'traffic' ? 1 : 0);
        const c = s.cars[1]!;
        c.kind = kind;
        c.z = 15.75;
        c.x = 1.4;
        c.speed = 0.5;
        Object.assign(c, { cruise: 0.5 }); // R41b (only matters for traffic)
        step(s, [IDLE, IDLE], STRAIGHT, [P, P]);
        if (kind === 'traffic') {
          expect(c.crashTicks, kind).toBe(0);
          expect(c.bumpTicks, kind).toBe(0);
          expect(c.speed, kind).toBeCloseTo(0.5, 12);
        } else {
          expect(c.crashTicks, kind).toBe(CRASH_TICKS);
          expect(c.crashSpeed0, kind).toBeCloseTo(0.5, 12);
          expect(c.crashX0, kind).toBeCloseTo(1.4, 9);
        }
      }
    });
  });

  describe(`R48 crash events and state reset (${label})`, () => {
    it.todo(
      'SimEvent "crash" with side = sign(x) is emitted on the hit tick (no event buffer in src/sim yet: see report)',
    );

    it('the hit stores crashSpeed0 = speed and crashX0 = x of the end of the step', () => {
      const c = car(startCrash(P, 1.37));
      expect(c.crashSpeed0).toBe(c.speed);
      expect(c.crashSpeed0).toBeCloseTo(0.5, 12);
      expect(c.crashX0).toBe(c.x);
      expect(c.crashX0).toBeCloseTo(1.37, 9);
    });

    it('GRIP, dir, vel, yaw, yawRate, carry, angle, vx, draft, boost, steer buffer are zeroed', () => {
      const s = mk({
        z: 15.75,
        x: 1.4,
        speed: 0.5,
        state: 'DRIFT',
        dir: 1,
        angle: 0.5,
        steer: 0.5,
        driftHeld: true,
        vel: 0.3,
        yaw: 0.4,
        yawRate: 0.2,
        carry: 0.1,
        vx: 0.05,
        draft: 0.7,
        boostTicks: 50,
        steerHist: new Array<number>(16).fill(0.5),
        steerHistHead: 3,
        steerHistCount: 10,
      });
      stepB(s, inp(0.5, true), P);
      const c = car(s);
      expect(c.crashTicks).toBe(CRASH_TICKS);
      expect(c.state).toBe('GRIP');
      expect(c.dir).toBe(0);
      expect(c.vel).toBe(0);
      expect(c.yaw).toBe(0);
      expect(c.yawRate).toBe(0);
      expect(c.carry).toBe(0);
      expect(c.angle).toBe(0);
      expect(c.vx).toBe(0);
      expect(c.draft).toBe(0);
      expect(c.boostTicks).toBe(0);
      expect(c.steerHistCount).toBe(0);
      // one more crash tick: steer 0 and the drift is not held
      stepB(s, inp(0.5, true), P);
      expect(c.steer).toBe(0);
      expect(c.driftHeld).toBe(false);
      expect(c.state).toBe('GRIP');
    });
  });

  describe(`R48 crash motion (${label})`, () => {
    for (const sign of [1, -1]) {
      it(`speed and x fall/move linearly, z keeps advancing, last tick values (side ${sign})`, () => {
        const s = startCrash(P, sign * 1.4);
        const c = car(s);
        const sp0 = c.crashSpeed0;
        const x0 = c.crashX0;
        const target = sign * 0.6;
        let n = 0;
        let lastZ = c.z;
        let lastSpeed = c.speed;
        while (c.crashTicks > 0 && n < 1000) {
          stepB(s, WILD, P);
          n++;
          const f = c.crashTicks / CRASH_TICKS;
          // linear in the remaining fraction f (1 at the hit, 0 at the end)
          expect(c.speed).toBeCloseTo(sp0 * f, 9);
          expect(c.x).toBeCloseTo(target + (x0 - target) * f, 9);
          // z grows by speed*0.5 of this tick: between the new and the previous speed
          const d = c.z - lastZ;
          expect(d).toBeGreaterThanOrEqual(c.speed * 0.5 - 1e-9);
          expect(d).toBeLessThanOrEqual(lastSpeed * 0.5 + 1e-9);
          lastZ = c.z;
          lastSpeed = c.speed;
        }
        expect(n).toBe(CRASH_TICKS);
        expect(c.x).toBeCloseTo(target, 9);
        expect(c.speed).toBeCloseTo(0, 9);
        expect(c.bumpTicks).toBe(BUMP_TICKS);
      });
    }

    it('input is ignored: full steer + drift + brake gives the same state as zero input', () => {
      const a = startCrash(P);
      const b = startCrash(P);
      for (let i = 0; i < CRASH_TICKS; i++) {
        stepB(a, WILD, P);
        stepB(b, IDLE, P);
        expect(JSON.stringify(a), `tick ${i}`).toBe(JSON.stringify(b));
      }
    });

    it('total distance of the crash is between 0 and crashSpeed0*0.5*192 (about 48 * 0.5 = 24 segments)', () => {
      const s = startCrash(P);
      const z0 = car(s).z;
      for (let i = 0; i < CRASH_TICKS; i++) stepB(s, IDLE, P);
      const d = car(s).z - z0;
      // linear fall 0.5 -> 0 over 192 ticks: sum of 0.25*f over f = 1/192 .. 1 -> about 24
      expect(d).toBeGreaterThan(23);
      expect(d).toBeLessThan(24.5);
    });

    it('no traffic bump during the crash', () => {
      const s = createRace(1, 1, 1);
      const pl = s.cars[0]!;
      pl.z = 15.75;
      pl.x = 1.4;
      pl.speed = 0.5;
      const t = s.cars[1]!;
      t.kind = 'traffic';
      t.z = 500;
      t.x = 0;
      t.speed = 0;
      step(s, [IDLE, IDLE], STRAIGHT, [P, P]);
      expect(pl.crashTicks).toBe(CRASH_TICKS);
      // park a standing traffic car right ahead in the player's lane: |dz| < 1.5, |dx| < 0.2
      t.z = pl.z + 0.3;
      t.x = pl.x;
      for (let i = 0; i < 40; i++) {
        step(s, [IDLE, IDLE], STRAIGHT, [P, P]);
        const f = pl.crashTicks / CRASH_TICKS;
        expect(pl.bumpTicks).toBe(0);
        expect(pl.vx).toBe(0);
        expect(pl.speed).toBeCloseTo(pl.crashSpeed0 * f, 9);
      }
    });

    it('after the crash: bumpTicks counts down, normal driving accelerates and steering works', () => {
      const run = (steer: number): Car => {
        const s = startCrash(P);
        for (let i = 0; i < CRASH_TICKS; i++) stepB(s, IDLE, P);
        expect(car(s).crashTicks).toBe(0);
        const drive: CarParams = { ...P, accel: 0.22 };
        let prev = car(s).speed;
        for (let i = 0; i < 100; i++) {
          stepB(s, inp(steer), drive);
          expect(car(s).speed).toBeGreaterThan(prev - 1e-12);
          prev = car(s).speed;
        }
        return car(s);
      };
      const straight = run(0);
      const right = run(1);
      expect(straight.speed).toBeGreaterThan(0.05);
      expect(straight.crashTicks).toBe(0);
      expect(straight.bumpTicks).toBe(0); // 96 - 100 -> floored at 0
      expect(Math.abs(right.x - straight.x)).toBeGreaterThan(0.01);
      expect(right.x).toBeGreaterThan(straight.x);
    });

    it('bumpTicks after the last crash tick counts 96, 95, ...', () => {
      const s = startCrash(P);
      for (let i = 0; i < CRASH_TICKS; i++) stepB(s, IDLE, P);
      expect(car(s).bumpTicks).toBe(BUMP_TICKS);
      for (let i = 1; i <= 10; i++) {
        stepB(s, IDLE, { ...P, accel: 0.22 });
        expect(car(s).bumpTicks).toBe(BUMP_TICKS - i);
      }
    });

    it('determinism: same inputs twice -> identical state JSON; mid-crash round-trip continues identically', () => {
      const play = (mid?: boolean): string => {
        let s = mk({ z: 14, x: 1.4, speed: 0.6 });
        for (let i = 0; i < 400; i++) {
          stepB(s, inp(Math.sin(i / 7), i % 50 < 25), i < 30 ? P : { ...P, accel: 0.22 });
          if (mid && i === 100) s = JSON.parse(JSON.stringify(s)) as RaceState;
        }
        return JSON.stringify(s);
      };
      expect(play()).toBe(play());
      expect(play(true)).toBe(play());
    });
  });

  describe(`R49 criterion: lamp crash costs at least 2 s (${label})`, () => {
    it('a car aimed along x = 1.4 reaches z = 400 at least 240 ticks later than a free run', () => {
      const drive: CarParams = { ...P, accel: 0.22 };
      const ticksTo = (x: number): number => {
        const s = mk({ z: 15, x, speed: 0.8 });
        let n = 0;
        while (car(s).z < 400 && n < 20000) {
          stepB(s, IDLE, drive);
          n++;
        }
        return n;
      };
      const free = ticksTo(0);
      const crashed = ticksTo(1.4);
      expect(crashed - free).toBeGreaterThanOrEqual(240);
    });
  });
}

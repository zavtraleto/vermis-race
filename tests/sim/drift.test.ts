import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { loadTestTwisty } from '../../src/data/tracks';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, RaceState } from '../../src/sim/types';
import { constTrack, inp, oneCar } from './driving_helpers';

/**
 * Stage 2 drift rules R20, R21, R22 (brief section 4, "Drift (stage 2)").
 * Step order: R10 -> transitions R20/R21 -> lateral target (R11 or R22) -> R12 -> R13/R19 -> R18
 * -> R14 -> R15 -> R17 -> R16. So transitions see the smoothed steer after R10, the position and
 * speed from the START of the step (speed before R14).
 * Params are explicit here, never read from base.json (new fields are not in CarParams yet).
 */
interface DriftExtra {
  driftEnterSpeed: number;
  driftEnterSteer: number;
  driftExitSpeed: number;
  driftOffroadTime: number;
  driftSteerMin: number;
  driftSteerMax: number;
}
type DP = CarParams & DriftExtra;
type DCar = Car & { offTicks: number };

const P = {
  ...baseCar,
  driftRate: 0.7,
  driftEnterSpeed: 0.45,
  driftEnterSteer: 0.2,
  driftExitSpeed: 0.3,
  driftOffroadTime: 0.4,
  driftSteerMin: 0.25,
  driftSteerMax: 1.75,
} as unknown as DP;
/** accel 0: a manually set speed stays constant (R14) unless the test wants otherwise. */
const PC = { ...P, accel: 0 } as DP;

const track0 = constTrack(0);
const car = (s: RaceState): DCar => s.cars[0] as DCar;
const drifting = (over: Partial<Car> = {}): RaceState =>
  oneCar({ state: 'DRIFT', dir: 1, speed: 0.8, steer: 0.6, ...over });
const one = (s: RaceState, i: InputFrame, t = track0, p: CarParams = P): void =>
  step(s, [i], t, [p]);

/** R12 with explicit grip. */
const r12 = (vx: number, tgt: number, g: number): number =>
  vx + (tgt - vx) * (1 - Math.exp(-g * DT));
/** R22 lateral target; sp = speed before R14. */
const r22Target = (steer: number, dir: number, sp: number, p: DP): number =>
  dir *
  (p.driftSteerMin + (p.driftSteerMax - p.driftSteerMin) * ((steer * dir + 1) / 2)) *
  p.driftRate *
  sp;

describe('R20 GRIP -> DRIFT', () => {
  const base = (): RaceState => oneCar({ speed: 0.8, steer: 0.5 });

  it('R20 enters DRIFT with dir = +1 when all four conditions hold (steer right)', () => {
    const s = base();
    one(s, inp(0.5, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
  it('R20 enters DRIFT with dir = -1 (steer left)', () => {
    const s = oneCar({ speed: 0.8, steer: -0.5 });
    one(s, inp(-0.5, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(-1);
  });
  it('R20 no drift input: stays GRIP, dir 0', () => {
    const s = base();
    one(s, inp(0.5, false, false), track0, PC);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
  });
  it('R20 speed <= driftEnterSpeed*vmax (0.45): stays GRIP; just above enters', () => {
    // vmax = 1 so the threshold is 0.45; accel 0 keeps speed fixed. Strict ">" at the boundary.
    const a = oneCar({ speed: 0.44, steer: 0.5 });
    one(a, inp(0.5, false, true), track0, PC);
    expect(car(a).state).toBe('GRIP');
    const b = oneCar({ speed: 0.46, steer: 0.5 });
    one(b, inp(0.5, false, true), track0, PC);
    expect(car(b).state).toBe('DRIFT');
  });
  it('R20 speed threshold scales with vmax', () => {
    // vmax 2: threshold is 0.9. speed 0.8 < 0.9 stays GRIP, speed 1.0 > 0.9 enters.
    const p2 = { ...PC, vmax: 2 } as DP;
    const a = oneCar({ speed: 0.8, steer: 0.5 });
    one(a, inp(0.5, false, true), track0, p2);
    expect(car(a).state).toBe('GRIP');
    const b = oneCar({ speed: 1.0, steer: 0.5 });
    one(b, inp(0.5, false, true), track0, p2);
    expect(car(b).state).toBe('DRIFT');
  });
  it('R20 |steer| <= driftEnterSteer (0.2): stays GRIP', () => {
    const s = oneCar({ speed: 0.8, steer: 0.1 });
    one(s, inp(0.1, false, true), track0, PC);
    expect(car(s).state).toBe('GRIP');
    const t = oneCar({ speed: 0.8, steer: -0.1 });
    one(t, inp(-0.1, false, true), track0, PC);
    expect(car(t).state).toBe('GRIP');
  });
  it('R20 uses the SMOOTHED steer after R10, not the raw input', () => {
    // steerRise 10/s, DT = 1/120: steer 0 -> 0.0833, 0.1667, 0.25 on steps 1, 2, 3 with input 1.
    // 0.0833 and 0.1667 are <= 0.2, 0.25 > 0.2: DRIFT begins exactly on the third step.
    const s = oneCar({ speed: 0.8, steer: 0 });
    one(s, inp(1, false, true), track0, PC);
    expect(car(s).state).toBe('GRIP');
    one(s, inp(1, false, true), track0, PC);
    expect(car(s).state).toBe('GRIP');
    one(s, inp(1, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
  it('R20 off road (|x| > 1): stays GRIP; |x| = 1 exactly still enters', () => {
    const a = oneCar({ speed: 0.8, steer: 0.5, x: 1.2 });
    one(a, inp(0.5, false, true), track0, PC);
    expect(car(a).state).toBe('GRIP');
    const b = oneCar({ speed: 0.8, steer: 0.5, x: -1.2 });
    one(b, inp(0.5, false, true), track0, PC);
    expect(car(b).state).toBe('GRIP');
    const c = oneCar({ speed: 0.8, steer: 0.5, x: 1 });
    one(c, inp(0.5, false, true), track0, PC);
    expect(car(c).state).toBe('DRIFT');
  });
  it('R20 dir does not flip when steer changes sign during the drift', () => {
    const s = oneCar({ speed: 0.8, steer: 0.5 });
    one(s, inp(0.5, false, true), track0, PC);
    expect(car(s).dir).toBe(1);
    let crossed = false;
    for (let i = 0; i < 40; i++) {
      one(s, inp(-1, false, true), track0, PC);
      if (car(s).steer < 0) crossed = true;
      expect(car(s).state).toBe('DRIFT');
      expect(car(s).dir).toBe(1);
    }
    expect(crossed).toBe(true);
  });
  it('R20 mirror: dir -1 also keeps its side when steer turns positive', () => {
    const s = oneCar({ speed: 0.8, steer: -0.5 });
    one(s, inp(-0.5, false, true), track0, PC);
    expect(car(s).dir).toBe(-1);
    for (let i = 0; i < 40; i++) {
      one(s, inp(1, false, true), track0, PC);
      expect(car(s).dir).toBe(-1);
      expect(car(s).state).toBe('DRIFT');
    }
  });
});

describe('R21 DRIFT -> GRIP', () => {
  it('R21 createRace initialises offTicks to 0', () => {
    const s = createRace(7, 3);
    for (const c of s.cars) expect((c as DCar).offTicks).toBe(0);
  });
  it('R21 drift input released: GRIP and dir 0 on that very step', () => {
    const s = drifting();
    one(s, inp(0.6, false, false), track0, PC);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
  });
  it('R21 drift held keeps DRIFT (control)', () => {
    const s = drifting();
    one(s, inp(0.6, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
  it('R21 forced exit when speed < driftExitSpeed*vmax (0.3), drift still held', () => {
    const s = drifting({ speed: 0.29 });
    one(s, inp(0.6, false, true), track0, PC);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
  });
  it('R21 speed above the threshold does not exit', () => {
    const s = drifting({ speed: 0.31 });
    one(s, inp(0.6, false, true), track0, PC);
    expect(car(s).state).toBe('DRIFT');
  });
  it('R21 braking in drift ends it once speed (before R14) is below 0.3*vmax', () => {
    // brake 0.6/s: 0.005 per tick, from 0.5 the speed passes 0.3 after about 40 ticks.
    const s = drifting({ speed: 0.5 });
    let exitTick = -1;
    for (let i = 0; i < 120; i++) {
      const before = car(s).speed;
      one(s, inp(0.6, true, true));
      if (car(s).state === 'GRIP') {
        exitTick = i;
        expect(before).toBeLessThan(0.3);
        expect(car(s).dir).toBe(0);
        break;
      }
      expect(before).toBeGreaterThanOrEqual(0.3 - 1e-12);
    }
    expect(exitTick).toBeGreaterThan(30);
    expect(exitTick).toBeLessThan(60);
  });
  it('R21 forced exit after driftOffroadTime (0.4 s = 48 ticks) of consecutive off-road time', () => {
    // x = 1.5, steer right, dir +1: the target pushes outward, the car stays off road (x clamps at 2).
    // Speed starts at vmax; R15 0.97^0.5 per tick keeps it above 0.3 for 52 ticks (0.985^52 ~ 0.46).
    // Exact counter convention (before/after the check) is not pinned: 40 ticks must still be DRIFT,
    // 52 ticks must be GRIP (48 ticks = 0.4 s, "longer than" => 49th tick or so).
    const s = drifting({ x: 1.5, speed: 1 });
    for (let i = 0; i < 40; i++) {
      one(s, inp(0.6, false, true));
      expect(Math.abs(car(s).x)).toBeGreaterThan(1);
      expect(car(s).state).toBe('DRIFT');
    }
    expect(car(s).offTicks).toBeGreaterThanOrEqual(39);
    expect(car(s).offTicks).toBeLessThanOrEqual(41);
    for (let i = 0; i < 12; i++) one(s, inp(0.6, false, true));
    expect(car(s).speed).toBeGreaterThan(0.3);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
  });
  it('R21 off-road exit works on the left side too', () => {
    const s = drifting({ x: -1.5, speed: 1, steer: -0.6, dir: -1 });
    for (let i = 0; i < 52; i++) one(s, inp(-0.6, false, true));
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
  });
  it('R21 offTicks resets on road and only consecutive off-road time counts', () => {
    const s = drifting({ x: 1.5, speed: 1 });
    for (let i = 0; i < 30; i++) one(s, inp(0.6, false, true));
    expect(car(s).offTicks).toBeGreaterThanOrEqual(29);
    car(s).x = 0.5; // back on the asphalt
    one(s, inp(0.6, false, true));
    expect(car(s).offTicks).toBe(0);
    expect(car(s).state).toBe('DRIFT');
    car(s).x = 1.5; // off again: 30 + 30 > 48 ticks in total, but never 48 in a row
    for (let i = 0; i < 30; i++) one(s, inp(0.6, false, true));
    expect(car(s).speed).toBeGreaterThan(0.3);
    expect(car(s).state).toBe('DRIFT');
  });
  it('R21 offTicks stays 0 while on the road', () => {
    const s = drifting();
    for (let i = 0; i < 50; i++) one(s, inp(0.6, false, true), track0, PC);
    expect(car(s).offTicks).toBe(0);
  });
  it('R3 state mid-drift is flat JSON: a round trip continues identically', () => {
    const track = constTrack(2.5);
    const a = drifting({ x: 0.2 });
    for (let i = 0; i < 60; i++) one(a, inp(0.3, false, true), track);
    expect(car(a).state).toBe('DRIFT');
    const b: RaceState = JSON.parse(JSON.stringify(a));
    expect(b).toEqual(a);
    for (let i = 0; i < 90; i++) {
      one(a, inp(0.3, false, true), track);
      one(b, inp(0.3, false, true), track);
    }
    expect(b).toEqual(a);
    expect(typeof car(b).offTicks).toBe('number');
  });
});

describe('R22 drift physics', () => {
  it('R22 vx, x, speed after one step with a known state (right, curve 2)', () => {
    // sp = 0.8, steer 0.6 (input 0.6, so R10 keeps it), dir +1.
    // lerp(0.25, 1.75, (0.6*1+1)/2 = 0.8) = 0.25 + 1.5*0.8 = 1.45
    // target = 1 * 1.45 * 0.7 * 0.8 = 0.812
    // R12 grip 3: k = 1 - exp(-3/120) = 0.0246901; vx = 0.3 + (0.812-0.3)*0.0246901 = 0.312641
    // R13 push = 2 * 0.64 * 0.3 * 0.35 * 1.5 = 0.2016 per second -> 0.2016/120 = 0.00168
    // x = 0.312641/120 - 0.00168 = 0.0026053 - 0.00168 = 0.0009253
    // speed = 0.8 + (0.22 - 0.03*1)/120 = 0.8 + 0.0015833 = 0.8015833
    const s = drifting({ vx: 0.3 });
    one(s, inp(0.6, false, true), constTrack(2));
    const k = 1 - Math.exp(-3 * DT);
    const vx = 0.3 + (0.812 - 0.3) * k;
    expect(car(s).vx).toBeCloseTo(vx, 9);
    expect(car(s).vx).toBeCloseTo(0.312641, 5);
    expect(car(s).x).toBeCloseTo(vx * DT - 0.2016 * DT, 9);
    expect(car(s).x).toBeCloseTo(0.0009253, 6);
    expect(car(s).speed).toBeCloseTo(0.8 + 0.19 * DT, 9);
    expect(car(s).state).toBe('DRIFT');
  });
  it('R22 mirror: left drift gives exactly negated x and vx, same speed', () => {
    const r = drifting({ vx: 0.3 });
    const l = drifting({ vx: -0.3, steer: -0.6, dir: -1 });
    for (let i = 0; i < 30; i++) {
      one(r, inp(0.6, false, true), constTrack(2));
      one(l, inp(-0.6, false, true), constTrack(-2));
    }
    expect(car(l).x).toBeCloseTo(-car(r).x, 12);
    expect(car(l).vx).toBeCloseTo(-car(r).vx, 12);
    expect(car(l).speed).toBeCloseTo(car(r).speed, 12);
  });
  it('R22 vx follows dir*lerp(min,max,(steer*dir+1)/2)*driftRate*sp with gripDrift 3 (several steer values)', () => {
    for (const steer of [-1, -0.5, 0, 0.4, 1]) {
      const s = drifting({ steer, vx: 0.1 });
      one(s, inp(steer, false, true), track0, PC);
      const sp = 0.8; // speed before R14 (accel 0 anyway)
      const exp = r12(0.1, r22Target(steer, 1, sp, PC), PC.gripDrift);
      expect(car(s).vx).toBeCloseTo(exp, 10);
    }
  });
  it('R22 uses sp from the speed BEFORE R14 (accel 0.22 does not leak into the target)', () => {
    const s = drifting({ speed: 0.8, vx: 0 });
    one(s, inp(0.6, false, true), track0, P);
    expect(car(s).vx).toBeCloseTo(r12(0, r22Target(0.6, 1, 0.8, P), 3), 12);
  });
  it('R22 gripDrift (3) is used, not grip (12)', () => {
    const s = drifting({ vx: 0 });
    one(s, inp(0.6, false, true), track0, PC);
    const withGrip = r12(0, 0.812, 12);
    const withDrift = r12(0, 0.812, 3);
    expect(Math.abs(car(s).vx - withDrift)).toBeLessThan(1e-10);
    expect(Math.abs(car(s).vx - withGrip)).toBeGreaterThan(1e-3);
  });
  it('R22 centrifugal push uses centMulDrift (0.35): x after one step with vx pinned at target', () => {
    // vx = target exactly => R12 keeps it. steer 0.6, sp 0.8: target 0.812, curve 4.5.
    // push = 4.5*0.64*0.3*0.35*1.5 = 0.4536 per s. x = (0.812 - 0.4536)/120 = 0.0029867
    const s = drifting({ vx: 0.812 });
    one(s, inp(0.6, false, true), constTrack(4.5), PC);
    expect(car(s).x).toBeCloseTo((0.812 - 0.4536) * DT, 10);
  });
  it('R22 without brake speed grows by (accel - driftDrag*vmax)*DT', () => {
    const s = drifting({ speed: 0.7 });
    one(s, inp(0.6, false, true));
    // (0.22 - 0.03*1)/120 = 0.0015833
    expect(car(s).speed).toBeCloseTo(0.7 + (0.22 - 0.03) * DT, 12);
  });
  it('R22 with brake speed falls by brake*DT (no drag term)', () => {
    const s = drifting({ speed: 0.7 });
    one(s, inp(0.6, true, true));
    expect(car(s).speed).toBeCloseTo(0.7 - 0.6 * DT, 12);
  });
  it('R22 speed in drift never exceeds vmax', () => {
    const s = drifting({ speed: 1 });
    for (let i = 0; i < 20; i++) one(s, inp(0.6, false, true));
    expect(car(s).speed).toBeLessThanOrEqual(1);
  });
  it('R22 R15b multipliers are not applied in DRIFT off road, R15 slowdown is', () => {
    // x = 1.5, offroadGrip 20 and offroadSteerMul 0.5 must be ignored in DRIFT.
    // vx = 0.3 + (0.812-0.3)*(1-exp(-3/120)) = 0.312641 (gripDrift, full target)
    // x = 1.5 + 0.312641/120. speed = (0.8 + 0.19/120) * 0.97^(60/120) (R15, x > 1).
    const p = { ...P, offroadGrip: 20, offroadSteerMul: 0.5 } as DP;
    const s = drifting({ x: 1.5, vx: 0.3 });
    one(s, inp(0.6, false, true), track0, p);
    const vx = r12(0.3, 0.812, 3);
    expect(car(s).vx).toBeCloseTo(vx, 10);
    expect(car(s).x).toBeCloseTo(1.5 + vx * DT, 10);
    expect(car(s).speed).toBeCloseTo((0.8 + 0.19 * DT) * Math.pow(0.97, 60 * DT), 10);
  });
  it('R22 steer inward gives a larger |target| than steer outward (same dir)', () => {
    // inward steer*dir = +0.8: lerp = 0.25+1.5*0.9 = 1.6; outward -0.8: 0.25+1.5*0.1 = 0.4
    const inward = drifting({ steer: 0.8, vx: 0 });
    const outward = drifting({ steer: -0.8, vx: 0 });
    one(inward, inp(0.8, false, true), track0, PC);
    one(outward, inp(-0.8, false, true), track0, PC);
    expect(Math.abs(car(inward).vx)).toBeGreaterThan(Math.abs(car(outward).vx));
    expect(car(inward).vx).toBeCloseTo(r12(0, 1.6 * 0.7 * 0.8, 3), 10);
    expect(car(outward).vx).toBeCloseTo(r12(0, 0.4 * 0.7 * 0.8, 3), 10);
  });
  it('R22 |target| is monotonic in steer*dir and symmetric for dir -1', () => {
    let prev = -Infinity;
    for (let k = -10; k <= 10; k++) {
      const steer = k / 10;
      const r = drifting({ steer, vx: 0 });
      const l = drifting({ steer: -steer, vx: 0, dir: -1 });
      one(r, inp(steer, false, true), track0, PC);
      one(l, inp(-steer, false, true), track0, PC);
      expect(car(l).vx).toBeCloseTo(-car(r).vx, 12);
      expect(car(r).vx).toBeGreaterThan(prev);
      prev = car(r).vx;
    }
  });
  it('R22 position is bounded by R18 xLimit in drift', () => {
    const s = drifting({ x: 1.9, vx: 2 });
    for (let i = 0; i < 20; i++) one(s, inp(1, false, true), track0, PC);
    expect(car(s).x).toBeLessThanOrEqual(P.xLimit);
  });
});

describe('R2 determinism with drift input', () => {
  it('R2 two identical runs with drift on twisty are bit-identical, and drift actually happens', () => {
    const track = buildTrack(loadTestTwisty().def);
    const script = (t: number): InputFrame => ({
      steer: ((t * 7) % 40) / 20 - 1,
      brake: t % 313 > 300,
      drift: t % 200 < 150,
    });
    const runOnce = (): { s: RaceState; sawDrift: boolean } => {
      const s = createRace(42, 1);
      let sawDrift = false;
      for (let i = 0; i < 1500; i++) {
        step(s, [script(s.tick)], track, [P]);
        if (s.cars[0]!.state === 'DRIFT') sawDrift = true;
      }
      return { s, sawDrift };
    };
    const a = runOnce();
    const b = runOnce();
    expect(a.sawDrift).toBe(true);
    expect(JSON.stringify(b.s)).toBe(JSON.stringify(a.s));
    expect(b.s).toStrictEqual(a.s);
  });
});

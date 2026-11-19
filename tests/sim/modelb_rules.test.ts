// Driving model B (H14), rules R80-R88 of docs/brief.md. One describe per rule id.
// Expected numbers are hand-derived from the brief formulas; arithmetic is in the comments.
//
// Reading of the update order inside one tick (brief "Порядок в шаге модели B"):
//   R80 steer -> R81 flick check (state GRIP) then the current steer is recorded -> R82 exit ->
//   R83 body (parameters of the state AFTER R81/R82) -> R84 motion -> R85 shift -> R86 speed.
//   sp = speed / vmax taken at the start of R83 (R14/R86 change speed only afterwards).
// All rule tests run with Q (accel 0, slipDrag 0) unless the rule is about speed, so speed is
// constant over a tick. Cars start with recover = 10 (full grip) unless a test says otherwise.
import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { DT, STEER_HIST } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { CarParams, RaceState } from '../../src/sim/types';
import {
  PB,
  Q,
  STRAIGHT,
  car,
  chase,
  constTrack,
  inp,
  mk as mk0,
  slipOf,
  stepB,
  stepN,
  withHistory,
} from './modelb_helpers';

/** Car with full grip recovered (recover = 10 s >= gripRecoverTime). */
function mk(over: Partial<ReturnType<typeof car>> = {}): RaceState {
  return mk0({ recover: 10, ...over });
}

describe('R80 raw steer', () => {
  it('steer equals the clamped input on the same tick, no R10 slew', () => {
    const s = mk({ speed: 0.8 });
    stepB(s, inp(0.7));
    // model A would give steerRise * DT = 10/120 = 0.0833; model B gives the input itself.
    expect(car(s).steer).toBe(0.7);
    stepB(s, inp(-0.2));
    expect(car(s).steer).toBe(-0.2);
  });
  it('clamps to [-1, 1]', () => {
    const s = mk({ speed: 0.8 });
    stepB(s, inp(5));
    expect(car(s).steer).toBe(1);
    stepB(s, inp(-5));
    expect(car(s).steer).toBe(-1);
  });
});

describe('R81 flick entry', () => {
  // Straight track (A = 0), speed 0.8 (f = min(1, 0.8/0.3) = 1), history: -0.3 for 5 ticks, then 0.3.
  // d = 0.3 - (-0.3) = 0.6, |d| - flickDelta = 0.1, kick = 8 + 15*0.1 = 9.5, dir = +1.
  // R83 runs with DRIFT parameters (state is DRIFT by then): Y = 43.6, al = 6, r = 12.
  //   yawRate1 = yawRate0 + 9.5 (R81)
  //   yawRate2 = yawRate1 + (steer*Y*f - al*yaw0 - yawRate1) * (1 - exp(-12*DT))
  //   yaw1     = yaw0 + (yawRate2 - A)*DT, A = 0
  const yaw0 = 0.1;
  const yr0 = 0.2;
  const entry = (prev: number, last: number, sign = 1) => {
    const s = withHistory({ speed: 0.8, recover: 10 }, Array<number>(5).fill(prev * sign), true);
    Object.assign(car(s), { yaw: yaw0 * sign, yawRate: yr0 * sign, vel: 0.05 * sign });
    stepB(s, inp(last * sign, true));
    return s;
  };
  const expectedYawRate = (d: number, steer: number) => {
    const kick = 8 + 15 * (d - 0.5);
    const yr1 = yr0 + kick;
    return yr1 + (steer * 43.6 - 6 * yaw0 - yr1) * chase(12);
  };

  it('R81 enters DRIFT with dir = sign of the change and the hand-computed kick', () => {
    const s = entry(-0.3, 0.3);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
    const yr2 = expectedYawRate(0.6, 0.3);
    expect(car(s).yawRate).toBeCloseTo(yr2, 9);
    expect(car(s).yaw).toBeCloseTo(yaw0 + yr2 * DT, 9);
  });
  it('R81 a flick from -0.3 to +0.3 (|d| 0.6) enters to the right', () => {
    const s = entry(-0.3, 0.3);
    expect(car(s).dir).toBe(1);
    expect(car(s).yawRate).toBeGreaterThan(yr0);
  });
  it('R81 left flick is the mirror image (dir -1, negated state)', () => {
    const a = entry(-0.3, 0.3, 1);
    const b = entry(-0.3, 0.3, -1);
    expect(car(b).state).toBe('DRIFT');
    expect(car(b).dir).toBe(-1);
    expect(car(b).yawRate).toBeCloseTo(-car(a).yawRate, 9);
    expect(car(b).yaw).toBeCloseTo(-car(a).yaw, 9);
  });
  it('R81 a bigger flick gives a bigger kick (same final steer)', () => {
    const small = entry(-0.3, 0.3); // d = 0.6, kick 9.5
    const big = entry(-0.7, 0.3); // d = 1.0, kick 8 + 15*0.5 = 15.5
    expect(car(big).state).toBe('DRIFT');
    expect(car(big).yawRate).toBeGreaterThan(car(small).yawRate);
    expect(car(big).yawRate).toBeCloseTo(expectedYawRate(1.0, 0.3), 9);
    // the difference before the chase is 6; the chase keeps (1 - chase(12)) of it
    expect(car(big).yawRate - car(small).yawRate).toBeCloseTo(6 * (1 - chase(12)), 9);
  });
  it('R81 a slow ramp of the same size never enters', () => {
    // 0 -> 1 over 60 ticks: at most 14 ticks * (1/60) = 0.233 < flickDelta inside any window.
    const s = mk({ speed: 0.8 });
    for (let i = 0; i <= 60; i++) {
      stepB(s, inp(i / 60, true));
      expect(car(s).state).toBe('GRIP');
    }
    // and a longer ramp -0.3 -> 0.3 over 40 ticks
    const t = mk({ speed: 0.8 });
    for (let i = 0; i <= 40; i++) {
      stepB(t, inp(-0.3 + (0.6 * i) / 40, true));
      expect(car(t).state).toBe('GRIP');
    }
  });
  it('R81 no entry without input.drift', () => {
    const s = withHistory({ speed: 0.8, recover: 10 }, Array<number>(5).fill(-0.3), false);
    stepB(s, inp(0.3, false));
    expect(car(s).state).toBe('GRIP');
  });
  it('R81 no entry at or below driftEnterSpeed*vmax, entry above it', () => {
    const slow = withHistory({ speed: 0.44, recover: 10 }, Array<number>(5).fill(-0.3), true);
    stepB(slow, inp(0.3, true));
    expect(car(slow).state).toBe('GRIP'); // 0.44 < 0.45
    const fast = withHistory({ speed: 0.5, recover: 10 }, Array<number>(5).fill(-0.3), true);
    stepB(fast, inp(0.3, true));
    expect(car(fast).state).toBe('DRIFT'); // 0.5 > 0.45
  });
  it('R81 the buffer is written every tick, also with drift input released', () => {
    // history recorded with drift released; the flick is found on the first drift-held tick.
    const s = withHistory({ speed: 0.8, recover: 10 }, Array<number>(5).fill(-0.3), false);
    expect(car(s).steerHistCount).toBe(5);
    stepB(s, inp(0.3, true));
    expect(car(s).state).toBe('DRIFT');
  });
  it('R81 the buffer is written every tick, also in DRIFT', () => {
    // DRIFT with steer -0.3 for 5 ticks, release (-> GRIP, steer 0.3), press again with steer 0.3.
    // Look-back at the last tick finds -0.3 recorded during DRIFT: d = 0.6 -> entry.
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: -1 });
    stepN(s, 5, inp(-0.3, true));
    expect(car(s).state).toBe('DRIFT');
    stepB(s, inp(0.3, false));
    expect(car(s).state).toBe('GRIP');
    stepB(s, inp(0.3, true));
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
  it('R81 only samples inside flickWindow count (0.12 s = 14.4 ticks)', () => {
    // one -0.3 sample, then n ticks of +0.3, then the flick tick: the old sample is n+1 ticks back.
    const run = (n: number) => {
      const s = withHistory({ speed: 0.8, recover: 10 }, [-0.3, ...Array<number>(n).fill(0.3)], false);
      stepB(s, inp(0.3, true));
      return car(s).state;
    };
    expect(run(9)).toBe('DRIFT'); // 10 ticks = 0.083 s ago
    expect(run(19)).toBe('GRIP'); // 20 ticks = 0.167 s ago
  });
  it('R81 fresh race: the zero-filled buffer gives no false flick', () => {
    const s = createRace(1, 1);
    car(s).speed = 0.8;
    car(s).recover = 10;
    expect(car(s).steerHist).toHaveLength(STEER_HIST);
    expect(car(s).steerHistCount).toBe(0);
    stepB(s, inp(0.6, true)); // would be d = 0.6 against a zero sample
    expect(car(s).state).toBe('GRIP');
    stepB(s, inp(0.6, true));
    stepB(s, inp(0.6, true));
    expect(car(s).state).toBe('GRIP');
  });
  it('R81 steerHistCount grows by one per tick up to STEER_HIST; head stays in range', () => {
    const s = mk({ speed: 0.8 });
    for (let i = 1; i <= STEER_HIST + 5; i++) {
      stepB(s, inp(0.1));
      expect(car(s).steerHistCount).toBe(Math.min(i, STEER_HIST));
      expect(car(s).steerHistHead).toBeGreaterThanOrEqual(0);
      expect(car(s).steerHistHead).toBeLessThan(STEER_HIST);
      expect(car(s).steerHist).toHaveLength(STEER_HIST);
    }
  });
  it('R81 STEER_HIST covers flickWindow with margin', () => {
    expect(STEER_HIST * DT).toBeGreaterThan(PB.flickWindow + 0.01);
  });
});

describe('R82 exit', () => {
  // DRIFT at speed 0.8, steer 0, straight. After exit recover = 0, so R83/R84 in the same tick use
  // DRIFT parameters (k = min(1, 0/0.25) = 0): al = 6, r = 12, g = 6.3, smax = 3.
  it('R82 release of input.drift ends the drift: GRIP, dir 0, recover 0', () => {
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1 });
    stepB(s, inp(0, false));
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    // recover is 0 at the exit; whether the same tick already adds DT is an ambiguity (see report)
    expect(car(s).recover).toBeGreaterThanOrEqual(0);
    expect(car(s).recover).toBeLessThanOrEqual(DT + 1e-12);
  });
  it('R82 speed below driftExitSpeed*vmax ends the drift', () => {
    const s = mk({ speed: 0.29, state: 'DRIFT', dir: 1 });
    stepB(s, inp(0, true));
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
  });
  it('R82 above the exit speed with input held the drift stays', () => {
    const s = mk({ speed: 0.31, state: 'DRIFT', dir: 1 });
    stepB(s, inp(0, true));
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
  it('R82 no exit at small angle: DRIFT holds at zero slip for 2 s while input is held', () => {
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1 });
    stepN(s, 240, inp(0, true));
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
  // snap: yaw 1.5, vel 0 -> slip 1.5 > slipSnapMax 1.2.
  //   R82: vel = 0 + 1.5*0.5 = 0.75; speed = 0.8 - 0.04*1 = 0.76
  //   R83 (k = 0): yawRate = (0 - 6*1.5 - 0)*(1 - exp(-12 DT)); yaw1 = 1.5 + yawRate*DT
  //   R84: vel = 0.75 + 6.3*clamp(yaw1 - 0.75, +-3)*DT
  const afterSnap = (yaw: number) => {
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1, yaw, vel: 0 });
    stepB(s, inp(0, false));
    return s;
  };
  it('R82 snap above slipSnapMax: vel += slip*snapCatch, speed -= snapLoss*vmax', () => {
    const yr = -6 * 1.5 * chase(12);
    const yaw1 = 1.5 + yr * DT;
    const vel2 = 0.75 + 6.3 * (yaw1 - 0.75) * DT;
    const s = afterSnap(1.5);
    expect(car(s).speed).toBeCloseTo(0.76, 12);
    expect(car(s).vel).toBeCloseTo(vel2, 9);
  });
  it('R82 snap works for negative slip (mirror)', () => {
    const a = afterSnap(1.5);
    const b = afterSnap(-1.5);
    expect(car(b).speed).toBeCloseTo(0.76, 12);
    expect(car(b).vel).toBeCloseTo(-car(a).vel, 9);
  });
  it('R82 no snap below slipSnapMax: speed intact, vel only follows R84', () => {
    // slip 1.0 < 1.2: vel stays 0 at R82, then R84: vel = 6.3*yaw1*DT
    const yr = -6 * 1.0 * chase(12);
    const yaw1 = 1.0 + yr * DT;
    const s = afterSnap(1.0);
    expect(car(s).speed).toBeCloseTo(0.8, 12);
    expect(car(s).vel).toBeCloseTo(6.3 * yaw1 * DT, 9);
  });
  it('R82 snap loss is floored at speed 0', () => {
    const s = mk({ speed: 0.02, state: 'DRIFT', dir: 1, yaw: 1.5, vel: 0 });
    stepB(s, inp(0, true)); // below driftExitSpeed: exits, slip 1.5 snaps
    expect(car(s).state).toBe('GRIP');
    expect(car(s).speed).toBe(0);
  });
});

describe('R83 body', () => {
  it('R83 GRIP one tick: yawRate and yaw by the hand formula', () => {
    // speed 0.5 -> f = min(1, 0.5/0.3) = 1; steer 0.6, yaw 0.2, yawRate 0.3, straight (A = 0).
    // Y = 15, al = 12.5, r = 50.
    // yawRate1 = 0.3 + (0.6*15*1 - 12.5*0.2 - 0.3)*(1 - exp(-50/120)) = 0.3 + 6.2*0.34076 = 2.4127
    // yaw1 = 0.2 + 2.4127/120 = 0.22011
    const s = mk({ speed: 0.5, yaw: 0.2, yawRate: 0.3 });
    stepB(s, inp(0.6));
    const yr = 0.3 + (0.6 * 15 - 12.5 * 0.2 - 0.3) * chase(50);
    expect(car(s).yawRate).toBeCloseTo(yr, 9);
    expect(car(s).yaw).toBeCloseTo(0.2 + yr * DT, 9);
    expect(car(s).yawRate).toBeCloseTo(2.4127, 3);
  });
  it('R83 f = min(1, sp/yawFullSpeed): steer authority is halved at speed 0.15', () => {
    // speed 0.15 -> f = 0.5; steer 1, yaw 0, yawRate 0: yawRate1 = (1*15*0.5)*(1 - exp(-50 DT))
    const s = mk({ speed: 0.15 });
    stepB(s, inp(1));
    expect(car(s).yawRate).toBeCloseTo(7.5 * chase(50), 9);
    // stationary: no authority at all
    const z = mk({ speed: 0 });
    stepB(z, inp(1));
    expect(car(z).yawRate).toBe(0);
  });
  it('R83 DRIFT one tick uses the drift parameters', () => {
    // DRIFT, speed 0.5 (f = 1), steer 0.4, yaw 0.5, yawRate 0.2, vel 0.3, straight.
    // Y = 43.6, al = 6, r = 12.
    // yawRate1 = 0.2 + (0.4*43.6 - 6*0.5 - 0.2)*(1 - exp(-12 DT)) = 0.2 + 14.24*0.09516 = 1.5551
    // yaw1 = 0.5 + 1.5551/120 = 0.51296
    const s = mk({ speed: 0.5, state: 'DRIFT', dir: 1, yaw: 0.5, yawRate: 0.2, vel: 0.3 });
    stepB(s, inp(0.4, true));
    const yr = 0.2 + (0.4 * 43.6 - 6 * 0.5 - 0.2) * chase(12);
    expect(car(s).yawRate).toBeCloseTo(yr, 9);
    expect(car(s).yaw).toBeCloseTo(0.5 + yr * DT, 9);
    expect(car(s).yawRate).toBeCloseTo(1.5551, 3);
  });
  it('R83 sign convention: a right curve turns the road under the car, yaw decreases', () => {
    // curve 4.5 (medium), speed 1: A = 4.5*1*2 = 9. steer 0, yaw 0, yawRate 0:
    // yaw1 = 0 + (0 - 9)*DT = -0.075
    const right = mk({ speed: 1 });
    stepB(right, inp(0), Q, constTrack(4.5));
    expect(car(right).yaw).toBeCloseTo(-0.075, 9);
    const left = mk({ speed: 1 });
    stepB(left, inp(0), Q, constTrack(-4.5));
    expect(car(left).yaw).toBeCloseTo(0.075, 9);
  });
  describe('R83 recovery blend after leaving DRIFT', () => {
    // GRIP, speed 0.5, steer 0.5, yaw 0.1, yawRate 0.2, straight. k = min(1, recover/0.25), recover
    // read at the start of the tick. P = Pdrift + (Pgrip - Pdrift)*k.
    const body = (recover: number) => {
      const s = mk({ speed: 0.5, yaw: 0.1, yawRate: 0.2, recover });
      stepB(s, inp(0.5));
      return s;
    };
    const expected = (k: number) => {
      const Y = 43.6 + (15 - 43.6) * k;
      const al = 6 + (12.5 - 6) * k;
      const r = 12 + (50 - 12) * k;
      return 0.2 + (0.5 * Y - al * 0.1 - 0.2) * chase(r);
    };
    it('recover = 0: pure drift parameters (Y 43.6, al 6, r 12)', () => {
      expect(car(body(0)).yawRate).toBeCloseTo(expected(0), 9);
    });
    it('recover = half of gripRecoverTime: halfway (Y 29.3, al 9.25, r 31)', () => {
      expect(car(body(0.125)).yawRate).toBeCloseTo(expected(0.5), 9);
    });
    it('recover >= gripRecoverTime: pure grip parameters', () => {
      expect(car(body(0.25)).yawRate).toBeCloseTo(expected(1), 9);
      expect(car(body(2)).yawRate).toBeCloseTo(expected(1), 9);
    });
    it('recover advances by DT per GRIP tick', () => {
      const s = body(0.125);
      expect(car(s).recover).toBeCloseTo(0.125 + DT, 12);
    });
  });
});

describe('R84 motion', () => {
  // GRIP, straight, speed 0.5, steer 0, yaw 0.3, yawRate 0, vel 0.1.
  // R83: yawRate1 = (0 - 12.5*0.3)*chase(50) = -3.75*0.34076 = -1.2779; yaw1 = 0.3 - 1.2779/120 = 0.28935
  // R84: slip = yaw1 - vel = 0.18935 < smax 0.42 -> vel1 = 0.1 + 22*0.18935*DT = 0.13472
  it('R84 vel update with the force clamp inactive', () => {
    const s = mk({ speed: 0.5, yaw: 0.3, vel: 0.1 });
    stepB(s, inp(0));
    const yaw1 = 0.3 + -12.5 * 0.3 * chase(50) * DT;
    expect(car(s).vel).toBeCloseTo(0.1 + 22 * (yaw1 - 0.1) * DT, 9);
    expect(car(s).vel).toBeCloseTo(0.13472, 4);
  });
  it('R84 force clamp active (slip 0.53 > smax 0.42, < limit 0.6): vel1 = g*smax*DT', () => {
    // yaw 0.55, vel 0: yaw1 = 0.55 - 12.5*0.55*0.34076/120 = 0.53047; vel1 = 22*0.42/120 = 0.077
    const s = mk({ speed: 0.5, yaw: 0.55, vel: 0 });
    stepB(s, inp(0));
    expect(car(s).vel).toBeCloseTo((22 * 0.42) * DT, 9);
    expect(car(s).yaw).toBeCloseTo(0.55 - 12.5 * 0.55 * chase(50) * DT, 9);
  });
  describe('geometric slip limit', () => {
    // GRIP: lim 0.6. yaw 0.9, vel 0, steer 1, yawRate 0. R83: yawRate1 = (15 - 11.25)*chase(50) = 1.2779.
    // With curve c (speed 1): A = c*2. yaw1 = 0.9 + (yawRate1 - A)*DT; vel1 = (22*0.42 - A)*DT.
    // slip > lim: yaw = vel1 + 0.6, yawRate = min(yawRate1, A).
    const run = (curve: number, sign: 1 | -1) => {
      const s = mk({ speed: 1, yaw: 0.9 * sign, vel: 0 });
      stepB(s, inp(sign), Q, constTrack(curve * sign));
      return s;
    };
    for (const curve of [0, 0.5]) {
      const A = curve * 2;
      for (const sign of [1, -1] as const) {
        it(`R84 yaw pulled to vel ${sign > 0 ? '+' : '-'} lim, yawRate capped to A (curve ${curve}, sign ${sign})`, () => {
          const s = run(curve, sign);
          const vel1 = (22 * 0.42 - A) * DT;
          expect(car(s).vel).toBeCloseTo(sign * vel1, 9);
          expect(car(s).yaw).toBeCloseTo(sign * (vel1 + 0.6), 9);
          // yawRate1 = 1.2779 > A for both curves, so the cap is exactly A
          expect(car(s).yawRate).toBeCloseTo(sign * A, 9);
        });
      }
    }
    it('R84 DRIFT limit slipHardMax 3.5 with force clamp slipDriftMax 3.0', () => {
      // DRIFT, speed 0.5, steer 1, yaw 4, vel 0: yawRate1 = (43.6 - 24)*chase(12) = 1.8652
      // yaw1 = 4 + 1.8652/120 = 4.01554; vel1 = 6.3*3/120 = 0.1575; slip 3.858 > 3.5
      // -> yaw = 0.1575 + 3.5 = 3.6575, yawRate = min(1.8652, 0) = 0
      const s = mk({ speed: 0.5, state: 'DRIFT', dir: 1, yaw: 4, vel: 0 });
      stepB(s, inp(1, true));
      expect(car(s).vel).toBeCloseTo(6.3 * 3 * DT, 9);
      expect(car(s).yaw).toBeCloseTo(6.3 * 3 * DT + 3.5, 9);
      expect(car(s).yawRate).toBeCloseTo(0, 9);
    });
    it('R84 limit and force blend with recover (k = 0.5: g 14.15, smax 1.71, lim 2.05)', () => {
      // GRIP, recover 0.125, speed 0.5, steer 1, yaw 2.2, vel 0.
      // Y 29.3, al 9.25, r 31: yawRate1 = (29.3 - 9.25*2.2)*chase(31) = 8.95*0.2278 = 2.039
      // yaw1 = 2.2 + 2.039/120 = 2.217; vel1 = 14.15*1.71/120 = 0.20164 (force clamped to 1.71)
      // slip = 2.015 -> wait: 2.217 - 0.2016 = 2.0154 < lim 2.05 -> no pull; use yaw 2.3 below.
      const s = mk({ speed: 0.5, yaw: 2.3, vel: 0, recover: 0.125 });
      stepB(s, inp(1));
      const yr1 = (29.3 - 9.25 * 2.3) * chase(31);
      const vel1 = 14.15 * 1.71 * DT;
      const yaw1 = 2.3 + yr1 * DT;
      expect(car(s).vel).toBeCloseTo(vel1, 9);
      // slip = yaw1 - vel1 = 2.3 + (-0.0...) - 0.2016 > 2.05? yaw1 ~ 2.296 -> 2.094 > 2.05: pulled
      expect(yaw1 - vel1).toBeGreaterThan(2.05);
      expect(car(s).yaw).toBeCloseTo(vel1 + 2.05, 9);
    });
  });
  describe('R84 off road scaling by offroadVelMul (GRIP only)', () => {
    const P06: CarParams = { ...Q, offroadVelMul: 0.6 };
    it('R84 off road (|x| > 1) g and smax are scaled by offroadVelMul (0.6)', () => {
      // yaw 0.5, vel 0, steer 0, GRIP: yaw1 = 0.5 - 12.5*0.5*chase(50)/120 = 0.48225
      // on road: slip > smax 0.42 -> vel1 = 22*0.42*DT = 0.077
      // off road: g = 22*0.6 = 13.2, smax = 0.42*0.6 = 0.252 -> vel1 = 13.2*0.252*DT = 0.02772
      const on = mk({ speed: 0.5, yaw: 0.5, x: 0.5 });
      stepB(on, inp(0), P06);
      const off = mk({ speed: 0.5, yaw: 0.5, x: 1.2 });
      stepB(off, inp(0), P06);
      expect(car(on).vel).toBeCloseTo(22 * 0.42 * DT, 9);
      expect(car(off).vel).toBeCloseTo(22 * 0.6 * (0.42 * 0.6) * DT, 9);
    });
    it('R84 offroadVelMul = 1: off-road vel equals the on-road value', () => {
      const p1: CarParams = { ...Q, offroadVelMul: 1 };
      const on = mk({ speed: 0.5, yaw: 0.5, x: 0.5 });
      stepB(on, inp(0), p1);
      const off = mk({ speed: 0.5, yaw: 0.5, x: 1.2 });
      stepB(off, inp(0), p1);
      expect(car(off).vel).toBeCloseTo(22 * 0.42 * DT, 9);
      expect(car(off).vel).toBeCloseTo(car(on).vel, 12);
    });
    it('R84 in DRIFT off road there is no scaling even with offroadVelMul 0.6', () => {
      const st = { speed: 0.8, state: 'DRIFT' as const, dir: 1 as const, yaw: 1, vel: 0.5 };
      const on = mk({ ...st, x: 0.5 });
      stepB(on, inp(1, true), P06);
      const off = mk({ ...st, x: 1.2 });
      stepB(off, inp(1, true), P06);
      expect(car(off).state).toBe('DRIFT');
      expect(car(off).vel).toBeCloseTo(car(on).vel, 12);
      expect(car(off).yaw).toBeCloseTo(car(on).yaw, 12);
    });
    it('R84 offroadSteerMul has no effect in model B', () => {
      const run = (m: number): number => {
        const s = mk({ speed: 0.5, yaw: 0.5, x: 1.2 });
        stepB(s, inp(0), { ...P06, offroadSteerMul: m });
        return car(s).vel;
      };
      expect(run(0.1)).toBe(run(1));
      expect(run(0.3)).toBeCloseTo(22 * 0.6 * (0.42 * 0.6) * DT, 9);
    });
    it('R84 data: base.json offroadVelMul is within (0, 1]', () => {
      expect(baseCar.offroadVelMul).toBeGreaterThan(0);
      expect(baseCar.offroadVelMul).toBeLessThanOrEqual(1);
    });
  });
});

describe('R85 shift', () => {
  const P2: CarParams = { ...Q, latScale: 2 };
  it('R85 vx = vel*sp*latScale and x += vx*DT', () => {
    const s = mk({ speed: 0.5, yaw: 0.4, vel: 0.4, x: 0.1 });
    stepB(s, inp(0), P2);
    expect(car(s).vx).toBeCloseTo(car(s).vel * 0.5 * 2, 12);
    expect(car(s).x).toBeCloseTo(0.1 + car(s).vel * 0.5 * 2 * DT, 12);
    expect(car(s).vel).not.toBe(0);
  });
  it('R85 xLimit clamps x and zeroes vel toward the wall (right)', () => {
    // vel ~2.98 * 0.5 / 120 = 0.0124 pushes 1.499 over 1.5
    const s = mk({ speed: 0.5, yaw: 3, vel: 3, x: 1.499 });
    stepB(s, inp(0));
    expect(car(s).x).toBe(1.5);
    expect(car(s).vel).toBe(0);
  });
  it('R85 xLimit clamps x and zeroes vel toward the wall (left)', () => {
    const s = mk({ speed: 0.5, yaw: -3, vel: -3, x: -1.499 });
    stepB(s, inp(0));
    expect(car(s).x).toBe(-1.5);
    expect(car(s).vel).toBe(0);
  });
  it('R85 vel away from the wall is not zeroed', () => {
    const s = mk({ speed: 0.5, yaw: -1, vel: -1, x: 1.5 });
    stepB(s, inp(0));
    expect(car(s).vel).toBeLessThan(-0.5);
    expect(car(s).x).toBeLessThan(1.5);
  });
  it('R85 no centrifugal term: straight, yaw = vel = 0 keeps x exactly', () => {
    const s = mk({ speed: 0.9 });
    stepN(s, 120, inp(0));
    expect(Math.abs(car(s).x)).toBe(0);
    expect(Math.abs(car(s).vel)).toBe(0);
    expect(Math.abs(car(s).yaw)).toBe(0);
  });
  it('R85 curve with yaw = vel = 0: vel changes only through A (no separate push)', () => {
    // curve 4.5, speed 1: A = 9. yaw1 = (0 - 9)*DT = -0.075 (yawRate1 = 0).
    // R84: vel1 = (22*clamp(-0.075 - 0, 0.42) - 9)*DT = (-1.65 - 9)/120 = -0.088750
    // x1 = vel1*1*1*DT
    const s = mk({ speed: 1 });
    stepB(s, inp(0), Q, constTrack(4.5));
    expect(car(s).vel).toBeCloseTo(-0.08875, 9);
    expect(car(s).x).toBeCloseTo(-0.08875 * DT, 12);
  });
});

describe('R86 speed', () => {
  // DRIFT, yaw 2, vel 0, steer 0, drift held; PB has accel 0.22 and slipDrag 0.058.
  const drag = (over: Partial<ReturnType<typeof car>> = {}, p: CarParams = PB) => {
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1, yaw: 2, vel: 0, ...over });
    stepB(s, inp(0, true), p);
    return s;
  };
  it('R86 slip drag subtracts slipDrag*slip^2*DT after R14 (slip after R84)', () => {
    // R14: 0.8 + 0.22*DT = 0.801833; then - 0.058*slip^2*DT
    const s = drag();
    const slip = slipOf(car(s));
    expect(Math.abs(slip)).toBeGreaterThan(1.5);
    expect(car(s).speed).toBeCloseTo(0.8 + 0.22 * DT - 0.058 * slip * slip * DT, 12);
  });
  it('R86 R15 applies after the drag (off road, x = 1.2)', () => {
    const s = drag({ x: 1.2 });
    const slip = slipOf(car(s));
    const expected = (0.8 + 0.22 * DT - 0.058 * slip * slip * DT) * Math.pow(0.99, 60 * DT);
    expect(car(s).speed).toBeCloseTo(expected, 12);
  });
  it('R86 speed is floored at 0 by the drag', () => {
    const s = drag({}, { ...PB, slipDrag: 100 });
    expect(car(s).speed).toBe(0);
  });
  it('R86 no drift speed cap: a drift at zero slip reaches vmax (stale angle is ignored)', () => {
    const p: CarParams = { ...PB, slipDrag: 0 };
    const s = mk({ speed: 0.5, state: 'DRIFT', dir: 1, angle: 1 });
    stepN(s, 400, inp(0, true), p);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).speed).toBeCloseTo(1, 12); // model A would cap at vmax*(1 - 0.15*angle)
  });
  it('R86 brake input slows by brake*DT (R14)', () => {
    const s = mk({ speed: 0.5 });
    stepB(s, inp(0, false, true), PB);
    expect(car(s).speed).toBeCloseTo(0.5 - 0.6 * DT, 12);
  });
  it('R86 above the cap speed falls by driftBrake*DT (R52 rule, both states)', () => {
    const g = mk({ speed: 1.1 });
    stepB(g, inp(0), PB);
    expect(car(g).speed).toBeCloseTo(1.1 - 0.3 * DT, 12);
    const d = mk({ speed: 1.1, state: 'DRIFT', dir: 1 });
    stepB(d, inp(0, true), { ...PB, slipDrag: 0 });
    expect(car(d).speed).toBeCloseTo(1.1 - 0.3 * DT, 12);
  });
  describe('R52 boost works in model B', () => {
    // traffic car 10 segments ahead in the cone (draftLength 80, draftWidth 0.25), draft = 1:
    // cap = vmax*draftCapMul = 1.13, accel*draftAccelMul = 0.352 -> speed 1.0 + 0.352*DT
    const P1: CarParams = { ...PB, slipDrag: 0 };
    const boosted = (over: Partial<ReturnType<typeof car>>, drift: boolean) => {
      const s = createRace(1, 1, 1);
      Object.assign(car(s), { recover: 10, speed: 1, draft: 1, ...over });
      const t = s.cars[1]!;
      t.z = 10;
      t.x = 0;
      t.speed = 0.5;
      step(s, [inp(0, drift), inp(0)], STRAIGHT, [P1, P1]);
      return s;
    };
    it('R52 GRIP: cap vmax*draftCapMul and accel*draftAccelMul', () => {
      expect(car(boosted({}, false)).speed).toBeCloseTo(1 + 0.22 * 1.6 * DT, 12);
    });
    it('R52 DRIFT: the boost applies too (no separate drift cap in model B)', () => {
      const s = boosted({ state: 'DRIFT', dir: 1 }, true);
      expect(car(s).speed).toBeCloseTo(1 + 0.22 * 1.6 * DT, 12);
    });
    it('R52 without the boost speed stops at vmax', () => {
      const s = mk({ speed: 1 });
      stepB(s, inp(0), P1);
      expect(car(s).speed).toBe(1);
    });
  });
});

describe('R87 derived fields', () => {
  const P2: CarParams = { ...Q, latScale: 2 };
  it('R87 DRIFT: angle = slip / slipViewFull inside the clamp', () => {
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1, yaw: 1.2, vel: 0 });
    stepB(s, inp(0, true));
    expect(car(s).angle).toBeCloseTo(slipOf(car(s)) / 2.47, 12);
    expect(Math.abs(car(s).angle)).toBeLessThan(1);
  });
  it('R87 DRIFT: angle clamps to +-1 beyond slipViewFull (2.47)', () => {
    const a = mk({ speed: 0.8, state: 'DRIFT', dir: 1, yaw: 3.4, vel: 0 });
    stepB(a, inp(0, true));
    expect(slipOf(car(a))).toBeGreaterThan(2.47);
    expect(car(a).angle).toBe(1);
    const b = mk({ speed: 0.8, state: 'DRIFT', dir: -1, yaw: -3.4, vel: 0 });
    stepB(b, inp(0, true));
    expect(car(b).angle).toBe(-1);
  });
  it('R87 GRIP: angle is 0 whatever the slip (stale angle is overwritten)', () => {
    const s = mk({ speed: 0.8, yaw: 0.4, vel: 0, angle: 0.7 });
    stepB(s, inp(0));
    expect(Math.abs(slipOf(car(s)))).toBeGreaterThan(0.1);
    expect(car(s).angle).toBe(0);
  });
  it('R87 vx = vel*sp*latScale and steer is the raw steer', () => {
    const s = mk({ speed: 0.8, yaw: 0.4, vel: 0.3 });
    stepB(s, inp(0.35), P2);
    expect(car(s).vx).toBeCloseTo(car(s).vel * 0.8 * 2, 12);
    expect(car(s).steer).toBe(0.35);
  });
});

describe('R88 bump and off road in model B', () => {
  // Side contact geometry: player z 10 -> 10.4 after R16 (speed 0.8 * 0.5), traffic parked at z 10:
  // dz = 0.4 < carLength 1.5, |dx| = 0.05 < (0.16 + 0.16)/2; car.z >= zT - carLength/2 -> side contact.
  // bumpSideLoss 0 keeps the speed at 0.8, so sp = 0.8 whichever way R42 reads it.
  const BQ: CarParams = {
    ...Q,
    latScale: 2,
    carLength: 1.5,
    carHitW: 0.16,
    trafficHitW: 0.16,
    bumpSideLoss: 0,
    bumpSpeedLoss: 0,
    bumpKick: 0.6,
    bumpInvulnTime: 0.8,
    bumpAngleLoss: 0.3,
  };
  const bump = (over: Partial<ReturnType<typeof car>>, p: CarParams = BQ, withTraffic = true) => {
    const s = createRace(1, 1, withTraffic ? 1 : 0);
    Object.assign(car(s), { recover: 10, speed: 0.8, z: 10, x: 0.05, ...over });
    if (withTraffic) {
      const t = s.cars[1]!;
      t.z = 10;
      t.x = 0;
      t.speed = 0;
    }
    const ps = withTraffic ? [p, p] : [p];
    const ins = withTraffic ? [inp(0, true), inp(0)] : [inp(0, true)];
    step(s, ins, STRAIGHT, ps);
    return s;
  };
  it('R42 vel = side*bumpKick/(sp*latScale) = 0.6/(0.8*2) = 0.375 (right of the traffic car)', () => {
    const s = bump({ yaw: 0.3, vel: 0.1 });
    expect(car(s).bumpTicks).toBeGreaterThan(0);
    expect(car(s).vel).toBeCloseTo(0.375, 9);
  });
  it('R42 pushes left (-0.375) when the player is left of the traffic car', () => {
    const s = bump({ x: -0.05, yaw: 0.3, vel: 0.1 });
    expect(car(s).vel).toBeCloseTo(-0.375, 9);
  });
  it('R42 yaw is left alone (GRIP): equals the run without the traffic car', () => {
    const hit = bump({ yaw: 0.3, vel: 0.1 });
    const ctrl = bump({ yaw: 0.3, vel: 0.1 }, BQ, false);
    expect(car(hit).bumpTicks).toBeGreaterThan(0);
    expect(car(ctrl).bumpTicks).toBe(0);
    expect(car(hit).yaw).toBeCloseTo(car(ctrl).yaw, 12);
  });
  it('R44 DRIFT: yaw -= dir*bumpAngleLoss and the drift is kept', () => {
    const hit = bump({ state: 'DRIFT', dir: 1, yaw: 2, vel: 0 });
    const ctrl = bump({ state: 'DRIFT', dir: 1, yaw: 2, vel: 0 }, BQ, false);
    expect(car(hit).state).toBe('DRIFT');
    expect(car(hit).dir).toBe(1);
    expect(car(hit).yaw).toBeCloseTo(car(ctrl).yaw - 0.3, 9);
  });
  it('R44 mirror: dir -1 yaw moves up by bumpAngleLoss', () => {
    const hit = bump({ x: -0.05, state: 'DRIFT', dir: -1, yaw: -2, vel: 0 });
    const ctrl = bump({ x: -0.05, state: 'DRIFT', dir: -1, yaw: -2, vel: 0 }, BQ, false);
    expect(car(hit).state).toBe('DRIFT');
    expect(car(hit).yaw).toBeCloseTo(car(ctrl).yaw + 0.3, 9);
  });
  it('R44 yaw does not cross vel (vel after R42 = 0.375): clamped onto it', () => {
    const p: CarParams = { ...BQ, bumpAngleLoss: 2 };
    const hit = bump({ state: 'DRIFT', dir: 1, yaw: 0.8, vel: 0 }, p);
    expect(car(hit).state).toBe('DRIFT');
    expect(car(hit).vel).toBeCloseTo(0.375, 9);
    expect(car(hit).yaw).toBeCloseTo(0.375, 9);
  });
  it('R21b/H11 a drift does not end off road (100 ticks at x = 1.3, driftOffroad 1)', () => {
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1, x: 1.3 });
    stepN(s, 100, inp(0, true), { ...Q, driftOffroad: 1 });
    // speed 0.8 * 0.99^50 = 0.484 > driftExitSpeed, so only the off-road rule could end it
    expect(car(s).speed).toBeGreaterThan(0.3);
    expect(car(s).state).toBe('DRIFT');
  });
});

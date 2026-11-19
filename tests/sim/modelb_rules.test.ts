// Driving model B (H14), rules R80-R88 of docs/brief.md (rewritten 2026-11-19: calm one-sided drift).
// One describe per rule id. Expected numbers are hand-derived from the brief formulas; arithmetic is
// in the comments.
//
// Reading of the update order inside one tick (brief "Порядок в шаге модели B"):
//   R80 steer -> R81 flick check (state GRIP) then the current steer is recorded -> R82 exit ->
//   R82b carry decay -> R83 body -> R84 motion -> R85 shift -> R86 speed.
//   sp = speed / vmax is taken at the start of R83 (R14/R86 change speed only afterwards).
// All rule tests run with Q (accel 0, slipDrag 0) unless the rule is about speed, so speed is
// constant over a tick. Tests that read `carry` right after an entry or exit use carryDecay 0 so the
// order of R82b relative to R81/R82 does not matter (the brief puts R82b before R83, the prototype
// decays at the end of the tick: see the report).
import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { DT, STEER_HIST } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { CarParams } from '../../src/sim/types';
import {
  PB,
  Q,
  STRAIGHT,
  car,
  chase,
  constTrack,
  inp,
  mk,
  slipOf,
  stepB,
  stepN,
  withHistory,
} from './modelb_helpers';

const clampTo = (v: number, lim: number): number => Math.max(-lim, Math.min(lim, v));
/** Q without carry decay and without the vel chase of DRIFT (vel is exactly preserved by R84). */
const E: CarParams = { ...Q, velGripDrift: 0, carryDecay: 0 };
/** Q without carry decay only. */
const N0: CarParams = { ...Q, carryDecay: 0 };
const W = 8; // slipResponse
const SF = 2.64; // slipFull

/** One DRIFT chase tick of R83 (critically damped), before the floor: returns [slip, yawRate]. */
function driftChase(slip: number, yawRate: number, slipT: number): [number, number] {
  const yr = yawRate + (W * W * (slipT - slip) - 2 * W * yawRate) * DT;
  return [slip + yr * DT, yr];
}

/**
 * One GRIP tick of R83 + R84 from the state right after an exit (yawRate = A, yaw = vel + sG),
 * speed 0.8 (f = 1), Q parameters (Y 15.75, al 15, r 60, g 22, smax 0.75, lim 0.8).
 */
function gripTick(yaw: number, yawRate: number, vel: number, steer: number, A: number) {
  const yr = yawRate + (steer * 15.75 - 15 * yaw - yawRate) * chase(60);
  let y = yaw + (yr - A) * DT;
  const v = vel + (22 * clampTo(y - vel, 0.75) - A) * DT;
  let yrOut = yr;
  if (y - v > 0.8) {
    y = v + 0.8;
    yrOut = Math.min(yr, A);
  } else if (y - v < -0.8) {
    y = v - 0.8;
    yrOut = Math.max(yr, A);
  }
  return { yaw: y, yawRate: yrOut, vel: v };
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
  // Straight track (A = 0), speed 0.8, history: -0.3 for 5 ticks, then steer 0.3 with drift held.
  // d = 0.3 - (-0.3) = 0.6, |d| - flickDelta = 0.1, kick = kickBase + kickGain*0.1 = 2 + 0.6 = 2.6, dir +1.
  // R83 (DRIFT, same tick): slipT = 2.64*clamp(0.3) = 0.792.
  //   yawRate1 = kick + (W^2*(slipT - slip0) - 2*W*kick)*DT with W = 8
  //   slip1    = slip0 + yawRate1*DT
  // E: velGripDrift 0 keeps vel exactly (R84 chase factor 0), carryDecay 0 keeps carry exactly.
  const entry = (
    prev: number,
    last: number,
    f: { yaw: number; vel: number; carry: number },
    sign = 1,
  ) => {
    const s = withHistory({ speed: 0.8 }, Array<number>(5).fill(prev * sign), true, E);
    Object.assign(car(s), {
      yaw: f.yaw * sign,
      yawRate: 0,
      vel: f.vel * sign,
      carry: f.carry * sign,
    });
    stepB(s, inp(last * sign, true), E);
    return s;
  };
  const kickOf = (d: number) => 2 + 6 * (d - 0.5);
  const expectedAfter = (d: number, slip0: number, steer: number): [number, number] =>
    driftChase(slip0, kickOf(d), SF * Math.max(0, Math.min(1, steer)));
  const WITH = { yaw: 0.5, vel: 0.2, carry: 0.1 }; // vis = 0.5 - 0.2 + 0.1 = 0.4 > 0 (along dir)
  const AGAINST = { yaw: 0.1, vel: 0.4, carry: 0.05 }; // vis = 0.1 - 0.4 + 0.05 = -0.25 (against dir +1)

  it('R81 enters DRIFT with dir = sign of the change', () => {
    const s = entry(-0.3, 0.3, WITH);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
  it('R81 vis along dir: slip0 = vis, carry = 0, yawRate = kick (hand numbers)', () => {
    // slip0 = 0.4, carry = vis - slip0 = 0. yawRate1 = 2.6 + (64*(0.792-0.4) - 16*2.6)/120
    //   = 2.6 + (25.088 - 41.6)/120 = 2.6 - 0.1376 = 2.4624; slip1 = 0.4 + 2.4624/120 = 0.42052
    const s = entry(-0.3, 0.3, WITH);
    const [slip1, yr1] = expectedAfter(0.6, 0.4, 0.3);
    expect(yr1).toBeCloseTo(2.4624, 9);
    expect(slip1).toBeCloseTo(0.42052, 9);
    expect(car(s).yawRate).toBeCloseTo(yr1, 9);
    expect(slipOf(car(s))).toBeCloseTo(slip1, 9);
    expect(car(s).carry).toBeCloseTo(0, 12);
  });
  it('R81 vel is not changed by the entry (no lateral jump)', () => {
    const s = entry(-0.3, 0.3, WITH);
    expect(car(s).vel).toBe(0.2);
  });
  it('R81 entering against the visible slip starts from slip 0, the whole vis goes to carry', () => {
    // vis*dir = -0.25 < 0: slip0 = 0, carry = -0.25, yaw = vel = 0.4.
    // yawRate1 = 2.6 + (64*0.792 - 16*2.6)/120 = 2.6 + (50.688 - 41.6)/120 = 2.67573; slip1 = 2.67573/120
    const s = entry(-0.3, 0.3, AGAINST);
    const [slip1, yr1] = expectedAfter(0.6, 0, 0.3);
    expect(yr1).toBeCloseTo(2.67573, 5);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).carry).toBeCloseTo(-0.25, 12);
    expect(car(s).vel).toBe(0.4);
    expect(car(s).yawRate).toBeCloseTo(yr1, 9);
    expect(slipOf(car(s))).toBeCloseTo(slip1, 9);
    expect(slipOf(car(s))).toBeGreaterThanOrEqual(0);
  });
  it('R81 left flick is the mirror image (dir -1, negated state)', () => {
    for (const f of [WITH, AGAINST]) {
      const a = entry(-0.3, 0.3, f, 1);
      const b = entry(-0.3, 0.3, f, -1);
      expect(car(b).state).toBe('DRIFT');
      expect(car(b).dir).toBe(-1);
      for (const k of ['yawRate', 'yaw', 'vel', 'carry'] as const)
        expect(car(b)[k]).toBeCloseTo(-car(a)[k], 9);
    }
  });
  it('R81 a bigger flick gives a faster slip growth, not a bigger angle (same final steer)', () => {
    const small = entry(-0.3, 0.3, WITH); // d = 0.6, kick 2.6
    const big = entry(-0.7, 0.3, WITH); // d = 1.0, kick 2 + 6*0.5 = 5
    expect(car(big).state).toBe('DRIFT');
    expect(car(big).yawRate).toBeGreaterThan(car(small).yawRate);
    expect(car(big).yawRate).toBeCloseTo(expectedAfter(1.0, 0.4, 0.3)[1], 9);
    // the kick is a RATE: after the entry tick the angle differs by far less than 0.03 slip units
    expect(Math.abs(slipOf(car(big)) - slipOf(car(small)))).toBeLessThan(0.03);
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
    const s = withHistory({ speed: 0.8 }, Array<number>(5).fill(-0.3), false);
    stepB(s, inp(0.3, false));
    expect(car(s).state).toBe('GRIP');
  });
  it('R81 no entry at or below driftEnterSpeed*vmax, entry above it', () => {
    const slow = withHistory({ speed: 0.44 }, Array<number>(5).fill(-0.3), true);
    stepB(slow, inp(0.3, true));
    expect(car(slow).state).toBe('GRIP'); // 0.44 < 0.45
    const fast = withHistory({ speed: 0.5 }, Array<number>(5).fill(-0.3), true);
    stepB(fast, inp(0.3, true));
    expect(car(fast).state).toBe('DRIFT'); // 0.5 > 0.45
  });
  it('R81 the buffer is cleared and not written while input.drift is released', () => {
    const s = withHistory({ speed: 0.8 }, Array<number>(5).fill(-0.3), true);
    expect(car(s).steerHistCount).toBe(5);
    stepB(s, inp(-0.3, false));
    expect(car(s).steerHistCount).toBe(0);
    stepN(s, 3, inp(-0.3, false));
    expect(car(s).steerHistCount).toBe(0);
    // history recorded with drift released does not give a flick on the first held tick
    const t = withHistory({ speed: 0.8 }, Array<number>(5).fill(-0.3), false);
    expect(car(t).steerHistCount).toBe(0);
    stepB(t, inp(0.3, true));
    expect(car(t).state).toBe('GRIP');
  });
  it('R81 the buffer is written every tick of a hold, also in DRIFT', () => {
    // DRIFT with steer -0.3 for 5 held ticks: the samples are recorded although the state is DRIFT.
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: -1 });
    stepN(s, 5, inp(-0.3, true));
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).steerHistCount).toBe(5);
    // release clears the buffer (-> GRIP); a new hold starts with no history, so a jump gives no flick
    stepB(s, inp(0.3, false));
    expect(car(s).state).toBe('GRIP');
    expect(car(s).steerHistCount).toBe(0);
    stepB(s, inp(0.3, true));
    expect(car(s).state).toBe('GRIP');
  });
  it('R81 only samples inside flickWindow count (0.12 s = 14.4 ticks)', () => {
    // one -0.3 sample, then n ticks of +0.3, then the flick tick: the old sample is n+1 ticks back.
    const run = (n: number) => {
      // recorded under driftEnterSpeed (no entry while building the history), then speed 0.8
      const s = withHistory({ speed: 0.44 }, [-0.3, ...Array<number>(n).fill(0.3)], true);
      car(s).speed = 0.8;
      stepB(s, inp(0.3, true));
      return car(s).state;
    };
    expect(run(9)).toBe('DRIFT'); // 10 ticks = 0.083 s ago
    expect(run(19)).toBe('GRIP'); // 20 ticks = 0.167 s ago
  });
  it('R81 fresh race: the zero-filled buffer gives no false flick', () => {
    const s = createRace(1, 1);
    car(s).speed = 0.8;
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
      stepB(s, inp(0.1, true));
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
  // DRIFT at speed 0.8, steer 0, straight.
  it('R82 release of input.drift ends the drift: GRIP, dir 0', () => {
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1 });
    stepB(s, inp(0, false));
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
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

  // Right curve 4.5 (medium), speed 0.8: A = 4.5*0.8*2 = 7.2; sG = clamp(7.2/22, +-0.75) = 0.32727.
  // DRIFT state: yaw 0.9, vel -0.1 (slip 1.0), carry 0.05 -> vis = 1.05.
  // R82: carry = 1.05 - 0.32727 = 0.72273; yaw = vel + sG = 0.22727; yawRate = A = 7.2; vel stays -0.1.
  // Then the GRIP tick of the same step (steer 0): gripTick().
  const exitTick = (sign: 1 | -1, curve: number, speed: number, steer: number) => {
    const s = mk({
      speed,
      state: 'DRIFT',
      dir: sign,
      yaw: 0.9 * sign,
      vel: -0.1 * sign,
      carry: 0.05 * sign,
    });
    stepB(s, inp(steer * sign, false), N0, constTrack(curve * sign));
    return s;
  };
  for (const sign of [1, -1] as const) {
    const tag = sign > 0 ? 'right' : 'left (mirror)';
    it(`R82 exit sets sG, carry = vis - sG, yaw = vel + sG, yawRate = A, then GRIP runs (${tag})`, () => {
      const A = 7.2;
      const sG = A / 22; // 0.327273 < slipGripMax
      const g = gripTick(-0.1 + sG, A, -0.1, 0, A);
      const s = exitTick(sign, 4.5, 0.8, 0);
      expect(car(s).state).toBe('GRIP');
      expect(car(s).dir).toBe(0);
      expect(car(s).carry).toBeCloseTo(sign * (1.05 - sG), 9);
      expect(car(s).yawRate).toBeCloseTo(sign * g.yawRate, 9);
      expect(car(s).yaw).toBeCloseTo(sign * g.yaw, 9);
      // vel continues from the DRIFT value: one GRIP step of R84, no snap and no jump
      expect(car(s).vel).toBeCloseTo(sign * g.vel, 9);
      expect(Math.abs(car(s).vel + sign * 0.1)).toBeLessThan(0.1);
    });
  }
  it('R82 sG is clamped to slipGripMax: curve 9, speed 1 -> A = 18, A/22 = 0.818 -> 0.75', () => {
    // vis = 1.05, carry = 1.05 - 0.75 = 0.3
    const s = exitTick(1, 9, 1, 0);
    expect(car(s).carry).toBeCloseTo(1.05 - 0.75, 9);
    const g = gripTick(-0.1 + 0.75, 18, -0.1, 0, 18);
    expect(car(s).yaw).toBeCloseTo(g.yaw, 9);
    expect(car(s).vel).toBeCloseTo(g.vel, 9);
  });
  it('R82 sG follows the curve: on a straight sG = 0, so carry = the whole vis', () => {
    const s = exitTick(1, 0, 0.8, 0);
    expect(car(s).carry).toBeCloseTo(1.05, 9);
    expect(car(s).yawRate).toBeCloseTo(gripTick(-0.1, 0, -0.1, 0, 0).yawRate, 9);
  });
  it('R82 no speed loss at exit even with a huge slip (the old snap is gone)', () => {
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1, yaw: 2.4, vel: 0 });
    stepB(s, inp(0, false), Q);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).speed).toBe(0.8);
  });
  it('R82 no snap at exit: |vel| after the tick differs from before by one GRIP step at most', () => {
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1, yaw: 2.4, vel: 0.2 });
    stepB(s, inp(0, false), Q);
    expect(Math.abs(car(s).vel - 0.2)).toBeLessThanOrEqual(22 * 0.75 * DT + 1e-12);
  });
});

describe('R82b carry decay', () => {
  // yaw = vel = 0, steer 0, straight: nothing else touches carry, so after n ticks
  // carry = c0*exp(-carryDecay*n*DT) = 0.5*exp(-8*n/120).
  it('R82b GRIP: one tick multiplies carry by exp(-carryDecay*DT)', () => {
    const s = mk({ speed: 0.8, carry: 0.5 });
    stepB(s, inp(0), Q);
    expect(car(s).carry).toBeCloseTo(0.5 * Math.exp(-8 * DT), 12);
  });
  it('R82b DRIFT: the same decay', () => {
    const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1, carry: 0.5 });
    stepB(s, inp(0, true), Q);
    expect(car(s).carry).toBeCloseTo(0.5 * Math.exp(-8 * DT), 12);
  });
  it('R82b after 60 ticks (0.5 s) carry = 0.5*exp(-4); sign is kept', () => {
    const s = mk({ speed: 0.8, carry: 0.5 });
    stepN(s, 60, inp(0), Q);
    expect(car(s).carry).toBeCloseTo(0.5 * Math.exp(-4), 12);
    const m = mk({ speed: 0.8, carry: -0.5 });
    stepN(m, 60, inp(0), Q);
    expect(car(m).carry).toBeCloseTo(-0.5 * Math.exp(-4), 12);
  });
  it('R82b carryDecay 0 keeps carry; the decay uses the parameter, not a literal', () => {
    const s = mk({ speed: 0.8, carry: 0.5 });
    stepN(s, 30, inp(0), { ...Q, carryDecay: 0 });
    expect(car(s).carry).toBeCloseTo(0.5, 12);
    const t = mk({ speed: 0.8, carry: 0.5 });
    stepN(t, 30, inp(0), { ...Q, carryDecay: 2 });
    expect(car(t).carry).toBeCloseTo(0.5 * Math.exp(-2 * 30 * DT), 12);
  });
});

describe('R83 body', () => {
  it('R83 GRIP one tick: yawRate and yaw by the hand formula (no recover blend)', () => {
    // speed 0.5 -> f = min(1, 0.5/0.3) = 1; steer 0.6, yaw 0.2, yawRate 0.3, straight (A = 0).
    // Y = 15.75, al = 15, r = 60, 1 - exp(-60/120) = 0.393469.
    // yawRate1 = 0.3 + (0.6*15.75 - 15*0.2 - 0.3)*0.393469 = 0.3 + 6.15*0.393469 = 2.719836
    // yaw1 = 0.2 + 2.719836/120 = 0.222665
    const s = mk({ speed: 0.5, yaw: 0.2, yawRate: 0.3 });
    stepB(s, inp(0.6));
    const yr = 0.3 + (0.6 * 15.75 - 15 * 0.2 - 0.3) * chase(60);
    expect(car(s).yawRate).toBeCloseTo(yr, 9);
    expect(car(s).yaw).toBeCloseTo(0.2 + yr * DT, 9);
    expect(car(s).yawRate).toBeCloseTo(2.719836, 5);
    expect(car(s).yaw).toBeCloseTo(0.222665, 5);
  });
  it('R83 GRIP: steer 0.6 mirrored gives the mirrored result', () => {
    const a = mk({ speed: 0.5, yaw: 0.2, yawRate: 0.3 });
    const b = mk({ speed: 0.5, yaw: -0.2, yawRate: -0.3 });
    stepB(a, inp(0.6));
    stepB(b, inp(-0.6));
    expect(car(b).yawRate).toBeCloseTo(-car(a).yawRate, 12);
    expect(car(b).yaw).toBeCloseTo(-car(a).yaw, 12);
  });
  it('R83 f = min(1, sp/yawFullSpeed): steer authority is halved at speed 0.15', () => {
    // speed 0.15 -> f = 0.5; steer 1, yaw 0, yawRate 0: yawRate1 = (1*15.75*0.5)*(1 - exp(-60 DT))
    const s = mk({ speed: 0.15 });
    stepB(s, inp(1));
    expect(car(s).yawRate).toBeCloseTo(7.875 * chase(60), 9);
    // stationary: no authority at all
    const z = mk({ speed: 0 });
    stepB(z, inp(1));
    expect(car(z).yawRate).toBe(0);
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

  describe('R83 DRIFT: critically damped slip chase', () => {
    // DRIFT dir +1, speed 0.5, straight, steer 0.4, yaw 0.9, vel 0.3 (slip 0.6), yawRate 0.2.
    // slipT = 2.64*clamp(0.4, 0, 1) = 1.056.
    // yawRate1 = 0.2 + (64*(1.056 - 0.6) - 16*0.2)/120 = 0.2 + (29.184 - 3.2)/120 = 0.416533
    // slip1 = 0.6 + 0.416533/120 = 0.603471   (slip = yaw - vel after R84: yaw = vel + slip)
    const setup = (sign: 1 | -1, slip = 0.6, yawRate = 0.2) =>
      mk({
        speed: 0.5,
        state: 'DRIFT',
        dir: sign,
        vel: 0.3 * sign,
        yaw: (0.3 + slip) * sign,
        yawRate: yawRate * sign,
      });
    for (const sign of [1, -1] as const) {
      const tag = sign > 0 ? 'right' : 'left (mirror)';
      it(`R83 DRIFT one tick by the hand formula (${tag})`, () => {
        const s = setup(sign);
        stepB(s, inp(0.4 * sign, true));
        const [slip1, yr1] = driftChase(0.6, 0.2, 1.056);
        expect(yr1).toBeCloseTo(0.416533, 6);
        expect(slip1).toBeCloseTo(0.603471, 6);
        expect(car(s).yawRate).toBeCloseTo(sign * yr1, 9);
        expect(slipOf(car(s))).toBeCloseTo(sign * slip1, 9);
      });
    }
    it('R83 DRIFT target: slipT = dir*slipFull*clamp(steer*dir, 0, 1): counter-steer targets 0', () => {
      // steer -0.5 (u = -0.5): slipT = 0. yawRate1 = 0.2 + (64*(0 - 0.6) - 3.2)/120 = 0.2 - 0.3547
      const s = setup(1);
      stepB(s, inp(-0.5, true));
      const [slip1, yr1] = driftChase(0.6, 0.2, 0);
      expect(yr1).toBeCloseTo(0.2 + (-38.4 - 3.2) / 120, 9);
      expect(car(s).yawRate).toBeCloseTo(yr1, 9);
      expect(slipOf(car(s))).toBeCloseTo(slip1, 9);
    });
    it('R83 DRIFT does not use the GRIP formula (no yawAlign, no yawRateMax)', () => {
      // with the old law yawRate would be driven by steer*yawRateMax; here steer 1 only moves slipT
      const s = setup(1);
      stepB(s, inp(1, true));
      const [, yr1] = driftChase(0.6, 0.2, 2.64);
      expect(car(s).yawRate).toBeCloseTo(yr1, 9);
      expect(Math.abs(car(s).yawRate)).toBeLessThan(5);
    });
    for (const sign of [1, -1] as const) {
      const tag = sign > 0 ? 'right' : 'left';
      it(`R83 DRIFT converges to slipT without overshoot above 2% (${tag}, steer 0.5 and 1, kick 2)`, () => {
        for (const steer of [0.5, 1]) {
          const s = mk({ speed: 0.8, state: 'DRIFT', dir: sign, yawRate: 2 * sign });
          const target = SF * steer;
          let peak = 0;
          for (let i = 0; i < 360; i++) {
            stepB(s, inp(steer * sign, true), Q);
            peak = Math.max(peak, slipOf(car(s)) * sign);
          }
          expect(peak).toBeLessThanOrEqual(target * 1.02);
          expect(slipOf(car(s)) * sign).toBeCloseTo(target, 3);
          expect(car(s).angle * sign).toBeCloseTo(steer, 3); // R87
        }
      });
      it(`R83 DRIFT is one-sided: full counter-steer drives slip*dir to 0 and never below (${tag})`, () => {
        const s = mk({
          speed: 0.8,
          state: 'DRIFT',
          dir: sign,
          vel: 0,
          yaw: 1.2 * sign,
          yawRate: 0,
        });
        let min = Infinity;
        for (let i = 0; i < 360; i++) {
          stepB(s, inp(-sign, true), Q); // 3 s of full counter-steer
          min = Math.min(min, slipOf(car(s)) * sign);
          expect(car(s).state).toBe('DRIFT');
          expect(car(s).dir).toBe(sign);
        }
        expect(min).toBeGreaterThanOrEqual(-1e-12);
        // critically damped decay from above: slip -> 0 without crossing (1.2*(1+24)*exp(-24) ~ 1.5e-8)
        expect(Math.abs(slipOf(car(s)))).toBeLessThan(1e-6);
        expect(Math.abs(car(s).yawRate)).toBeLessThan(1e-5);
      });
      it(`R83 DRIFT floor reached: a fast inward slip rate overshoots 0, the floor zeroes slip and yawRate for good (${tag})`, () => {
        // slip 1.2, yawRate -20 toward 0, target 0: x(t) = (1.2 + (-20 + 9.6) t) exp(-8 t) crosses 0 at t = 0.115 s
        const s = mk({
          speed: 0.8,
          state: 'DRIFT',
          dir: sign,
          vel: 0,
          yaw: 1.2 * sign,
          yawRate: -20 * sign,
        });
        let min = Infinity;
        for (let i = 0; i < 120; i++) {
          stepB(s, inp(-sign, true), Q);
          min = Math.min(min, slipOf(car(s)) * sign);
        }
        expect(Math.abs(min)).toBe(0); // reached exactly 0, never below
        expect(slipOf(car(s))).toBeCloseTo(0, 12);
        expect(car(s).yawRate).toBe(0);
        expect(car(s).state).toBe('DRIFT');
        expect(car(s).dir).toBe(sign);
      });
    }
    it('R83 DRIFT floor: slip with the wrong sign is set to 0 and yawRate to 0 on the same tick', () => {
      const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1, vel: 0.3, yaw: 0.2, yawRate: -1 });
      stepB(s, inp(0, true), Q); // slip -0.1, target 0, rate -1: still negative -> floored
      expect(slipOf(car(s))).toBeCloseTo(0, 12);
      expect(car(s).yawRate).toBe(0);
      expect(car(s).state).toBe('DRIFT');
    });
  });
});

describe('R84 motion', () => {
  // GRIP, straight, speed 0.5, steer 0, yaw 0.3, yawRate 0, vel 0.1.
  // R83: yawRate1 = (0 - 15*0.3)*0.393469 = -1.77061; yaw1 = 0.3 - 1.77061/120 = 0.285245
  // R84: slip = yaw1 - vel = 0.185245 < smax 0.75 -> vel1 = 0.1 + 22*0.185245/120 = 0.133962
  it('R84 GRIP vel update with the force clamp inactive', () => {
    const s = mk({ speed: 0.5, yaw: 0.3, vel: 0.1 });
    stepB(s, inp(0));
    const yaw1 = 0.3 + -15 * 0.3 * chase(60) * DT;
    expect(car(s).vel).toBeCloseTo(0.1 + 22 * (yaw1 - 0.1) * DT, 9);
    expect(car(s).vel).toBeCloseTo(0.133962, 5);
  });
  it('R84 GRIP force clamp active (slip 0.78 > smax 0.75, < limit 0.8): vel1 = g*smax*DT', () => {
    // yaw 0.82, vel 0: yaw1 = 0.82 - 15*0.82*0.393469/120 = 0.779669 > 0.75 -> vel1 = 22*0.75/120 = 0.1375
    // slip after = 0.642 < 0.8: no geometric pull
    const s = mk({ speed: 0.5, yaw: 0.82, vel: 0 });
    stepB(s, inp(0));
    expect(car(s).vel).toBeCloseTo(22 * 0.75 * DT, 9);
    expect(car(s).yaw).toBeCloseTo(0.82 - 15 * 0.82 * chase(60) * DT, 9);
    expect(car(s).yaw).toBeCloseTo(0.779669, 5);
  });
  it('R84 GRIP below slipGripMax the force is linear in the slip (0.7 -> not clamped)', () => {
    const s = mk({ speed: 0.5, yaw: 0.72, vel: 0 });
    stepB(s, inp(0));
    const yaw1 = 0.72 - 15 * 0.72 * chase(60) * DT; // 0.6918 < 0.75
    expect(car(s).vel).toBeCloseTo(22 * yaw1 * DT, 9);
  });
  describe('geometric slip limit (GRIP)', () => {
    // yaw 1.0, vel 0, steer s, yawRate 0: yawRate1 = (15.75 - 15)*0.393469 = 0.295102 (> 0).
    // With curve c (speed 1): A = c*2. yaw1 = 1 + (yawRate1 - A)*DT; vel1 = (22*0.75 - A)*DT.
    // slip = yaw1 - vel1 ~ 0.865 > lim 0.8: yaw = vel1 + 0.8, yawRate = min(yawRate1, A).
    const run = (curve: number, sign: 1 | -1) => {
      const s = mk({ speed: 1, yaw: 1.0 * sign, vel: 0 });
      stepB(s, inp(sign), Q, constTrack(curve * sign));
      return s;
    };
    for (const curve of [0, 0.5]) {
      const A = curve * 2;
      for (const sign of [1, -1] as const) {
        it(`R84 yaw pulled to vel ${sign > 0 ? '+' : '-'} lim, yawRate capped to A (curve ${curve}, sign ${sign})`, () => {
          const s = run(curve, sign);
          const vel1 = (22 * 0.75 - A) * DT;
          const yr1 = (15.75 - 15 * 1.0) * chase(60);
          expect(1 + (yr1 - A) * DT - vel1).toBeGreaterThan(0.8); // the limit is really active
          expect(car(s).vel).toBeCloseTo(sign * vel1, 9);
          expect(car(s).yaw).toBeCloseTo(sign * (vel1 + 0.8), 9);
          expect(car(s).yawRate).toBeCloseTo(sign * Math.min(yr1, A), 9);
        });
      }
    }
  });
  describe('R84 off road scaling by offroadVelMul (GRIP only)', () => {
    const P06: CarParams = { ...Q, offroadVelMul: 0.6 };
    it('R84 off road (|x| > 1) g and smax are scaled by offroadVelMul (0.6)', () => {
      // yaw 0.85, vel 0, steer 0, GRIP: yaw1 = 0.85 - 15*0.85*0.393469/120 = 0.808194
      // on road: slip > smax 0.75 -> vel1 = 22*0.75*DT = 0.1375
      // off road: g = 22*0.6 = 13.2, smax = 0.75*0.6 = 0.45 -> vel1 = 13.2*0.45*DT = 0.0495
      const on = mk({ speed: 0.5, yaw: 0.85, x: 0.5 });
      stepB(on, inp(0), P06);
      const off = mk({ speed: 0.5, yaw: 0.85, x: 1.2 });
      stepB(off, inp(0), P06);
      expect(car(on).vel).toBeCloseTo(22 * 0.75 * DT, 9);
      expect(car(off).vel).toBeCloseTo(22 * 0.6 * (0.75 * 0.6) * DT, 9);
    });
    it('R84 offroadVelMul = 1: off-road vel equals the on-road value', () => {
      const p1: CarParams = { ...Q, offroadVelMul: 1 };
      const on = mk({ speed: 0.5, yaw: 0.85, x: 0.5 });
      stepB(on, inp(0), p1);
      const off = mk({ speed: 0.5, yaw: 0.85, x: 1.2 });
      stepB(off, inp(0), p1);
      expect(car(off).vel).toBeCloseTo(22 * 0.75 * DT, 9);
      expect(car(off).vel).toBeCloseTo(car(on).vel, 12);
    });
    it('R84 offroadSteerMul has no effect in model B', () => {
      const run = (m: number): number => {
        const s = mk({ speed: 0.5, yaw: 0.85, x: 1.2 });
        stepB(s, inp(0), { ...P06, offroadSteerMul: m });
        return car(s).vel;
      };
      expect(run(0.1)).toBe(run(1));
      expect(run(0.3)).toBeCloseTo(22 * 0.6 * (0.75 * 0.6) * DT, 9);
    });
    it('R84 data: base.json offroadVelMul is within (0, 1]', () => {
      expect(baseCar.offroadVelMul).toBeGreaterThan(0);
      expect(baseCar.offroadVelMul).toBeLessThanOrEqual(1);
    });
  });

  describe('R84 DRIFT: velT = dir*driftLat*(slip*dir/slipFull + driftCounter*min(0, u)) - push*A', () => {
    // vel chase factor 1 - exp(-velGripDrift*DT) = 1 - exp(-3/120) = 0.024690
    const cf = 1 - Math.exp(-3 * DT);
    // Q: driftCounter 1, wrongPush = driftPush = 0.0287 -> bit-for-bit the pre-revision formula.
    // PN: the revised start numbers (driftCounter 0, wrongPush 0.13), explicit so the data file is not read.
    const PN: CarParams = { ...Q, driftCounter: 0, wrongPush: 0.13, driftPush: 0.0287 };
    it('R84 DRIFT driftCounter 0: counter-steer has no lateral effect (u < 0 gives the same vel as u = 0)', () => {
      // slip 0, straight: velT = 0.46*(0 + 0*u) - 0 = 0 for every u; vel1 = 0.1 + (0 - 0.1)*0.024690 = 0.097531
      const a = mk({ speed: 0.8, state: 'DRIFT', dir: 1, yaw: 0.1, vel: 0.1 });
      const b = mk({ speed: 0.8, state: 'DRIFT', dir: 1, yaw: 0.1, vel: 0.1 });
      stepB(a, inp(-0.5, true), PN);
      stepB(b, inp(0, true), PN);
      expect(car(a).vel).toBeCloseTo(0.1 - 0.1 * cf, 9);
      expect(car(a).vel).toBe(car(b).vel);
      expect(car(a).yaw).toBe(car(b).yaw);
    });
    it('R84 DRIFT driftCounter is a plain factor on the counter-steer term (0.5)', () => {
      // velT = 0.46*(0 + 0.5*(-0.5)) = -0.115; vel1 = 0.1 + (-0.115 - 0.1)*0.024690
      const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1, yaw: 0.1, vel: 0.1 });
      stepB(s, inp(-0.5, true), { ...Q, driftCounter: 0.5 });
      expect(car(s).vel).toBeCloseTo(0.1 + (-0.115 - 0.1) * cf, 9);
    });
    it('R84 DRIFT driftCounter 0 does not change the finger-toward-dir case (u = 0.4, A toward dir)', () => {
      const a = mk({ speed: 0.5, state: 'DRIFT', dir: 1, yaw: 0.9, vel: 0.3, yawRate: 0.2 });
      const b = mk({ speed: 0.5, state: 'DRIFT', dir: 1, yaw: 0.9, vel: 0.3, yawRate: 0.2 });
      stepB(a, inp(0.4, true), PN, constTrack(3));
      stepB(b, inp(0.4, true), Q, constTrack(3));
      expect(car(a).vel).toBe(car(b).vel);
    });
    // Push selection by the sign of A*dir. A = curve*speed/vmax*kYaw = curve*2 at speed 1; steer 0, slip 0, vel 0.
    it('R84 DRIFT push: turn toward the drift side (right drift, right curve 4.5, A = 9) uses driftPush', () => {
      // velT = -0.0287*9 = -0.2583
      const s = mk({ speed: 1, state: 'DRIFT', dir: 1 });
      stepB(s, inp(0, true), PN, constTrack(4.5));
      expect(car(s).vel).toBeCloseTo(-0.0287 * 9 * cf, 9);
    });
    it('R84 DRIFT push: turn against the drift side (right drift, left curve -4.5, A = -9) uses wrongPush', () => {
      // A*dir = -9 < 0 -> velT = -0.13*(-9) = +1.17
      const s = mk({ speed: 1, state: 'DRIFT', dir: 1 });
      stepB(s, inp(0, true), PN, constTrack(-4.5));
      expect(car(s).vel).toBeCloseTo(0.13 * 9 * cf, 9);
    });
    it('R84 DRIFT push mirror: left drift, left curve uses driftPush; left drift, right curve uses wrongPush', () => {
      // dir -1, A = -9: A*dir = 9 >= 0 -> velT = -0.0287*(-9) = +0.2583
      const toward = mk({ speed: 1, state: 'DRIFT', dir: -1 });
      stepB(toward, inp(0, true), PN, constTrack(-4.5));
      expect(car(toward).vel).toBeCloseTo(0.0287 * 9 * cf, 9);
      // dir -1, A = +9: A*dir = -9 < 0 -> velT = -0.13*9 = -1.17
      const against = mk({ speed: 1, state: 'DRIFT', dir: -1 });
      stepB(against, inp(0, true), PN, constTrack(4.5));
      expect(car(against).vel).toBeCloseTo(-0.13 * 9 * cf, 9);
    });
    it('R84 DRIFT push on a straight (A = 0, both sides): zero whatever the pushes are', () => {
      // velT = -push*0 = 0 for dir +1 and dir -1; vel stays 0
      for (const dir of [1, -1] as const) {
        const s = mk({ speed: 1, state: 'DRIFT', dir });
        stepB(s, inp(0, true), { ...PN, wrongPush: 5, driftPush: 5 });
        expect(car(s).vel).toBeCloseTo(0, 12);
      }
    });
    it('R84 wrongPush and driftCounter exist only in DRIFT: GRIP is identical for any values', () => {
      const run = (p: CarParams) => {
        const s = mk({ speed: 1 });
        stepN(s, 60, inp(0.3), p, constTrack(-4.5));
        return car(s);
      };
      const a = run(PN);
      const b = run({ ...PN, wrongPush: 9, driftCounter: 1 });
      expect(a.state).toBe('GRIP');
      expect(b.vel).toBe(a.vel);
      expect(b.yaw).toBe(a.yaw);
      expect(b.x).toBe(a.x);
    });
    it('R84 DRIFT one tick: velT from the new slip and A, vel chases it, yaw = vel + slip', () => {
      // DRIFT dir +1, speed 0.5, curve 3 (A = 3*0.5*2 = 3), steer 0.4 (u = 0.4), yaw 0.9, vel 0.3, yawRate 0.2.
      // slip1 = 0.603471 (see R83); velT = 0.46*(0.603471/2.64 + min(0, 0.4)) - 0.0287*3
      //   = 0.46*0.228588 - 0.0861 = 0.105150 - 0.0861 = 0.019050
      // vel1 = 0.3 + (0.019050 - 0.3)*0.024690 = 0.293064
      const s = mk({ speed: 0.5, state: 'DRIFT', dir: 1, yaw: 0.9, vel: 0.3, yawRate: 0.2 });
      stepB(s, inp(0.4, true), Q, constTrack(3));
      const [slip1] = driftChase(0.6, 0.2, 1.056);
      const velT = 0.46 * (slip1 / SF + Math.min(0, 0.4)) - 0.0287 * 3;
      expect(velT).toBeCloseTo(0.01905, 5);
      const vel1 = 0.3 + (velT - 0.3) * cf;
      expect(car(s).vel).toBeCloseTo(vel1, 9);
      expect(car(s).vel).toBeCloseTo(0.293064, 5);
      expect(car(s).yaw).toBeCloseTo(vel1 + slip1, 9);
    });
    it('R84 DRIFT counter-steer term: min(0, u) moves the car against dir with driftLat', () => {
      // slip 0 (yaw = vel = 0.1), steer -0.5 (u = -0.5), straight: slip stays 0.
      // velT = 0.46*(0 - 0.5) - 0 = -0.23; vel1 = 0.1 + (-0.23 - 0.1)*0.024690 = 0.091853
      const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1, yaw: 0.1, vel: 0.1 });
      stepB(s, inp(-0.5, true));
      expect(car(s).vel).toBeCloseTo(0.1 + (-0.23 - 0.1) * cf, 9);
      expect(car(s).yaw).toBeCloseTo(car(s).vel, 12); // slip 0
    });
    it('R84 DRIFT push by the road turn: steer 0, slip 0, curve 4.5 at speed 1 (A = 9)', () => {
      // velT = -0.0287*9 = -0.2583; vel1 = -0.2583*0.024690 = -0.006378
      const s = mk({ speed: 1, state: 'DRIFT', dir: 1 });
      stepB(s, inp(0, true), Q, constTrack(4.5));
      expect(car(s).vel).toBeCloseTo(-0.0287 * 9 * cf, 9);
    });
    it('R84 DRIFT left (dir -1) is the exact mirror of right', () => {
      const a = mk({ speed: 0.5, state: 'DRIFT', dir: 1, yaw: 0.9, vel: 0.3, yawRate: 0.2 });
      const b = mk({ speed: 0.5, state: 'DRIFT', dir: -1, yaw: -0.9, vel: -0.3, yawRate: -0.2 });
      stepB(a, inp(0.4, true), Q, constTrack(3));
      stepB(b, inp(-0.4, true), Q, constTrack(-3));
      expect(car(b).vel).toBeCloseTo(-car(a).vel, 12);
      expect(car(b).yaw).toBeCloseTo(-car(a).yaw, 12);
    });
    it('R84 DRIFT full slip gives full driftLat: steady vel = driftLat*slip/slipFull on a straight', () => {
      // steer 1: slip -> 2.64; velT = 0.46 -> vel -> 0.46 (chase rate 3, 6 s)
      const s = mk({ speed: 0.8, state: 'DRIFT', dir: 1 });
      stepN(s, 720, inp(1, true), { ...Q, xLimit: 1e9, offroadMul: 1 }); // no wall, no off-road loss
      expect(car(s).vel).toBeCloseTo(0.46, 3);
      expect(car(s).yaw).toBeCloseTo(0.46 + 2.64, 3);
    });
    it('R84 in DRIFT off road there is no scaling even with offroadVelMul 0.6', () => {
      const P06: CarParams = { ...Q, offroadVelMul: 0.6 };
      const st = { speed: 0.8, state: 'DRIFT' as const, dir: 1 as const, yaw: 1, vel: 0.5 };
      const on = mk({ ...st, x: 0.5 });
      stepB(on, inp(1, true), P06);
      const off = mk({ ...st, x: 1.2 });
      stepB(off, inp(1, true), P06);
      expect(car(off).state).toBe('DRIFT');
      expect(car(off).vel).toBeCloseTo(car(on).vel, 12);
      expect(car(off).yaw).toBeCloseTo(car(on).yaw, 12);
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
    // R84: vel1 = (22*clamp(-0.075 - 0, 0.75) - 9)*DT = (-1.65 - 9)/120 = -0.088750
    // x1 = vel1*1*1*DT
    const s = mk({ speed: 1 });
    stepB(s, inp(0), Q, constTrack(4.5));
    expect(car(s).vel).toBeCloseTo(-0.08875, 9);
    expect(car(s).x).toBeCloseTo(-0.08875 * DT, 12);
  });
});

describe('R86 speed', () => {
  // DRIFT with a steady slip: steer 0.5, yaw = vel + 1.32, yawRate 0, vel 0 -> slip stays 1.32 (= slipT),
  // so cap = vmax*min(capMul, 1 - 0.15*1.32/2.64) = 0.925. PB has accel 0.22, slipDrag 0.058, driftBrake 0.3.
  const steady = (speed: number, over: Partial<ReturnType<typeof car>> = {}, p: CarParams = PB) => {
    const s = mk({ speed, state: 'DRIFT', dir: 1, yaw: 1.32, vel: 0, ...over });
    stepB(s, inp(0.5, true), p);
    return s;
  };
  it('R86 DRIFT above the angle cap falls by driftBrake*DT (cap 0.925, speed 1 -> 0.9975)', () => {
    const s = steady(1);
    expect(slipOf(car(s))).toBeCloseTo(1.32, 9);
    expect(car(s).speed).toBeCloseTo(1 - 0.3 * DT, 12);
  });
  it('R86 DRIFT below the cap accelerates by accel*DT and slipDrag is NOT applied', () => {
    // 0.92 + 0.22/120 = 0.921833 < 0.925; with slipDrag the result would be lower by 0.058*1.32^2/120
    const s = steady(0.92);
    expect(car(s).speed).toBeCloseTo(0.92 + 0.22 * DT, 12);
  });
  it('R86 DRIFT cap uses slip, not carry: a big carry changes nothing', () => {
    const a = steady(1);
    const b = steady(1, { carry: 0.8 });
    expect(car(b).speed).toBeCloseTo(car(a).speed, 12);
  });
  it('R86 DRIFT cap tightens with the slip: full slip 2.64 -> cap 0.85', () => {
    // steer 1, yaw = vel + 2.64, yawRate 0: slip stays 2.64, cap = 1 - 0.15 = 0.85
    const s = mk({ speed: 0.9, state: 'DRIFT', dir: 1, yaw: 2.64, vel: 0 });
    stepB(s, inp(1, true), PB);
    expect(car(s).speed).toBeCloseTo(0.9 - 0.3 * DT, 12);
    const lo = mk({ speed: 0.84, state: 'DRIFT', dir: 1, yaw: 2.64, vel: 0 });
    stepB(lo, inp(1, true), PB);
    expect(car(lo).speed).toBeCloseTo(0.84 + 0.22 * DT, 12);
  });
  it('R86 DRIFT cap is monotone: a larger slip never gives a higher cap (above-cap speed)', () => {
    let last = Infinity;
    for (const slip of [0, 0.66, 1.32, 1.98, 2.64]) {
      const s = mk({ speed: 1.0, state: 'DRIFT', dir: 1, yaw: slip, vel: 0 });
      stepB(s, inp(slip / SF, true), PB);
      // speed after one tick: 1 - brake*DT while above the cap, so compare through a long run
      stepN(s, 600, inp(slip / SF, true), PB);
      expect(car(s).speed).toBeLessThanOrEqual(last + 1e-9);
      last = car(s).speed;
    }
  });
  it('R86 GRIP: speed -= slipDrag*vis^2*DT with vis = yaw - vel + carry (after R82b, R83, R84)', () => {
    // GRIP, steer 0, yaw 0.3, vel 0.1, carry 0.4: R14: 0.8 + 0.22 DT; then minus 0.058*vis^2*DT
    const s = mk({ speed: 0.8, yaw: 0.3, vel: 0.1, carry: 0.4 });
    stepB(s, inp(0), PB);
    const vis = slipOf(car(s)) + car(s).carry;
    expect(car(s).carry).toBeCloseTo(0.4 * Math.exp(-8 * DT), 12);
    expect(car(s).speed).toBeCloseTo(0.8 + 0.22 * DT - 0.058 * vis * vis * DT, 12);
  });
  it('R86 GRIP: carry alone (yaw = vel) costs speed', () => {
    const s = mk({ speed: 0.8, carry: 0.5 });
    stepB(s, inp(0), PB);
    const c = 0.5 * Math.exp(-8 * DT);
    expect(car(s).speed).toBeCloseTo(0.8 + 0.22 * DT - 0.058 * c * c * DT, 12);
  });
  it('R86 R15 applies after the drag (GRIP, off road, x = 1.2)', () => {
    const s = mk({ speed: 0.8, yaw: 0.3, vel: 0.1, x: 1.2 });
    stepB(s, inp(0), PB);
    const vis = slipOf(car(s)) + car(s).carry;
    const expected = (0.8 + 0.22 * DT - 0.058 * vis * vis * DT) * Math.pow(0.99, 60 * DT);
    expect(car(s).speed).toBeCloseTo(expected, 12);
  });
  it('R86 R15 applies in DRIFT too (x = 1.2)', () => {
    const s = steady(0.92, { x: 1.2 });
    expect(car(s).speed).toBeCloseTo((0.92 + 0.22 * DT) * Math.pow(0.99, 60 * DT), 12);
  });
  it('R86 speed is floored at 0 by the drag (GRIP)', () => {
    const s = mk({ speed: 0.8, yaw: 0.3, vel: 0.1 });
    stepB(s, inp(0), { ...PB, slipDrag: 1e5 });
    expect(car(s).speed).toBe(0);
  });
  it('R86 brake input slows by brake*DT (R14)', () => {
    const s = mk({ speed: 0.5 });
    stepB(s, inp(0, false, true), PB);
    expect(car(s).speed).toBeCloseTo(0.5 - 0.6 * DT, 12);
  });
  it('R86 above vmax speed falls by driftBrake*DT (GRIP)', () => {
    const g = mk({ speed: 1.1 });
    stepB(g, inp(0), PB);
    expect(car(g).speed).toBeCloseTo(1.1 - 0.3 * DT, 12);
  });
  it('R86 a drift at zero slip reaches vmax (cap = vmax*(1 - 0) = vmax)', () => {
    const s = mk({ speed: 0.5, state: 'DRIFT', dir: 1 });
    stepN(s, 400, inp(0, true), PB);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).speed).toBeCloseTo(1, 12);
  });
  describe('R52 boost works in model B', () => {
    // traffic car 10 segments ahead in the cone (draftLength 80, draftWidth 0.25), draft = 1:
    // cap = vmax*draftCapMul = 1.13, accel*draftAccelMul = 0.352 -> speed 1.0 + 0.352*DT
    const P1: CarParams = { ...PB, slipDrag: 0 };
    const boosted = (over: Partial<ReturnType<typeof car>>, drift: boolean) => {
      const s = createRace(1, 1, 1);
      Object.assign(car(s), { speed: 1, draft: 1, ...over });
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
    it('R52 DRIFT: the cap is min(capMul, 1 - loss*|slip|/slipFull): at zero slip vmax, no boost', () => {
      const s = boosted({ state: 'DRIFT', dir: 1 }, true);
      expect(car(s).speed).toBeCloseTo(1, 12);
    });
    it('R52 DRIFT: a boosted speed above the angle cap falls by driftBrake*DT', () => {
      const s = boosted({ state: 'DRIFT', dir: 1, speed: 1.1 }, true);
      expect(car(s).speed).toBeCloseTo(1.1 - 0.3 * DT, 12);
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
  for (const sign of [1, -1] as const) {
    const tag = sign > 0 ? 'right' : 'left';
    it(`R87 DRIFT: angle = slip / slipFull, angle*dir in [0, 1] (${tag})`, () => {
      // steer 0.45: slipT = 1.188; start at slip 1.2 -> chase pulls it down slightly
      const s = mk({
        speed: 0.8,
        state: 'DRIFT',
        dir: sign,
        yaw: 1.2 * sign,
        vel: 0,
        yawRate: 0,
      });
      stepB(s, inp(0.45 * sign, true));
      expect(car(s).angle).toBeCloseTo(slipOf(car(s)) / 2.64, 12);
      expect(car(s).angle * sign).toBeGreaterThan(0);
      expect(car(s).angle * sign).toBeLessThanOrEqual(1);
    });
    it(`R87 DRIFT: full steer for a long time keeps angle*dir <= 1 and reaches 1 (${tag})`, () => {
      const s = mk({ speed: 0.8, state: 'DRIFT', dir: sign, yawRate: 2 * sign });
      let peak = 0;
      for (let i = 0; i < 480; i++) {
        stepB(s, inp(sign, true), Q);
        peak = Math.max(peak, car(s).angle * sign);
      }
      expect(peak).toBeLessThanOrEqual(1.02);
      expect(car(s).angle * sign).toBeCloseTo(1, 3);
    });
  }
  it('R87 GRIP: angle is 0 whatever the slip and carry (stale angle is overwritten)', () => {
    const s = mk({ speed: 0.8, yaw: 0.4, vel: 0, angle: 0.7, carry: 0.5 });
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
    Object.assign(car(s), { speed: 0.8, z: 10, x: 0.05, ...over });
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
  it('R44 DRIFT: slip falls by bumpAngleLoss*slipFull = 0.3*2.64 = 0.792 and the drift is kept', () => {
    // DRIFT dir +1, yaw 2, vel 0 (slip ~2): after R42 vel = 0.375, slip ~1.6 > 0.792, so no floor.
    // R42 leaves yaw alone, so yaw_hit = yaw_ctrl - 0.792.
    const hit = bump({ state: 'DRIFT', dir: 1, yaw: 2, vel: 0 });
    const ctrl = bump({ state: 'DRIFT', dir: 1, yaw: 2, vel: 0 }, BQ, false);
    expect(car(hit).state).toBe('DRIFT');
    expect(car(hit).dir).toBe(1);
    expect(car(hit).yaw).toBeCloseTo(car(ctrl).yaw - 0.792, 9);
  });
  it('R44 mirror: dir -1 yaw moves up by bumpAngleLoss*slipFull', () => {
    const hit = bump({ x: -0.05, state: 'DRIFT', dir: -1, yaw: -2, vel: 0 });
    const ctrl = bump({ x: -0.05, state: 'DRIFT', dir: -1, yaw: -2, vel: 0 }, BQ, false);
    expect(car(hit).state).toBe('DRIFT');
    expect(car(hit).yaw).toBeCloseTo(car(ctrl).yaw + 0.792, 9);
  });
  it('R44 the loss scales with slipFull (a car with slipFull 1 loses 0.3)', () => {
    const p: CarParams = { ...BQ, slipFull: 1 };
    const hit = bump({ state: 'DRIFT', dir: 1, yaw: 2, vel: 0 }, p);
    const ctrl = bump({ state: 'DRIFT', dir: 1, yaw: 2, vel: 0 }, p, false);
    expect(car(hit).yaw).toBeCloseTo(car(ctrl).yaw - 0.3, 9);
  });
  it('R44 slip is floored at 0 (yaw does not cross vel) and the drift stays', () => {
    const p: CarParams = { ...BQ, bumpAngleLoss: 2 }; // 2*2.64 = 5.28 > any slip here
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

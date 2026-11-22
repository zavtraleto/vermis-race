import { describe, expect, it } from 'vitest';
import curves from '../../src/data/tracks/curves.json';
import hypotheses from '../../src/data/hypotheses.json';
import { DT } from '../../src/sim/constants';
import type { CarParams, RaceState } from '../../src/sim/types';
import {
  G,
  P,
  STRAIGHT,
  car0,
  curveTrack,
  frame,
  perTick,
  race1,
  rad,
  slipOf,
  stepN,
  vMs,
} from './r200_helpers';

// Driving slice 2 (drift), brief R205, R207 (gripRear < 1), R208, R209, R215(3)-(6), (8), H23-H26.
// Written from docs/brief.md only. DT = 1/120; vmaxKmh = 180 -> v(0.5) = 25 m/s.
//
// Hypothesis switches reach the sim as CarParams numbers (like H5 draftBoost): 1 = A (on), 0 = B (off).
// Names chosen by the test writer (brief does not name them): hypAssist (H23, R205), hypEdge (H24,
// R209 edge), hypRef (H25, R209 refAngle), hypBrakeTap (H26, R208 brake tap).
type Flags = { hypAssist?: number; hypEdge?: number; hypRef?: number; hypBrakeTap?: number };
const withP = (over: Partial<CarParams> & Flags, base: CarParams = P): CarParams =>
  ({ ...base, ...over }) as CarParams;

/** Brief R208: timers = round(t/DT): driftWindow 0.66 s -> round(79.2) = 79 ticks. Each tick first
 * driftTimer -= 1, then an opening sets the full value -> 79 right after the opening tick. */
const WIN = Math.round(0.66 / DT); // 79
const WIN_LO = WIN;
const WIN_HI = WIN;
/** Brief R208: driftHold 0.2 s = 24 ticks. */
const HOLD = Math.round(0.2 / DT);
/** Brief R209: "0.01 per OR2 tick" and "1.4 deg per OR2 tick" -> x 60.2 per second (units paragraph). */
const EDGE_FALL = 0.01 * 60.2 * DT; // 0.0050167 per our tick
const REF_MAX = rad(1.4) * 60.2 * DT; // 0.0122882 rad per our tick (0.7023 deg)

/** R207 first tick from travelRate 0: travelRate = sign(slip)*min(slipRateMax, min(T, |slip|*slipDecay)*k4). */
function rate1(speed: number, slip: number, gripRear: number, p: CarParams = P): number {
  const v = vMs(p, speed);
  const T = p.slipRecover * Math.atan((gripRear * p.rearMu * G * p.wheelBase) / (v * v));
  const desired = Math.min(T, Math.abs(slip) * p.slipDecay);
  return Math.sign(slip) * Math.min(rad(p.slipRateMax), desired * perTick(0.25));
}

/** R208 in drift: gripDrift - (dropFull + (dropLift - dropFull)*(1 - gas)*cs), clamped 0..1. */
function gripDriftOf(steer: number, gas: number, slip: number, p: CarParams = P): number {
  const cs = Math.max(0, Math.min(1, (1 - steer * Math.sign(slip)) / 2));
  const g = p.gripDrift - (p.dropFull + (p.dropLift - p.dropFull) * (1 - gas) * cs);
  return Math.max(0, Math.min(1, g));
}

/** R205-R207 one tick from travel 0, slip = heading: heading after the tick when front = wheel (no clamp). */
function heading1(speed: number, slip: number, wheel: number, p: CarParams = P): number {
  const v = vMs(p, speed);
  const rear = -slip;
  return slip + ((v * Math.cos(rear) * (Math.tan(wheel) - Math.tan(rear))) / p.wheelBase) * DT;
}

/** R208 "набор дрифта": while driftTimer > 0, R206 uses gripFrontDrift and R207 slipDecayDrift. */
const dp = (p: CarParams = P): CarParams => ({
  ...p,
  gripFront: p.gripFrontDrift,
  slipDecay: p.slipDecayDrift,
});

/** R206/R207 one tick from travel 0, slip = heading, counter 0: heading with the aFront clamp. */
function heading1c(speed: number, slip: number, wheel: number, p: CarParams = P): number {
  const v = vMs(p, speed);
  const rear = -slip;
  const a = Math.atan((p.gripFront * G * p.wheelBase) / (v * v));
  const front = rear + Math.max(-a, Math.min(a, wheel - rear));
  return slip + ((v * Math.cos(rear) * (Math.tan(front) - Math.tan(rear))) / p.wheelBase) * DT;
}

/** R206 aFront with counter 0. */
const aFront0 = (speed: number, p: CarParams = P): number => {
  const v = vMs(p, speed);
  return Math.atan((p.gripFront * G * p.wheelBase) / (v * v));
};

/**
 * R215(3) entry: straight, x kept at 0, driftTap on tick 0, full steer to `side`. Returns the tick
 * (0-based) of the first latch (|slip| > slipLatch while driftTimer > 0), or -1 within the window.
 */
function enterDrift(s: RaceState, side: number, p: CarParams = P): number {
  let latch = -1;
  for (let i = 0; i <= WIN_HI && latch < 0; i++) {
    stepN(s, 1, frame(side, 1, 0, i === 0), STRAIGHT, p, true);
    const c = car0(s);
    if (Math.abs(slipOf(c)) > rad(8.4) && c.driftTimer > 0) latch = i;
  }
  return latch;
}

describe('R208 drift parameters and flags exist', () => {
  it('R208/R209/R205: every slice-2 parameter is a finite number in CarParams (src/data)', () => {
    const names = [
      'driftWindow',
      'driftHold',
      'gripDrift',
      'dropFull',
      'dropLift',
      'railDrift',
      'edgePull',
      'refGain',
      'refLook',
      'refGrip',
      'assistSpeed',
      'assistLead',
      'brakeTapOn',
      'gasTapMax',
      'gripFrontDrift',
      'slipDecayDrift',
      'hypAssist',
      'hypEdge',
      'hypRef',
      'hypBrakeTap',
    ];
    const rec = P as unknown as Record<string, unknown>;
    for (const n of names) {
      expect(typeof rec[n], n).toBe('number');
      expect(Number.isFinite(rec[n]), n).toBe(true);
    }
  });

  it('R208/R205: constants stated in the brief', () => {
    expect(P.driftWindow).toBe(0.66); // R208 s
    expect(P.driftHold).toBe(0.2); // R208 s
    expect(P.brakeTapOn).toBe(0.04); // R208
    expect(P.gasTapMax).toBe(0.98); // R208
    expect(P.assistSpeed).toBe(20); // R205 km/h
    expect(P.assistLead).toBe(0.133); // R205 seconds (8 OR2 ticks / 60.2)
    expect(P.dropLift).toBeLessThan(P.dropFull); // R208
  });

  it('H23-H26: flags exist in src/data/hypotheses.json with A, and the car data is A (on)', () => {
    const h = hypotheses as Record<string, string>;
    for (const id of ['H23', 'H24', 'H25', 'H26']) {
      const key = Object.keys(h).find((k) => k === id || k.startsWith(`${id}_`));
      expect(key, id).toBeDefined();
      expect(h[key!], id).toBe('A');
    }
    expect(P.hypAssist).toBe(1);
    expect(P.hypEdge).toBe(1);
    expect(P.hypRef).toBe(1);
    expect(P.hypBrakeTap).toBe(1);
  });
});

describe('R208 drift window, latch, exit', () => {
  it('R208: driftTap opens the window: driftTimer = driftWindow (~79 ticks), then -1 per tick', () => {
    const s = race1({ speed: 0.5 });
    stepN(s, 1, frame(0, 1, 0, true));
    const t0 = car0(s).driftTimer;
    expect(t0).toBeGreaterThanOrEqual(WIN_LO);
    expect(t0).toBeLessThanOrEqual(WIN_HI);
    for (let i = 1; i <= 10; i++) {
      stepN(s, 1, frame(0));
      expect(car0(s).driftTimer).toBe(t0 - i);
    }
  });

  it('R208: window expires without slip -> driftTimer 0 after ~0.66 s, no drift, never refreshed', () => {
    const s = race1({ speed: 0.5 });
    let prev = Infinity;
    stepN(
      s,
      WIN_HI + 2,
      (t) => frame(0, 1, 0, t === 0),
      STRAIGHT,
      P,
      false,
      (c) => {
        expect(c.driftTimer).toBeLessThan(prev); // strictly falls until 0 (or stays 0)
        expect(Math.abs(slipOf(c))).toBe(0);
        prev = c.driftTimer === 0 ? Infinity : c.driftTimer;
      },
    );
    expect(car0(s).driftTimer).toBe(0);
  });

  it('R208: driftTimer never goes below 0', () => {
    const s = race1({ speed: 0.5 });
    stepN(s, 30, frame(0), STRAIGHT, P, false, (c) => expect(c.driftTimer).toBe(0));
  });

  it('R208/H26 A: brake crosses brakeTapOn upward while gas < gasTapMax -> window opens', () => {
    const s = race1({ speed: 0.8, prevGas: 0, prevBrake: 0 });
    stepN(s, 1, frame(0, 0, 0.5));
    expect(car0(s).driftTimer).toBeGreaterThanOrEqual(WIN_LO);
    expect(car0(s).driftTimer).toBeLessThanOrEqual(WIN_HI);
    // R200: prevGas/prevBrake = this tick's input
    expect(car0(s).prevGas).toBe(0);
    expect(car0(s).prevBrake).toBe(0.5);
  });

  it('R208/H26 A: gas falls below gasTapMax while brake > brakeTapOn -> window opens', () => {
    const s = race1({ speed: 0.8, prevGas: 1, prevBrake: 0.5 });
    stepN(s, 1, frame(0, 0.5, 0.5));
    expect(car0(s).driftTimer).toBeGreaterThanOrEqual(WIN_LO);
    expect(car0(s).driftTimer).toBeLessThanOrEqual(WIN_HI);
  });

  it('R208/H26 A: held brake, or a brake press with gas >= gasTapMax, does not open the window', () => {
    const held = race1({ speed: 0.8, prevGas: 0, prevBrake: 0.5 });
    stepN(held, 1, frame(0, 0, 0.5));
    expect(car0(held).driftTimer).toBe(0);
    const gasOn = race1({ speed: 0.8, prevGas: 1, prevBrake: 0 });
    stepN(gasOn, 1, frame(0, 1, 0.5));
    expect(car0(gasOn).driftTimer).toBe(0);
    const tiny = race1({ speed: 0.8, prevGas: 0, prevBrake: 0 }); // 0.03 < brakeTapOn 0.04
    stepN(tiny, 1, frame(0, 0, 0.03));
    expect(car0(tiny).driftTimer).toBe(0);
  });

  it('R208/H26 B: with the flag off a brake tap does not open the window; driftTap still does', () => {
    const off = withP({ hypBrakeTap: 0 });
    const a = race1({ speed: 0.8, prevGas: 0, prevBrake: 0 });
    stepN(a, 1, frame(0, 0, 0.5), STRAIGHT, off);
    expect(car0(a).driftTimer).toBe(0);
    const b = race1({ speed: 0.8, prevGas: 1, prevBrake: 0.5 });
    stepN(b, 1, frame(0, 0.5, 0.5), STRAIGHT, off);
    expect(car0(b).driftTimer).toBe(0);
    const c = race1({ speed: 0.8 });
    stepN(c, 1, frame(0, 1, 0, true), STRAIGHT, off);
    expect(car0(c).driftTimer).toBeGreaterThanOrEqual(WIN_LO);
  });

  it('R208: latch: driftTimer > 0 and |slip| > 8.4 deg -> driftTimer = driftHold (24 ticks) every tick', () => {
    // slip 20 deg, full steer to the slip side at vmax: slip stays well above 8.4 deg for some ticks
    const s = race1({ speed: P.vmax, steer: 1, heading: rad(20), driftTimer: 50 });
    stepN(s, 5, frame(1), STRAIGHT, P, true, (c) => {
      expect(Math.abs(slipOf(c))).toBeGreaterThan(rad(8.4));
      expect(c.driftTimer).toBe(HOLD);
    });
  });

  it('R208: no latch without the window: |slip| > 8.4 deg with driftTimer 0 keeps it 0', () => {
    const s = race1({ speed: 0.5, heading: rad(20) });
    stepN(s, 1, frame(0));
    expect(car0(s).driftTimer).toBe(0);
  });

  it('R208: exit: |slip| < 8.4 deg for driftHold -> timer runs out (24 ticks from a latch value)', () => {
    const s = race1({ speed: 0.5, driftTimer: HOLD });
    stepN(s, HOLD - 1, frame(0));
    expect(car0(s).driftTimer).toBe(1);
    stepN(s, 1, frame(0));
    expect(car0(s).driftTimer).toBe(0);
  });
});

describe('R208 gripRear (seen through the R207 first-tick travelRate)', () => {
  // travelRate starts at 0; R205/R206 change only heading; R209 changes travel, not travelRate.
  // H25 off to isolate the formula (with refAngle = 0 there is no bonus anyway, tested below).
  const noRef = withP({ hypRef: 0 });
  const speed = 0.5;

  it('R208: in drift and |slip| >= slipGrip: gripDrift - (dropFull + (dropLift - dropFull)*(1-gas)*cs)', () => {
    const slip = rad(20);
    // cs = clamp((1 - steer*sign(slip))/2): steer 1 -> 0, steer 0 -> 0.5, steer -1 -> 1
    for (const steer of [1, 0, -1]) {
      for (const gas of [1, 0.5, 0]) {
        const s = race1({ speed, steer, heading: slip, driftTimer: 50 });
        stepN(s, 1, frame(steer, gas), STRAIGHT, noRef);
        const g = gripDriftOf(steer, gas, slip, noRef);
        expect(g).toBeLessThan(1);
        expect(car0(s).travelRate, `steer ${steer} gas ${gas}`).toBeCloseTo(
          rate1(speed, slip, g, dp(noRef)),
          12,
        );
      }
    }
  });

  it('R208: property: cs is mirrored for slip < 0 (left is the mirror of right)', () => {
    for (const steer of [1, 0, -1]) {
      const r = race1({ speed, steer, heading: rad(20), driftTimer: 50 });
      const l = race1({ speed, steer: -steer, heading: rad(-20), driftTimer: 50 });
      stepN(r, 1, frame(steer, 0.5), STRAIGHT, noRef);
      stepN(l, 1, frame(-steer, 0.5), STRAIGHT, noRef);
      expect(car0(l).travelRate).toBeCloseTo(-car0(r).travelRate, 12);
    }
  });

  it('R208: property: less gas with countersteer never raises rear grip (dropLift vs dropFull)', () => {
    // R208: dropLift < dropFull -> lifting the gas with countersteer gives grip back (g0 > g1)
    const g1 = gripDriftOf(-1, 1, rad(20));
    const g0 = gripDriftOf(-1, 0, rad(20));
    expect(Math.sign(g1 - g0)).toBe(Math.sign(P.dropLift - P.dropFull));
  });

  it('R208/R209 H25 on: refAngle = 0 gives no extra grip (same as H25 off)', () => {
    const slip = rad(20);
    const s = race1({ speed, heading: slip, driftTimer: 50, refAngle: 0 });
    stepN(s, 1, frame(0, 0.5));
    expect(car0(s).travelRate).toBeCloseTo(rate1(speed, slip, gripDriftOf(0, 0.5, slip), dp()), 12);
  });

  it('R208: outside drift (driftTimer 0) gripRear = 1 at the same slip', () => {
    const slip = rad(20);
    const s = race1({ speed, heading: slip });
    stepN(s, 1, frame(0, 0.5), STRAIGHT, noRef);
    expect(car0(s).travelRate).toBeCloseTo(rate1(speed, slip, 1), 12);
  });

  it('R208: in drift but |slip| < slipGrip (3 deg): gripRear = 1', () => {
    const slip = rad(3);
    const s = race1({ speed, heading: slip, driftTimer: 50 });
    stepN(s, 1, frame(0, 0.5), STRAIGHT, noRef);
    // drift set: slipDecayDrift (R208 "набор дрифта")
    expect(car0(s).travelRate).toBeCloseTo(rate1(speed, slip, 1, dp(noRef)), 12);
  });
});

describe('R208 drift coefficient set (gripFrontDrift, slipDecayDrift while driftTimer > 0)', () => {
  // vmax (v = 50 m/s), full steer preset, slip 0.5 deg (< slipGrip -> gripRear 1 either way):
  // wheel 5 deg vs rear -0.5 deg -> the R206 aFront clamp binds (grip: atan(3.33*9.81*3/2500) = 2.25 deg);
  // the R207 catch-up is slipDecay-limited (|slip|*slipDecay = 0.00873*120 = 1.05 < T).
  // R205: wheelGo = -0.5 deg is opposite to the wheel, slipRate 0 -> no change; counter stays 0.
  const slip = rad(0.5);
  const wheel = rad(P.wheelMax);
  const gripH = heading1c(P.vmax, slip, wheel);
  const driftH = heading1c(P.vmax, slip, wheel, dp());
  const gripR = rate1(P.vmax, slip, 1);
  const driftR = rate1(P.vmax, slip, 1, dp());

  it('R208: the two sets differ at this state (precondition of the tests below)', () => {
    expect(Math.abs(driftH - gripH)).toBeGreaterThan(1e-9);
    expect(Math.abs(driftR - gripR)).toBeGreaterThan(1e-9);
  });

  it('R208: driftTimer 0 -> grip set (gripFront, slipDecay)', () => {
    const s = race1({ speed: P.vmax, steer: 1, heading: slip });
    stepN(s, 1, frame(1));
    expect(car0(s).heading).toBeCloseTo(gripH, 12);
    expect(car0(s).travelRate).toBeCloseTo(gripR, 12);
  });

  it('R208: opening the window (driftTap) switches both coefficients on that same tick', () => {
    const s = race1({ speed: P.vmax, steer: 1, heading: slip });
    stepN(s, 1, frame(1, 1, 0, true));
    expect(car0(s).driftTimer).toBe(WIN);
    expect(car0(s).heading).toBeCloseTo(driftH, 12);
    expect(car0(s).travelRate).toBeCloseTo(driftR, 12);
  });

  it('R208/H26: a brake tap opening switches them on that tick too', () => {
    const s = race1({ speed: P.vmax, steer: 1, heading: slip, prevGas: 0, prevBrake: 0 });
    stepN(s, 1, frame(1, 0, 0.5));
    expect(car0(s).heading).toBeCloseTo(driftH, 12);
    expect(car0(s).travelRate).toBeCloseTo(driftR, 12);
  });

  it('R208: driftTimer 2 -> 1 keeps the drift set; 1 -> 0 switches back to the grip set on that tick', () => {
    const a = race1({ speed: P.vmax, steer: 1, heading: slip, driftTimer: 2 });
    stepN(a, 1, frame(1));
    expect(car0(a).driftTimer).toBe(1);
    expect(car0(a).heading).toBeCloseTo(driftH, 12);
    expect(car0(a).travelRate).toBeCloseTo(driftR, 12);
    const b = race1({ speed: P.vmax, steer: 1, heading: slip, driftTimer: 1 });
    stepN(b, 1, frame(1));
    expect(car0(b).driftTimer).toBe(0);
    expect(car0(b).heading).toBeCloseTo(gripH, 12);
    expect(car0(b).travelRate).toBeCloseTo(gripR, 12);
  });
});

describe('R205 countersteer assist (H23)', () => {
  // Straight, travel 0, heading = slip, slipRate 0 -> wheelGo = clamp(-slip, +-45 deg).
  // heading after the tick = slip + v*cos(rear)*(tan(front) - tan(rear))/wheelBase*DT with front = wheel
  // whenever |wheel - rear| stays inside aFront (checked; counter grows <= 0.05 on the first tick).
  const slip = rad(8);

  it('R205: wheel on the countersteer side short of wheelGo is pulled by min(1, |steer|/0.88)', () => {
    const speed = 0.5; // 90 km/h > 20 km/h
    const steer = -0.5;
    // wheel = -0.5*5 = -2.5 deg; wheelGo = -8 deg; k = 0.5/0.88 = 0.568182
    // wheel' = -2.5 + (-8 + 2.5)*0.568182 = -5.625 deg
    const w0 = steer * rad(P.wheelMax);
    const wheel = w0 + (-slip - w0) * Math.min(1, Math.abs(steer) / 0.88);
    expect(Math.abs(wheel + slip)).toBeLessThan(0.9 * aFront0(speed)); // no aFront clamp
    const s = race1({ speed, steer, heading: slip });
    stepN(s, 1, frame(steer));
    expect(car0(s).heading).toBeCloseTo(heading1(speed, slip, wheel), 12);
  });

  it('R205: |steer| >= 0.88 puts the wheels on wheelGo: front = rear, the body does not rotate', () => {
    const s = race1({ speed: 0.5, steer: -0.95, heading: slip });
    stepN(s, 1, frame(-0.95));
    // wheel = wheelGo = -slip = rear -> omega = 0
    expect(Math.abs(car0(s).heading - slip)).toBeLessThan(1e-12);
  });

  it('R205: wheelGo is clamped to +-45 deg (slip 60 deg, steer -1 at 27 km/h)', () => {
    const speed = 27 / P.vmaxKmh; // v = 7.5 m/s, aFront ~ 60 deg
    const big = rad(60);
    const wheel = -rad(45); // -5 + (-45 + 5)*1
    expect(Math.abs(wheel + big)).toBeLessThan(0.9 * aFront0(speed));
    const s = race1({ speed, steer: -1, heading: big });
    stepN(s, 1, frame(-1));
    expect(car0(s).heading).toBeCloseTo(heading1(speed, big, wheel), 12);
  });

  it('R205: in drift otherwise wheel -= slipRate/60.2 (wheel on the slip side, slipRate 0.6 rad/s)', () => {
    const speed = 0.3; // 54 km/h, aFront ~ 23.5 deg
    const steer = 0.5; // wheel +2.5 deg, wheelGo < 0: opposite signs -> else branch
    const sr = 0.6;
    const wheel = steer * rad(P.wheelMax) - sr / 60.2; // 2.5 deg - 0.5711 deg = 1.9289 deg
    expect(Math.abs(wheel + slip)).toBeLessThan(0.9 * aFront0(speed, dp())); // gripFrontDrift
    expect(Math.abs(steer * rad(P.wheelMax) + slip)).toBeLessThan(0.9 * aFront0(speed));
    const s = race1({ speed, steer, heading: slip, slipRate: sr, driftTimer: 50 });
    stepN(s, 1, frame(steer));
    expect(car0(s).heading).toBeCloseTo(heading1(speed, slip, wheel), 12);
    // outside drift the same case leaves the wheel alone
    const n = race1({ speed, steer, heading: slip, slipRate: sr });
    stepN(n, 1, frame(steer));
    expect(car0(n).heading).toBeCloseTo(heading1(speed, slip, steer * rad(P.wheelMax)), 12);
  });

  it('R205: below assistSpeed (18 km/h) nothing: wheel = steer*wheelMax', () => {
    const speed = 18 / P.vmaxKmh;
    const s = race1({ speed, steer: -0.5, heading: slip });
    stepN(s, 1, frame(-0.5));
    expect(car0(s).heading).toBeCloseTo(heading1(speed, slip, -0.5 * rad(P.wheelMax)), 12);
  });

  it('R205/H23 B: flag off -> nothing above assistSpeed either (also in drift)', () => {
    const off = withP({ hypAssist: 0 });
    const a = race1({ speed: 0.5, steer: -0.5, heading: slip });
    stepN(a, 1, frame(-0.5), STRAIGHT, off);
    expect(car0(a).heading).toBeCloseTo(heading1(0.5, slip, -0.5 * rad(P.wheelMax)), 12);
    expect(0.5 * rad(P.wheelMax) + slip).toBeLessThan(0.9 * aFront0(0.3, dp())); // gripFrontDrift
    const b = race1({ speed: 0.3, steer: 0.5, heading: slip, slipRate: 0.6, driftTimer: 50 });
    stepN(b, 1, frame(0.5), STRAIGHT, off);
    expect(car0(b).heading).toBeCloseTo(heading1(0.3, slip, 0.5 * rad(P.wheelMax)), 12);
  });

  it('R205: the assist changes only wheel, not steer', () => {
    const s = race1({ speed: 0.5, steer: -0.5, heading: slip });
    stepN(s, 1, frame(-0.5));
    expect(car0(s).steer).toBe(-0.5);
  });
});

describe('R209 rail, edge pull, reference angle', () => {
  // Pairs of runs that differ only in one parameter: R203-R208 are identical in both, so the travel
  // after the tick differs exactly by the R209 factor. Rail factors are "share per OR2 tick"
  // (CarParams comment on railGrip) -> perTick(c).
  it('R209: outside drift c = railGrip*sin^2(slip) rotates travel toward 0; speed unchanged', () => {
    const st = { speed: 0.5, travel: 0.2, heading: 0.3 };
    const a = race1(st);
    const b = race1(st);
    stepN(a, 1, frame(0), STRAIGHT, P);
    stepN(b, 1, frame(0), STRAIGHT, withP({ railGrip: 0 }));
    const tb = car0(b).travel;
    const c = P.railGrip * Math.sin(car0(b).heading - tb) ** 2;
    expect(car0(a).travel).toBeCloseTo(tb * (1 - perTick(c)), 12);
    expect(Math.abs(car0(a).travel)).toBeLessThan(Math.abs(tb));
    expect(car0(a).speed).toBe(car0(b).speed);
    expect(car0(a).heading).toBe(car0(b).heading);
  });

  it('R209: in drift c = railDrift*|sin(slip)| (railGrip not used); speed unchanged', () => {
    const st = { speed: 0.5, travel: 0.2, heading: 0.5, driftTimer: 50 };
    const base = withP({ railGrip: 0, hypEdge: 0 });
    const a = race1(st);
    const b = race1(st);
    stepN(a, 1, frame(0), STRAIGHT, base);
    stepN(b, 1, frame(0), STRAIGHT, withP({ railDrift: 0 }, base));
    const tb = car0(b).travel;
    const c = P.railDrift * Math.abs(Math.sin(car0(b).heading - tb));
    expect(car0(a).travel).toBeCloseTo(tb * (1 - perTick(c)), 12);
    expect(car0(a).speed).toBe(car0(b).speed);
    // and railGrip does nothing in drift
    const g = race1(st);
    stepN(g, 1, frame(0), STRAIGHT, withP({ railGrip: 0.5 }, base));
    expect(car0(g).travel).toBe(car0(a).travel);
  });

  it('R209/H24: edge pull in drift: travel *= (1 - perTick(edge)), edge grows with the share of way to the edge', () => {
    // travel > 0 (carried right), x > 0: side = x. driftTimer 50 -> min(1, 49/24) = 1.
    const run = (x: number, flag: number): { travel: number; edge: number; speed: number } => {
      const s = race1({ speed: 0.5, x, travel: 0.1, heading: 0.4, driftTimer: 50 });
      stepN(s, 1, frame(0), STRAIGHT, withP({ hypEdge: flag }));
      return { travel: car0(s).travel, edge: car0(s).edge, speed: car0(s).speed };
    };
    const near = run(0.9, 1);
    const far = run(0.3, 1);
    const nearOff = run(0.9, 0);
    expect(near.edge).toBeGreaterThan(0);
    expect(near.edge).toBeGreaterThan(far.edge);
    if (near.edge < 1) expect(near.edge / far.edge).toBeCloseTo(0.9 / 0.3, 6); // linear in side
    expect(near.travel).toBeCloseTo(nearOff.travel * (1 - perTick(near.edge)), 12); // per-OR2-tick share
    expect(near.speed).toBe(nearOff.speed);
  });

  it('R209/H24: no edge when the car is carried toward the centre (side = 0) or outside drift', () => {
    const inward = race1({ speed: 0.5, x: -0.9, travel: 0.1, heading: 0.4, driftTimer: 50 });
    stepN(inward, 1, frame(0));
    expect(car0(inward).edge).toBe(0);
    const grip = race1({ speed: 0.5, x: 0.9, travel: 0.1, heading: 0.4 });
    stepN(grip, 1, frame(0));
    expect(car0(grip).edge).toBe(0);
  });

  it('R209/H24: edge falls no faster than 0.01 per OR2 tick (0.0050167 per tick)', () => {
    const s = race1({ speed: 0.5, edge: 0.5, driftTimer: 50 });
    stepN(s, 1, frame(0)); // x 0 -> side 0 -> target 0
    expect(car0(s).edge).toBeCloseTo(0.5 - EDGE_FALL, 12);
    let prev = car0(s).edge;
    stepN(s, 200, frame(0), STRAIGHT, P, true, (c) => {
      expect(c.edge).toBeGreaterThanOrEqual(prev - EDGE_FALL - 1e-12);
      expect(c.edge).toBeGreaterThanOrEqual(0);
      expect(c.edge).toBeLessThanOrEqual(1);
      prev = c.edge;
    });
  });

  it('R209/H25: refAngle goes toward refGain*sum(curve*roadTurn) over refLook segments by 1/10, <= 1.4 deg per OR2 tick', () => {
    for (const curve of [curves.medium, -curves.medium, curves.sharp]) {
      const s = race1({ speed: 0.5 });
      // constant curve: the sum over any refLook segments = refLook*curve*roadTurn (sign of curve:
      // right corner -> natural slip > 0)
      const target = P.refGain * P.refLook * curve * P.roadTurn;
      stepN(s, 1, frame(0), curveTrack(curve));
      const d = Math.min(Math.abs(target) * perTick(0.1), REF_MAX);
      expect(car0(s).refAngle, `curve ${curve}`).toBeCloseTo(Math.sign(target) * d, 12);
      let prev = car0(s).refAngle;
      stepN(s, 600, frame(0), curveTrack(curve), P, true, (c) => {
        expect(Math.abs(c.refAngle - prev)).toBeLessThanOrEqual(REF_MAX + 1e-12);
        prev = c.refAngle;
      });
      expect(car0(s).refAngle).toBeCloseTo(target, 6);
    }
  });

  it('R209/H25: on a straight refAngle returns toward 0', () => {
    const s = race1({ speed: 0.5, refAngle: rad(5) });
    stepN(s, 1, frame(0));
    const d = Math.min(rad(5) * perTick(0.1), REF_MAX);
    expect(car0(s).refAngle).toBeCloseTo(rad(5) - d, 12);
  });

  it('R208/R209 H25: slip beyond refAngle on its side adds refGrip*(|slip|-|refAngle|)/(90deg-|refAngle|)', () => {
    // straight: R208 uses the refAngle of the previous tick (preset 5 deg); gas 1, steer 0.
    const slip = rad(20);
    const ref = rad(5);
    const base = gripDriftOf(0, 1, slip);
    // gripRear = base + refGrip*15/85, clamped 0..1
    const withRef = Math.min(
      1,
      Math.max(0, base + (P.refGrip * (slip - ref)) / (Math.PI / 2 - ref)),
    );
    const s = race1({ speed: 0.5, heading: slip, driftTimer: 50, refAngle: ref });
    stepN(s, 1, frame(0));
    expect(car0(s).travelRate).toBeCloseTo(rate1(0.5, slip, withRef, dp()), 12);
    // H25 off: no bonus
    const o = race1({ speed: 0.5, heading: slip, driftTimer: 50, refAngle: ref });
    stepN(o, 1, frame(0), STRAIGHT, withP({ hypRef: 0 }));
    expect(car0(o).travelRate).toBeCloseTo(rate1(0.5, slip, base, dp()), 12);
  });

  it('R208/R209 H25: no bonus when refAngle is on the other side or beyond |slip|', () => {
    const slip = rad(20);
    const base = gripDriftOf(0, 1, slip);
    for (const ref of [rad(-5), rad(30)]) {
      const s = race1({ speed: 0.5, heading: slip, driftTimer: 50, refAngle: ref });
      stepN(s, 1, frame(0));
      expect(car0(s).travelRate, `ref ${ref}`).toBeCloseTo(rate1(0.5, slip, base, dp()), 12);
    }
  });

  it('R209: after R209 |slip| <= slipMax every tick of a drifting run on curves', () => {
    const s = race1({ speed: P.vmax });
    const t = curveTrack(curves.sharp);
    stepN(
      s,
      1200,
      (k) => frame(k % 300 < 150 ? 1 : -1, k % 200 < 20 ? 0.3 : 1, 0, k % 150 === 0),
      t,
      P,
      false,
      (c) => {
        expect(Math.abs(slipOf(c))).toBeLessThanOrEqual(rad(P.slipMax) + 1e-9);
        expect(c.speed).toBeGreaterThanOrEqual(0);
      },
    );
  });
});

describe('R207 drift with gripRear < 1 (R215 criteria)', () => {
  it('R215(3): driftTap + full steer at vmax latches the drift within the window (both sides)', () => {
    for (const side of [1, -1]) {
      const s = race1({ speed: P.vmax });
      const latch = enterDrift(s, side);
      expect(latch, `side ${side}`).toBeGreaterThanOrEqual(0);
      expect(latch).toBeLessThanOrEqual(WIN);
      expect(Math.sign(slipOf(car0(s)))).toBe(side);
      expect(car0(s).driftTimer).toBe(HOLD);
    }
  });

  it('R215(4): in drift, steer released for 1 s -> |slip| stays >= 8.4 deg, drift holds', () => {
    for (const side of [1, -1]) {
      const s = race1({ speed: P.vmax });
      expect(enterDrift(s, side)).toBeGreaterThanOrEqual(0);
      stepN(s, 30, frame(side), STRAIGHT, P, true); // 0.25 s more full steer: the drift develops
      stepN(s, 120, frame(0), STRAIGHT, P, true, (c, i) => {
        expect(Math.abs(slipOf(c)), `tick ${i}`).toBeGreaterThanOrEqual(rad(8.4));
        expect(c.driftTimer, `tick ${i}`).toBeGreaterThan(0);
      });
    }
  });

  it('R215(5): full countersteer until |slip| < slipLatch, then steer 0: drift ends within 1.5 s, no re-latch', () => {
    for (const side of [1, -1]) {
      const s = race1({ speed: P.vmax });
      expect(enterDrift(s, side)).toBeGreaterThanOrEqual(0);
      stepN(s, 30, frame(side), STRAIGHT, P, true);
      // 1.5 s = 180 ticks from the start of countersteer; target -side while |slip| >= 8.4 deg, then 0
      let centred = false;
      let end = -1;
      for (let i = 0; i < 180; i++) {
        if (!centred && Math.abs(slipOf(car0(s))) < rad(8.4)) centred = true;
        stepN(s, 1, frame(centred ? 0 : -side), STRAIGHT, P, true);
        const c = car0(s);
        // no latch to the other side: never |slip| > 8.4 deg on -side while the timer is alive
        expect(-side * slipOf(c) > rad(8.4) && c.driftTimer > 0, `side ${side} tick ${i}`).toBe(
          false,
        );
        if (end < 0 && c.driftTimer === 0) end = i;
        if (end >= 0) expect(c.driftTimer, `side ${side} tick ${i} after end`).toBe(0);
      }
      expect(centred, `side ${side}`).toBe(true);
      expect(end, `side ${side}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('R215(6): speed does not decrease over 2 s of drift at gas 1', () => {
    for (const speed of [P.vmax, 0.9]) {
      const s = race1({ speed });
      expect(enterDrift(s, 1)).toBeGreaterThanOrEqual(0);
      let prev = car0(s).speed;
      stepN(
        s,
        240,
        (k) => frame(k % 120 < 60 ? 1 : 0),
        STRAIGHT,
        P,
        true,
        (c, i) => {
          expect(c.driftTimer, `tick ${i}`).toBeGreaterThan(0);
          expect(c.speed, `tick ${i}`).toBeGreaterThanOrEqual(prev);
          prev = c.speed;
        },
      );
    }
  });

  it('R215(8)/R208: switch: drift left, countersteer and steer right -> re-latches right without driftTap', () => {
    const s = race1({ speed: P.vmax });
    expect(enterDrift(s, -1)).toBeGreaterThanOrEqual(0);
    stepN(s, 30, frame(-1), STRAIGHT, P, true);
    let right = -1;
    stepN(s, 240, frame(1), STRAIGHT, P, true, (c, i) => {
      if (right < 0 && slipOf(c) > rad(8.4) && c.driftTimer === HOLD) right = i;
    });
    expect(right).toBeGreaterThanOrEqual(0);
  });

  it('R215(2) stays: without driftTap full steer at vmax never drifts (gripRear = 1)', () => {
    const s = race1({ speed: P.vmax });
    stepN(s, 360, frame(1), STRAIGHT, P, true, (c) => {
      expect(c.driftTimer).toBe(0);
      expect(Math.abs(slipOf(c))).toBeLessThanOrEqual(rad(8.4));
    });
  });
});

describe('R208 drift properties', () => {
  const script = (k: number) =>
    frame(k < 90 ? 0.9 : k < 200 ? 0 : -0.7, k % 97 < 10 ? 0.4 : 1, k % 233 < 5 ? 0.6 : 0, k === 3);

  it('R208: property: left is the mirror of right through a drift (curve and straight)', () => {
    for (const curve of [0, curves.hard]) {
      const r = race1({ speed: P.vmax });
      const l = race1({ speed: P.vmax });
      const tr = curveTrack(curve);
      const tl = curveTrack(-curve);
      for (let k = 0; k < 360; k++) {
        const f = script(k);
        stepN(r, 1, f, tr);
        stepN(l, 1, { ...f, steer: -f.steer }, tl);
        const a = car0(r);
        const b = car0(l);
        for (const n of ['x', 'heading', 'travel', 'travelRate', 'refAngle'] as const) {
          expect(b[n], `${n} tick ${k}`).toBeCloseTo(-a[n], 9);
        }
        expect(b.driftTimer).toBe(a.driftTimer);
        expect(b.edge).toBeCloseTo(a.edge, 9);
        expect(b.speed).toBeCloseTo(a.speed, 12);
      }
    }
  });

  it('R208: property: determinism and JSON round-trip mid-drift', () => {
    const t = curveTrack(curves.hard);
    const a = race1({ speed: P.vmax });
    const b = race1({ speed: P.vmax });
    stepN(a, 150, script, t);
    stepN(b, 150, script, t);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = JSON.parse(JSON.stringify(a)) as RaceState;
    stepN(a, 150, (k) => script(k), t);
    stepN(c, 150, (k) => script(k), t);
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });
});

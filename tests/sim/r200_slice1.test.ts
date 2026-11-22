import { describe, expect, it } from 'vitest';
import curves from '../../src/data/tracks/curves.json';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import type { Car, CarParams } from '../../src/sim/types';
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

// Driving slice 1 (brief R200-R215, OutRun 2006 model): R203, R204, R206, R207, R210, R18, R215.
// No drift in this slice: driftTap is never sent, so gripRear = 1 (R208 "иначе gripRear = 1").

/** R206/R207 on the first tick from slip = 0 (rear = 0, counter stays 0): heading after one tick. */
function yawFirstTick(p: CarParams, speed: number, steer: number): number {
  const v = vMs(p, speed);
  const L = p.wheelBase;
  const wheel = steer * rad(p.wheelMax); // R203
  const aFront = Math.atan((p.gripFront * G * L) / (v * v)); // R206, counter = 0
  const front = Math.max(-aFront, Math.min(aFront, wheel)); // rear = 0
  return ((v * Math.cos(0) * (Math.tan(front) - Math.tan(0))) / L) * DT; // R207
}

describe('R200 driving parameters exist', () => {
  it('R200: every parameter the rules name is a finite number in CarParams (src/data)', () => {
    const names = [
      'wheelMax',
      'wheelBase',
      'gripFront',
      'rearMu',
      'slipRecover',
      'slipDecay',
      'slipRateMax',
      'roadTurn',
      'steerInTime',
      'steerOutTime',
      'driftTraction',
      'slipGrip',
      'slipLatch',
      'slipMax',
      'railGrip',
    ];
    const rec = P as unknown as Record<string, unknown>;
    for (const n of names) {
      expect(typeof rec[n], n).toBe('number');
      expect(Number.isFinite(rec[n]), n).toBe(true);
    }
  });

  it('R200: OR2 constants stated in the brief (degrees, seconds)', () => {
    expect(P.steerInTime).toBe(0.17); // R203
    expect(P.steerOutTime).toBe(0.14); // R203
    expect(P.slipGrip).toBe(4.2); // R204/R208
    expect(P.slipLatch).toBe(8.4); // R208
    expect(P.slipMax).toBe(73); // R207
  });
});

describe('R203 steering smoothing', () => {
  it('R203: away from 0 steer rises by DT/steerInTime per tick and stops at the target', () => {
    const s = race1({ speed: 0 });
    stepN(s, 1, frame(1));
    // 1 tick: (1/120)/0.17 = 1/20.4 = 0.0490196
    expect(car0(s).steer).toBeCloseTo(DT / P.steerInTime, 9);
    stepN(s, 9, frame(1));
    // 10 ticks: 10/20.4 = 0.490196
    expect(car0(s).steer).toBeCloseTo((10 * DT) / P.steerInTime, 9);
    stepN(s, 10, frame(1));
    // 20 ticks: 20/20.4 = 0.980392 (< 1)
    expect(car0(s).steer).toBeCloseTo((20 * DT) / P.steerInTime, 9);
    stepN(s, 1, frame(1));
    // 21 ticks: 21/20.4 > 1 -> exactly the target 1
    expect(car0(s).steer).toBe(1);
  });

  it('R203: release returns to 0 by DT/steerOutTime per tick, 0 after ceil(0.14*120) = 17 ticks', () => {
    const s = race1({ speed: 0, steer: 1 });
    stepN(s, 1, frame(0));
    // 1 - (1/120)/0.14 = 1 - 1/16.8 = 0.940476
    expect(car0(s).steer).toBeCloseTo(1 - DT / P.steerOutTime, 9);
    stepN(s, 15, frame(0));
    // 16 ticks: 1 - 16/16.8 = 0.047619 (> 0)
    expect(car0(s).steer).toBeCloseTo(1 - (16 * DT) / P.steerOutTime, 9);
    stepN(s, 1, frame(0));
    // 17 ticks: 1 - 17/16.8 < 0 -> exactly the target 0 (no overshoot), ~ steerOutTime
    expect(car0(s).steer).toBe(0);
  });

  it('R203: reversal to the other side runs at the steerInTime rate all the way, no overshoot', () => {
    const s = race1({ speed: 0, steer: 1 });
    stepN(s, 1, frame(-1));
    // 1 - 1/20.4 = 0.950980
    expect(car0(s).steer).toBeCloseTo(1 - DT / P.steerInTime, 9);
    stepN(s, 39, frame(-1));
    // 40 ticks: 1 - 40/20.4 = -0.960784 (2 units of travel need 40.8 ticks)
    expect(car0(s).steer).toBeCloseTo(1 - (40 * DT) / P.steerInTime, 9);
    stepN(s, 1, frame(-1));
    expect(car0(s).steer).toBe(-1);
  });

  it('R203: target closer to zero on the same side moves at the steerOutTime rate', () => {
    const s = race1({ speed: 0, steer: 1 });
    stepN(s, 1, frame(0.5));
    // 1 - 1/16.8 = 0.940476
    expect(car0(s).steer).toBeCloseTo(1 - DT / P.steerOutTime, 9);
    stepN(s, 8, frame(0.5));
    // 9 ticks: 1 - 9/16.8 = 0.464 < 0.5 -> exactly 0.5 (no overshoot)
    expect(car0(s).steer).toBe(0.5);
  });

  it('R203: small target is reached without overshoot (0.3: 7 ticks)', () => {
    const s = race1({ speed: 0 });
    stepN(s, 6, frame(0.3));
    // 6/20.4 = 0.294118 < 0.3
    expect(car0(s).steer).toBeCloseTo((6 * DT) / P.steerInTime, 9);
    stepN(s, 1, frame(0.3));
    expect(car0(s).steer).toBe(0.3);
    stepN(s, 30, frame(0.3));
    expect(car0(s).steer).toBe(0.3);
  });

  it('R203: left is the mirror of right', () => {
    const r = race1({ speed: 0 });
    const l = race1({ speed: 0 });
    for (let i = 0; i < 40; i++) {
      const t = i < 25 ? 1 : 0;
      stepN(r, 1, frame(t));
      stepN(l, 1, frame(-t));
      expect(car0(l).steer).toBe(-car0(r).steer);
    }
  });

  it('R203: wheel = steer*wheelMax, seen through the first-tick body yaw at 18 km/h', () => {
    // Low speed (18 km/h < assistSpeed 20 km/h, R205 off). Steer preset = target, so R203 keeps it.
    const speed = 18 / P.vmaxKmh;
    for (const st of [0.25, 0.5, 1]) {
      const s = race1({ speed, steer: st });
      stepN(s, 1, frame(st));
      expect(car0(s).heading).toBeCloseTo(yawFirstTick(P, speed, st), 12);
    }
  });
});

describe('R204 speed', () => {
  // DT = 1/120; accel, engineBrake, brakeDecel from src/data/cars/base.json (0.22, 0.05, 0.6 now).
  it('R204: gas^2 and engine brake: gas 0.5 at speed 0.5', () => {
    const s = race1({ speed: 0.5 });
    stepN(s, 1, frame(0, 0.5, 0));
    // 0.5 + 0.22*0.25/120 - 0.05*0.5/120 = 0.5 + 0.03/120 = 0.50025
    expect(car0(s).speed).toBeCloseTo(0.5 + (P.accel * 0.25 - P.engineBrake * 0.5) * DT, 12);
  });

  it('R204: gas 0 = engine brake only', () => {
    const s = race1({ speed: 0.5 });
    stepN(s, 1, frame(0, 0, 0));
    // 0.5 - 0.05/120 = 0.4995833
    expect(car0(s).speed).toBeCloseTo(0.5 - P.engineBrake * DT, 12);
  });

  it('R204: brake 1 at gas 0', () => {
    const s = race1({ speed: 0.5 });
    stepN(s, 1, frame(0, 0, 1));
    // 0.5 - (0.05 + 0.6)/120 = 0.4945833
    expect(car0(s).speed).toBeCloseTo(0.5 - (P.engineBrake + P.brakeDecel) * DT, 12);
  });

  it('R204: speed never goes below 0 and never above vmax*capMul (capMul = 1)', () => {
    const s = race1({ speed: 0.001 });
    stepN(s, 1, frame(0, 0, 1));
    expect(car0(s).speed).toBe(0);
    const f = race1({ speed: P.vmax });
    stepN(f, 1, frame(0, 1, 0));
    expect(car0(f).speed).toBe(P.vmax);
  });

  it('R204: property: speed stays in [0, vmax] under changing input', () => {
    const s = race1({ speed: 0.3 });
    stepN(
      s,
      1200,
      (t) => frame(Math.sin(t / 37), 0.5 + 0.5 * Math.cos(t / 53), t % 240 < 30 ? 1 : 0),
      STRAIGHT,
      P,
      true,
      (c) => {
        expect(c.speed).toBeGreaterThanOrEqual(0);
        expect(c.speed).toBeLessThanOrEqual(P.vmax * 1);
      },
    );
  });

  it('R204: property: at gas 1 (no brake, straight, steer 0) speed is monotone non-decreasing', () => {
    const s = race1({ speed: 0 });
    let prev = 0;
    stepN(s, 600, frame(0), STRAIGHT, P, false, (c) => {
      expect(c.speed).toBeGreaterThanOrEqual(prev);
      prev = c.speed;
    });
    expect(prev).toBe(P.vmax);
  });

  it('R204: traction = driftTraction when |slip| >= slipGrip (slip 10 deg)', () => {
    const s = race1({ speed: 0.5, heading: rad(10) });
    stepN(s, 1, frame(0));
    // 0.5 + 0.22*1^2*driftTraction/120
    expect(car0(s).speed).toBeCloseTo(0.5 + P.accel * P.driftTraction * DT, 12);
  });

  it('R204: traction = 1 when |slip| < slipGrip (slip 2 deg)', () => {
    const s = race1({ speed: 0.5, heading: rad(2) });
    stepN(s, 1, frame(0));
    // 0.5 + 0.22/120 = 0.5018333
    expect(car0(s).speed).toBeCloseTo(0.5 + P.accel * DT, 12);
  });
});

describe('R206 front axle limit and counter-steer', () => {
  it('R206: first tick of full steer from slip 0 at vmax and at 0.5*vmax matches the formula', () => {
    // aFront = atan(gripFront*g*wheelBase/v^2); front = clamp(wheel, +-aFront);
    // heading = v*tan(front)/wheelBase*DT (g = 9.81, brief units)
    for (const speed of [P.vmax, 0.5 * P.vmax]) {
      const s = race1({ speed, steer: 1 });
      stepN(s, 1, frame(1));
      expect(car0(s).heading).toBeCloseTo(yawFirstTick(P, speed, 1), 12);
    }
  });

  it('R206/R215(7): at vmax full steer turns the body slower than at 0.5*vmax', () => {
    const yaw = (speed: number): number => {
      const s = race1({ speed });
      stepN(s, 60, frame(1), STRAIGHT, P, true);
      return car0(s).heading;
    };
    const fast = yaw(P.vmax);
    const half = yaw(0.5 * P.vmax);
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(half);
  });

  it('R206: wheel on the side of rear but smaller -> counter goes to |steer| by 0.1 per OR2 tick', () => {
    // 18 km/h: R205 off. slip = +min(70 deg, wheelMax) -> rear = -slip; steer -0.5 -> wheel = -0.5*wheelMax,
    // |wheel| < |rear| and (wheel - rear)*wheel < 0.
    const slip = Math.min(rad(70), rad(P.wheelMax));
    const s = race1({ speed: 18 / P.vmaxKmh, steer: -0.5, heading: slip });
    stepN(s, 1, frame(-0.5));
    // kc = 1 - 0.9^(60.2/120) = 0.051484; counter = 0.5*kc = 0.025742
    expect(car0(s).counter).toBeCloseTo(0.5 * perTick(0.1), 12);
  });

  it('R206: otherwise counter goes to 0 by 0.1 per OR2 tick', () => {
    const slip = Math.min(rad(70), rad(P.wheelMax));
    const s = race1({ speed: 18 / P.vmaxKmh, steer: 0.5, heading: slip, counter: 0.8 });
    stepN(s, 1, frame(0.5));
    // 0.8*(1 - 0.051484) = 0.758813
    expect(car0(s).counter).toBeCloseTo(0.8 * (1 - perTick(0.1)), 12);
  });

  it('R206: counter 1 -> aFront 0 -> front = rear -> the body does not rotate', () => {
    expect(P.wheelMax).toBeLessThan(70); // precondition: |wheel| < |rear| = 70 deg
    const s = race1({ speed: 18 / P.vmaxKmh, steer: -1, heading: rad(70), counter: 1 });
    stepN(s, 1, frame(-1));
    expect(car0(s).counter).toBe(1); // target |steer| = 1
    expect(Math.abs(car0(s).heading - rad(70))).toBeLessThan(1e-12);
  });
});

describe('R207 body yaw and slip (grip, gripRear = 1)', () => {
  const noRail: CarParams = { ...P, railGrip: 0 }; // isolate R207 from R209

  it('R207: travel catches the body: first tick travelRate = min(slipRateMax, desired*k(1/4))', () => {
    // Wheels exactly along the rear (wheel = rear) -> front = rear -> omega = 0, R205 inert.
    // speed 0.5: v = 25 m/s at vmaxKmh 180; slip = 0.5*wheelMax; steer -0.5.
    const speed = 0.5;
    const slip = 0.5 * rad(P.wheelMax);
    const s = race1({ speed, steer: -0.5, heading: slip });
    stepN(s, 1, frame(-0.5), STRAIGHT, noRail);
    const v = vMs(P, speed);
    // T = slipRecover*atan(gripRear*rearMu*g*wheelBase/v^2), gripRear = 1 outside drift (R208)
    const T = P.slipRecover * Math.atan((1 * P.rearMu * G * P.wheelBase) / (v * v));
    const desired = Math.min(T, slip * P.slipDecay);
    // k4 = 1 - 0.75^(60.2/120) = 0.134390
    const rate = Math.min(rad(P.slipRateMax), desired * perTick(0.25));
    const c = car0(s);
    expect(Math.abs(c.heading - slip)).toBeLessThan(1e-12);
    expect(c.travelRate).toBeCloseTo(rate, 12); // + : travel turns toward heading (slip > 0)
    expect(c.travel).toBeCloseTo(rate * DT, 12);
    // R200/R210: slipRate = (slip1 - slip0)/DT; heading fixed, travel += rate*DT -> slipRate = -rate
    expect(c.slipRate).toBeCloseTo((slipOf(c) - slip) / DT, 9);
    expect(c.slipRate).toBeCloseTo(-rate, 9);
  });

  it('R207/R209: |slip| <= slipMax (73 deg) after the step: slip 80 deg is cut on the next tick', () => {
    const s = race1({ speed: 0.5, heading: rad(80) });
    stepN(s, 1, frame(0)); // real railGrip: R210 order re-applies the limit after R209
    expect(Math.abs(slipOf(car0(s)))).toBeLessThanOrEqual(rad(P.slipMax) + 1e-9);
  });

  it('R207: full steer grows slip on the steer side; |travelRate| <= slipRateMax (deg/s in data)', () => {
    const s = race1({ speed: P.vmax });
    stepN(s, 360, frame(1), STRAIGHT, P, true, (c) => {
      expect(Math.abs(c.travelRate)).toBeLessThanOrEqual(rad(P.slipRateMax) + 1e-12);
    });
    expect(slipOf(car0(s))).toBeGreaterThan(0);
  });

  it('R200: slipRate = change of slip over the last tick / DT, every tick of a varying run', () => {
    const s = race1({ speed: 0.7 });
    let prev = 0;
    stepN(
      s,
      600,
      (t) => frame(Math.sin(t / 37)),
      curveTrack(curves.medium),
      P,
      true,
      (c) => {
        const slip = slipOf(c);
        expect(c.slipRate).toBeCloseTo((slip - prev) / DT, 6);
        prev = slip;
      },
    );
  });

  it('R215(1): released finger on a straight: slip and travel stay 0, speed by R204', () => {
    const s = race1();
    stepN(s, 360, frame(0), STRAIGHT, P, false, (c, i) => {
      expect(Math.abs(c.travel)).toBe(0);
      expect(Math.abs(slipOf(c))).toBe(0);
      expect(Math.abs(c.x)).toBe(0);
      // speed = min(vmax, 0.22*(i+1)/120)
      expect(c.speed).toBeCloseTo(Math.min(P.vmax, P.accel * (i + 1) * DT), 9);
    });
  });

  it('R215(2): full steer on a straight at vmax without drift: |slip| <= slipLatch, driftTimer stays 0', () => {
    for (const speed of [P.vmax]) {
      for (const side of [1, -1]) {
        const s = race1({ speed });
        stepN(s, 360, frame(side), STRAIGHT, P, true, (c) => {
          expect(Math.abs(slipOf(c))).toBeLessThanOrEqual(rad(P.slipLatch));
          expect(c.driftTimer).toBe(0);
        });
      }
    }
  });

  it('R207: property: left is the mirror of right (straight and curve)', () => {
    const fields: (keyof Car)[] = ['x', 'heading', 'travel', 'travelRate', 'slipRate', 'steer'];
    for (const curve of [0, curves.medium]) {
      const r = race1({ speed: 0.8 });
      const l = race1({ speed: 0.8 });
      const tr = curveTrack(curve);
      const tl = curveTrack(-curve);
      for (let i = 0; i < 240; i++) {
        const st = i < 120 ? 0.8 : 0;
        stepN(r, 1, frame(st), tr);
        stepN(l, 1, frame(-st), tl);
        for (const f of fields) {
          expect(car0(l)[f] as number).toBeCloseTo(-(car0(r)[f] as number), 12);
        }
        expect(car0(l).speed).toBe(car0(r).speed);
        expect(car0(l).counter).toBeCloseTo(car0(r).counter, 12);
      }
    }
  });
});

describe('R210 road turning under the car', () => {
  it('R210: z uses cos(travel), x uses v*sin(travel)/halfWidthM (straight, travel = heading = 0.3)', () => {
    // slip 0 -> omega 0, no travel catch-up, R209 c = 0; speed 1 stays 1.
    const s = race1({ speed: 1, travel: 0.3, heading: 0.3 });
    stepN(s, 1, frame(0));
    const c = car0(s);
    expect(c.travel).toBe(0.3);
    // z = 1*(1/120)*60*cos(0.3) = 0.5*0.955336 = 0.477668
    expect(c.z).toBeCloseTo(1 * DT * SEG_PER_UNIT * Math.cos(0.3), 12);
    // x = 50*sin(0.3)/120/12 = 50*0.295520/1440 = 0.0102611
    expect(c.x).toBeCloseTo((vMs(P, 1) * Math.sin(0.3) * DT) / P.halfWidthM, 12);
  });

  it('R210: steer 0 on a constant curve: travel = heading = -curve*roadTurn*z, slip 0', () => {
    for (const curve of [curves.medium, -curves.medium]) {
      const s = race1({ speed: 1 });
      stepN(s, 120, frame(0), curveTrack(curve));
      const c = car0(s);
      const expected = -curve * P.roadTurn * c.z; // sum of dz = z (start z = 0)
      expect(Math.abs(slipOf(c))).toBeLessThan(1e-12);
      expect(c.heading).toBeCloseTo(c.travel, 12);
      // 1% tolerance: the brief leaves open whether dz uses travel before or after the turn
      expect(Math.abs(c.travel - expected)).toBeLessThanOrEqual(0.01 * Math.abs(expected));
      expect(Math.abs(expected)).toBeGreaterThan(0);
    }
  });

  it('R210: steer 0 on a curve drifts the car to the outside', () => {
    const r = race1({ speed: 1 });
    stepN(r, 60, frame(0), curveTrack(curves.medium)); // right curve: outside = -x
    expect(car0(r).x).toBeLessThan(0);
    const l = race1({ speed: 1 });
    stepN(l, 60, frame(0), curveTrack(-curves.medium));
    expect(car0(l).x).toBeGreaterThan(0);
  });
});

describe('R18 lateral limit', () => {
  it('R18: at |x| = xLimit x is clamped and travel toward the border becomes 0', () => {
    for (const side of [1, -1]) {
      const s = race1({
        speed: 1,
        x: side * (P.xLimit - 0.001),
        travel: side * 0.3,
        heading: side * 0.3,
      });
      stepN(s, 1, frame(0));
      const c = car0(s);
      expect(c.x).toBe(side * P.xLimit);
      expect(Math.abs(c.travel)).toBe(0);
    }
  });

  it('R18: travel away from the border is kept', () => {
    const s = race1({ speed: 1, x: P.xLimit, travel: -0.1, heading: -0.1 });
    stepN(s, 1, frame(0));
    expect(car0(s).travel).toBeCloseTo(-0.1, 12);
    expect(car0(s).x).toBeLessThan(P.xLimit);
  });
});

describe('R215(9) corner calibration at vmax (curves.json, real car data)', () => {
  /**
   * Body yaw relative to the road over 0.75 s -> 1.5 s with a constant steer on a constant curve (right),
   * x kept at 0 so the border never interferes. > 0: the body outruns the road (the steer holds the
   * corner, the car goes inside); < 0: it cannot hold it (the car goes outside).
   */
  function yawDrift(curve: number, steer: number): number {
    const s = race1({ speed: P.vmax, steer });
    const t = curveTrack(curve);
    stepN(s, 90, frame(steer), t, P, true);
    const h1 = car0(s).heading;
    stepN(s, 90, frame(steer), t, P, true, (c) => {
      expect(c.driftTimer).toBe(0);
      expect(c.speed).toBe(P.vmax);
    });
    return car0(s).heading - h1;
  }

  it('R215(9): medium is held in grip with a steady steer in 0.9..1.0', () => {
    expect(yawDrift(curves.medium, 0.9)).toBeLessThan(0);
    expect(yawDrift(curves.medium, 1.0)).toBeGreaterThanOrEqual(0);
  });

  it('R215(9): easy is held with a steady steer in 0.4..0.5', () => {
    expect(yawDrift(curves.easy, 0.4)).toBeLessThan(0);
    expect(yawDrift(curves.easy, 0.5)).toBeGreaterThanOrEqual(0);
  });

  it('R215(9): hard and sharp are not held without drift even at full steer', () => {
    expect(yawDrift(curves.hard, 1.0)).toBeLessThan(0);
    expect(yawDrift(curves.sharp, 1.0)).toBeLessThan(0);
  });

  it('R215(9): property: more steer never holds the corner worse (medium)', () => {
    let prev = -Infinity;
    for (const st of [0.2, 0.4, 0.6, 0.8, 1.0]) {
      const d = yawDrift(curves.medium, st);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

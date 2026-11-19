// Driving model B (H14): R89b calibration on the REAL car data, properties of the formulas
// (docs/research/yaw-slip-spike.md section 1), determinism, serialization, golden example.
// The scenarios follow the spike (S1, S2, S3, S7). Holding steers are found by bisection on a
// constant steer (the spike's method for S2/S3); no x-controller is needed for these criteria.
import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import curves from '../../src/data/tracks/curves.json';
import { DT, STEER_HIST } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { GAS, run } from './helpers';
import { PB, Q, STRAIGHT, car, constTrack, inp, mk as mk0, slipOf, stepB, stepN } from './modelb_helpers';

const C = curves as { easy: number; medium: number; hard: number };
/** Real data pinned to model B; walls and off-road loss removed where only the steer is measured. */
const REAL: CarParams = { ...baseCar, model: 1 };
const FREE: CarParams = { ...REAL, xLimit: 1e9, offroadMul: 1, offroadSteerMul: 1 };
const SLIP_DEG = 17; // degrees on screen per unit of slip (R89b criteria)

const mk = (over: Partial<ReturnType<typeof car>> = {}): RaceState => mk0({ recover: 1e9, ...over });

interface Hold {
  steer: number;
  slip: number;
  speed: number;
  vel: number;
}

/** Bisection on a constant steer so that the mean vel over the last second is 0 (x is held). */
function holdSteer(curve: number, drift: boolean, secs: number, speed: number): Hold {
  const track = constTrack(curve);
  let lo = drift ? 0 : -1;
  let hi = 1;
  let res: Hold = { steer: NaN, slip: NaN, speed: NaN, vel: NaN };
  for (let it = 0; it < 30; it++) {
    const st = (lo + hi) / 2;
    const A = curve * speed * FREE.kYaw;
    const s = mk({
      speed,
      yawRate: A,
      yaw: A / (drift ? FREE.velGripDrift : FREE.velGrip),
      ...(drift ? { state: 'DRIFT' as const, dir: 1 as const } : {}),
    });
    let velSum = 0;
    let n = 0;
    for (let i = 0; i < secs / DT; i++) {
      stepB(s, inp(st, drift), FREE, track);
      if (i * DT > secs - 1) {
        velSum += car(s).vel;
        n++;
      }
    }
    const v = velSum / n;
    res = { steer: st, slip: slipOf(car(s)), speed: car(s).speed, vel: v };
    if (v > 0) hi = st;
    else lo = st;
  }
  return res;
}

/** Steady drift speed on a constant curve: accel = slipDrag*(curve*sp*kYaw/velGripDrift)^2 (spike s1). */
const equilibriumSpeed = (curve: number): number =>
  Math.min(
    1,
    (Math.sqrt(REAL.accel / REAL.slipDrag) * REAL.velGripDrift) / (Math.abs(curve) * REAL.kYaw),
  );

describe('R89b calibration: lane change (S1)', () => {
  // straight, vmax, steer 0.5 for 0.4 s, then 0
  function pulse() {
    const s = mk({ speed: 1 });
    const xs: number[] = [];
    const yaws: number[] = [];
    const vxs: number[] = [];
    for (let i = 0; i < 1.6 / DT; i++) {
      stepB(s, inp(i * DT < 0.4 ? 0.5 : 0), REAL);
      xs.push(car(s).x);
      yaws.push(car(s).yaw);
      vxs.push(car(s).vx);
    }
    return { s, xs, yaws, vxs };
  }
  it('R89b a 0.5 pulse for 0.4 s shifts the car by about a lane (0.2-0.3 half-widths)', () => {
    const { s } = pulse();
    expect(car(s).x).toBeGreaterThan(0.2);
    expect(car(s).x).toBeLessThan(0.3);
  });
  it('R89b the pulse settles within 0.6 s of the release, overshoot < 10%, no oscillation', () => {
    const { s, xs, yaws, vxs } = pulse();
    const rel = Math.round(0.4 / DT);
    const peakYaw = Math.max(...yaws.map(Math.abs));
    const peakVx = Math.max(...vxs.map(Math.abs));
    let settle = NaN;
    let signChanges = 0;
    let last = 0;
    for (let i = rel; i < xs.length; i++) {
      if (Number.isNaN(settle) && Math.abs(yaws[i]!) < 0.02 * peakYaw && Math.abs(vxs[i]!) < 0.02 * peakVx)
        settle = (i - rel) * DT;
      const sg = Math.sign(vxs[i]!);
      if (sg !== 0 && last !== 0 && sg !== last && Math.abs(vxs[i]!) > 0.02 * peakVx) signChanges++;
      if (sg !== 0) last = sg;
    }
    expect(settle).toBeLessThanOrEqual(0.6);
    expect(signChanges).toBe(0);
    expect((Math.max(...xs) - car(s).x) / car(s).x).toBeLessThan(0.1);
  });
});

describe('R89b calibration: GRIP on constant curves at vmax (S2)', () => {
  it('R89b easy is held at steer 0.4-0.5', () => {
    const h = holdSteer(C.easy, false, 3, 1);
    expect(h.steer).toBeGreaterThanOrEqual(0.4);
    expect(h.steer).toBeLessThanOrEqual(0.5);
  });
  it('R89b medium is held at steer 0.9-1.0 (on the edge)', () => {
    const h = holdSteer(C.medium, false, 3, 1);
    expect(h.steer).toBeGreaterThanOrEqual(0.9);
    expect(h.steer).toBeLessThanOrEqual(1.0);
  });
  it('R89b hard cannot be held at full steer: the car runs outward', () => {
    const s = mk({ speed: 1 });
    stepN(s, 180, inp(1), FREE, constTrack(C.hard)); // 1.5 s
    expect(car(s).vel).toBeLessThan(-0.05); // outward (left) on a right curve
    expect(car(s).x).toBeLessThan(-0.5);
  });
  it('R89b hold steer grows with the curve (easy < medium)', () => {
    expect(holdSteer(C.easy, false, 3, 1).steer).toBeLessThan(holdSteer(C.medium, false, 3, 1).steer);
  });
});

describe('R89b calibration: DRIFT on constant curves (S3)', () => {
  const hard = holdSteer(C.hard, true, 4, equilibriumSpeed(C.hard));
  const medium = holdSteer(C.medium, true, 4, equilibriumSpeed(C.medium));
  it('R89b hard: held at steer 0.45-0.65', () => {
    expect(hard.steer).toBeGreaterThanOrEqual(0.45);
    expect(hard.steer).toBeLessThanOrEqual(0.65);
  });
  it('R89b hard: steady speed >= 0.85 vmax', () => {
    expect(hard.speed).toBeGreaterThanOrEqual(0.85);
    expect(hard.speed).toBeLessThanOrEqual(1);
  });
  it('R89b hard: on-screen angle slip*17 within 30-40 degrees', () => {
    expect(hard.slip * SLIP_DEG).toBeGreaterThanOrEqual(30);
    expect(hard.slip * SLIP_DEG).toBeLessThanOrEqual(40);
  });
  it('R89b medium: held at steer 0.3-0.5', () => {
    expect(medium.steer).toBeGreaterThanOrEqual(0.3);
    expect(medium.steer).toBeLessThanOrEqual(0.5);
  });
  it('R89b medium: on-screen angle slip*17 within 15-25 degrees', () => {
    expect(medium.slip * SLIP_DEG).toBeGreaterThanOrEqual(15);
    expect(medium.slip * SLIP_DEG).toBeLessThanOrEqual(25);
  });
  it('R89b more steer in a steady hard drift moves the line inward (monotone in steer)', () => {
    // 2 s from the steady drift at the equilibrium speed, no walls: mean vel (+ = inward)
    const v0 = equilibriumSpeed(C.hard);
    const A = C.hard * v0 * FREE.kYaw;
    const meanVel = (st: number) => {
      const s = mk({ speed: v0, state: 'DRIFT', dir: 1, yawRate: A, yaw: A / FREE.velGripDrift });
      let sum = 0;
      for (let i = 0; i < 240; i++) {
        stepB(s, inp(st, true), FREE, constTrack(C.hard));
        sum += car(s).vel;
      }
      return sum / 240;
    };
    const a = meanVel(0.25);
    const b = meanVel(0.55);
    const c = meanVel(0.85);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});

describe('R89b calibration: response times at vmax on a straight (S7)', () => {
  /** 10-90% rise time of a series relative to its last value. */
  const rise = (series: number[]): number => {
    const fin = series[series.length - 1]!;
    let t10 = NaN;
    let t90 = NaN;
    for (let i = 0; i < series.length; i++) {
      const v = series[i]! / fin;
      if (Number.isNaN(t10) && v >= 0.1) t10 = i * DT;
      if (Number.isNaN(t90) && v >= 0.9) t90 = i * DT;
    }
    return t90 - t10;
  };
  const steerToYaw = (drift: boolean): number => {
    const s = mk({ speed: 1, ...(drift ? { state: 'DRIFT' as const, dir: 1 as const } : {}) });
    const ys: number[] = [];
    for (let i = 0; i < 1.5 / DT; i++) {
      stepB(s, inp(0.5, drift), REAL);
      ys.push(car(s).yaw);
    }
    return rise(ys);
  };
  const yawToVel = (drift: boolean): number => {
    // yaw is forced to a 0.5 step every tick, so only the yaw -> vel link is measured
    const s = mk({ speed: 1, ...(drift ? { state: 'DRIFT' as const, dir: 1 as const } : {}) });
    const vs: number[] = [];
    for (let i = 0; i < 1.5 / DT; i++) {
      car(s).yaw = 0.5;
      car(s).yawRate = 0;
      stepB(s, inp(0, drift), REAL);
      car(s).yaw = 0.5;
      vs.push(car(s).vel);
    }
    return rise(vs);
  };
  it('R89b GRIP steer -> yaw 10-90% in 0.10-0.15 s', () => {
    const t = steerToYaw(false);
    expect(t).toBeGreaterThanOrEqual(0.1);
    expect(t).toBeLessThanOrEqual(0.15);
  });
  it('R89b GRIP yaw -> vel 10-90% in 0.08-0.12 s', () => {
    const t = yawToVel(false);
    expect(t).toBeGreaterThanOrEqual(0.08);
    expect(t).toBeLessThanOrEqual(0.12);
  });
  it('R89b DRIFT yaw -> vel 10-90% in 0.3-0.4 s', () => {
    const t = yawToVel(true);
    expect(t).toBeGreaterThanOrEqual(0.3);
    expect(t).toBeLessThanOrEqual(0.4);
  });
});

describe('model B properties (spike section 1)', () => {
  const free: CarParams = { ...Q, xLimit: 1e9, offroadMul: 1, offroadSteerMul: 1 };
  for (const drift of [false, true]) {
    const label = drift ? 'DRIFT' : 'GRIP';
    const base = { speed: 1, ...(drift ? { state: 'DRIFT' as const, dir: 1 as const } : {}) };
    it(`on a straight with steer 0 any initial yaw/vel decays to 0 (${label})`, () => {
      for (const [yaw, vel] of [
        [0.5, -0.4],
        [-0.8, 0.3],
        [1.0, 1.0],
      ] as const) {
        const s = mk({ ...base, yaw, vel });
        stepN(s, 720, inp(0, drift), free); // 6 s
        expect(Math.abs(car(s).yaw)).toBeLessThan(1e-3);
        expect(Math.abs(car(s).vel)).toBeLessThan(1e-3);
        expect(Math.abs(car(s).yawRate)).toBeLessThan(1e-2);
      }
    });
    it(`steady yaw on a straight is steer*Y*f/al (${label})`, () => {
      // GRIP: 0.3*15/12.5 = 0.36; DRIFT: 0.3*43.6/6 = 2.18 (f = 1 at speed 1)
      const expected = drift ? (0.3 * 43.6) / 6 : (0.3 * 15) / 12.5;
      const s = mk({ ...base });
      stepN(s, 720, inp(0.3, drift), free);
      expect(car(s).yaw).toBeCloseTo(expected, 3);
      // mirrored steer gives the mirrored steady yaw
      const m = mk({ ...base, ...(drift ? { dir: -1 as const } : {}) });
      stepN(m, 720, inp(-0.3, drift), free);
      expect(car(m).yaw).toBeCloseTo(-expected, 3);
    });
  }
});

/** Deterministic scripted input: flicks, ramps, releases (no RNG). */
function scripted(i: number): InputFrame {
  const steer = Math.max(-1, Math.min(1, 1.3 * Math.sin(i / 17) + 0.6 * Math.sin(i / 5)));
  return { steer, brake: i % 700 > 650, drift: i % 300 > 60 };
}
const wavy = (sign: number): Track => {
  const segments = [];
  for (let i = 0; i < 3000; i++) segments.push({ curve: sign * 6 * Math.sin(i / 60) });
  return { segments };
};
function playB(n: number, sign = 1): RaceState {
  const s = createRace(3, 1);
  car(s).speed = 0.8;
  car(s).recover = 1e9;
  const t = wavy(sign);
  for (let i = 0; i < n; i++) {
    const f = scripted(i);
    step(s, [{ steer: f.steer * sign, brake: f.brake, drift: f.drift }], t, [PB]);
  }
  return s;
}

describe('model B determinism, symmetry, bounds, serialization (R2, R3)', () => {
  it('R2 same inputs twice give an identical state (steerHist included)', () => {
    expect(JSON.stringify(playB(2000))).toBe(JSON.stringify(playB(2000)));
  });
  it('R3 JSON round trip mid-run continues identically', () => {
    const t = wavy(1);
    const a = playB(500);
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    for (let i = 500; i < 1500; i++) {
      const f = scripted(i);
      step(a, [f], t, [PB]);
      step(b, [f], t, [PB]);
    }
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it('the script really drifts (guard against vacuous symmetry tests)', () => {
    const s = createRace(3, 1);
    car(s).speed = 0.8;
    car(s).recover = 1e9;
    let drifts = 0;
    for (let i = 0; i < 2000; i++) {
      step(s, [scripted(i)], wavy(1), [PB]);
      if (car(s).state === 'DRIFT') drifts++;
    }
    expect(drifts).toBeGreaterThan(100);
    expect(drifts).toBeLessThan(1900);
  });
  it('left/right symmetry: mirrored track and steer give the mirrored state', () => {
    for (const n of [300, 1000, 2000]) {
      const r = car(playB(n, 1));
      const l = car(playB(n, -1));
      for (const k of ['x', 'vx', 'yaw', 'yawRate', 'vel', 'steer', 'angle', 'heading'] as const)
        expect(l[k]).toBeCloseTo(-r[k], 9);
      expect(l.speed).toBeCloseTo(r.speed, 9);
      expect(l.z).toBeCloseTo(r.z, 9);
      expect(l.state).toBe(r.state);
      expect(l.dir + r.dir).toBe(0);
    }
  });
  it('bounds: everything finite, |x| <= xLimit, 0 <= speed <= vmax, buffer length fixed', () => {
    const s = createRace(3, 1);
    car(s).speed = 0.8;
    car(s).recover = 1e9;
    const t = wavy(1);
    for (let i = 0; i < 4000; i++) {
      step(s, [scripted(i)], t, [PB]);
      const c = car(s);
      for (const k of ['x', 'z', 'speed', 'vx', 'yaw', 'yawRate', 'vel', 'angle', 'recover'] as const)
        expect(Number.isFinite(c[k])).toBe(true);
      expect(Math.abs(c.x)).toBeLessThanOrEqual(PB.xLimit + 1e-12);
      expect(c.speed).toBeGreaterThanOrEqual(0);
      expect(c.speed).toBeLessThanOrEqual(PB.vmax + 1e-12);
      expect(Math.abs(c.angle)).toBeLessThanOrEqual(1);
      expect(c.steerHist).toHaveLength(STEER_HIST);
    }
  });
});

describe('golden example in model B (brief section 5)', () => {
  it('straight track, 120 steps, steer 0: speed 0.22, z 6.655, x = vx = heading = 0', () => {
    for (const p of [PB, REAL]) {
      const s = createRace(1, 1);
      run(s, 120, () => [GAS], [p], STRAIGHT);
      const c = car(s);
      // z = 0.22 * (120*121/2) / 120^2 * 60 = 0.22 * 7260 / 14400 * 60 = 6.655
      // (the director's note said 13.31; the brief gives 6.655, which the model A golden also uses)
      expect(Math.abs(c.speed - 0.22)).toBeLessThan(1e-9);
      expect(Math.abs(c.z - 6.655)).toBeLessThan(1e-6);
      expect(Math.abs(c.x)).toBe(0);
      expect(Math.abs(c.vx)).toBe(0);
      expect(Math.abs(c.heading)).toBe(0);
      expect(s.tick).toBe(120);
    }
  });
});

describe('model B createRace fields', () => {
  it('new fields start at 0 and steerHist is a preallocated zero array of STEER_HIST', () => {
    const c = createRace(1, 1).cars[0]!;
    expect(c.yaw).toBe(0);
    expect(c.yawRate).toBe(0);
    expect(c.vel).toBe(0);
    expect(c.recover).toBe(0);
    expect(c.steerHist).toEqual(new Array<number>(STEER_HIST).fill(0));
    expect(c.steerHistHead).toBe(0);
    expect(c.steerHistCount).toBe(0);
  });
});

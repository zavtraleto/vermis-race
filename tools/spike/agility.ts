// THROWAWAY SPIKE (docs/research/agility-spike.md): agility of driving model B without and in DRIFT.
// Everything runs through the REAL src/sim `step`; parameters are overridden in memory only
// (src/data is not touched). The only non-rule piece is the optional prototype `lead`
// (direct lateral authority in DRIFT, see protoLead), applied after the real step.
// Run: node tools/run-ts.mjs tools/spike/agility.ts [--part 1|2|all] [--set k=v,...] [--lead v]
import { baseCar } from '../../src/data/cars';
import inputCfg from '../../src/data/input.json';
import curves from '../../src/data/tracks/curves.json';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { argValue, type Io } from '../io';

const C = curves as { easy: number; medium: number; hard: number };
const LANE = 0.25; // road x in [-1, 1], 8 lanes
const RELEASE_S = inputCfg.touch.releaseMs / 1000; // finger lift: steer -> 0 at 1/releaseMs
const KB_RAMP_S = inputCfg.keyboard.steerRampMs / 1000;
const B: CarParams = { ...baseCar, model: 1 };
const A: CarParams = { ...baseCar, model: 0 }; // = tests/sim/baseCarA.ts

interface Cfg {
  p: CarParams;
  lead: number; // prototype only, 0 = today's rules
}

// ---------------------------------------------------------------- sim wrapper
const tracks = new Map<number, Track>();
function constTrack(curve: number): Track {
  let t = tracks.get(curve);
  if (t === undefined) {
    const segments = [];
    for (let i = 0; i < 4000; i++) segments.push({ curve });
    t = { segments };
    tracks.set(curve, t);
  }
  return t;
}
const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  offroadSteerMul: 1,
  offroadGrip: p.grip,
  offroadVelMul: 1,
});
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const approach = (cur: number, target: number, rate: number): number => {
  const d = rate * DT;
  return cur < target ? Math.min(target, cur + d) : Math.max(target, cur - d);
};

class Sim {
  race: RaceState = createRace(1, 1);
  car: Car;
  p: CarParams;
  lead: number;
  frame: InputFrame = { steer: 0, brake: false, drift: false };
  track: Track;
  dx = 0; // dx/dt of the last tick
  entries = 0;
  constructor(cfg: Cfg, curve: number, walls = false) {
    // R47 lamp posts (|x| ~ lampOffset) would crash the car in these open-road manoeuvres; they
    // are switched off here (crash threshold above any speed), everything else is the real step.
    const noLamps = { ...cfg.p, crashMinSpeed: 1e9 } as CarParams;
    this.p = walls ? noLamps : free(noLamps);
    this.lead = cfg.lead;
    this.car = this.race.cars[0]!;
    this.car.speed = this.p.vmax;
    this.track = constTrack(curve);
  }
  tick(steer: number, drift: boolean): void {
    const c = this.car;
    const x0 = c.x;
    const wasDrift = c.state === 'DRIFT';
    this.frame.steer = steer;
    this.frame.drift = drift;
    step(this.race, [this.frame], this.track, [this.p]);
    if (this.lead !== 0 && this.p.model === 1 && c.state === 'DRIFT')
      protoLead(c, this.p, this.lead);
    if (!wasDrift && c.state === 'DRIFT') this.entries++;
    this.dx = (c.x - x0) / DT;
  }
  get drifting(): boolean {
    return this.car.state === 'DRIFT';
  }
  /** model B: slip in DRIFT (yaw - vel), model A: angle. */
  get slip(): number {
    const c = this.car;
    if (c.state !== 'DRIFT') return 0;
    return this.p.model === 1 ? c.yaw - c.vel : c.angle;
  }
}

/**
 * PROTOTYPE rule (not in the brief): in DRIFT the part of the finger the body angle has not
 * followed yet moves the car directly: x += dir*lead*e*sp*latScale*DT, e = clamp(u,0,1) -
 * slip*dir/slipFull (u = steer*dir). In a steady drift e = 0, so holds and drift numbers stay.
 */
function protoLead(c: Car, p: CarParams, lead: number): void {
  const u = c.steer * c.dir;
  const e = clamp(u, 0, 1) - ((c.yaw - c.vel) * c.dir) / p.slipFull;
  c.x += c.dir * lead * e * (c.speed / p.vmax) * p.latScale * DT;
}

const run = (s: Sim, steer: number, drift: boolean, sec: number): void => {
  for (let t = 0; t < sec - 1e-9; t += DT) s.tick(steer, drift);
};
const meanDx = (s: Sim, steer: number, drift: boolean, sec: number): number => {
  const x0 = s.car.x;
  run(s, steer, drift, sec);
  return (s.car.x - x0) / sec;
};

// ---------------------------------------------------------------- steady states
/** GRIP steer that holds the line on `curve` (bisection, 3 s from rest); NaN if |hold| > 1. */
function gripHold(cfg: Cfg, curve: number): number {
  const f = (s: number): number => {
    const sim = new Sim(cfg, curve);
    run(sim, s, false, 2.5);
    return meanDx(sim, s, false, 0.5);
  };
  if (f(1) < 0 || f(-1) > 0) return NaN;
  let lo = -1;
  let hi = 1;
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2;
    if (f(m) < 0) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** GRIP steady state at steer h: slow ramp from 0 (no flick), 3 s. */
function settleGrip(cfg: Cfg, curve: number, h: number, touch: boolean): Sim {
  const sim = new Sim(cfg, curve);
  let st = 0;
  const drift = touch && cfg.p.model === 1;
  for (let t = 0; t < 3; t += DT) {
    st = approach(st, h, 2);
    sim.tick(st, drift);
  }
  return sim;
}

/** DRIFT dir +1 entered by a flick (0 -> 1 in one tick, drift held), then steer s. */
function enterDrift(cfg: Cfg, curve: number, s: number): Sim {
  const sim = new Sim(cfg, curve);
  if (cfg.p.model === 1) {
    // model B: finger held, slow ramp to -1 (no flick), then -1 -> +1 in one tick (d = 2), so the
    // entry works for any flickDelta <= 2 of the sweep
    let st = 0;
    for (let t = 0; t < 0.6; t += DT) {
      st = approach(st, -1, 2);
      sim.tick(st, true);
    }
  } else run(sim, 0, false, 0.3);
  sim.tick(1, true);
  sim.tick(s, true);
  return sim;
}

interface DH {
  s: number;
  speed: number;
}
/** DRIFT steer that holds the line (free speed, 6 s), bisection on [0, 1]. */
function driftHold(cfg: Cfg, curve: number): DH {
  const f = (s: number): number => {
    const sim = enterDrift(cfg, curve, s);
    run(sim, s, true, 5);
    return meanDx(sim, s, true, 1);
  };
  let lo = 0;
  let hi = 1;
  if (f(0) > 0) hi = 0;
  else if (f(1) < 0) lo = 1;
  else
    for (let i = 0; i < 20; i++) {
      const m = (lo + hi) / 2;
      if (f(m) < 0) lo = m;
      else hi = m;
    }
  const s = (lo + hi) / 2;
  const sim = enterDrift(cfg, curve, s);
  run(sim, s, true, 6);
  return { s, speed: sim.car.speed };
}

// ---------------------------------------------------------------- a) b) dodge
type Ret = 'none' | 'keep' | 'release';
interface Dodge {
  hold: number;
  t1: number; // time to one lane
  t2: number; // time to two lanes (ret 'none' only)
  drift: boolean; // DRIFT entered during the manoeuvre
  over: number; // beyond one lane after the return starts
  coast: number; // how far x keeps going toward the dodge side after the steer is back (input stopped)
  settle: number; // from return start until |dx/dt| < 0.05 for good (NaN: never within 3 s)
  res: number; // |dx/dt| at the start (steady-state check)
}
/**
 * From the GRIP steady state holding the line, steer ramps from hold toward +1 (side +1, inside)
 * or -1 (side -1, outside) at 1/ramp per s. ret 'none': held until two lanes. 'keep': at one lane
 * the finger stays and steer ramps back to hold at the same rate. 'release': at one lane drift
 * input goes false and steer falls to 0 at 1/releaseMs (touch lift). touch: drift held all along
 * in model B; in model A drift goes true at the dodge start (rising edge arms R20).
 */
function dodge(
  cfg: Cfg,
  curve: number,
  side: 1 | -1,
  rampS: number,
  touch: boolean,
  ret: Ret,
  hold?: number,
): Dodge {
  const h = hold ?? (curve === 0 ? 0 : gripHold(cfg, curve));
  const out: Dodge = {
    hold: h,
    t1: NaN,
    t2: NaN,
    drift: false,
    over: NaN,
    coast: NaN,
    settle: NaN,
    res: NaN,
  };
  if (Number.isNaN(h)) return out;
  const sim = settleGrip(cfg, curve, h, touch);
  out.res = Math.abs(sim.dx);
  const x0 = sim.car.x;
  const rate = 1 / rampS;
  const target = side > 0 ? 1 : -1;
  let st = h;
  let back = false;
  let tRet = 0;
  let maxD = 0;
  let dStop = NaN;
  let maxAfter = -Infinity;
  let calm = NaN;
  let drift = touch;
  const T = 6;
  for (let t = DT; t < T; t += DT) {
    if (!back) st = approach(st, target, rate);
    else if (ret === 'keep') st = approach(st, h, rate);
    else {
      drift = false;
      st = approach(st, 0, 1 / RELEASE_S);
    }
    sim.tick(st, drift);
    if (sim.drifting) out.drift = true;
    const d = (sim.car.x - x0) * side;
    if (Number.isNaN(out.t1) && d >= LANE) {
      out.t1 = t;
      if (ret !== 'none') {
        back = true;
        tRet = t;
      }
    }
    if (ret === 'none') {
      if (d >= 2 * LANE) {
        out.t2 = t;
        break;
      }
      if (t > 3) break;
      continue;
    }
    if (!back) {
      if (t > 3) break;
      continue;
    }
    if (d > maxD) maxD = d;
    if (Number.isNaN(dStop) && st === (ret === 'keep' ? h : 0)) dStop = d;
    if (!Number.isNaN(dStop) && d > maxAfter) maxAfter = d;
    if (Math.abs(sim.dx) < 0.05) {
      if (Number.isNaN(calm)) calm = t;
    } else calm = NaN;
    if (t > tRet + 3) break;
  }
  if (ret !== 'none' && back) {
    out.over = maxD - LANE;
    out.coast = maxAfter - dStop;
    out.settle = calm - tRet;
  }
  return out;
}

// ---------------------------------------------------------------- c) dodge inside a drift
interface DDodge {
  hold: number;
  dx2: number;
  dx4: number;
  dx6: number;
  tLaneHalf: number; // steer hold +/-0.5 kept until one lane
  tLaneFull: number; // steer +1 / -1 kept until one lane
}
function driftDodge(cfg: Cfg, curve: number, sign: 1 | -1, dh: DH): DDodge {
  const h = dh.s;
  const out: DDodge = { hold: h, dx2: NaN, dx4: NaN, dx6: NaN, tLaneHalf: NaN, tLaneFull: NaN };
  const steady = (): Sim => {
    const sim = enterDrift(cfg, curve, h);
    run(sim, h, true, 6);
    return sim;
  };
  {
    const sim = steady();
    const x0 = sim.car.x;
    const s1 = clamp(h + 0.5 * sign, -1, 1);
    let i = 0;
    for (let t = DT; t < 0.6 + 1e-9; t += DT, i++) {
      sim.tick(t <= 0.4 + 1e-9 ? s1 : h, true);
      const n = i + 1;
      if (n === Math.round(0.2 / DT)) out.dx2 = sim.car.x - x0;
      if (n === Math.round(0.4 / DT)) out.dx4 = sim.car.x - x0;
      if (n === Math.round(0.6 / DT)) out.dx6 = sim.car.x - x0;
    }
  }
  const tl = (s1: number): number => {
    const sim = steady();
    const x0 = sim.car.x;
    for (let t = DT; t < 3; t += DT) {
      sim.tick(s1, true);
      if ((sim.car.x - x0) * sign >= LANE) return t;
    }
    return NaN;
  };
  out.tLaneHalf = tl(clamp(h + 0.5 * sign, -1, 1));
  out.tLaneFull = tl(sign);
  return out;
}

// ---------------------------------------------------------------- d) slalom
interface Slalom {
  lps: number; // lane changes per second after the first switch
  amp: number; // max |x - x0|
  first: number; // time of the first switch (half a lane from the centre)
  drift: boolean;
}
/** Bang-bang between the lane centres x0 +/- LANE/2: full steer toward the current target lane. */
function slalom(cfg: Cfg, touch: boolean, rampS: number): Slalom {
  const sim = new Sim(cfg, 0);
  const drift = touch && cfg.p.model === 1;
  run(sim, 0, drift, 1);
  const x0 = sim.car.x;
  let side = 1;
  let st = 0;
  let flips = 0;
  let tFirst = NaN;
  let tLast = NaN;
  let amp = 0;
  let dr = false;
  for (let t = DT; t < 8; t += DT) {
    st = approach(st, side, 1 / rampS);
    sim.tick(st, touch);
    if (sim.drifting) dr = true;
    const d = sim.car.x - x0;
    amp = Math.max(amp, Math.abs(d));
    if (d * side >= LANE / 2) {
      side = -side;
      flips++;
      if (Number.isNaN(tFirst)) tFirst = t;
      tLast = t;
    }
  }
  return {
    lps: flips >= 2 ? (flips - 1) / (tLast - tFirst) : 0,
    amp,
    first: tFirst,
    drift: dr,
  };
}

// ---------------------------------------------------------------- guards
/** Noisy finger (+/-0.1 uniform at 20 Hz around the hold) in the hard drift, worst of 5 seeds. */
function wobble(cfg: Cfg, dh: DH): number {
  let worst = 0;
  for (let seed = 1; seed <= 5; seed++) {
    let rng = seed * 7919;
    const rnd = (): number => {
      rng = (Math.imul(rng, 1103515245) + 12345) | 0;
      return ((rng >>> 8) & 0xffff) / 0xffff;
    };
    const sim = enterDrift(cfg, C.hard, dh.s);
    run(sim, dh.s, true, 6);
    const x0 = sim.car.x;
    let noise = 0;
    let i = 0;
    for (let t = 0; t < 10; t += DT, i++) {
      if (i % Math.round(0.05 / DT) === 0) noise = (rnd() * 2 - 1) * 0.1;
      sim.tick(dh.s + noise, true);
      worst = Math.max(worst, Math.abs(sim.car.x - x0));
    }
  }
  return worst;
}
/** T4: DRIFT dir +1, steer +1 1 s, -1 1.5 s, hold 1 s; min slip*dir and whether dir/state changed. */
function sideFlip(cfg: Cfg, dhHard: DH): { minSlipDir: number; flipped: boolean } {
  let minS = Infinity;
  let flipped = false;
  for (const [c, hold] of [
    [0, 0.5],
    [C.hard, dhHard.s],
  ] as const) {
    const sim = enterDrift(cfg, c, 1);
    for (let t = 0; t < 3.5; t += DT) {
      sim.tick(t < 1 ? 1 : t < 2.5 ? -1 : hold, true);
      if (!sim.drifting || sim.car.dir !== 1) flipped = true;
      minS = Math.min(minS, sim.slip * sim.car.dir);
    }
  }
  return { minSlipDir: minS, flipped };
}
/** T13: steady hard drift 4 s at hold, release, steer 1 for 1 s: dx in 1 s (negative = out). */
function runOut(cfg: Cfg, dh: DH): number {
  const sim = enterDrift(cfg, C.hard, dh.s);
  run(sim, dh.s, true, 4);
  const x0 = sim.car.x;
  run(sim, 1, false, 1);
  return sim.car.x - x0;
}
/** Full steer from the road centre on a straight with the real walls: time to |x| = 1 and xLimit. */
function wallTime(cfg: Cfg, touch: boolean): { edge: number; wall: number } {
  const sim = new Sim(cfg, 0, true);
  const drift = touch && cfg.p.model === 1;
  run(sim, 0, drift, 0.5);
  let st = 0;
  let edge = NaN;
  const rate = 1 / (touch ? 0.08 : KB_RAMP_S);
  for (let t = DT; t < 5; t += DT) {
    st = approach(st, 1, rate);
    sim.tick(st, touch);
    if (Number.isNaN(edge) && sim.car.x >= 1) edge = t;
    if (sim.car.x >= sim.p.xLimit - 1e-9) return { edge, wall: t };
  }
  return { edge, wall: NaN };
}
/** R89b T5: max |x - x_nokick| over 0.6 s, flick to 1 over 0.06 s then 0.5, straight. */
/**
 * Extra sideways shift the prototype lead adds at a drift entry: max |x(lead) - x(lead 0)| with the
 * same numbers and input. Straight: T5 input (0 -> 1 in 60 ms, then 0.5), 0.6 s. Hard: 0.3 s GRIP
 * at steer 0, then a one-tick step to the hard drift hold (a flick), 2 s.
 */
function leadShift(cfg: Cfg): { straight: number; hard: number } {
  const base: Cfg = { ...cfg, lead: 0 };
  const go = (c: Cfg, curve: number, hold: number): number[] => {
    const sim = new Sim(c, curve);
    run(sim, 0, true, 0.3);
    const xs: number[] = [];
    let st = 0;
    const T = curve === 0 ? 0.6 : 2;
    for (let t = DT; t < T; t += DT) {
      if (curve === 0) st = t <= 0.06 ? approach(st, 1, 1 / 0.06) : 0.5;
      else st = hold;
      sim.tick(st, true);
      xs.push(sim.car.x);
    }
    return xs;
  };
  const diff = (a: number[], b: number[]): number => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!));
    return d;
  };
  const h = driftHold(base, C.hard).s;
  return {
    straight: diff(go(cfg, 0, 0), go(base, 0, 0)),
    hard: diff(go(cfg, C.hard, h), go(base, C.hard, h)),
  };
}
function entryThrow(cfg: Cfg): { vsNoKick: number; maxX: number } {
  const go = (c: Cfg): number[] => {
    const sim = new Sim(c, 0);
    run(sim, 0, true, 0.3);
    const xs: number[] = [];
    let st = 0;
    for (let t = DT; t < 0.6; t += DT) {
      st = t <= 0.06 ? approach(st, 1, 1 / 0.06) : 0.5;
      sim.tick(st, true);
      xs.push(sim.car.x);
    }
    return xs;
  };
  const a = go(cfg);
  const b = go({ ...cfg, p: { ...cfg.p, kickBase: 0, kickGain: 0 } });
  let d = 0;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    d = Math.max(d, Math.abs(a[i]! - b[i]!));
    m = Math.max(m, Math.abs(a[i]!));
  }
  return { vsNoKick: d, maxX: m };
}

// ---------------------------------------------------------------- R89b calibration (info)
interface Calib {
  vFull: number;
  pulse: number;
  holdEasy: number;
  holdMed: number;
  holdHard: number; // 9 when GRIP cannot hold hard (|hold| > 1)
  hardFullOut: number;
  medZeroOut: number;
  dHoldHard: number;
  dHoldMed: number;
  dSpeedHard: number;
  steerYaw: number;
  yawVel: number;
}
/** 10-90% rise time of a series relative to its last value (as calm-drift T8). */
function rise(series: number[]): number {
  const fin = series[series.length - 1]!;
  let t10 = NaN;
  let t90 = NaN;
  for (let i = 0; i < series.length; i++) {
    const v = series[i]! / fin;
    if (Number.isNaN(t10) && v >= 0.1) t10 = i * DT;
    if (Number.isNaN(t90) && v >= 0.9) t90 = i * DT;
  }
  return t90 - t10;
}
function riseSteerYaw(cfg: Cfg): number {
  const sim = new Sim(cfg, 0);
  const ys: number[] = [];
  for (let t = 0; t < 1.5; t += DT) {
    sim.car.speed = cfg.p.vmax;
    sim.tick(0.5, false);
    ys.push(sim.car.yaw);
  }
  return rise(ys);
}
function riseYawVel(cfg: Cfg): number {
  const sim = new Sim(cfg, 0);
  const vs: number[] = [];
  for (let t = 0; t < 1.5; t += DT) {
    sim.car.speed = cfg.p.vmax;
    sim.car.yaw = 0.5;
    sim.car.yawRate = 0;
    sim.tick(0, false);
    sim.car.yaw = 0.5;
    vs.push(sim.car.vel);
  }
  return rise(vs);
}
function calib(cfg: Cfg, dhHard: DH): Calib {
  const sim = new Sim(cfg, 0);
  run(sim, 1, false, 1.5);
  const vFull = sim.dx;
  const ps = new Sim(cfg, 0);
  run(ps, 0.5, false, 0.4);
  run(ps, 0, false, 1.6);
  const hf = new Sim(cfg, C.hard);
  run(hf, 1, false, 1.5);
  const mz = new Sim(cfg, C.medium);
  run(mz, 0, false, 1.5);
  return {
    vFull,
    pulse: ps.car.x,
    holdEasy: gripHold(cfg, C.easy),
    holdMed: gripHold(cfg, C.medium),
    holdHard: ((h) => (Number.isNaN(h) ? 9 : h))(gripHold(cfg, C.hard)),
    hardFullOut: -hf.dx,
    medZeroOut: -mz.dx,
    dHoldHard: dhHard.s,
    dHoldMed: driftHold(cfg, C.medium).s,
    dSpeedHard: dhHard.speed,
    steerYaw: riseSteerYaw(cfg),
    yawVel: riseYawVel(cfg),
  };
}

// ---------------------------------------------------------------- evaluation (Part 2)
interface Metrics {
  sLane: number; // straight GRIP ramp 150 one lane
  mIn: number;
  mOut: number;
  dDodge: number; // worst one-lane time among all touch dodges (ramp 40/80), GRIP or DRIFT
  enters40: boolean; // straight 0 -> 1 in 40 ms with the finger held enters DRIFT
  dDodgeAll: string;
  hIn: number; // hard drift, full deflection, one lane
  hOut: number;
  over: number; // worst GRIP coast after the steer is back (straight, medium in/out, ramp 150)
  overLane: number; // same manoeuvres: worst beyond one lane (return starts at one lane)
  wob: number;
  flip: boolean;
  runOut: number;
  wall: number; // min over keyboard / touch
  throwX: number;
  slT: number; // slalom lanes/s, touch ramp 80 ms
  slG: number; // slalom lanes/s, keyboard
  touchKeep: Dodge; // straight touch dodge ramp 80 ms, finger kept, steer back to 0 at one lane
  touchRel: Dodge; // same, finger lifted at one lane
  lead: { straight: number; hard: number };
  calib: Calib;
}
function evaluate(cfg: Cfg): Metrics {
  const hm = gripHold(cfg, C.medium);
  const dh = driftHold(cfg, C.hard);
  const s = dodge(cfg, 0, 1, 0.15, false, 'none', 0);
  const mi = dodge(cfg, C.medium, 1, 0.15, false, 'none', hm);
  const mo = dodge(cfg, C.medium, -1, 0.15, false, 'none', hm);
  let over = 0;
  let overL = 0;
  for (const [c, side, h] of [
    [0, 1, 0],
    [C.medium, 1, hm],
    [C.medium, -1, hm],
  ] as const) {
    const d = dodge(cfg, c, side, 0.15, false, 'keep', h);
    over = Math.max(over, Number.isNaN(d.coast) ? Infinity : d.coast);
    overL = Math.max(overL, Number.isNaN(d.over) ? Infinity : d.over);
  }
  let dd = 0;
  let e40 = false;
  const parts: string[] = [];
  for (const ramp of [0.04, 0.08])
    for (const [c, side, h, k] of [
      [0, 1, 0, 'S'],
      [C.medium, 1, hm, 'Mi'],
      [C.medium, -1, hm, 'Mo'],
    ] as const) {
      const d = dodge(cfg, c, side, ramp, true, 'none', h);
      dd = Math.max(dd, Number.isNaN(d.t1) ? Infinity : d.t1);
      if (c === 0 && ramp === 0.04) e40 = d.drift;
      parts.push(`${k}${ramp * 1000}:${f2(d.t1, 2)}${d.drift ? 'D' : 'G'}`);
    }
  const hi = driftDodge(cfg, C.hard, 1, dh);
  const ho = driftDodge(cfg, C.hard, -1, dh);
  const fl = sideFlip(cfg, dh);
  const wk = wallTime(cfg, false);
  const wt = wallTime(cfg, true);
  return {
    sLane: s.t1,
    mIn: mi.t1,
    mOut: mo.t1,
    dDodge: dd,
    enters40: e40,
    dDodgeAll: parts.join(' '),
    hIn: hi.tLaneFull,
    hOut: ho.tLaneFull,
    over,
    overLane: overL,
    wob: wobble(cfg, dh),
    flip: fl.flipped || fl.minSlipDir < -1e-9,
    runOut: runOut(cfg, dh),
    wall: Math.min(nz(wk.wall), nz(wt.wall)),
    throwX: entryThrow(cfg).vsNoKick,
    slT: slalom(cfg, true, 0.08).lps,
    slG: slalom(cfg, false, KB_RAMP_S).lps,
    touchKeep: dodge(cfg, 0, 1, 0.08, true, 'keep', 0),
    touchRel: dodge(cfg, 0, 1, 0.08, true, 'release', 0),
    lead: leadShift(cfg),
    calib: calib(cfg, dh),
  };
}
const nz = (v: number): number => (Number.isNaN(v) ? Infinity : v);

const WOB_TODAY = 0.034; // docs/research/calm-drift-spike.md T10 (re-measured by Part 1)
interface Check {
  name: string;
  v: (m: Metrics) => number;
  lim: number;
  le: boolean; // value must be <= lim (else >=)
  guard: boolean;
}
const CHECKS: Check[] = [
  {
    name: 'straight GRIP lane, ramp 150 (s)',
    v: (m) => m.sLane,
    lim: 0.35,
    le: true,
    guard: false,
  },
  { name: 'medium GRIP lane inside (s)', v: (m) => m.mIn, lim: 0.45, le: true, guard: false },
  { name: 'medium GRIP lane outside (s)', v: (m) => m.mOut, lim: 0.45, le: true, guard: false },
  {
    name: 'touch dodge ramp 40/80 worst (s)',
    v: (m) => m.dDodge,
    lim: 0.5,
    le: true,
    guard: false,
  },
  { name: 'hard drift lane inside (s)', v: (m) => m.hIn, lim: 0.6, le: true, guard: false },
  { name: 'hard drift lane outside (s)', v: (m) => m.hOut, lim: 0.6, le: true, guard: false },
  {
    name: 'GRIP coast after input stops, worst (hw)',
    v: (m) => m.over,
    lim: 0.12,
    le: true,
    guard: false,
  },
  { name: 'G wobble hard (hw)', v: (m) => m.wob, lim: 1.5 * WOB_TODAY, le: true, guard: true },
  { name: 'G side flip (1 = yes)', v: (m) => (m.flip ? 1 : 0), lim: 0, le: true, guard: true },
  {
    name: 'G run-out after hard exit |dx 1 s|',
    v: (m) => -m.runOut,
    lim: 0.6,
    le: true,
    guard: true,
  },
  { name: 'G full steer to wall (s)', v: (m) => m.wall, lim: 0.9, le: false, guard: true },
];
const pass = (c: Check, v: number): boolean =>
  !Number.isNaN(v) && (c.le ? v <= c.lim + 1e-9 : v >= c.lim - 1e-9);
/** R89b calibration windows (brief) measured here; guards only in the strict searches. */
const R89B_WIN: [string, (m: Metrics) => number, number, number][] = [
  ['GRIP full steer straight', (m) => m.calib.vFull, 1.0, 1.1],
  ['GRIP pulse 0.5 x 0.4 s', (m) => m.calib.pulse, 0.15, 0.3],
  ['GRIP hold easy', (m) => m.calib.holdEasy, 0.4, 0.5],
  ['GRIP hold medium', (m) => m.calib.holdMed, 0.9, 1.0],
  ['GRIP hard full steer out', (m) => m.calib.hardFullOut, 0.4, 0.7],
  ['GRIP medium steer 0 out', (m) => m.calib.medZeroOut, 0.9, 1.1],
  ['GRIP steer->yaw 10-90%', (m) => m.calib.steerYaw, 0.1, 0.15],
  ['GRIP yaw->vel 10-90%', (m) => m.calib.yawVel, 0.08, 0.12],
  ['DRIFT hold hard', (m) => m.calib.dHoldHard, 0.7, 0.85],
  ['DRIFT hold medium', (m) => m.calib.dHoldMed, 0.45, 0.55],
  ['DRIFT hard speed', (m) => m.calib.dSpeedHard, 0.85, 9],
  ['T5 entry vs no kick', (m) => m.throwX, -1, 0.05],
];
const R89B: Check[] = R89B_WIN.flatMap(([name, v, lo, hi]) => [
  { name: `${name} >= ${lo}`, v, lim: lo, le: false, guard: true },
  { name: `${name} <= ${hi}`, v, lim: hi, le: true, guard: true },
]);
const HARD_NEEDS_DRIFT: Check = {
  name: 'GRIP hold hard > 1 (hard needs a drift)',
  v: (m) => m.calib.holdHard,
  lim: 1,
  le: false,
  guard: true,
};
type Mode = 'task' | 'hard' | 'r89b';
const checksOf = (mode: Mode): Check[] =>
  mode === 'r89b' ? [...CHECKS, ...R89B] : mode === 'hard' ? [...CHECKS, HARD_NEEDS_DRIFT] : CHECKS;
function cost(m: Metrics, changed: number, mode: Mode = 'task'): number {
  let k = changed * 0.03;
  for (const c of checksOf(mode)) {
    const v = c.v(m);
    if (pass(c, v)) continue;
    const ex = !Number.isFinite(v)
      ? 3
      : c.le
        ? (v - c.lim) / Math.max(c.lim, 0.05)
        : (c.lim - v) / Math.max(Math.abs(c.lim), 0.05);
    k += c.guard ? 10 + 10 * ex : Math.min(ex, 3);
  }
  return k;
}

// ---------------------------------------------------------------- output helpers
const f2 = (v: number, d = 3): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
function table(io: Io, head: string[], rows: (string | number)[][]): void {
  const cells = [head, ...rows.map((r) => r.map((c) => (typeof c === 'number' ? f2(c) : c)))];
  const wd = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  io.log('| ' + head.map((c, i) => pad(c, wd[i]!)).join(' | ') + ' |');
  io.log('| ' + wd.map((w) => '-'.repeat(w)).join(' | ') + ' |');
  for (const r of cells.slice(1)) io.log('| ' + r.map((c, i) => pad(c, wd[i]!)).join(' | ') + ' |');
}
const yn = (b: boolean): string => (b ? 'D' : 'G');

// ---------------------------------------------------------------- Part 1
function part1(io: Io, cfgB: Cfg): void {
  const models: [string, Cfg][] = [
    ['B', cfgB],
    ['A', { p: A, lead: 0 }],
  ];
  io.log('\n## a) straight, vmax start, free speed: steer 0 -> +1 at 1/ramp');
  io.log(
    't1/t2 = time to one/two lanes (0.25/0.5) with steer kept at 1; D = DRIFT entered, G = GRIP',
  );
  io.log(
    'keep = finger kept, steer back to the hold at the same rate at one lane; release = finger',
  );
  io.log(
    'lifted at one lane (drift false, steer -> 0 at 1/releaseMs). over = beyond one lane, settle',
  );
  io.log('= from return start until |dx/dt| < 0.05 for good. coast = how far x keeps going toward');
  io.log('the dodge side after the steer is back at the hold (keep) or at 0 (release).');
  const rowsA: (string | number)[][] = [];
  for (const [mn, cfg] of models)
    for (const touch of [true, false])
      for (const r of [0.04, 0.08, 0.15, 0.25]) {
        const n = dodge(cfg, 0, 1, r, touch, 'none', 0);
        const k = dodge(cfg, 0, 1, r, touch, 'keep', 0);
        const l = dodge(cfg, 0, 1, r, touch, 'release', 0);
        rowsA.push([
          mn,
          touch ? 'touch' : 'grip',
          r * 1000,
          n.t1,
          n.t2,
          yn(n.drift),
          `${f2(k.over)} / ${f2(k.coast)}`,
          k.settle,
          yn(k.drift),
          `${f2(l.over)} / ${f2(l.coast)}`,
          l.settle,
        ]);
      }
  table(
    io,
    [
      'model',
      'input',
      'ramp ms',
      't1',
      't2',
      'state',
      'keep over / coast',
      'keep settle',
      'keep st',
      'rel over / coast',
      'rel settle',
    ],
    rowsA,
  );

  io.log('\n## b) constant corners, from the GRIP steady state holding the lane; inside = +x');
  io.log('outside: steer from hold toward -1 at the same finger speed (1/ramp per s)');
  const rowsB: (string | number)[][] = [];
  for (const [mn, cfg] of models)
    for (const [cn, c] of [
      ['medium', C.medium],
      ['hard', C.hard],
    ] as const) {
      const h = gripHold(cfg, c);
      if (Number.isNaN(h)) {
        rowsB.push([mn, cn, '>1 (no GRIP hold)', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-']);
        continue;
      }
      for (const side of [1, -1] as const)
        for (const touch of [true, false])
          for (const r of [0.04, 0.08, 0.15, 0.25]) {
            const n = dodge(cfg, c, side, r, touch, 'none', h);
            const k = dodge(cfg, c, side, r, touch, 'keep', h);
            const l = dodge(cfg, c, side, r, touch, 'release', h);
            rowsB.push([
              mn,
              cn,
              f2(h) + ` (spare ${f2(1 - h, 2)})`,
              side > 0 ? 'in' : 'out',
              touch ? 'touch' : 'grip',
              r * 1000,
              n.t1,
              n.t2,
              yn(n.drift),
              `${f2(k.over)} / ${f2(k.coast)}`,
              k.settle,
              `${f2(l.over)} / ${f2(l.coast)}`,
              l.settle,
            ]);
          }
    }
  table(
    io,
    [
      'model',
      'curve',
      'hold',
      'side',
      'input',
      'ramp',
      't1',
      't2',
      'st',
      'keep over / coast',
      'keep settle',
      'rel over / coast',
      'rel settle',
    ],
    rowsB,
  );
  io.log(
    'analytic GRIP hold (model B, f = 1, vmax): A*(1 + yawAlign/velGrip)/yawRateMax, A = curve*kYaw',
  );
  for (const [cn, c] of [
    ['easy', C.easy],
    ['medium', C.medium],
    ['hard', C.hard],
  ] as const) {
    const Ay = c * B.kYaw;
    io.log(`  ${cn}: ${f2((Ay * (1 + B.yawAlign / B.velGrip)) / B.yawRateMax)}`);
  }

  io.log('\n## c) steady drift in hard (free speed, 6 s at the hold), then steer step');
  io.log(
    'dx at 0.2/0.4/0.6 s for hold +/-0.5 kept 0.4 s then hold; one-lane time with the step kept',
  );
  const rowsC: (string | number)[][] = [];
  for (const [mn, cfg] of models) {
    const dh = driftHold(cfg, C.hard);
    for (const sign of [1, -1] as const) {
      const d = driftDodge(cfg, C.hard, sign, dh);
      rowsC.push([
        mn,
        dh.s,
        dh.speed,
        sign > 0 ? '+0.5 (in)' : '-0.5 (out)',
        d.dx2,
        d.dx4,
        d.dx6,
        d.tLaneHalf,
        d.tLaneFull,
      ]);
    }
  }
  table(
    io,
    [
      'model',
      'hold',
      'speed',
      'step',
      'dx 0.2',
      'dx 0.4',
      'dx 0.6',
      't lane (step kept)',
      't lane (full +/-1)',
    ],
    rowsC,
  );

  io.log('\n## d) slalom on a straight: bang-bang between two adjacent lane centres, 8 s');
  const rowsD: (string | number)[][] = [];
  for (const [mn, cfg] of models)
    for (const [k, touch, r] of [
      ['grip (keyboard 120 ms)', false, KB_RAMP_S],
      ['touch ramp 80 ms', true, 0.08],
    ] as const) {
      const s = slalom(cfg, touch, r);
      rowsD.push([mn, k, s.lps, s.amp, s.first, yn(s.drift)]);
    }
  table(io, ['model', 'input', 'lanes/s', 'max |x - x0|', 'first switch s', 'state'], rowsD);
}

// ---------------------------------------------------------------- Part 2
const KNOBS: Record<string, number[]> = {
  yawRateMax: [15.75, 18, 20, 22.5, 25, 28, 32, 36, 40],
  yawAlign: [12, 15, 18, 21, 25, 30],
  yawResponse: [60, 72, 84, 100, 120],
  velGrip: [22, 26, 30, 36, 44, 55],
  slipGripMax: [0.75, 0.9, 1.1],
  slipGripLimit: [0.8, 1.0, 1.2],
  driftLat: [0.46, 0.6, 0.75, 0.9, 1.1, 1.4],
  velGripDrift: [3, 4.5, 6, 8, 10, 14],
  slipResponse: [8, 10, 12, 15, 20],
  driftPush: [0.0287, 0.035, 0.045, 0.06],
  flickDelta: [0.5, 0.7, 0.9, 1.2],
  flickWindow: [0.12, 0.08, 0.06],
};
type Over = Record<string, number>;
function cfgOf(over: Over, lead = 0): Cfg {
  return { p: { ...B, ...over } as CarParams, lead };
}
function row(m: Metrics): (string | number)[] {
  return CHECKS.map((c) => {
    const v = c.v(m);
    return `${f2(v, 3)}${pass(c, v) ? '' : ' X'}`;
  });
}
function describe(over: Over, lead: number): string {
  const parts = Object.keys(over).map((k) => `${k}=${over[k]}`);
  if (lead) parts.push(`lead=${lead}`);
  return parts.length ? parts.join(',') : '(today)';
}
function search(
  io: Io,
  keys: string[],
  lead: number[],
  mode: Mode = 'task',
): { over: Over; lead: number } {
  let best: Over = {};
  let bestLead = 0;
  let bestC = cost(evaluate(cfgOf(best, 0)), 0, mode);
  for (let it = 0; it < 4; it++) {
    let improved = false;
    for (const k of [...keys, 'lead']) {
      const vals = k === 'lead' ? lead : KNOBS[k]!;
      for (const v of vals) {
        const o: Over = { ...best };
        let l = bestLead;
        if (k === 'lead') l = v;
        else if (v === (B as unknown as Record<string, number>)[k]) delete o[k];
        else o[k] = v;
        const m = evaluate(cfgOf(o, l));
        const c = cost(m, Object.keys(o).length + (l ? 1 : 0), mode);
        if (c < bestC - 1e-6) {
          bestC = c;
          best = o;
          bestLead = l;
          improved = true;
          io.log(`  it${it} ${k}=${v}: cost ${f2(c, 3)} ${describe(o, l)}`);
        }
      }
    }
    if (!improved) break;
  }
  // prune: drop a changed knob if that costs at most 0.05 more (prefer the smallest set)
  for (const k of Object.keys(best)) {
    const o: Over = { ...best };
    delete o[k];
    const c = cost(evaluate(cfgOf(o, bestLead)), Object.keys(o).length + (bestLead ? 1 : 0), mode);
    if (c <= bestC + 0.05) {
      io.log(`  prune ${k}: cost ${f2(c, 3)}`);
      best = o;
      bestC = c;
    }
  }
  io.log(`  result: ${describe(best, bestLead)} cost ${f2(bestC, 3)}`);
  return { over: best, lead: bestLead };
}
const LEADS = [0, 0.5, 1, 1.5, 2, 3];
function part2(io: Io): void {
  const head = ['set', ...CHECKS.map((c) => `${c.name} ${c.le ? '<=' : '>='} ${f2(c.lim, 3)}`)];
  io.log('\n## Part 2: one knob at a time (X = fails)');
  const rows: (string | number)[][] = [];
  const today = evaluate(cfgOf({}));
  rows.push(['(today)', ...row(today)]);
  for (const k of Object.keys(KNOBS))
    for (const v of KNOBS[k]!) {
      if (v === (B as unknown as Record<string, number>)[k]) continue;
      rows.push([`${k}=${v}`, ...row(evaluate(cfgOf({ [k]: v })))]);
    }
  for (const l of [0.5, 1, 1.5, 2])
    rows.push([`lead=${l} (proto)`, ...row(evaluate(cfgOf({}, l)))]);
  table(io, head, rows);

  tradeOffs(io);
  const noEntry = Object.keys(KNOBS).filter((k) => k !== 'flickDelta' && k !== 'flickWindow');
  io.log('\n## Part 2: greedy coordinate search (cost = relative target misses capped at 3,');
  io.log('## + 10 + 10*miss per failed guard, + 0.03 per changed knob; then prune)');
  io.log('\n### N: numbers, flick knobs fixed, task guards');
  const n = search(io, noEntry, [0]);
  io.log('\n### NE: numbers incl. flick knobs, task guards');
  const ne = search(io, Object.keys(KNOBS), [0]);
  io.log('\n### NH: numbers, flick knobs fixed, task guards + GRIP cannot hold hard');
  const nh = search(io, noEntry, [0], 'hard');
  io.log('\n### NS: numbers, flick knobs fixed, task guards + all R89b windows');
  const ns = search(io, noEntry, [0], 'r89b');
  io.log('\n### P: prototype lead allowed, flick knobs fixed, task guards');
  const pr = search(io, noEntry, LEADS);
  io.log('\n### PH: prototype lead allowed, task guards + GRIP cannot hold hard');
  const ph = search(io, noEntry, LEADS, 'hard');
  io.log('\n### PS: prototype lead allowed, task guards + all R89b windows');
  const ps = search(io, noEntry, LEADS, 'r89b');
  const sets: [string, Over, number][] = [
    ['today', {}, 0],
    ['N', n.over, 0],
    ['NE', ne.over, 0],
    ['NH', nh.over, 0],
    ['NS', ns.over, 0],
    ['P', pr.over, pr.lead],
    ['PH', ph.over, ph.lead],
    ['PS', ps.over, ps.lead],
  ];
  io.log('');
  for (const [k, o, l] of sets) io.log(`${k}: ${describe(o, l)}`);
  report(io, sets);
}
/** Trade-off grids for the two targets that collide with the brief (R89b) or a guard. */
function tradeOffs(io: Io): void {
  io.log('\n## trade-off 1: dodge inside a hard drift vs noisy-finger wobble (others today)');
  const r1: (string | number)[][] = [];
  for (const lead of [0, 1])
    for (const dl of [0.46, 0.6, 0.75, 0.9, 1.1, 1.4])
      for (const vg of [3, 6, 10]) {
        const cfg = cfgOf({ driftLat: dl, velGripDrift: vg }, lead);
        const dh = driftHold(cfg, C.hard);
        const hi = driftDodge(cfg, C.hard, 1, dh);
        const ho = driftDodge(cfg, C.hard, -1, dh);
        const full = enterDrift(cfg, C.hard, 1);
        run(full, 1, true, 6);
        r1.push([
          lead,
          dl,
          vg,
          dh.s,
          meanDx(full, 1, true, 1),
          hi.tLaneFull,
          ho.tLaneFull,
          wobble(cfg, dh),
        ]);
      }
  table(
    io,
    [
      'lead',
      'driftLat',
      'velGripDrift',
      'hold hard',
      'full steer in hw/s (R89b <= 0.2)',
      't lane in',
      't lane out',
      'wobble (<= 0.051)',
    ],
    r1,
  );
  io.log('\n## trade-off 2: GRIP dodge inside medium vs "hard needs a drift" (R89b) and the wall');
  const r2: (string | number)[][] = [];
  for (const [al, g, r] of [
    [15, 22, 60],
    [25, 44, 100],
  ] as const)
    for (const Y of [15.75, 20, 25, 28, 32, 36, 40]) {
      const cfg = cfgOf({ yawRateMax: Y, yawAlign: al, velGrip: g, yawResponse: r });
      const hm = gripHold(cfg, C.medium);
      const mi = dodge(cfg, C.medium, 1, 0.15, false, 'none', hm);
      const st = dodge(cfg, 0, 1, 0.15, false, 'keep', 0);
      const hard = new Sim(cfg, C.hard);
      run(hard, 1, false, 1.5);
      r2.push([
        al,
        g,
        r,
        Y,
        Y / al,
        hm,
        gripHold(cfg, C.hard),
        -hard.dx,
        mi.t1,
        st.t1,
        st.coast,
        wallTime(cfg, false).wall,
      ]);
    }
  table(
    io,
    [
      'yawAlign',
      'velGrip',
      'yawResponse',
      'yawRateMax',
      'full straight',
      'hold medium',
      'hold hard',
      'hard full out hw/s',
      't lane medium in',
      't lane straight',
      'coast straight',
      'wall s',
    ],
    r2,
  );
}
function report(io: Io, sets: [string, Over, number][]): void {
  const ms = sets.map(([, o, l]) => evaluate(cfgOf(o, l)));
  io.log('\n## before / after: targets and guards');
  table(
    io,
    ['check', 'limit', ...sets.map((s) => s[0])],
    CHECKS.map((c, i) => [
      c.name,
      `${c.le ? '<=' : '>='} ${f2(c.lim, 3)}`,
      ...ms.map((m) => {
        const v = CHECKS[i]!.v(m);
        return `${f2(v, 3)} ${pass(c, v) ? 'ok' : 'FAIL'}`;
      }),
    ]),
  );
  io.log(
    '\n## touch dodges ramp 40/80 (S straight, Mi/Mo medium in/out): one-lane s, D drift / G grip',
  );
  for (let i = 0; i < sets.length; i++) io.log(`  ${sets[i]![0]}: ${ms[i]!.dDodgeAll}`);
  io.log(
    '\n## info: R89b calibration windows and entry (guards only in NS / PS; hard hold in NH / PH)',
  );
  const cal: [string, string, (m: Metrics) => number][] = [
    ['GRIP full steer straight hw/s', '1.0-1.1', (m) => m.calib.vFull],
    ['GRIP pulse 0.5 x 0.4 s, hw', '0.15-0.3', (m) => m.calib.pulse],
    ['GRIP hold easy', '0.4-0.5', (m) => m.calib.holdEasy],
    ['GRIP hold medium', '0.9-1.0', (m) => m.calib.holdMed],
    ['GRIP hard full steer, out hw/s', '0.4-0.7', (m) => m.calib.hardFullOut],
    ['GRIP medium steer 0, out hw/s', '0.9-1.1', (m) => m.calib.medZeroOut],
    ['DRIFT hold hard (free speed)', '0.70-0.85', (m) => m.calib.dHoldHard],
    ['DRIFT hold medium', '0.45-0.55', (m) => m.calib.dHoldMed],
    ['DRIFT hard speed', '>= 0.85', (m) => m.calib.dSpeedHard],
    ['GRIP steer->yaw 10-90% s', '0.10-0.15', (m) => m.calib.steerYaw],
    ['GRIP yaw->vel 10-90% s', '0.08-0.12', (m) => m.calib.yawVel],
    ['GRIP over beyond lane (return at lane)', '-', (m) => m.overLane],
    ['GRIP hold hard (9 = cannot hold)', '> 1', (m) => m.calib.holdHard],
    ['touch straight 80 ms keep: over', '-', (m) => m.touchKeep.over],
    ['touch straight 80 ms keep: coast', '-', (m) => m.touchKeep.coast],
    ['touch straight 80 ms keep: settle s', '-', (m) => m.touchKeep.settle],
    ['touch straight 80 ms lift: over', '-', (m) => m.touchRel.over],
    ['touch straight 80 ms lift: settle s', '-', (m) => m.touchRel.settle],
    ['T5 entry vs no kick 0.6 s, hw', '<= 0.05', (m) => m.throwX],
    ['lead: extra entry shift straight 0.6 s', '-', (m) => m.lead.straight],
    ['lead: extra entry shift hard 2 s', '(T9 <= 0.15)', (m) => m.lead.hard],
    ['flick 0->1 in 40 ms enters DRIFT', '1', (m) => (m.enters40 ? 1 : 0)],
    ['slalom lanes/s touch 80 ms', '-', (m) => m.slT],
    ['slalom lanes/s keyboard', '-', (m) => m.slG],
  ];
  table(
    io,
    ['quantity', 'R89b', ...sets.map((s) => s[0])],
    cal.map(([n, w, f]) => [n, w, ...ms.map((m) => f2(f(m), 3))]),
  );
}

export function main(io: Io): number {
  const part = argValue(io.argv, 'part') ?? 'all';
  const set = argValue(io.argv, 'set');
  const over: Over = {};
  if (set)
    for (const kv of set.split(',')) {
      const [k, v] = kv.split('=');
      if (k && v) over[k] = Number(v);
    }
  const lead = Number(argValue(io.argv, 'lead') ?? 0);
  const cfg = cfgOf(over, lead);
  if (part === '1' || part === 'all') {
    io.log(`# Part 1 (model B ${describe(over, lead)})`);
    part1(io, cfg);
    const dh = driftHold(cfg, C.hard);
    io.log(`\nguards today: wobble ${f2(wobble(cfg, dh))}, run-out ${f2(runOut(cfg, dh))}`);
  }
  if (part === '2' || part === 'all') part2(io);
  if (part === 'check') {
    // --sets "k=v,k=v;k=v,lead=1.5;..." : several candidate sets side by side (lead = prototype)
    const sets: [string, Over, number][] = [['today', {}, 0]];
    const many = argValue(io.argv, 'sets');
    if (many)
      for (const one of many.split(';')) {
        const o: Over = {};
        let l = 0;
        for (const kv of one.split(',')) {
          const [k, v] = kv.split('=');
          if (k === 'lead') l = Number(v);
          else if (k && v) o[k] = Number(v);
        }
        sets.push([`S${sets.length}`, o, l]);
      }
    else sets.push(['S1', over, lead]);
    for (const [k, o, l] of sets) io.log(`${k}: ${describe(o, l)}`);
    report(io, sets);
  }
  return 0;
}

// THROWAWAY SPIKE (docs/research/agility-r89c.md): GRIP numbers of driving model B for R89c
// (one-lane change at vmax <= 0.30 s, overshoot <= 0.025, lateral stop <= 0.15 s) against every
// R89b bound that runs GRIP ticks, the R84 criterion, R86b (bots on drift-run) and novice checks.
// Everything runs through the REAL src/sim `step`; parameters are overridden in memory only.
// The only non-rule piece is the optional prototype `gripLead` L (a rule change, director's call):
// after the real step, in GRIP, x += L*(vStar - vel)*sp*latScale*DT, where vStar is the GRIP
// steady-state vel for the current steer and curve (so every steady state of R89b is unchanged).
// Run: node tools/run-ts.mjs tools/spike/agility-r89c.ts [--part cands|search|laps|all] [--seeds N]
import { botInput, createBot, type BotParams } from '../../src/bot/driver';
import { botParams } from '../../src/data/bots';
import { baseCar } from '../../src/data/cars';
import road from '../../src/data/road.json';
import sprites from '../../src/data/sprites.json';
import curves from '../../src/data/tracks/curves.json';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { loadTracks, type LoadedTrack } from '../botlib';
import { argValue, type Io } from '../io';

const C = curves as { easy: number; medium: number; hard: number; sharp: number };
const LANE = 2 / (road as { lanes: number }).lanes;
const SLIP_DEG = (sprites as { weight: { slipDeg: number } }).weight.slipDeg;
const NO_H = { gripScrub: 0, driftTurbo: 0 };
const ENTRY_A = { driftEntry: 0 };
const A_CAR: CarParams = { ...baseCar, model: 0, crashMinSpeed: 1e9, ...NO_H }; // = tests baseCarA
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const f3 = (v: number, d = 3): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));

interface Cand {
  name: string;
  p: Partial<CarParams>;
  L: number; // prototype gripLead, 0 = today's rules
}

// ---------------------------------------------------------------- sim wrapper with the prototype
const trackCache = new Map<number, Track>();
function constTrack(curve: number): Track {
  let t = trackCache.get(curve);
  if (!t) {
    const segments = [];
    for (let i = 0; i < 4000; i++) segments.push({ curve });
    t = { segments };
    trackCache.set(curve, t);
  }
  return t;
}

/** GRIP steady-state vel for steer s and road turn A (R83/R84 with yaw' = vel' = 0, slip clamped). */
function vStar(p: CarParams, steer: number, sp: number, A: number, off: boolean): number {
  let f = sp / p.yawFullSpeed;
  if (f > 1) f = 1;
  const g = off ? p.velGrip * p.offroadVelMul : p.velGrip;
  const smax = off ? p.slipGripMax * p.offroadVelMul : p.slipGripMax;
  return (steer * p.yawRateMax * f - A) / p.yawAlign - clamp(A / g, -smax, smax);
}

/** One real step of car 0, then the prototype lead (L > 0, GRIP, not crashing). */
function stepL(race: RaceState, frame: InputFrame, track: Track, p: CarParams, L: number): void {
  const c = race.cars[0]!;
  const crash = c.crashTicks > 0;
  const sp = c.speed / p.vmax;
  const n = track.segments.length;
  let seg = Math.floor(c.z) % n;
  if (seg < 0) seg += n;
  const A = track.segments[seg]!.curve * sp * p.kYaw;
  const off = c.x > 1 || c.x < -1;
  const steer = clamp(frame.steer, -1, 1);
  step(race, [frame], track, [p]);
  if (L === 0 || crash || p.model !== 1 || c.state !== 'GRIP' || c.crashTicks > 0) return;
  const lead = L * (vStar(p, steer, sp, A, off) - c.vel) * sp * p.latScale;
  c.x += lead * DT;
  if (c.x > p.xLimit) {
    c.x = p.xLimit;
    if (c.vel > 0) c.vel = 0;
  } else if (c.x < -p.xLimit) {
    c.x = -p.xLimit;
    if (c.vel < 0) c.vel = 0;
  }
  c.vx += lead;
}

class Rig {
  race: RaceState = createRace(1, 1);
  car: Car = this.race.cars[0]!;
  frame: InputFrame = { steer: 0, brake: false, drift: false };
  lastDx = 0;
  constructor(
    public p: CarParams,
    public L: number,
    public curve: number,
    speed: number,
  ) {
    this.car.speed = speed;
  }
  step(steer: number, drift: boolean, pin?: number): void {
    if (pin !== undefined) this.car.speed = pin;
    this.frame.steer = steer;
    this.frame.drift = drift;
    const x0 = this.car.x;
    stepL(this.race, this.frame, constTrack(this.curve), this.p, this.L);
    this.lastDx = (this.car.x - x0) / DT;
    if (pin !== undefined) this.car.speed = pin;
  }
  get slip(): number {
    return this.p.model === 0 ? this.car.angle : this.car.yaw - this.car.vel + this.car.carry;
  }
  enterDrift(dir: 1 | -1, s: number): void {
    const c = this.car;
    c.state = 'DRIFT';
    c.dir = dir;
    c.driftHeld = true;
    if (this.p.model === 0) {
      c.angle = clamp(s * dir, 0, 1) * dir;
      c.steer = s;
      return;
    }
    const A = this.curve * (c.speed / this.p.vmax) * this.p.kYaw;
    const u = s * dir;
    const slip = dir * this.p.slipFull * clamp(u, 0, 1);
    c.vel =
      dir * this.p.driftLat * ((slip * dir) / this.p.slipFull + Math.min(0, u)) -
      this.p.driftPush * A;
    c.yaw = c.vel + slip;
    c.yawRate = 0;
  }
}
const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  offroadSteerMul: 1,
  offroadGrip: p.grip,
  crashMinSpeed: 1e9,
});

// ---------------------------------------------------------------- R89c (tests/sim/modelb_agility_r89c.test.ts)
function r89c(p0: Partial<CarParams>, L: number) {
  const P: CarParams = { ...baseCar, ...p0, model: 1, crashMinSpeed: 1e9 };
  const r = new Rig(P, L, 0, P.vmax);
  let tLane = NaN;
  for (let i = 1; i <= 240 && Number.isNaN(tLane); i++) {
    r.step(1, false, P.vmax);
    if (r.car.x >= LANE) tLane = i * DT;
  }
  let maxX = -Infinity;
  let last = -1;
  for (let i = 0; i < 1.5 / DT; i++) {
    r.step(0, false, P.vmax);
    maxX = Math.max(maxX, r.car.x);
    if (Math.abs(r.lastDx) > 0.02) last = i;
  }
  return { tLane, over: maxX - LANE, tStop: (last + 1) * DT, grip: r.car.state === 'GRIP' };
}

// ---------------------------------------------------------------- R89b bounds (tests/sim/modelb_calibration.test.ts)
interface Bound {
  name: string;
  v: number;
  lo: number;
  hi: number;
}
const ok = (b: Bound): boolean => b.v >= b.lo && b.v <= b.hi;

function driftLat(
  p: CarParams,
  L: number,
  curve: number,
  s: number,
  pin: number | null,
  secs: number,
) {
  const r = new Rig(p, L, curve, 1);
  r.enterDrift(1, s);
  let sum = 0;
  let sl = 0;
  let n = 0;
  const N = Math.round(secs / DT);
  for (let i = 0; i < N; i++) {
    r.step(s, true, pin ?? undefined);
    if (i * DT >= secs - 1) {
      sum += r.lastDx;
      sl += r.slip;
      n++;
    }
  }
  return { vx: sum / n, slip: sl / n, speed: r.car.speed };
}
function driftHold(p: CarParams, L: number, curve: number, pin: number | null, secs: number) {
  let lo = -1;
  let hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (driftLat(p, L, curve, mid, pin, secs).vx > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
function gripHold(p: CarParams, L: number, curve: number): number {
  let lo = -1;
  let hi = 1;
  for (let i = 0; i < 26; i++) {
    const st = (lo + hi) / 2;
    const r = new Rig(p, L, curve, 1);
    const A = curve * p.kYaw;
    r.car.yawRate = A;
    r.car.yaw = A / p.velGrip;
    let sum = 0;
    let n = 0;
    for (let k = 0; k < 360; k++) {
      r.step(st, false, 1);
      if (k >= 240) {
        sum += r.car.vel; // the test bisects on vel (the prototype lead never changes vel)
        n++;
      }
    }
    if (sum / n > 0) hi = st;
    else lo = st;
  }
  return (lo + hi) / 2;
}
function gripOut(p: CarParams, L: number, curve: number, steer: number): number[] {
  const r = new Rig(p, L, curve, 1);
  const out: number[] = [];
  for (let i = 1; i <= 360; i++) {
    r.step(steer, false, 1);
    if (i === 60 || i === 120 || i === 240 || i === 360) out.push(r.lastDx);
  }
  return out;
}
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
const approach = (cur: number, target: number, rampS: number): number => {
  const d = DT / rampS;
  return cur < target ? Math.min(target, cur + d) : Math.max(target, cur - d);
};

function calib(p0: Partial<CarParams>, L: number): Bound[] {
  const REAL: CarParams = { ...baseCar, ...p0, model: 1, ...NO_H, ...ENTRY_A };
  const FB = free(REAL);
  const FA = free(A_CAR);
  const out: Bound[] = [];
  const add = (name: string, v: number, lo: number, hi: number): void => {
    out.push({ name, v, lo, hi });
  };
  // GRIP straight
  {
    const r = new Rig(FB, L, 0, 1);
    for (let i = 0; i < 240; i++) r.step(1, false, 1);
    add('full steer straight, hw/s', r.lastDx, 1.0, 1.1);
  }
  {
    const r = new Rig({ ...REAL, crashMinSpeed: 1e9 }, L, 0, 1);
    const xs: number[] = [];
    const yaws: number[] = [];
    const vxs: number[] = [];
    for (let i = 0; i < 1.6 / DT; i++) {
      r.step(i * DT < 0.4 ? 0.5 : 0, false);
      xs.push(r.car.x);
      yaws.push(r.car.yaw);
      vxs.push(r.car.vx);
    }
    const x = r.car.x;
    add('pulse 0.5x0.4 s shift', x, 0.15, 0.3);
    const rel = Math.round(0.4 / DT);
    const peakYaw = Math.max(...yaws.map(Math.abs));
    const peakVx = Math.max(...vxs.map(Math.abs));
    let settle = NaN;
    let sc = 0;
    let last = 0;
    for (let i = rel; i < xs.length; i++) {
      if (
        Number.isNaN(settle) &&
        Math.abs(yaws[i]!) < 0.02 * peakYaw &&
        Math.abs(vxs[i]!) < 0.02 * peakVx
      )
        settle = (i - rel) * DT;
      const sg = Math.sign(vxs[i]!);
      if (sg !== 0 && last !== 0 && sg !== last && Math.abs(vxs[i]!) > 0.02 * peakVx) sc++;
      if (sg !== 0) last = sg;
    }
    add('pulse settle s', settle, 0, 0.6);
    add('pulse vx sign changes', sc, 0, 0);
    add('pulse overshoot rel', (Math.max(...xs) - x) / x, -1, 0.0999);
  }
  {
    const r = new Rig({ ...REAL, crashMinSpeed: 1e9 }, L, 0, 1);
    const ys: number[] = [];
    for (let i = 0; i < 1.5 / DT; i++) {
      r.step(0.5, false);
      ys.push(r.car.yaw);
    }
    add('rise steer->yaw s', rise(ys), 0.1, 0.15);
  }
  {
    const r = new Rig({ ...REAL, crashMinSpeed: 1e9 }, L, 0, 1);
    const vs: number[] = [];
    for (let i = 0; i < 1.5 / DT; i++) {
      r.car.yaw = 0.5;
      r.car.yawRate = 0;
      r.step(0, false);
      r.car.yaw = 0.5;
      vs.push(r.car.vel);
    }
    add('rise yaw->vel s', rise(vs), 0.08, 0.12);
  }
  // GRIP curves
  const hE = gripHold(FB, L, C.easy);
  const hM = gripHold(FB, L, C.medium);
  add('hold easy', hE, 0.4, 0.5);
  add('hold medium', hM, 0.9, 1.0);
  {
    const r = new Rig(FB, L, C.hard, 1);
    for (let i = 0; i < 180; i++) r.step(1, false);
    add('hard full: vel after 1.5 s (< -0.05)', r.car.vel, -1e9, -0.05);
    add('hard full: x after 1.5 s (< -0.5)', r.car.x, -1e9, -0.5);
  }
  const hardFull = gripOut(FB, L, C.hard, 1);
  const hardZero = gripOut(FB, L, C.hard, 0);
  const mediumZero = gripOut(FB, L, C.medium, 0);
  add('hard full outward @3 s', -hardFull[3]!, 0.4, 0.7);
  add(
    'hard full |@0.5-@3| / |@3|',
    Math.abs(hardFull[0]! - hardFull[3]!) / Math.abs(hardFull[3]!),
    0,
    0.1,
  );
  add('hard full |@2-@3|', Math.abs(hardFull[2]! - hardFull[3]!), 0, 0.01);
  add('hard zero outward @3 s', -hardZero[3]!, 1.3, 1.8);
  add('hard zero |@2-@3|', Math.abs(hardZero[2]! - hardZero[3]!), 0, 0.01);
  add('medium zero outward @3 s', -mediumZero[3]!, 0.9, 1.1);
  add('vs A hard full', Math.abs(gripOut(FA, 0, C.hard, 1)[3]! - hardFull[3]!), 0, 0.0999);
  add('vs A hard zero', Math.abs(gripOut(FA, 0, C.hard, 0)[3]! - hardZero[3]!), 0, 0.0999);
  add('vs A medium zero', Math.abs(gripOut(FA, 0, C.medium, 0)[3]! - mediumZero[3]!), 0, 0.0999);
  // DRIFT holds (DRIFT branch: GRIP numbers not read) — needed as inputs for entry/exit
  const hMf = driftHold(FB, L, C.medium, null, 8);
  const hHf = driftHold(FB, L, C.hard, null, 8);
  const hMp = driftHold(FB, L, C.medium, 1, 3);
  const hHp = driftHold(FB, L, C.hard, 1, 3);
  {
    const d = driftLat(FB, L, C.hard, hHf, null, 8);
    add('DRIFT hard hold steer (control)', hHf, 0.7, 0.85);
    add('DRIFT hard angle deg (control)', d.slip * SLIP_DEG, 30, 40);
  }
  // DRIFT entry (0.13 s of GRIP before the flick)
  const enter = (p: CarParams, curve: number, from: number, hs: number) => {
    const r = new Rig(p, L, 0, 1);
    for (let i = 0; i < Math.round(0.13 / DT); i++) r.step(from, true);
    r.curve = curve;
    const xs: number[] = [];
    const vis: number[] = [];
    for (let i = 0; i < 300; i++) {
      r.step(i * DT < 0.06 ? 1 : hs, true);
      xs.push(r.car.x);
      vis.push(r.slip);
    }
    return { xs, vis, drifted: r.car.state === 'DRIFT' };
  };
  let eJump = 0;
  let eT90lo = Infinity;
  let eT90hi = 0;
  let eOver = 0;
  let eNot = 0;
  for (const [curve, hs] of [
    [0, 0.5],
    [C.medium, hMf],
    [C.hard, hHf],
  ] as const) {
    for (const from of [0.45, 0, -1]) {
      const a = enter(FB, curve, from, hs);
      const ref = enter({ ...FB, kickBase: 0, kickGain: 0 }, curve, from, hs);
      if (!a.drifted) eNot++;
      for (let i = 0; i < Math.round(0.6 / DT); i++)
        eJump = Math.max(eJump, Math.abs(a.xs[i]! - ref.xs[i]!));
      const tail = a.vis.slice(180);
      const steady = tail.reduce((u, v) => u + v, 0) / tail.length;
      let t90 = NaN;
      for (let i = 0; i < a.vis.length; i++)
        if (Number.isNaN(t90) && a.vis[i]! >= 0.9 * steady) t90 = (i + 1) * DT;
      eT90lo = Math.min(eT90lo, t90);
      eT90hi = Math.max(eT90hi, t90);
      eOver = Math.max(eOver, Math.max(...a.vis) / steady - 1);
    }
  }
  add('entry: cases not drifting', eNot, 0, 0);
  add('entry: max jump vs no kick', eJump, 0, 0.05);
  add('entry: min t90', eT90lo, 0.15, 0.45);
  add('entry: max t90', eT90hi, 0.15, 0.45);
  add('entry: max angle overshoot', eOver, 0, 0.15);
  // DRIFT exit
  let xJump = 0;
  for (const [curve, hs] of [
    [0, 0.5],
    [C.medium, hMp],
    [C.hard, hHp],
  ] as const) {
    for (const after of [0, hs]) {
      const r = new Rig(FB, L, curve, 1);
      r.enterDrift(1, hs);
      for (let i = 0; i < 240; i++) r.step(hs, true);
      const ref = new Rig(FB, L, curve, r.car.speed);
      const A = curve * (r.car.speed / FB.vmax) * FB.kYaw;
      ref.car.x = r.car.x;
      ref.car.vel = r.car.vel;
      ref.car.yaw = r.car.vel + clamp(A / FB.velGrip, -FB.slipGripMax, FB.slipGripMax);
      ref.car.yawRate = A;
      for (let i = 0; i < Math.round(0.3 / DT); i++) {
        r.step(after, false);
        ref.step(after, false);
        xJump = Math.max(xJump, Math.abs(r.car.x - ref.car.x));
      }
    }
  }
  add('exit: max jump vs GRIP ref (6 cases)', xJump, 0, 0.1);
  {
    const r = new Rig(FB, L, C.hard, 1);
    r.enterDrift(1, hHf);
    for (let i = 0; i < 480; i++) r.step(hHf, true);
    const x0 = r.car.x;
    for (let i = 0; i < 120; i++) r.step(1, false);
    add('exit mid-hard full steer: carried out in 1 s', -(r.car.x - x0), -1e9, 0.9);
  }
  // agility block (R89b)
  {
    const r = new Rig(FB, L, 0, 1);
    let st = 0;
    let t1 = NaN;
    for (let i = 1; i <= 360 && Number.isNaN(t1); i++) {
      st = approach(st, 1, 0.25);
      r.step(st, false, 1);
      if (r.car.x >= LANE) t1 = i * DT;
    }
    add('ramp 250 ms: one lane s', t1, 0, 0.46);
  }
  const sharp = (rampBack: boolean) => {
    const r = new Rig(FB, L, 0, 1);
    for (let i = 0; i < 36; i++) r.step(0, true);
    let st = 0;
    let t1 = NaN;
    let drifted = false;
    let xStop = NaN;
    let maxAfter = -Infinity;
    for (let i = 1; i <= 480; i++) {
      const back = !Number.isNaN(t1) && rampBack;
      st = approach(st, back ? 0 : 1, 0.08);
      r.step(st, true);
      if (r.car.state === 'DRIFT') drifted = true;
      if (Number.isNaN(t1) && r.car.x >= LANE) t1 = i * DT;
      if (back) {
        if (Number.isNaN(xStop) && st === 0) xStop = r.car.x;
        if (!Number.isNaN(xStop)) maxAfter = Math.max(maxAfter, r.car.x);
      }
      if (!rampBack && !Number.isNaN(t1)) break;
    }
    return { t1, drifted, coast: maxAfter - xStop };
  };
  const s1 = sharp(false);
  const s2 = sharp(true);
  add('sharp 80 ms held: drifted (1)', s1.drifted && s2.drifted ? 1 : 0, 1, 1);
  add('sharp 80 ms held: one lane s', s1.t1, 0, 0.45);
  add('sharp back to 0: coast', s2.coast, -1e9, 0.06);
  // R84 criterion (tGrip = GRIP steer 0 leaves the road)
  {
    const REV: CarParams = { ...FB, driftCounter: 0, wrongPush: 0.13 };
    const leave = (r: Rig, steer: number, drift: boolean): number => {
      for (let i = 1; i <= 20 / DT; i++) {
        r.step(steer, drift, 1);
        if (Math.abs(r.car.x) > 1) return i * DT;
      }
      return Infinity;
    };
    const into = (dir: 1 | -1, mag: number): Rig => {
      const r = new Rig(REV, L, 0, 1);
      r.enterDrift(dir, dir * 0.5);
      for (let i = 0; i < 240; i++) r.step(dir * 0.5, true, 1);
      r.car.x = 0;
      r.curve = -dir * mag;
      return r;
    };
    let worst = 0;
    for (const dir of [-1, 1] as const)
      for (const mag of [C.medium, C.hard]) {
        const tD = leave(into(dir, mag), -dir, true);
        const tG = leave(new Rig(REV, L, -dir * mag, 1), 0, false);
        worst = Math.max(worst, tD / (tG * 1.1));
      }
    add('R84: max tDrift/(1.1 tGrip)', worst, 0, 1);
  }
  return out;
}

// ---------------------------------------------------------------- novice checks
function novice(p0: Partial<CarParams>, L: number) {
  const P: CarParams = { ...baseCar, ...p0, model: 1, ...NO_H, crashMinSpeed: 1e9, xLimit: 1e9 };
  const steadyLat = (s: number): { ss: number; first: number } => {
    const r = new Rig(P, L, 0, 1);
    r.step(s, false, 1);
    const first = r.lastDx;
    for (let i = 0; i < 240; i++) r.step(s, false, 1);
    return { ss: r.lastDx, first };
  };
  const a = steadyLat(0.3);
  const b = steadyLat(1);
  // straight, steer noise +-0.05: (i) new value every 0.05 s, (ii) every tick; 10 s; 3 seeds
  const wander = (every: number) => {
    let maxX = 0;
    let rms = 0;
    let n = 0;
    for (const seed of [1, 2, 3]) {
      let rng = seed * 7919;
      const rnd = (): number => {
        rng = (Math.imul(rng, 1103515245) + 12345) | 0;
        return ((rng >>> 8) & 0xffff) / 0xffff;
      };
      const r = new Rig(P, L, 0, 1);
      let noise = 0;
      for (let i = 0; i < 1200; i++) {
        if (i % every === 0) noise = (rnd() * 2 - 1) * 0.05;
        r.step(noise, false, 1);
        maxX = Math.max(maxX, Math.abs(r.car.x));
        rms += r.lastDx * r.lastDx;
        n++;
      }
    }
    return { maxX, rmsVx: Math.sqrt(rms / n) };
  };
  // corner entry at steer 0: outward dx/dt 1 tick and 0.1 s after the straight turns into hard
  const entry = (): { t1: number; t10: number } => {
    const r = new Rig(P, L, C.hard, 1);
    r.step(0, false, 1);
    const t1 = -r.lastDx;
    for (let i = 1; i < 12; i++) r.step(0, false, 1);
    return { t1, t10: -r.lastDx };
  };
  return { s03: a, s10: b, w20: wander(6), w120: wander(1), entry: entry() };
}

// ---------------------------------------------------------------- R86b laps (bots on drift-run)
interface LapOut {
  lap: number;
  finished: boolean;
  crashes: number;
  offFrac: number;
  driftShare: number;
}
function runLaps(
  track: Track,
  bp: BotParams,
  p: CarParams,
  L: number,
  seed: number,
  laps: number,
): LapOut {
  const n = track.segments.length;
  const race = createRace(seed, 1, 0);
  const car = race.cars[0]!;
  const bot = createBot(seed);
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const goal = laps * n;
  const maxTicks = Math.ceil((laps * 180) / DT);
  const lapTimes: number[] = [];
  let lapStart = 0;
  let crashes = 0;
  let wasCrash = false;
  let off = 0;
  let drift = 0;
  while (car.z < goal && race.tick < maxTicks) {
    botInput(bot, bp, car, track, p, frame);
    stepL(race, frame, track, p, L);
    if (Math.abs(car.x) > 1) off++;
    if (car.state === 'DRIFT') drift++;
    const cr = car.crashTicks > 0;
    if (cr && !wasCrash) crashes++;
    wasCrash = cr;
    if (Math.floor(car.z / n) > lapTimes.length) {
      lapTimes.push((race.tick - lapStart) * DT);
      lapStart = race.tick;
    }
  }
  const fl = lapTimes.slice(1);
  return {
    lap: fl.reduce((s, x) => s + x, 0) / (fl.length || 1),
    finished: car.z >= goal && lapTimes.length === laps,
    crashes,
    offFrac: off / race.tick,
    driftShare: drift / race.tick,
  };
}
const GMARG = [0.8, 1.0, 1.2, 1.45, 1.8, 2.4, 3.5];
function laps86b(tr: LoadedTrack, p0: Partial<CarParams>, L: number, seeds: number) {
  const p: CarParams = { ...baseCar, ...p0 };
  const E = botParams.expert;
  const sd = Array.from({ length: seeds }, (_, i) => i + 1);
  const d = sd.map((s) => runLaps(tr.track, E, p, L, s, 3));
  const lapD = d.every((r) => r.finished) ? d.reduce((s, r) => s + r.lap, 0) / seeds : NaN;
  let lapG = NaN;
  let mG = NaN;
  for (const m of GMARG) {
    const rs = sd.map((s) =>
      runLaps(tr.track, { ...E, drift: 'never', bGripMargin: m }, p, L, s, 3),
    );
    if (!rs.every((r) => r.finished)) continue;
    const crash = rs.reduce((s, r) => s + r.crashes, 0);
    const offF = rs.reduce((s, r) => s + r.offFrac, 0) / seeds;
    const lap = rs.reduce((s, r) => s + r.lap, 0) / seeds;
    if (crash === 0 && offF <= 0.01 && (Number.isNaN(lapG) || lap < lapG)) {
      lapG = lap;
      mG = m;
    }
  }
  return {
    lapD,
    lapG,
    mG,
    gap: lapG / lapD - 1,
    driftShare: d.reduce((s, r) => s + r.driftShare, 0) / seeds,
  };
}

// ---------------------------------------------------------------- candidates
const CANDS: Cand[] = [
  { name: 'C0 today', p: {}, L: 0 },
  // numbers only, fastest that still keeps V = 1.05: R89c met, R89b broken (see note)
  {
    name: 'C1 numbers: Y94.5 al90 vg90 yr360',
    p: { yawRateMax: 94.5, yawAlign: 90, velGrip: 90, yawResponse: 360 },
    L: 0,
  },
  // numbers only, best found inside the R89b ranges (search part)
  {
    name: 'C2 numbers in R89b: Y15.6 al14.4 vg27 yr60',
    p: { yawRateMax: 15.6, yawAlign: 14.4, velGrip: 27, yawResponse: 60 },
    L: 0,
  },
  // prototype gripLead on today's numbers
  { name: 'C3 gripLead 0.8', p: {}, L: 0.8 },
  { name: 'C4 gripLead 0.85', p: {}, L: 0.85 },
  { name: 'C5 gripLead 0.9', p: {}, L: 0.9 },
];

function parseCand(s: string): Cand {
  // "L=0.85;yawAlign=15,velGrip=22"
  const [lp, pp] = s.split(';');
  const p: Record<string, number> = {};
  for (const kv of (pp ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    p[k!] = Number(v);
  }
  return { name: s, p: p as Partial<CarParams>, L: Number(lp!.split('=')[1]) };
}

function partCands(io: Io, cands: Cand[]): void {
  io.log('## R89c + R89b + novice per candidate');
  {
    // model A reference: corner entry at steer 0, outward dx/dt after 1 tick and 0.1 s (hard)
    const r = new Rig({ ...A_CAR, xLimit: 1e9 }, 0, C.hard, 1);
    r.step(0, false, 1);
    const t1 = -r.lastDx;
    for (let i = 1; i < 12; i++) r.step(0, false, 1);
    io.log(`model A: hard entry steer 0 outward dx/dt 1 tick ${f3(t1)}, 0.1 s ${f3(-r.lastDx)}`);
  }
  for (const c of cands) {
    const m = r89c(c.p, c.L);
    const b = calib(c.p, c.L);
    const nv = novice(c.p, c.L);
    const fails = b.filter((x) => !ok(x));
    io.log(`### ${c.name}  (L=${c.L}, ${JSON.stringify(c.p)})`);
    io.log(
      `R89c: tLane ${f3(m.tLane)} s (<=0.30), overshoot ${f3(m.over)} (<=0.025), tStop ${f3(m.tStop)} s (<=0.15), GRIP ${m.grip}`,
    );
    io.log(
      `novice: steer 0.3 -> ${f3(nv.s03.ss)} hw/s (first tick ${f3(nv.s03.first)}); steer 1 -> ${f3(nv.s10.ss)} (first tick ${f3(nv.s10.first)}); noise +-0.05 @20Hz max|x| ${f3(nv.w20.maxX)} rms dx/dt ${f3(nv.w20.rmsVx)}; @120Hz max|x| ${f3(nv.w120.maxX)} rms ${f3(nv.w120.rmsVx)}; hard entry steer 0 outward dx/dt 1 tick ${f3(nv.entry.t1)}, 0.1 s ${f3(nv.entry.t10)}`,
    );
    io.log(`R89b bounds: ${b.length - fails.length}/${b.length} pass`);
    for (const x of b)
      io.log(`  ${ok(x) ? 'ok  ' : 'FAIL'} ${x.name}: ${f3(x.v)} [${x.lo}, ${x.hi}]`);
    io.log('');
  }
}

function partLaps(io: Io, cands: Cand[], seeds: number): void {
  const tr = loadTracks(io).find((t) => t.name === 'drift-run')!;
  io.log(
    `## R86b on drift-run: expert, ${seeds} seeds x 3 laps (flying 2-3), clean grip = 0 crashes, <= 1% off`,
  );
  const base = laps86b(tr, {}, 0, seeds);
  io.log(
    '| candidate | drift lap s | drift lap change vs C0 | DRIFT share | clean grip lap s (margin) | gap (8-14%) |',
  );
  io.log('| --- | --- | --- | --- | --- | --- |');
  for (const c of cands) {
    const e = c.name === 'C0 today' ? base : laps86b(tr, c.p, c.L, seeds);
    io.log(
      `| ${c.name} | ${f3(e.lapD, 2)} | ${f3(100 * (e.lapD / base.lapD - 1), 2)}% | ${f3(100 * e.driftShare, 0)}% | ${f3(e.lapG, 2)} (m ${e.mG}) | ${f3(100 * e.gap, 1)}% |`,
    );
  }
  io.log('');
}

/** Numbers-only grid: V = Y/al fixed 1.05; best R89c score with and without all GRIP R89b bounds. */
function partSearch(io: Io): void {
  io.log('## numbers-only grid (L = 0): Y = 1.05*al');
  const rows: { s: string; score: number; inB: boolean }[] = [];
  for (const al of [10, 12, 14.4, 15, 18, 22, 30, 45, 60, 90])
    for (const vg of [16, 18.3, 22, 27, 30, 45, 60, 90])
      for (const yr of [30, 60, 120, 240, 360]) {
        const p = { yawAlign: al, yawRateMax: 1.05 * al, velGrip: vg, yawResponse: yr };
        const m = r89c(p, 0);
        const score = Math.max(m.tLane / 0.3, m.over / 0.025, m.tStop / 0.15);
        // cheap R89b screen: gripA keeps medium hold in [0.9, 1] -> gripA in [9, 10]
        const gA = p.yawRateMax / (1 + al / vg);
        const inA = gA >= 9 && gA <= 10;
        rows.push({
          s: `al ${al} Y ${f3(1.05 * al, 2)} vg ${vg} yr ${yr} gripA ${f3(gA, 2)}: tLane ${f3(m.tLane)} over ${f3(m.over)} tStop ${f3(m.tStop)} score ${f3(score)}`,
          score,
          inB: inA,
        });
      }
  rows.sort((a, b) => a.score - b.score);
  io.log('best 5 overall:');
  for (const r of rows.slice(0, 5)) io.log('  ' + r.s);
  io.log('best 5 with gripA in [9, 10] (medium held at 0.9-1.0):');
  for (const r of rows.filter((r) => r.inB).slice(0, 5)) io.log('  ' + r.s);
  io.log('');
}

export function main(io: Io): number {
  const part = argValue(io.argv, 'part') ?? 'all';
  const seeds = Number(argValue(io.argv, 'seeds') ?? '3');
  const extra = argValue(io.argv, 'cand');
  const cands = extra ? [CANDS[0]!, parseCand(extra)] : CANDS;
  if (part === 'all' || part === 'cands') partCands(io, cands);
  if (part === 'all' || part === 'search') partSearch(io);
  if (part === 'all' || part === 'laps') partLaps(io, cands, seeds);
  return 0;
}

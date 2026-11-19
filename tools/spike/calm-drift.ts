// THROWAWAY SPIKE (docs/research/calm-drift-spike.md): model B with a calm, one-sided DRIFT
// ("model C" below). Own step function; does not touch src/sim. Model A and current model B run
// through the real src/sim step for the side-by-side columns.
// Run: node tools/run-ts.mjs tools/spike/calm-drift.ts [--only D,T1,T5,...] [--dt 120] [--set k=v,...]
import { runBot as runRealBot, type MeasureConfig } from '../../src/bot/run';
import { baseCar } from '../../src/data/cars';
import { botParams } from '../../src/data/bots';
import { loadTestTwisty } from '../../src/data/tracks';
import curves from '../../src/data/tracks/curves.json';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step as realStep } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { argValue, type Io } from '../io';

// ---------------------------------------------------------------- model C parameters
export interface P {
  vmax: number;
  accel: number;
  brake: number;
  driftBrake: number;
  kYaw: number;
  latScale: number;
  yawFullSpeed: number;
  // GRIP (current model B body and motion; only Y/al/r retuned for T8)
  yawRateMax: number;
  yawAlign: number;
  yawResponse: number;
  velGrip: number;
  slipGripMax: number;
  slipGripLimit: number;
  // DRIFT (new)
  slipFull: number; // visible slip at full steer into dir
  slipResponse: number; // wn of the critically damped slip, 1/s
  driftLat: number; // lateral authority in DRIFT, vel units per unit of steer
  driftPush: number; // share of the road turn A that pushes vel outward in DRIFT
  velGripDrift: number; // vel chase rate in DRIFT, 1/s
  driftSpeedLoss: number; // > 0: DRIFT speed cap vmax*(1 - driftSpeedLoss*|slip|/slipFull) as R22 (no slipDrag in DRIFT)
  // entry
  driftEnterSpeed: number;
  driftExitSpeed: number;
  flickDelta: number;
  flickWindow: number;
  kickBase: number; // slip rate kick at flickDelta
  kickGain: number; // extra slip rate per unit of steer change above flickDelta
  // exit
  carryDecay: number; // 1/s, decay of the visible slip carried out of DRIFT
  // cost
  slipDrag: number;
  offroadMul: number;
  xLimit: number;
  slipDeg: number; // render only
}

export const BASE: P = {
  vmax: 1,
  accel: 0.22,
  brake: 0.6,
  driftBrake: 0.3,
  kYaw: 2.0,
  latScale: 1,
  yawFullSpeed: 0.3,
  yawRateMax: 15.75,
  yawAlign: 15,
  yawResponse: 60,
  velGrip: 22,
  slipGripMax: 0.42,
  slipGripLimit: 0.6,
  slipFull: 2.64,
  slipResponse: 8,
  driftLat: 0.46,
  driftPush: 0.0287,
  velGripDrift: 3,
  driftSpeedLoss: 0.15,
  driftEnterSpeed: 0.45,
  driftExitSpeed: 0.3,
  flickDelta: 0.5,
  flickWindow: 0.12,
  kickBase: 2,
  kickGain: 6,
  carryDecay: 8,
  slipDrag: 0.058,
  offroadMul: 0.99,
  xLimit: 1.5,
  slipDeg: 17,
};

// ---------------------------------------------------------------- model C state and step
export interface S {
  x: number;
  z: number;
  speed: number;
  yaw: number;
  yawRate: number; // GRIP: body yaw rate (world); DRIFT: d(slip)/dt
  vel: number;
  vx: number;
  drift: boolean;
  dir: number;
  carry: number; // visible slip left over from the last state change, decays (screen + speed cost only)
  hist: number[];
  histHead: number;
  histN: number;
  entries: number;
  minSlipDir: number; // diagnostics: min slip*dir seen in DRIFT
}

export function makeState(speed = 1, x = 0): S {
  return {
    x,
    z: 0,
    speed,
    yaw: 0,
    yawRate: 0,
    vel: 0,
    vx: 0,
    drift: false,
    dir: 0,
    carry: 0,
    hist: new Array<number>(64).fill(0),
    histHead: 0,
    histN: 0,
    entries: 0,
    minSlipDir: Infinity,
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** Visible slip (render, speed cost): body minus motion plus what DRIFT left behind. */
export const visSlip = (s: S): number => s.yaw - s.vel + s.carry;

export function step(
  s: S,
  inp: { steer: number; drift: boolean; brake?: boolean },
  curve: number,
  dt: number,
  p: P,
  capMul = 1,
): void {
  const steer = clamp(inp.steer, -1, 1); // R80
  // R81': flick entry (same detection as model B); the flick sets the slip RATE, slip stays continuous.
  const w = Math.max(1, Math.round(p.flickWindow / dt));
  if (!s.drift && inp.drift && s.speed > p.driftEnterSpeed * p.vmax) {
    let best = 0;
    for (let k = 1; k <= Math.min(w, s.histN); k++) {
      const d = steer - s.hist[(s.histHead - k + 64) % 64]!;
      if (Math.abs(d) > Math.abs(best)) best = d;
    }
    if (Math.abs(best) >= p.flickDelta) {
      s.drift = true;
      s.dir = best > 0 ? 1 : -1;
      const vis = visSlip(s);
      const slip0 = s.dir * Math.max(0, vis * s.dir); // R84' one-sided from the first tick
      s.carry = vis - slip0; // R82': what the new state does not take over fades as carry
      s.yaw = s.vel + slip0;
      s.yawRate = s.dir * (p.kickBase + p.kickGain * (Math.abs(best) - p.flickDelta));
      s.entries++;
    }
  }
  s.hist[s.histHead] = steer;
  s.histHead = (s.histHead + 1) % 64;
  if (s.histN < 64) s.histN++;
  const sp = s.speed / p.vmax;
  const A = curve * sp * p.kYaw;
  // R82': exit. GRIP starts in its own quasi-steady state; the rest of the slip becomes carry.
  if (s.drift && (!inp.drift || s.speed < p.driftExitSpeed * p.vmax)) {
    s.drift = false;
    s.dir = 0;
    const sG = clamp(A / p.velGrip, -p.slipGripMax, p.slipGripMax);
    s.carry = visSlip(s) - sG;
    s.yaw = s.vel + sG;
    s.yawRate = A;
  }
  if (s.drift) {
    const u = steer * s.dir;
    // R83': visible slip chases dir*slipFull*clamp(u,0,1), critically damped (wn = slipResponse).
    const slipT = s.dir * p.slipFull * clamp(u, 0, 1);
    let slip = s.yaw - s.vel;
    const wn = p.slipResponse;
    s.yawRate += (wn * wn * (slipT - slip) - 2 * wn * s.yawRate) * dt;
    slip += s.yawRate * dt;
    if (slip * s.dir < 0) {
      slip = 0; // R84': one-sided floor
      s.yawRate = 0;
    }
    // R84': motion chases the slip's lateral share (or the counter-steer) minus a small push.
    const velT =
      s.dir * p.driftLat * ((slip * s.dir) / p.slipFull + Math.min(0, u)) - p.driftPush * A;
    s.vel += (velT - s.vel) * (1 - Math.exp(-p.velGripDrift * dt));
    s.yaw = s.vel + slip;
    s.minSlipDir = Math.min(s.minSlipDir, slip * s.dir);
  } else {
    // GRIP = current model B R83/R84 without the recover blend.
    const f = Math.min(1, sp / p.yawFullSpeed);
    s.yawRate +=
      (steer * p.yawRateMax * f - p.yawAlign * s.yaw - s.yawRate) *
      (1 - Math.exp(-p.yawResponse * dt));
    s.yaw += (s.yawRate - A) * dt;
    s.vel += (p.velGrip * clamp(s.yaw - s.vel, -p.slipGripMax, p.slipGripMax) - A) * dt;
    const sl = s.yaw - s.vel;
    if (sl > p.slipGripLimit) {
      s.yaw = s.vel + p.slipGripLimit;
      if (s.yawRate > A) s.yawRate = A;
    } else if (sl < -p.slipGripLimit) {
      s.yaw = s.vel - p.slipGripLimit;
      if (s.yawRate < A) s.yawRate = A;
    }
  }
  s.carry *= Math.exp(-p.carryDecay * dt); // R82': carry fades in both states (screen angle + speed cost only)
  // R85
  s.vx = s.vel * sp * p.latScale;
  s.x += s.vx * dt;
  if (s.x > p.xLimit) {
    s.x = p.xLimit;
    if (s.vel > 0) s.vel = 0;
  } else if (s.x < -p.xLimit) {
    s.x = -p.xLimit;
    if (s.vel < 0) s.vel = 0;
  }
  if (s.drift) s.yaw = s.vel + (s.yaw - s.vel); // wall keeps slip
  // R86 with the visible slip
  let cap = p.vmax * capMul;
  const capDrift = s.drift && p.driftSpeedLoss > 0;
  if (capDrift)
    cap = p.vmax * Math.min(capMul, 1 - (p.driftSpeedLoss * Math.abs(s.yaw - s.vel)) / p.slipFull);
  let v = s.speed;
  if (inp.brake) v -= p.brake * dt;
  else if (v > cap) v = Math.max(cap, v - p.driftBrake * dt);
  else v = Math.min(cap, v + p.accel * dt);
  const vs = visSlip(s);
  if (!capDrift) v -= p.slipDrag * vs * vs * dt;
  if (v < 0) v = 0;
  if (s.x > 1 || s.x < -1) v *= Math.pow(p.offroadMul, 60 * dt);
  s.speed = v;
  s.z += v * dt * SEG_PER_UNIT;
}

// ---------------------------------------------------------------- uniform wrapper over A / B / C
type ModelName = 'A' | 'B' | 'C';
interface Sim {
  x: number;
  vx: number;
  slip: number; // A: angle*slipFull-equivalent is not meaningful; we report angle
  speed: number;
  drift: boolean;
  dir: number;
  step(steer: number, drift: boolean, pin?: number): void;
}
const C = curves as { easy: number; medium: number; hard: number };
const trackCache = new Map<number, Track>();
function constTrack(c: number): Track {
  let t = trackCache.get(c);
  if (!t) {
    t = { segments: Array.from({ length: 4000 }, () => ({ curve: c })) };
    trackCache.set(c, t);
  }
  return t;
}
function noWalls(p: CarParams): CarParams {
  return { ...p, xLimit: 1e9, offroadMul: 1, offroadSteerMul: 1, offroadGrip: p.grip };
}
/** Real src/sim step for model A (0) or current model B (1); curve may change per tick via setCurve. */
class RealSim implements Sim {
  race: RaceState;
  car: Car;
  p: CarParams;
  inp: InputFrame = { steer: 0, brake: false, drift: false };
  curve: number;
  constructor(model: 0 | 1, curve: number, speed: number, walls = false) {
    this.p = walls ? { ...baseCar, model } : noWalls({ ...baseCar, model });
    this.race = createRace(1, 1);
    this.car = this.race.cars[0]!;
    this.car.speed = speed;
    this.curve = curve;
  }
  get x(): number {
    return this.car.x;
  }
  get vx(): number {
    return this.car.vx;
  }
  get slip(): number {
    return this.p.model === 0 ? this.car.angle : this.car.yaw - this.car.vel;
  }
  get speed(): number {
    return this.car.speed;
  }
  get drift(): boolean {
    return this.car.state === 'DRIFT';
  }
  get dir(): number {
    return this.car.dir;
  }
  step(steer: number, drift: boolean, pin?: number): void {
    if (pin !== undefined) this.car.speed = pin;
    this.inp.steer = steer;
    this.inp.drift = drift;
    const x0 = this.car.x;
    realStep(this.race, [this.inp], constTrack(this.curve), [this.p]);
    this.lastDx = (this.car.x - x0) / DT;
    if (pin !== undefined) this.car.speed = pin;
  }
  lastDx = 0;
  /** Put the car into a DRIFT with dir and a steady-ish start for steer s. */
  enterDrift(dir: number, s: number): void {
    const c = this.car;
    c.state = 'DRIFT';
    c.dir = dir > 0 ? 1 : -1;
    c.driftHeld = true;
    if (this.p.model === 0) {
      c.angle = clamp(s * dir, 0, 1) * dir;
      c.steer = s;
    } else {
      const A = this.curve * (c.speed / this.p.vmax) * this.p.kYaw;
      c.yawRate = A;
      c.yaw = A / this.p.velGripDrift;
      c.steer = s;
    }
  }
}
class CSim implements Sim {
  s: S;
  constructor(
    public p: P,
    public curve: number,
    speed: number,
    public dt: number,
    walls = false,
  ) {
    if (!walls) this.p = { ...p, xLimit: 1e9, offroadMul: 1 };
    this.s = makeState(speed);
  }
  get x(): number {
    return this.s.x;
  }
  get vx(): number {
    return this.s.vx;
  }
  get slip(): number {
    return visSlip(this.s);
  }
  get speed(): number {
    return this.s.speed;
  }
  get drift(): boolean {
    return this.s.drift;
  }
  get dir(): number {
    return this.s.dir;
  }
  lastDx = 0;
  maxVisJump = 0; // max per-tick change of the R89 screen angle slip*17 + vel*5, degrees
  get visDeg(): number {
    return visSlip(this.s) * 17 + this.s.vel * 5;
  }
  step(steer: number, drift: boolean, pin?: number): void {
    if (pin !== undefined) this.s.speed = pin;
    const x0 = this.s.x;
    const v0 = this.visDeg;
    step(
      this.s,
      { steer, drift },
      this.curve,
      this.dt,
      this.p,
      pin !== undefined && pin > 1 ? pin : 1,
    );
    this.lastDx = (this.s.x - x0) / this.dt;
    this.maxVisJump = Math.max(this.maxVisJump, Math.abs(this.visDeg - v0));
    if (pin !== undefined) this.s.speed = pin;
  }
  enterDrift(dir: number, s: number): void {
    const q = this.s;
    q.drift = true;
    q.dir = dir;
    const sp = q.speed / this.p.vmax;
    const A = this.curve * sp * this.p.kYaw;
    const u = s * dir;
    const slip = dir * this.p.slipFull * clamp(u, 0, 1);
    q.vel =
      dir * this.p.driftLat * ((slip * dir) / this.p.slipFull + Math.min(0, u)) -
      this.p.driftPush * A;
    q.yaw = q.vel + slip;
    q.yawRate = 0;
  }
}
function makeSim(
  m: ModelName,
  p: P,
  curve: number,
  speed: number,
  dt: number,
  walls = false,
): RealSim | CSim {
  return m === 'C'
    ? new CSim(p, curve, speed, dt, walls)
    : new RealSim(m === 'A' ? 0 : 1, curve, speed, walls);
}
const dtOf = (m: ModelName, dt: number): number => (m === 'C' ? dt : DT);

// ---------------------------------------------------------------- helpers
const f2 = (v: number, d = 3): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
function table(io: Io, head: string[], rows: (string | number)[][]): void {
  const cells = [head, ...rows.map((r) => r.map((c) => (typeof c === 'number' ? f2(c) : c)))];
  const wd = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  for (const r of cells) io.log('| ' + r.map((c, i) => pad(c, wd[i]!)).join(' | ') + ' |');
}
const verdicts: string[] = [];
function verdict(io: Io, name: string, ok: boolean, note: string): void {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${note}`;
  verdicts.push(line);
  io.log(line);
}

/** Steady lateral speed (dx/dt incl. model A's push, mean over the last second) for held steer s in DRIFT dir +1. */
function driftLat(
  m: ModelName,
  p: P,
  curve: number,
  s: number,
  dt: number,
  pin: number | null = 1,
  secs = 3,
): { vx: number; slip: number; speed: number } {
  const sim = makeSim(m, p, curve, 1, dtOf(m, dt));
  sim.enterDrift(1, s);
  const d = dtOf(m, dt);
  let sum = 0;
  let sl = 0;
  let n = 0;
  for (let t = 0; t < secs; t += d) {
    sim.step(s, true, pin ?? undefined);
    if (t >= secs - 1) {
      sum += sim.lastDx;
      sl += sim.slip;
      n++;
    }
  }
  return { vx: sum / n, slip: sl / n, speed: sim.speed };
}
/** Bisection on steer for zero mean lateral speed in DRIFT (dir +1). */
function driftHold(
  m: ModelName,
  p: P,
  curve: number,
  dt: number,
  pin: number | null = 1,
  secs = 3,
): { steer: number; slip: number; speed: number } {
  let lo = -1;
  let hi = 1;
  let r = { vx: 0, slip: 0, speed: 0 };
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    r = driftLat(m, p, curve, mid, dt, pin, secs);
    if (r.vx > 0) hi = mid;
    else lo = mid;
  }
  return { steer: (lo + hi) / 2, slip: r.slip, speed: r.speed };
}

// ---------------------------------------------------------------- D: diagnosis (current B vs A)
function diag(io: Io, p: P, dt: number): void {
  io.log(
    '\n## D diagnosis: DRIFT steady lateral speed dx/dt (hw/s, + = inward) at pinned vmax, dir +1',
  );
  const rows: (string | number)[][] = [];
  for (const [k, c] of [
    ['straight', 0],
    ['medium', C.medium],
    ['hard', C.hard],
  ] as const) {
    for (const m of ['A', 'B'] as const) {
      const v = [0, 0.25, 0.5, 0.75, 1].map((s) => driftLat(m, p, c, s, dt).vx);
      const h = c > 0 ? driftHold(m, p, c, dt) : { steer: 0 };
      const e = 0.05;
      const slope =
        c > 0
          ? (driftLat(m, p, c, h.steer + e, dt).vx - driftLat(m, p, c, h.steer - e, dt).vx) /
            (2 * e)
          : (v[2]! - v[1]!) / 0.25;
      rows.push([k, m, ...v, c > 0 ? h.steer : '-', slope]);
    }
  }
  table(
    io,
    [
      'curve',
      'model',
      's=0',
      's=0.25',
      's=0.5',
      's=0.75',
      's=1',
      'hold steer',
      'd(vx)/d(steer) at hold',
    ],
    rows,
  );
  io.log(
    `analytic current B slope: yawRateMaxDrift/yawAlignDrift = ${f2(baseCar.yawRateMaxDrift / baseCar.yawAlignDrift)}; model A driftRate = ${baseCar.driftRate}`,
  );
  // two-sidedness: DRIFT right on a straight at full steer, then full counter-steer
  for (const m of ['A', 'B'] as const) {
    const sim = makeSim(m, p, 0, 1, DT);
    sim.enterDrift(1, 1);
    let minS = Infinity;
    for (let t = 0; t < 1; t += DT) sim.step(1, true, 1);
    for (let t = 0; t < 1.5; t += DT) {
      sim.step(-1, true, 1);
      minS = Math.min(minS, sim.slip * sim.dir);
    }
    io.log(
      `two-sided check ${m}: straight, DRIFT dir +1, 1 s at steer +1 then 1.5 s at -1: min slip*dir ${f2(minS)} (${m === 'A' ? 'angle' : 'slip'}), still DRIFT ${String(sim.drift)}, final dx/dt ${f2(sim.lastDx)}`,
    );
  }
  // entry kick of current B: straight, flick 0 -> 1, then steer 0.5 held
  const rowsK: (string | number)[][] = [];
  for (const [nm, from] of [
    ['weak 0.55', 0.45],
    ['normal 1.0', 0],
    ['strong 2.0', -1],
  ] as const) {
    const b = new RealSim(1, 0, 1);
    const g = new RealSim(1, 0, 1);
    for (let t = 0; t < 0.13; t += DT) {
      b.step(from, false);
      g.step(from, false);
    }
    let maxD = 0;
    let peak = 0;
    for (let t = 0; t < 0.6; t += DT) {
      const st = t < 0.06 ? 1 : 0.5;
      b.step(st, true);
      g.step(st, false);
      maxD = Math.max(maxD, Math.abs(b.x - g.x));
      peak = Math.max(peak, b.slip);
    }
    rowsK.push([nm, maxD, peak, peak * 17]);
  }
  io.log(
    'current B entry on a straight (flick to 1 for 0.06 s, then steer 0.5): vs the same input without drift',
  );
  table(io, ['flick', 'max |dx| 0.6 s vs GRIP', 'peak slip', 'deg'], rowsK);
}

// ---------------------------------------------------------------- T1-T3 DRIFT authority
function tAuth(io: Io, p: P, dt: number): void {
  io.log(
    '\n## T1-T3 DRIFT authority, dx/dt (hw/s, + inward), pinned vmax; hold also at free (equilibrium) speed',
  );
  const rows: (string | number)[][] = [];
  interface AuthRow {
    v0: number;
    v1: number;
    hold: number;
    holdFree: number;
    slope: number;
    speedFree: number;
    slipFree: number;
    slipHold: number;
  }
  const res: Record<string, AuthRow> = {};
  for (const [k, c] of [
    ['straight', 0],
    ['medium', C.medium],
    ['hard', C.hard],
  ] as const) {
    for (const m of ['A', 'C'] as const) {
      const v0 = driftLat(m, p, c, 0, dt).vx;
      const v1 = driftLat(m, p, c, 1, dt).vx;
      const h = c > 0 ? driftHold(m, p, c, dt) : { steer: NaN, slip: NaN, speed: NaN };
      const hf = c > 0 ? driftHold(m, p, c, dt, null, 8) : { steer: NaN, slip: NaN, speed: NaN };
      const e = 0.05;
      const sc = c > 0 ? h.steer : 0.5;
      const slope = (driftLat(m, p, c, sc + e, dt).vx - driftLat(m, p, c, sc - e, dt).vx) / (2 * e);
      res[`${k}${m}`] = {
        v0,
        v1,
        hold: h.steer,
        holdFree: hf.steer,
        slope,
        speedFree: hf.speed,
        slipFree: hf.slip,
        slipHold: h.slip,
      };
      rows.push([
        k,
        m,
        v0,
        v1,
        h.steer,
        slope,
        hf.steer,
        hf.speed,
        m === 'C' ? hf.slip * p.slipDeg : hf.slip,
      ]);
    }
  }
  table(
    io,
    [
      'curve',
      'model',
      'steer 0',
      'steer 1',
      'hold (vmax)',
      'slope at hold',
      'hold (free, 8 s)',
      'speed (free)',
      'C: deg / A: angle',
    ],
    rows,
  );
  const h = res.hardC!;
  const m = res.mediumC!;
  const st = res.straightC!;
  verdict(
    io,
    'T1 hard hold (free speed)',
    h.holdFree >= 0.7 && h.holdFree <= 0.85,
    `free ${f2(h.holdFree, 2)} (0.70-0.85); pinned vmax ${f2(h.hold, 2)} (A pinned ${f2(res.hardA!.hold, 2)}, free ${f2(res.hardA!.holdFree, 2)})`,
  );
  verdict(io, 'T1 hard steer 0', -h.v0 >= 0.3 && -h.v0 <= 0.5, `${f2(h.v0)} (out 0.3-0.5)`);
  verdict(io, 'T1 hard full', h.v1 <= 0.2, `${f2(h.v1)} (in <= 0.2)`);
  verdict(
    io,
    'T1 hard slope',
    h.slope >= 0.4 && h.slope <= 0.8,
    `${f2(h.slope)} (0.4-0.8; A ${f2(res.hardA!.slope)})`,
  );
  verdict(
    io,
    'T2 medium hold (free speed)',
    m.holdFree >= 0.45 && m.holdFree <= 0.55,
    `free ${f2(m.holdFree, 2)} (0.45-0.55); pinned vmax ${f2(m.hold, 2)} (A pinned ${f2(res.mediumA!.hold, 2)}, free ${f2(res.mediumA!.holdFree, 2)})`,
  );
  verdict(io, 'T2 medium steer 0', -m.v0 >= 0.2 && -m.v0 <= 0.35, `${f2(m.v0)} (out 0.2-0.35)`);
  verdict(io, 'T2 medium full', m.v1 >= 0.15 && m.v1 <= 0.3, `${f2(m.v1)} (in 0.15-0.3)`);
  verdict(io, 'T3 straight full', st.v1 <= 0.6, `${f2(st.v1)} (<= 0.6)`);
  verdict(io, 'T3 straight 0', Math.abs(st.v0) <= 0.05, `${f2(st.v0)} (|.| <= 0.05)`);
}

// ---------------------------------------------------------------- T4 one-sided
function t4(io: Io, p: P, dt: number): void {
  io.log(
    '\n## T4 one-sided: DRIFT dir +1, steer +1 for 1 s, then -1 for 1.5 s, then back to hold for 1 s',
  );
  const rows: (string | number)[][] = [];
  let okAll = true;
  for (const [k, c] of [
    ['straight', 0],
    ['hard', C.hard],
  ] as const) {
    const sim = new CSim(p, c, 1, dt);
    sim.enterDrift(1, 1);
    const hold = c > 0 ? driftHold('C', p, c, dt).steer : 0.5;
    let minS = Infinity;
    let t = 0;
    const T = 3.5;
    const tick = Math.round(0.25 / dt);
    let i = 0;
    for (; t < T; t += dt, i++) {
      const st = t < 1 ? 1 : t < 2.5 ? -1 : hold;
      sim.step(st, true, 1);
      minS = Math.min(minS, sim.slip * sim.dir);
      if (i % tick === 0)
        rows.push([
          k,
          f2(t, 2),
          st,
          sim.slip,
          sim.slip * p.slipDeg,
          sim.s.vel,
          sim.lastDx,
          String(sim.drift),
        ]);
    }
    if (minS < 0) okAll = false;
    io.log(`${k}: min slip*dir ${f2(minS, 4)}`);
  }
  table(io, ['curve', 't', 'steer', 'slip', 'deg', 'vel', 'dx/dt', 'DRIFT'], rows);
  verdict(
    io,
    'T4 slip*dir >= 0',
    okAll,
    'rows above; counter-steer moves the car against dir at driftLat with slip 0 (body along the motion)',
  );
}

// ---------------------------------------------------------------- T5 entry
function t5(io: Io, p: P, dt: number): void {
  io.log(
    '\n## T5 entry at vmax: 0.13 s at steer `from` (no drift), flick to 1 for 0.06 s with drift held, then hold steer',
  );
  io.log(
    'Reference (same input) = the same run with kickBase = kickGain = 0 (removes only what the flick strength adds).',
  );
  const rows: (string | number)[][] = [];
  let okJump = true;
  let okRise = true;
  let okOver = true;
  for (const [k, c] of [
    ['straight', 0],
    ['medium', C.medium],
    ['hard', C.hard],
  ] as const) {
    const hold = c > 0 ? driftHold('C', p, c, dt, null, 8).steer : 0.5;
    for (const [nm, from] of [
      ['weak 0.55', 0.45],
      ['normal 1.0', 0],
      ['strong 2.0', -1],
    ] as const) {
      let visJ = 0;
      const run = (q: P, mdl: ModelName, drift: boolean): { xs: number[]; sl: number[] } => {
        const sim = makeSim(mdl, q, c, 1, dtOf(mdl, dt));
        const d = dtOf(mdl, dt);
        // straight before: from steer for 0.13 s (on the straight), then the corner starts
        sim.curve = 0;
        for (let t = 0; t < 0.13; t += d) sim.step(from, false);
        sim.curve = c;
        const xs: number[] = [];
        const sl: number[] = [];
        for (let t = 0; t < 2.5; t += d) {
          sim.step(t < 0.06 ? 1 : hold, drift);
          xs.push(sim.x);
          sl.push(sim.slip);
        }
        if (drift && q === p) visJ = (sim as CSim).maxVisJump;
        return { xs, sl };
      };
      const a = run(p, 'C', true);
      const r = run({ ...p, kickBase: 0, kickGain: 0 }, 'C', true);
      const g = run(p, 'C', false);
      const n06 = Math.round(0.6 / dt);
      let dK = 0;
      let dG = 0;
      for (let i = 0; i < n06; i++) {
        dK = Math.max(dK, Math.abs(a.xs[i]! - r.xs[i]!));
        dG = Math.max(dG, Math.abs(a.xs[i]! - g.xs[i]!));
      }
      const tail = a.sl.slice(Math.round(1.5 / dt));
      const steady = tail.reduce((u, v) => u + v, 0) / tail.length;
      let t90 = NaN;
      for (let i = 0; i < a.sl.length; i++)
        if (Number.isNaN(t90) && a.sl[i]! >= 0.9 * steady) t90 = (i + 1) * dt;
      const peak = Math.max(...a.sl);
      const over = steady > 0 ? peak / steady - 1 : NaN;
      const s01 = a.sl[Math.round(0.1 / dt) - 1]!;
      rows.push([
        k,
        nm,
        f2(hold, 2),
        dK,
        dG,
        s01 * p.slipDeg,
        steady * p.slipDeg,
        f2(t90, 2),
        f2(over * 100, 1) + '%',
        visJ,
      ]);
      if (dK > 0.15) okJump = false;
      if (c > 0 && nm !== 'strong 2.0' && !(t90 >= 0.25 && t90 <= 0.45)) okRise = false;
      if (c > 0 && over > 0.15) okOver = false;
    }
  }
  table(
    io,
    [
      'curve',
      'flick',
      'hold',
      'max|dx| vs no-kick 0.6 s',
      'max|dx| vs GRIP 0.6 s',
      'deg at 0.1 s',
      'steady deg',
      't90 s',
      'overshoot',
      'max screen-angle step per tick, deg',
    ],
    rows,
  );
  verdict(io, 'T5 no lateral jump from flick strength', okJump, '<= 0.15 hw in 0.6 s');
  verdict(io, 'T5 rise 0.25-0.45 s (weak/normal, curves)', okRise, 'rows above');
  verdict(io, 'T5 overshoot <= 15% (curves)', okOver, 'rows above');
}

// ---------------------------------------------------------------- T6 speed
function t6(io: Io, p: P, dt: number): void {
  io.log('\n## T6 speed: steady drift at the free hold steer (8 s); extra slip costs speed');
  const rows: (string | number)[][] = [];
  const out: Record<string, number> = {};
  for (const [k, c] of [
    ['medium', C.medium],
    ['hard', C.hard],
  ] as const) {
    for (const m of ['A', 'C'] as const) {
      const h = driftHold(m, p, c, dt, null, 8);
      const more = driftLat(m, p, c, Math.min(1, h.steer + 0.15), dt, null, 8);
      rows.push([k, m, h.steer, h.speed, more.speed, m === 'C' ? h.slip * p.slipDeg : h.slip]);
      out[k + m] = h.speed;
    }
  }
  table(
    io,
    ['curve', 'model', 'hold steer', 'speed at hold', 'speed at hold+0.15', 'C deg / A angle'],
    rows,
  );
  verdict(
    io,
    'T6 speed',
    out.hardC! >= 0.85 && out.mediumC! >= 0.92,
    `hard ${f2(out.hardC!)} (>=0.85), medium ${f2(out.mediumC!)} (>=0.92)`,
  );
}

// ---------------------------------------------------------------- T7 exit
function t7(io: Io, p: P, dt: number): void {
  io.log(
    '\n## T7 exit: steady drift (2 s at hold, free speed), release; steer after release as listed',
  );
  io.log(
    'jump = max |x - x_ref| over 0.3 s, x_ref = GRIP car with the same x, vel, speed and its own GRIP slip on this curve (yawRate = A)',
  );
  const rows: (string | number)[][] = [];
  let okJ = true;
  for (const [k, c] of [
    ['straight', 0],
    ['medium', C.medium],
    ['hard', C.hard],
  ] as const) {
    for (const m of ['B', 'C'] as const) {
      const hold =
        c > 0 ? (m === 'C' ? driftHold('C', p, c, dt).steer : driftHold('B', p, c, dt).steer) : 0.5;
      for (const after of [0, hold] as const) {
        const sim = makeSim(m, p, c, 1, dtOf(m, dt));
        const d = dtOf(m, dt);
        sim.enterDrift(1, hold);
        for (let t = 0; t < 2; t += d) sim.step(hold, true);
        // reference GRIP car from the same motion state (model C GRIP laws for both columns)
        const ref = new CSim(p, c, sim.speed, dt);
        ref.s.x = sim.x;
        const sp = sim.speed;
        const velNow = m === 'C' ? (sim as CSim).s.vel : (sim as RealSim).car.vel;
        ref.s.vel = velNow;
        const A = c * sp * p.kYaw;
        ref.s.yaw = velNow + clamp(A / p.velGrip, -p.slipGripMax, p.slipGripMax);
        ref.s.yawRate = A;
        const slip0 = sim.slip;
        const vx0 = sim.vx;
        let jump = 0;
        if (m === 'C') (sim as CSim).maxVisJump = 0;
        const xr = sim.x;
        const sp0 = sim.speed;
        for (let t = 0; t < 1; t += d) {
          sim.step(after, false);
          if (t < 0.3) {
            ref.step(after, false);
            jump = Math.max(jump, Math.abs(sim.x - ref.x));
          }
        }
        rows.push([
          k,
          m,
          f2(after, 2),
          slip0 * 17,
          vx0,
          jump,
          sim.x - xr,
          sim.speed - sp0,
          sim.slip * 17,
          m === 'C' ? (sim as CSim).maxVisJump : '-',
        ]);
        if (m === 'C' && jump > 0.1) okJ = false;
      }
    }
  }
  // hard release at hold steer: understeer outward (x after 1 s relative to release point)
  const sim = new CSim(p, C.hard, 1, dt);
  const hold = driftHold('C', p, C.hard, dt).steer;
  sim.enterDrift(1, hold);
  for (let t = 0; t < 2; t += dt) sim.step(hold, true);
  const xr = sim.x;
  for (let t = 0; t < 1; t += dt) sim.step(1, false);
  table(
    io,
    [
      'curve',
      'model',
      'steer after',
      'deg at release',
      'vx at release',
      'jump 0.3 s',
      'x after 1 s',
      'speed change 1 s',
      'deg after 1 s',
      'C: max screen-angle step per tick',
    ],
    rows,
  );
  verdict(io, 'T7 no exit jump (C)', okJ, '<= 0.1 hw within 0.3 s, all rows');
  verdict(
    io,
    'T7 hard release understeers out',
    sim.x - xr < -0.3,
    `full steer after release: dx in 1 s ${f2(sim.x - xr)} (out = negative)`,
  );
}

// ---------------------------------------------------------------- T8 GRIP
function gripHold(p: P, curve: number, dt: number): number {
  let lo = -1;
  let hi = 1;
  for (let it = 0; it < 30; it++) {
    const st = (lo + hi) / 2;
    const sim = new CSim(p, curve, 1, dt);
    const A = curve * p.kYaw;
    sim.s.yawRate = A;
    sim.s.yaw = A / p.velGrip;
    let sum = 0;
    let n = 0;
    for (let t = 0; t < 3; t += dt) {
      sim.step(st, false, 1);
      if (t > 2) {
        sum += sim.s.vel;
        n++;
      }
    }
    if (sum / n > 0) hi = st;
    else lo = st;
  }
  return (lo + hi) / 2;
}
function rise(series: number[], dt: number): number {
  const fin = series[series.length - 1]!;
  let t10 = NaN;
  let t90 = NaN;
  for (let i = 0; i < series.length; i++) {
    const v = series[i]! / fin;
    if (Number.isNaN(t10) && v >= 0.1) t10 = i * dt;
    if (Number.isNaN(t90) && v >= 0.9) t90 = i * dt;
  }
  return t90 - t10;
}
function t8(io: Io, p: P, dt: number): void {
  io.log(
    '\n## T8 GRIP (model C GRIP = current B GRIP with yawRateMax/yawAlign/yawResponse retuned)',
  );
  const full = new CSim(p, 0, 1, dt);
  for (let t = 0; t < 2; t += dt) full.step(1, false, 1);
  const a = new RealSim(0, 0, 1);
  for (let t = 0; t < 2; t += DT) a.step(1, false, 1);
  const b = new RealSim(1, 0, 1);
  for (let t = 0; t < 2; t += DT) b.step(1, false, 1);
  const holds = (['easy', 'medium', 'hard'] as const).map((k) => gripHold(p, C[k], dt));
  // hard full steer: runs out
  const hs = new CSim(p, C.hard, 1, dt);
  for (let t = 0; t < 1.5; t += dt) hs.step(1, false);
  // responses on a straight
  const y = new CSim(p, 0, 1, dt);
  const ys: number[] = [];
  for (let t = 0; t < 1.5; t += dt) {
    y.step(0.5, false, 1);
    ys.push(y.s.yaw);
  }
  const v = new CSim(p, 0, 1, dt);
  const vs: number[] = [];
  for (let t = 0; t < 1.5; t += dt) {
    v.s.yaw = 0.5;
    v.s.yawRate = 0;
    v.step(0, false, 1);
    v.s.yaw = 0.5;
    vs.push(v.s.vel);
  }
  // DRIFT slip -> vel (slip pinned at 1, dir +1, straight)
  const dsim = new CSim(p, 0, 1, dt);
  dsim.s.drift = true;
  dsim.s.dir = 1;
  const dvs: number[] = [];
  for (let t = 0; t < 3; t += dt) {
    dsim.s.yaw = dsim.s.vel + 1;
    dsim.s.yawRate = 0;
    dsim.step(1 / p.slipFull, true, 1);
    dvs.push(dsim.s.vel);
  }
  // S1 pulse 0.5 for 0.4 s
  const pl = new CSim(p, 0, 1, dt);
  for (let t = 0; t < 1.6; t += dt) pl.step(t < 0.4 ? 0.5 : 0, false, 1);
  table(
    io,
    ['quantity', 'C', 'target'],
    [
      [
        'full-steer straight vx (2 s)',
        full.vx,
        '1.0-1.1 (A ' + f2(a.lastDx) + ', B ' + f2(b.vx) + ')',
      ],
      ['easy hold', holds[0]!, '0.4-0.5'],
      ['medium hold', holds[1]!, '0.9-1.0'],
      ['hard full steer x after 1.5 s', hs.x, '< -0.5 (not holdable)'],
      ['steer->yaw 10-90%', rise(ys, dt), '0.10-0.15 s'],
      ['yaw->vel 10-90%', rise(vs, dt), '0.08-0.12 s'],
      ['DRIFT slip->vel 10-90%', rise(dvs, dt), 'report (B: 0.3-0.4)'],
      ['pulse 0.5 x 0.4 s shift', pl.x, 'about a lane, 0.2-0.3'],
    ],
  );
  verdict(io, 'T8 straight full', full.vx >= 1.0 && full.vx <= 1.1, f2(full.vx));
  verdict(
    io,
    'T8 windows',
    holds[0]! >= 0.4 && holds[0]! <= 0.5 && holds[1]! >= 0.9 && holds[1]! <= 1.0 && hs.x < -0.5,
    `easy ${f2(holds[0]!, 2)}, medium ${f2(holds[1]!, 2)}, hard out ${f2(hs.x)}`,
  );
  const r1 = rise(ys, dt);
  const r2 = rise(vs, dt);
  verdict(
    io,
    'T8 responses',
    r1 >= 0.1 && r1 <= 0.15 && r2 >= 0.08 && r2 <= 0.12,
    `steer->yaw ${f2(r1)}, yaw->vel ${f2(r2)}`,
  );
}

// ---------------------------------------------------------------- T9 trace
function t9(io: Io, p: P, dt: number, own = false): number {
  const holdA = driftHold('A', p, C.hard, dt, null, 8).steer;
  const holdC = own ? driftHold('C', p, C.hard, dt, null, 8).steer : holdA;
  const holdB = own ? driftHold('B', p, C.hard, dt, null, 8).steer : holdA;
  let hold = holdA;
  io.log(
    `\n## T9 trace on hard from vmax (${own ? 'each model its own free hold steer' : 'same input for all'}): t<0 straight GRIP; t=0 corner starts, steer -> hold (A ${f2(holdA, 3)}, C ${f2(holdC, 3)}, B ${f2(holdB, 3)}) with drift; +0.2 at 2.0-2.5 s; -0.2 at 2.5-3.0 s; release at 3.0 s (steer stays hold)`,
  );
  const seq = (t: number): { s: number; d: boolean } => ({
    s: t < 2 ? hold : t < 2.5 ? hold + 0.2 : t < 3 ? hold - 0.2 : hold,
    d: t < 3,
  });
  const out: Record<string, { x: number[]; sl: number[]; sp: number[]; dr: boolean[] }> = {};
  for (const m of ['A', 'C', 'B'] as const) {
    hold = m === 'A' ? holdA : m === 'C' ? holdC : holdB;
    const sim = makeSim(m, p, 0, 1, dtOf(m, dt));
    const d = dtOf(m, dt);
    for (let t = 0; t < 0.3; t += d) sim.step(0, false);
    sim.curve = C.hard;
    const r = { x: [] as number[], sl: [] as number[], sp: [] as number[], dr: [] as boolean[] };
    const every = Math.round(0.1 / d);
    let i = 0;
    for (let t = 0; t < 4 - 1e-9; t += d, i++) {
      const q = seq(t);
      sim.step(q.s, q.d);
      if ((i + 1) % every === 0) {
        r.x.push(sim.x);
        r.sl.push(sim.slip);
        r.sp.push(sim.speed);
        r.dr.push(sim.drift);
      }
    }
    out[m] = r;
  }
  const rows: (string | number)[][] = [];
  let maxD = 0;
  for (let i = 0; i < out.A!.x.length; i++) {
    const dx = out.C!.x[i]! - out.A!.x[i]!;
    if (i < 30) maxD = Math.max(maxD, Math.abs(dx));
    rows.push([
      f2((i + 1) * 0.1, 1),
      out.A!.x[i]!,
      out.C!.x[i]!,
      dx,
      out.B!.x[i]!,
      out.A!.sl[i]!,
      out.C!.sl[i]! * 17,
      out.A!.sp[i]!,
      out.C!.sp[i]!,
    ]);
  }
  table(
    io,
    ['t', 'x A', 'x C', 'C-A', 'x B (current)', 'A angle', 'C deg', 'speed A', 'speed C'],
    rows,
  );
  verdict(
    io,
    own ? 'T9 trace close to A (own hold)' : 'T9 trace close to A (same input)',
    maxD <= 0.15,
    `max |x_C - x_A| up to the release (3.0 s) ${f2(maxD)} (<= 0.15)`,
  );
  return maxD;
}

// ---------------------------------------------------------------- T10 stability
function t10(io: Io, p: P): void {
  io.log('\n## T10 stability');
  const rows: (string | number)[][] = [];
  let ok = true;
  for (const hz of [60, 120, 240]) {
    const dt = 1 / hz;
    const h = driftHold('C', p, C.hard, dt, null, 8);
    const m = driftHold('C', p, C.medium, dt, null, 8);
    const s0 = driftLat('C', p, C.hard, 0, dt).vx;
    const d9 = t9quiet(p, dt);
    rows.push([`1/${hz}`, h.steer, h.speed, h.slip * 17, m.steer, s0, d9]);
  }
  table(
    io,
    ['dt', 'hard hold (free)', 'speed', 'deg', 'medium hold', 'hard steer 0 dx/dt', 'T9 max|C-A|'],
    rows,
  );
  const r2: (string | number)[][] = [];
  for (const v of [0.3, 0.5, 0.8, 1.0, 1.13]) {
    const h = driftHold('C', p, C.hard, DT, v);
    const sim = new CSim(p, C.hard, v, DT);
    sim.enterDrift(1, h.steer);
    let fin = true;
    let maxX = 0;
    for (let t = 0; t < 5; t += DT) {
      sim.step(h.steer + 0.1 * Math.sin(t * 7), true, v);
      maxX = Math.max(maxX, Math.abs(sim.x));
      if (!Number.isFinite(sim.x)) fin = false;
    }
    r2.push([v, h.steer, h.slip * 17, maxX, String(fin)]);
    if (!fin || maxX > 0.6) ok = false;
  }
  table(io, ['pinned speed', 'hard hold', 'deg', 'max|x| 5 s (hold + 0.1 sin)', 'finite'], r2);
  // noisy steer on hard, 10 s, free speed, from the steady drift
  const r3: (string | number)[][] = [];
  for (const m of ['A', 'C'] as const) {
    const h = driftHold(m, p, C.hard, DT, null, 8);
    let worst = 0;
    for (let seed = 1; seed <= 5; seed++) {
      let rng = seed * 7919;
      const rnd = (): number => {
        rng = (Math.imul(rng, 1103515245) + 12345) | 0;
        return ((rng >>> 8) & 0xffff) / 0xffff;
      };
      const sim = makeSim(m, p, C.hard, 1, DT);
      sim.enterDrift(1, h.steer);
      // settle 6 s at hold so speed is at equilibrium, x reset
      for (let t = 0; t < 6; t += DT) sim.step(h.steer, true);
      const x0 = sim.x;
      let noise = 0;
      let maxX = 0;
      let i = 0;
      for (let t = 0; t < 10; t += DT, i++) {
        if (i % Math.round(0.05 / DT) === 0) noise = (rnd() * 2 - 1) * 0.1;
        sim.step(h.steer + noise, true);
        maxX = Math.max(maxX, Math.abs(sim.x - x0));
      }
      worst = Math.max(worst, maxX);
    }
    r3.push([m, h.steer, worst]);
    if (m === 'C' && worst >= 0.6) ok = false;
  }
  table(io, ['model', 'hold', 'max |x - x0| 10 s, worst of 5 seeds'], r3);
  verdict(io, 'T10 stability', ok, 'rows above');
}
function t9quiet(p: P, dt: number): number {
  const saved = verdicts.length;
  const io: Io = {
    argv: [],
    read: () => '',
    write: () => undefined,
    exists: () => false,
    list: () => [],
    log: () => undefined,
  };
  const r = t9(io, p, dt);
  verdicts.length = saved;
  return r;
}

// ---------------------------------------------------------------- T11 bot
interface BotCfg {
  steerGain: number;
  steerDamp: number;
  curveGain: number;
  look: number;
  driftSteerGain: number;
  driftSteerDamp: number;
  driftCurveGain: number;
  gripMargin: number;
  flickLook: number;
  releaseLook: number;
  releaseFrac: number;
  dipSteer: number;
  dipTime: number;
  kickTime: number;
  lineIn: number;
  insideX: number;
  insideFullCurve: number;
}
const BOT: BotCfg = {
  steerGain: 1.5,
  steerDamp: 0.4,
  curveGain: 0.2,
  look: 0.3,
  driftSteerGain: 1.2,
  driftSteerDamp: 0.6,
  driftCurveGain: 0.09,
  gripMargin: 1.0,
  flickLook: 0.35,
  releaseLook: 0.25,
  releaseFrac: 0.6,
  dipSteer: 0.3,
  dipTime: 0.03,
  kickTime: 0.06,
  lineIn: -0.5,
  insideX: 0.7,
  insideFullCurve: 2.5,
};
function curveAt(t: Track, z: number): number {
  const n = t.segments.length;
  let i = Math.floor(z) % n;
  if (i < 0) i += n;
  return t.segments[i]!.curve;
}
function meanCurve(t: Track, z: number, d: number): number {
  let s = 0;
  const k = Math.max(1, Math.round(d));
  for (let i = 0; i < k; i++) s += curveAt(t, z + i);
  return s / k;
}
/** Feedback driver after src/bot/driver.ts botInputB (no model inversion). */
function botStep(
  s: S,
  b: { flick: number; dir: number },
  t: Track,
  p: P,
  c: BotCfg,
  dt: number,
): { steer: number; drift: boolean } {
  const sp = s.speed / p.vmax;
  const segPerS = s.speed * SEG_PER_UNIT;
  const gripCap = p.velGrip * p.slipGripMax * c.gripMargin;
  const turn = sp * p.kYaw;
  let driftSign = 0;
  const look = Math.max(1, Math.round(segPerS * (s.drift ? c.releaseLook : c.flickLook)));
  for (let i = 0; i < look; i++) {
    const cv = curveAt(t, s.z + i);
    const a = Math.abs(cv) * turn;
    if (s.drift && cv * s.dir < 0 && a > gripCap * c.releaseFrac) break;
    if (a > (s.drift ? gripCap * c.releaseFrac : gripCap)) {
      driftSign = Math.sign(cv);
      break;
    }
  }
  const holdDrift = s.drift && driftSign === s.dir;
  const cAhead = meanCurve(t, s.z, segPerS * c.look);
  let xT = clamp(cAhead / c.insideFullCurve, -1, 1) * c.insideX;
  if (holdDrift) xT = c.lineIn * s.dir;
  let steer = holdDrift
    ? c.driftCurveGain * cAhead * sp + c.driftSteerGain * (xT - s.x) - c.driftSteerDamp * s.vx
    : c.curveGain * cAhead * sp + c.steerGain * (xT - s.x) - c.steerDamp * s.vx;
  if (s.drift) b.flick = 0;
  if (!s.drift && b.flick === 0 && driftSign !== 0 && s.speed > p.driftEnterSpeed * p.vmax) {
    b.flick = 1;
    b.dir = driftSign;
  }
  let drift = holdDrift;
  if (!s.drift && b.flick > 0) {
    const dip = Math.round(c.dipTime / dt);
    const kick = Math.round(c.kickTime / dt);
    if (b.flick <= dip) steer = -b.dir * c.dipSteer;
    else if (b.flick <= dip + kick) steer = b.dir;
    drift = b.flick > dip;
    b.flick = b.flick >= dip + kick + Math.round(p.flickWindow / dt) ? 0 : b.flick + 1;
  }
  return { steer: clamp(steer, -1, 1), drift };
}
function t11(io: Io, p: P, dt: number): void {
  io.log('\n## T11 bots on test-twisty (3 laps; flying laps 2-3)');
  const tw = loadTestTwisty();
  const track = buildTrack(tw.def);
  const n = track.segments.length;
  const s = makeState(0);
  const b = { flick: 0, dir: 0 };
  const laps: number[] = [];
  let last = 0;
  let drift = 0;
  let ticks = 0;
  let maxX = 0;
  let off = 0;
  let minSp = Infinity;
  for (let t = 0; t < 400 && laps.length < 3; t += dt) {
    const inp = botStep(s, b, track, p, BOT, dt);
    step(s, inp, curveAt(track, s.z), dt, { ...p });
    ticks++;
    if (s.drift) drift++;
    maxX = Math.max(maxX, Math.abs(s.x));
    if (Math.abs(s.x) > 1) off++;
    if (laps.length >= 1) minSp = Math.min(minSp, s.speed);
    if (s.z >= (laps.length + 1) * n) {
      laps.push(t + dt - last);
      last = t + dt;
    }
  }
  const m: MeasureConfig = {
    laps: 3,
    maxSecondsPerLap: 200,
    saturationSteer: 0.95,
    deadSteer: 0.05,
    straightCurveMax: 0.5,
    longHoldSeconds: 2,
  };
  const rows: (string | number)[][] = [];
  for (const [nm, model] of [
    ['A (expert, real)', 0],
    ['B current (expert, real)', 1],
  ] as const) {
    const r = runRealBot(botParams.expert, { ...baseCar, model }, track, tw.sections, 1, m);
    let mx = 0;
    for (const c of r.corners) mx = Math.max(mx, c.maxAbsX);
    rows.push([
      nm,
      r.lapTimes.map((v) => v.toFixed(1)).join(' / '),
      r.driftTicks / r.ticks,
      mx,
      r.offroadTicks,
      r.minSpeedFlying,
    ]);
  }
  rows.push([
    'C (spike feedback bot)',
    laps.map((v) => v.toFixed(1)).join(' / '),
    drift / ticks,
    maxX,
    off,
    minSp,
  ]);
  table(
    io,
    ['model', 'laps, s', 'drift share', 'max|x|', 'offroad ticks', 'min speed (laps 2-3)'],
    rows,
  );
  verdict(
    io,
    'T11 C bot on the road',
    laps.length === 3 && maxX <= 1,
    `laps ${laps.map((v) => v.toFixed(1)).join('/')}, max|x| ${f2(maxX)}`,
  );
}

// ---------------------------------------------------------------- main
export function main(io: Io): number {
  const only = argValue(io.argv, 'only')?.split(',');
  const hz = Number(argValue(io.argv, 'dt') ?? 120);
  const dt = 1 / hz;
  const p: P = { ...BASE };
  for (const kv of (argValue(io.argv, 'set') ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (k! in BOT) (BOT as unknown as Record<string, number>)[k!] = Number(v);
    else (p as unknown as Record<string, number>)[k!] = Number(v);
  }
  const want = (k: string): boolean => !only || only.includes(k);
  io.log(`# calm-drift spike, dt 1/${hz} (models A and B always at the real DT 1/120)`);
  if (want('D')) diag(io, p, dt);
  if (want('T1')) tAuth(io, p, dt);
  if (want('T4')) t4(io, p, dt);
  if (want('T5')) t5(io, p, dt);
  if (want('T6')) t6(io, p, dt);
  if (want('T7')) t7(io, p, dt);
  if (want('T8')) t8(io, p, dt);
  if (want('T9')) {
    t9(io, p, dt);
    t9(io, p, dt, true);
  }
  if (want('T10')) t10(io, p);
  if (want('T11')) t11(io, p, dt);
  io.log(
    `\n# verdicts: ${verdicts.filter((v) => v.startsWith('PASS')).length} pass, ${verdicts.filter((v) => v.startsWith('FAIL')).length} fail`,
  );
  for (const v of verdicts) io.log(v);
  return 0;
}

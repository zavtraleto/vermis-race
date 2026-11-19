// THROWAWAY SPIKE (docs/research/yaw-slip-spike.md): "body heading and slip" driving model
// (docs/research/drift-fun.md section 6.1, variant 2). Own step function; does not touch src/sim.
// Run: node tools/run-ts.mjs tools/spike/yaw-slip.ts [--only S1,S3] [--dt 120]
import { loadTestTwisty, figureDict, resolveSections, curveClasses } from '../../src/data/tracks';
import curves from '../../src/data/tracks/curves.json';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { buildTrack } from '../../src/sim/track';
import type { Track } from '../../src/sim/types';
import { argValue, type Io } from '../io';

// ---------------------------------------------------------------- parameters
export interface P {
  vmax: number;
  accel: number;
  brake: number;
  driftBrake: number; // above the cap (boost over), as R22/R52
  kYaw: number; // road rotation under the car: A = curve * sp * kYaw  (vel units per second)
  latScale: number; // vx = vel * sp * latScale (half-widths per second)
  yawFullSpeed: number; // steer authority f(sp) = min(1, sp / yawFullSpeed)
  // GRIP body
  yawRateMax: number; // Y: steer -> yaw-rate target gain
  yawAlign: number; // al: self-aligning of the body toward the road tangent, 1/s
  yawResponse: number; // r: yawRate chase rate, 1/s
  grip: number; // g: vel chases yaw, 1/s
  slipGripMax: number; // usable slip in GRIP (force saturation)
  // DRIFT body
  yawRateMaxDrift: number;
  yawAlignDrift: number;
  yawResponseDrift: number;
  gripDrift: number;
  slipDriftMax: number; // force saturation in DRIFT
  slipHardMax: number; // geometric clamp of |slip| in DRIFT (no spin state)
  slipGripLimit: number; // geometric clamp of |slip| in GRIP (body cannot rotate past the motion)
  // cost
  slipDrag: number; // speed -= slipDrag * slip^2 * DT
  // entry
  driftEnterSpeed: number;
  driftExitSpeed: number;
  flickDelta: number;
  flickWindow: number; // s
  kickBase: number; // yawRate kick on entry at flickDelta
  kickGain: number; // extra kick per unit of steer change above flickDelta
  // exit
  gripRecoverTime: number;
  slipSnapMax: number;
  snapLoss: number; // vmax
  snapCatch: number; // share of the slip the velocity catches instantly
  // offroad / walls
  offroadMul: number;
  xLimit: number;
  // render mapping (not sim)
  slipDeg: number; // degrees on screen per unit of slip
}

export const BASE: P = {
  vmax: 1,
  accel: 0.22,
  brake: 0.6,
  driftBrake: 0.3,
  kYaw: 2.0,
  latScale: 1,
  yawFullSpeed: 0.3,
  yawRateMax: 15,
  yawAlign: 12.5,
  yawResponse: 50,
  grip: 22,
  slipGripMax: 0.42,
  yawRateMaxDrift: 43.6,
  yawAlignDrift: 6,
  yawResponseDrift: 12,
  gripDrift: 6.3,
  slipDriftMax: 3.0,
  slipHardMax: 3.5,
  slipGripLimit: 0.6,
  slipDrag: 0.058,
  driftEnterSpeed: 0.45,
  driftExitSpeed: 0.3,
  flickDelta: 0.5,
  flickWindow: 0.12,
  kickBase: 8,
  kickGain: 15,
  gripRecoverTime: 0.25,
  slipSnapMax: 1.2,
  snapLoss: 0.04,
  snapCatch: 0.5,
  offroadMul: 0.99,
  xLimit: 1.5,
  slipDeg: 17,
};

// ---------------------------------------------------------------- state and step
export interface S {
  x: number;
  z: number;
  speed: number;
  yaw: number;
  yawRate: number;
  vel: number;
  vx: number;
  drift: boolean;
  dir: number;
  recover: number; // s since the last DRIFT -> GRIP (grip ramps over gripRecoverTime)
  hist: number[]; // raw steer ring buffer (flick)
  histHead: number;
  histN: number;
  snaps: number;
  lastSnapLoss: number;
  entries: number;
  lastKick: number;
}

export interface In {
  steer: number;
  drift: boolean;
  brake?: boolean;
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
    recover: 1e9,
    hist: new Array<number>(64).fill(0),
    histHead: 0,
    histN: 0,
    snaps: 0,
    lastSnapLoss: 0,
    entries: 0,
    lastKick: 0,
  };
}

export const slipOf = (s: S): number => s.yaw - s.vel;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** One tick. Order: Y1 input -> Y2 flick entry -> Y3 exit/snap -> Y4 body -> Y5 motion -> Y6 move
 * and walls -> Y7 speed (R14 + slip cost + R15) -> R16. */
export function step(s: S, inp: In, curve: number, dt: number, p: P, capMul = 1): void {
  const steer = clamp(inp.steer, -1, 1); // Y1: raw steer, no R10 slew
  // Y2: flick entry, compared with every raw sample of the last flickWindow seconds.
  const w = Math.max(1, Math.round(p.flickWindow / dt));
  if (!s.drift && inp.drift && s.speed > p.driftEnterSpeed * p.vmax) {
    let best = 0;
    for (let k = 1; k <= Math.min(w, s.histN); k++) {
      const j = (s.histHead - k + 64) % 64;
      const d = steer - s.hist[j]!;
      if (Math.abs(d) > Math.abs(best)) best = d;
    }
    if (Math.abs(best) >= p.flickDelta) {
      s.drift = true;
      s.dir = best > 0 ? 1 : -1;
      const kick = p.kickBase + p.kickGain * (Math.abs(best) - p.flickDelta);
      s.yawRate += s.dir * kick;
      s.lastKick = kick;
      s.entries++;
    }
  }
  s.hist[s.histHead] = steer;
  s.histHead = (s.histHead + 1) % 64;
  if (s.histN < 64) s.histN++;
  // Y3: exit on release (R21c) or low speed; a large slip snaps.
  if (s.drift && (!inp.drift || s.speed < p.driftExitSpeed * p.vmax)) {
    s.drift = false;
    s.dir = 0;
    s.recover = 0;
    const slip = slipOf(s);
    if (Math.abs(slip) > p.slipSnapMax) {
      s.vel += slip * p.snapCatch;
      const before = s.speed;
      s.speed = Math.max(0, s.speed - p.snapLoss * p.vmax);
      s.lastSnapLoss = before - s.speed;
      s.snaps++;
    } else s.lastSnapLoss = 0;
  }
  const sp = s.speed / p.vmax;
  const A = curve * sp * p.kYaw; // road turning under the car
  const f = Math.min(1, sp / p.yawFullSpeed);
  let Y: number, al: number, r: number, g: number, smax: number;
  let hard = p.slipHardMax;
  if (s.drift) {
    Y = p.yawRateMaxDrift;
    al = p.yawAlignDrift;
    r = p.yawResponseDrift;
    g = p.gripDrift;
    smax = p.slipDriftMax;
  } else {
    Y = p.yawRateMax;
    al = p.yawAlign;
    r = p.yawResponse;
    // Y3: grip and its saturation ramp back from the DRIFT values over gripRecoverTime.
    const k = p.gripRecoverTime > 0 ? Math.min(1, s.recover / p.gripRecoverTime) : 1;
    g = p.gripDrift + (p.grip - p.gripDrift) * k;
    smax = p.slipDriftMax + (p.slipGripMax - p.slipDriftMax) * k;
    // the ramp keeps the DRIFT body for the same time (body and tyres recover together)
    Y = p.yawRateMaxDrift + (p.yawRateMax - p.yawRateMaxDrift) * k;
    al = p.yawAlignDrift + (p.yawAlign - p.yawAlignDrift) * k;
    r = p.yawResponseDrift + (p.yawResponse - p.yawResponseDrift) * k;
    hard = p.slipHardMax + (p.slipGripLimit - p.slipHardMax) * k;
    s.recover += dt;
  }
  // Y4: body. yawRate chases steer*Y*f - al*yaw; the road turns under the body.
  const target = steer * Y * f - al * s.yaw;
  s.yawRate += (target - s.yawRate) * (1 - Math.exp(-r * dt));
  s.yaw += (s.yawRate - A) * dt;
  // Y5: motion. vel chases yaw with saturation; the road turns under the velocity too.
  const slip = s.yaw - s.vel;
  // explicit force: the exponential form would make the saturated force depend on DT
  s.vel += (g * clamp(slip, -smax, smax) - A) * dt;
  // no spin state: |slip| is clamped geometrically (the body stops rotating further).
  const sl = s.yaw - s.vel;
  if (sl > hard) {
    s.yaw = s.vel + hard;
    if (s.yawRate > A) s.yawRate = A;
  } else if (sl < -hard) {
    s.yaw = s.vel - hard;
    if (s.yawRate < A) s.yawRate = A;
  }
  // Y6: lateral move, R18 walls.
  s.vx = s.vel * sp * p.latScale;
  s.x += s.vx * dt;
  if (s.x > p.xLimit) {
    s.x = p.xLimit;
    if (s.vel > 0) s.vel = 0;
  } else if (s.x < -p.xLimit) {
    s.x = -p.xLimit;
    if (s.vel < 0) s.vel = 0;
  }
  // Y7: R14 throttle/brake/cap, then slip cost, then R15.
  const cap = p.vmax * capMul;
  let v = s.speed;
  if (inp.brake) v -= p.brake * dt;
  else if (v > cap) v = Math.max(cap, v - p.driftBrake * dt);
  else v = Math.min(cap, v + p.accel * dt);
  const sl2 = s.yaw - s.vel;
  v -= p.slipDrag * sl2 * sl2 * dt;
  if (v < 0) v = 0;
  if (s.x > 1 || s.x < -1) v *= Math.pow(p.offroadMul, 60 * dt);
  s.speed = v;
  s.z += v * dt * SEG_PER_UNIT; // R16
}

// ---------------------------------------------------------------- helpers
const f2 = (v: number, d = 3): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));
const deg = (slip: number, p: P): string => `${(slip * p.slipDeg).toFixed(1)}В°`;
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
function table(io: Io, head: string[], rows: (string | number)[][]): void {
  const cells = [head, ...rows.map((r) => r.map((c) => (typeof c === 'number' ? f2(c) : c)))];
  const wd = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  for (const r of cells) io.log('| ' + r.map((c, i) => pad(c, wd[i]!)).join(' | ') + ' |');
}
let pass = 0;
let fail = 0;
const verdicts: string[] = [];
function verdict(io: Io, name: string, ok: boolean, note: string): void {
  if (ok) pass++;
  else fail++;
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${note}`;
  verdicts.push(line);
  io.log(line);
}

const C = curves as { easy: number; medium: number; hard: number };

/** Drift-hold / grip controller by model inversion (used by S3-S8). */
export interface Ctl {
  kx: number; // lateral position gain, vel per half-width
  kv: number; // vel error -> extra slip, 1/s
  ky: number; // yaw error -> yaw rate, 1/s
  velMax: number;
}
const CTL: Ctl = { kx: 2.5, kv: 5, ky: 8, velMax: 1.2 };

/** Steer that drives x toward xT, given the curve used for feed-forward. */
export function holdSteer(s: S, xT: number, curveFF: number, p: P, c: Ctl = CTL): number {
  const sp = s.speed / p.vmax;
  const A = curveFF * sp * p.kYaw;
  const d = s.drift;
  const g = d ? p.gripDrift : p.grip;
  const smax = d ? p.slipDriftMax : p.slipGripMax;
  const Y = d ? p.yawRateMaxDrift : p.yawRateMax;
  const al = d ? p.yawAlignDrift : p.yawAlign;
  const f = Math.min(1, sp / p.yawFullSpeed);
  const vT = clamp(c.kx * (xT - s.x), -c.velMax, c.velMax);
  const slipT = clamp((A + c.kv * (vT - s.vel)) / g, -smax, smax);
  const yawT = s.vel + slipT;
  const rateT = A + c.ky * (yawT - s.yaw);
  return clamp((rateT + al * s.yaw) / (Y * Math.max(f, 1e-3)), -1, 1);
}

function curveAt(t: Track, z: number): number {
  const n = t.segments.length;
  let i = Math.floor(z) % n;
  if (i < 0) i += n;
  return t.segments[i]!.curve;
}

// ---------------------------------------------------------------- S1 straight lane change
function s1(
  io: Io,
  p: P,
  dt: number,
  speed = 1,
  quiet = false,
): { ok: boolean; shift: number; lc: number } {
  const s = makeState(speed);
  const rows: (string | number)[][] = [];
  let peakYaw = 0;
  let peakVx = 0;
  let maxX = 0;
  const T = 0.4;
  const total = 1.6;
  let settle = NaN;
  let osc = 0;
  let lastSign = 0;
  for (let t = 0; t <= total + 1e-9; t += dt) {
    const steer = t < T ? 0.5 : 0;
    step(s, { steer, drift: false }, 0, dt, p, speed);
    peakYaw = Math.max(peakYaw, Math.abs(s.yaw));
    peakVx = Math.max(peakVx, Math.abs(s.vx));
    maxX = Math.max(maxX, s.x);
    if (t > T) {
      const sg = Math.sign(s.vx);
      if (sg !== 0 && lastSign !== 0 && sg !== lastSign && Math.abs(s.vx) > 0.02 * peakVx) osc++;
      if (sg !== 0) lastSign = sg;
      if (
        Number.isNaN(settle) &&
        Math.abs(s.yaw) < 0.02 * peakYaw &&
        Math.abs(s.vx) < 0.02 * peakVx
      )
        settle = t - T;
    }
    if (!quiet && Math.round(t / dt) % Math.round(0.1 / dt) === 0)
      rows.push([f2(t, 2), steer, s.yaw, s.vel, s.vx, s.x]);
  }
  const over = (maxX - s.x) / s.x;
  // full-steer lane change across 2 lanes (0.5 hw): steer 1 until predicted landing, then 0
  const q = makeState(speed);
  let lc = NaN;
  let released = false;
  for (let t = 0; t < 2; t += dt) {
    // ideal driver: release when a forward copy with steer 0 would settle at x >= 0.5
    if (!released) {
      const c = { ...q, hist: [...q.hist] };
      for (let k = 0; k < 1 / dt; k++) step(c, { steer: 0, drift: false }, 0, dt, p, speed);
      if (c.x >= 0.5) released = true;
    }
    step(q, { steer: released ? 0 : 1, drift: false }, 0, dt, p, speed);
    if (Math.abs(q.x - 0.5) < 0.025 && Math.abs(q.vx) < 0.05 && Number.isNaN(lc)) lc = t;
  }
  const ok =
    Math.abs(s.x - 0.25) < 0.04 &&
    settle <= 0.6 &&
    over < 0.1 &&
    osc === 0 &&
    lc >= 0.5 &&
    lc <= 0.8;
  if (!quiet) {
    io.log(`\n## S1 straight, speed ${speed}, dt 1/${Math.round(1 / dt)}`);
    table(io, ['t', 'steer', 'yaw', 'vel', 'vx', 'x'], rows);
    io.log(
      `shift ${f2(s.x)} hw, settle(2%) ${f2(settle, 2)} s after release, overshoot ${f2(over * 100, 1)}%, sign changes ${osc}, 2-lane change (0.5 hw, В±1/4 lane, vx<0.05) ${f2(lc, 2)} s, final x ${f2(q.x)}`,
    );
  }
  return { ok, shift: s.x, lc };
}

// ---------------------------------------------------------------- S2 grip on constant curves
/** Bisection on a constant steer so that the car holds x (mean vel ~0 over the last second). */
function holdConstSteer(
  p: P,
  curve: number,
  drift: boolean,
  dt: number,
  secs = 3,
  speed = 1,
): {
  steer: number;
  slip: number;
  speed: number;
  vel: number;
} {
  // measurement only: no walls, no offroad loss (the question is the steer, not the road edge)
  const q: P = { ...p, xLimit: 1e9, offroadMul: 1 };
  let lo = drift ? 0 : -1;
  let hi = 1;
  let res = { steer: NaN, slip: NaN, speed: NaN, vel: NaN };
  for (let it = 0; it < 30; it++) {
    const st = (lo + hi) / 2;
    const s = makeState(speed);
    const A = curve * speed * p.kYaw;
    s.yawRate = A;
    s.yaw = A / (drift ? p.gripDrift : p.grip);
    if (drift) {
      s.drift = true;
      s.dir = Math.sign(curve);
    }
    let velSum = 0;
    let n = 0;
    for (let t = 0; t < secs; t += dt) {
      step(s, { steer: st * Math.sign(curve), drift }, curve, dt, q);
      if (t > secs - 1) {
        velSum += s.vel;
        n++;
      }
    }
    const v = (velSum / n) * Math.sign(curve);
    res = { steer: st, slip: slipOf(s) * Math.sign(curve), speed: s.speed, vel: v };
    if (v > 0) hi = st;
    else lo = st;
  }
  return res;
}

function s2(io: Io, p: P, dt: number): void {
  io.log(`\n## S2 GRIP at vmax on constant curves (holding steer by bisection, 3 s)`);
  const rows: (string | number)[][] = [];
  const out: Record<string, { steer: number; slip: number; vel: number }> = {};
  for (const k of ['easy', 'medium', 'hard'] as const) {
    const h = holdConstSteer(p, C[k], false, dt);
    out[k] = h;
    rows.push([k, C[k], h.steer, h.slip, deg(h.slip, p), h.speed, h.vel]);
  }
  table(
    io,
    ['class', 'curve', 'hold steer', 'slip', 'slip on screen', 'speed', 'vel (last 1 s)'],
    rows,
  );
  // hard at full steer, time series
  const s = makeState(1);
  const ts: (string | number)[][] = [];
  for (let t = 0; t <= 1.5 + 1e-9; t += dt) {
    step(s, { steer: 1, drift: false }, C.hard, dt, p);
    if (Math.round(t / dt) % Math.round(0.25 / dt) === 0)
      ts.push([f2(t, 2), s.yaw, s.vel, slipOf(s), deg(slipOf(s), p), s.x, s.speed]);
  }
  io.log('hard, GRIP, full steer from x = 0:');
  table(io, ['t', 'yaw', 'vel', 'slip', 'deg', 'x', 'speed'], ts);
  verdict(
    io,
    'S2 easy',
    out.easy!.steer >= 0.4 && out.easy!.steer <= 0.5,
    `hold steer ${f2(out.easy!.steer, 2)} (0.4-0.5)`,
  );
  verdict(
    io,
    'S2 medium',
    out.medium!.steer >= 0.9 && out.medium!.steer <= 1.0,
    `hold steer ${f2(out.medium!.steer, 2)} (0.9-1.0)`,
  );
  verdict(
    io,
    'S2 hard',
    out.hard!.vel < -0.05 && s.x < -0.5 && slipOf(s) > 0,
    `full steer: vel ${f2(out.hard!.vel)} (out), x ${f2(s.x)} after 1.5 s, yaw points in (slip ${deg(slipOf(s), p)})`,
  );
}

// ---------------------------------------------------------------- S3 drift holding
function s3(io: Io, p: P, dt: number, quiet = false): { ok: boolean } {
  if (!quiet) io.log(`\n## S3 DRIFT at vmax, constant curve (holding steer by bisection, 4 s)`);
  const rows: (string | number)[][] = [];
  const h: Record<string, ReturnType<typeof holdConstSteer>> = {};
  for (const k of ['easy', 'medium', 'hard'] as const) {
    const sp = equilibriumSpeed(p, C[k]);
    h[k] = holdConstSteer(p, C[k], true, dt, 4, sp);
    rows.push([k, h[k].steer, h[k].slip, deg(h[k].slip, p), h[k].speed, sp]);
  }
  if (!quiet) {
    table(
      io,
      ['class', 'hold steer', 'slip', 'on screen', 'speed after 4 s', 'equilibrium speed'],
      rows,
    );
    // steer around the hold value on hard: slip, speed and line (vel)
    io.log('hard, steer around the hold value (4 s from steady entry):');
    const t2: (string | number)[][] = [];
    for (const d of [-0.3, -0.15, 0, 0.15, 0.3]) {
      const st = h.hard!.steer + d;
      const q: P = { ...p, xLimit: 1e9, offroadMul: 1 };
      const v0 = equilibriumSpeed(p, C.hard);
      const s = makeState(v0);
      s.drift = true;
      s.dir = 1;
      s.yawRate = C.hard * v0 * p.kYaw;
      s.yaw = s.yawRate / p.gripDrift;
      let slipSum = 0;
      let n = 0;
      for (let t = 0; t < 2; t += dt) {
        step(s, { steer: st, drift: true }, C.hard, dt, q);
        slipSum += slipOf(s);
        n++;
      }
      t2.push([f2(st, 2), slipSum / n, deg(slipSum / n, p), s.speed, s.vel, s.x]);
    }
    table(io, ['steer', 'mean slip 2 s', 'deg', 'speed 2 s', 'vel (+ in)', 'x 2 s'], t2);
    io.log('slip held constant (forced) vs steady speed (accel = slipDrag*slip^2):');
    const t3: (string | number)[][] = [];
    for (const sl of [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]) {
      t3.push([sl, deg(sl, p), Math.min(1, Math.sqrt(p.accel / p.slipDrag) / sl)]);
    }
    table(io, ['slip', 'deg', 'steady speed'], t3);
  }
  const hd = h.hard!.slip * p.slipDeg;
  const md = h.medium!.slip * p.slipDeg;
  const eqH = equilibriumSpeed(p, C.hard);
  const eqM = equilibriumSpeed(p, C.medium);
  const ok1 = hd >= 30 && hd <= 40;
  const ok2 = md >= 15 && md <= 25;
  const ok3 = eqH >= 0.85 && eqM >= 0.92;
  const ok4 =
    h.hard!.steer >= 0.3 &&
    h.hard!.steer <= 0.7 &&
    h.medium!.steer >= 0.3 &&
    h.medium!.steer <= 0.7;
  if (!quiet) {
    verdict(io, 'S3 hard angle', ok1, `${hd.toFixed(1)}В° (30-40)`);
    verdict(io, 'S3 medium angle', ok2, `${md.toFixed(1)}В° (15-25)`);
    verdict(io, 'S3 speed', ok3, `hard ${f2(eqH)} (>=0.85), medium ${f2(eqM)} (>=0.92)`);
    verdict(
      io,
      'S3 hold steer mid',
      ok4,
      `hard ${f2(h.hard!.steer, 2)}, medium ${f2(h.medium!.steer, 2)}, easy ${f2(h.easy!.steer, 2)} (0.3-0.7)`,
    );
  }
  return { ok: ok1 && ok2 && ok3 && ok4 };
}

/** Speed at which slipDrag*(A/gripDrift)^2 = accel (steady drift on a constant curve). */
function equilibriumSpeed(p: P, curve: number): number {
  // slip = curve*sp*kYaw/gD; accel = D*slip^2
  const v = (Math.sqrt(p.accel / p.slipDrag) * p.gripDrift) / (Math.abs(curve) * p.kYaw);
  return Math.min(1, v);
}

// ---------------------------------------------------------------- S4 flick entry
function flickRun(
  p: P,
  curve: number,
  from: number,
  to: number,
  dt: number,
  holdFlick = 0.06,
  counter = false,
): { stable: number; peak: number; recover: number; kick: number; entered: boolean } {
  const s = makeState(1);

  let t = 0;
  // 0.3 s straight at steer 0, 0.13 s swing to the flick's start steer (drift not held), the corner starts at the flick
  for (; t < 0.3; t += dt) step(s, { steer: 0, drift: false }, 0, dt, p);
  for (; t < 0.43; t += dt) step(s, { steer: from, drift: false }, 0, dt, p); // the swing before the flick (> flickWindow)
  const dir = Math.sign(curve);
  const need = (Math.abs(curve) * p.kYaw) / p.gripDrift;
  let stable = NaN;
  let peak = 0;
  let recover = NaN;
  let inBand = 0;
  let overSince = NaN;
  for (let tt = 0; tt < 2.5; tt += dt) {
    let steer: number;
    if (tt < holdFlick) steer = to;
    else if (counter && Number.isNaN(recover) && slipOf(s) * dir > need * 1.25) {
      steer = -dir; // counter-steer until the slip is back in the band
      if (Number.isNaN(overSince)) overSince = tt;
    } else steer = holdSteer(s, 0, curve, p);
    if (!Number.isNaN(overSince) && Number.isNaN(recover) && slipOf(s) * dir <= need * 1.25)
      recover = tt - overSince;
    step(s, { steer, drift: true }, curve, dt, p);
    const sl = slipOf(s) * dir;
    if (tt < 0.5) peak = Math.max(peak, sl);
    const sNeed = (Math.abs(curve) * s.speed * p.kYaw) / p.gripDrift;
    if (s.drift && Math.abs(sl - sNeed) < 0.2 * sNeed) inBand += dt;
    else inBand = 0;
    if (inBand >= 0.15 && Number.isNaN(stable)) stable = tt - 0.15;
  }
  return { stable, peak, recover, kick: s.lastKick, entered: s.entries > 0 };
}

function s4(io: Io, p: P, dt: number, quiet = false): boolean {
  if (!quiet)
    io.log(
      `\n## S4 flick entry at vmax (GRIP 0.3 s on the curve, flick, then the hold controller)`,
    );
  const rows: (string | number)[][] = [];
  let ok = true;
  const res: Record<string, ReturnType<typeof flickRun>> = {};
  for (const k of ['medium', 'hard'] as const) {
    const gripSteer = Math.min(1, holdConstSteer(p, C[k], false, dt, 2).steer);
    for (const [name, from, to] of [
      ['weak (0.55)', 0.45, 1.0], // from = to - 0.55
      ['normal (1.0)', 0, 1.0],
      ['strong (2.0)', -1, 1.0],
    ] as const) {
      void gripSteer;
      const fromS = from;
      const r = flickRun(p, C[k], fromS, to, dt);
      res[`${k} ${name}`] = r;
      rows.push([
        k,
        name,
        f2(fromS, 2) + '->' + f2(to, 2),
        r.kick,
        r.peak,
        deg(r.peak, p),
        f2(r.stable, 2),
      ]);
      if (!(r.stable < 0.6)) ok = false;
    }
    const over = flickRun(p, C[k], -1, 1, dt, 0.25, true);
    rows.push([
      k,
      'strong + held 0.25 s + counter',
      '-1->1',
      over.kick,
      over.peak,
      deg(over.peak, p),
      f2(over.stable, 2) + ` (recover ${f2(over.recover, 2)} s)`,
    ]);
    if (!(over.recover <= 0.5 || Number.isNaN(over.recover))) ok = false;
    res[`${k} over`] = over;
  }
  if (!quiet) {
    table(
      io,
      ['class', 'flick', 'steer', 'kick', 'peak slip 0.5 s', 'deg', 'stable after, s'],
      rows,
    );
    const wk = res['hard weak (0.55)']!;
    const st = res['hard strong (2.0)']!;
    verdict(io, 'S4 time to stable < 0.6 s', ok, 'all rows above');
    verdict(
      io,
      'S4 weak vs strong angle',
      st.peak - wk.peak > 0.2,
      `hard peak ${deg(wk.peak, p)} vs ${deg(st.peak, p)}`,
    );
    const oh = res['hard over']!;
    verdict(
      io,
      'S4 over-rotation recoverable',
      Number.isNaN(oh.recover) || oh.recover <= 0.5,
      `hard: recover ${f2(oh.recover, 2)} s (NaN = never over the band)`,
    );
  }
  return ok;
}

// ---------------------------------------------------------------- S5 exit
function s5(io: Io, p: P, dt: number): void {
  io.log(`\n## S5 exit`);
  const steadyHard = (): S => {
    const s = makeState(1);
    s.drift = true;
    s.dir = 1;
    s.yaw = (C.hard * p.kYaw) / p.gripDrift;
    for (let t = 0; t < 1.5; t += dt)
      step(s, { steer: holdSteer(s, 0, C.hard, p), drift: true }, C.hard, dt, p);
    return s;
  };
  // (a) release mid-corner, then the grip controller wants x = 0 (full steer in practice)
  {
    const s = steadyHard();
    const slip0 = slipOf(s);
    const v0 = s.speed;
    const rows: (string | number)[][] = [];
    for (let t = 0; t <= 1.0 + 1e-9; t += dt) {
      step(s, { steer: holdSteer(s, 0, C.hard, p), drift: false }, C.hard, dt, p);
      if (Math.round(t / dt) % Math.round(0.1 / dt) === 0)
        rows.push([f2(t, 2), s.yaw, s.vel, slipOf(s), s.x, s.speed]);
    }
    io.log(
      `(a) release mid-corner on hard, slip at release ${deg(slip0, p)}, speed ${f2(v0)}; grip controller after:`,
    );
    table(io, ['t', 'yaw', 'vel', 'slip', 'x', 'speed'], rows);
    verdict(
      io,
      'S5a understeer out',
      s.x < -0.3,
      `x ${f2(s.x)} after 1 s (out = negative), snap ${s.snaps ? `yes, -${f2(s.lastSnapLoss)} vmax` : 'no'}`,
    );
  }
  // (b) clean exit: hard -> straight (ramp 35 segments like the hairpin leave), release when |slip| < snap
  {
    const curveOf = (z: number): number =>
      z < 60 ? C.hard : z < 95 ? C.hard * (0.5 + Math.cos((Math.PI * (z - 60)) / 35) / 2) : 0;
    const s = steadyHard();
    s.z = 0;
    let rel = NaN;
    let relSlip = NaN;
    let maxX = 0;
    for (let t = 0; t < 3; t += dt) {
      const c = curveOf(s.z);
      const cA = curveOf(s.z + s.speed * 60 * 0.3);
      const wantRelease = s.drift && cA < 1.5 && Math.abs(slipOf(s)) < p.slipSnapMax;
      if (wantRelease && Number.isNaN(rel)) {
        rel = t;
        relSlip = slipOf(s);
      }
      const held = Number.isNaN(rel);
      step(s, { steer: holdSteer(s, 0, held ? cA : c, p), drift: held }, c, dt, p);
      maxX = Math.max(maxX, Math.abs(s.x));
    }
    verdict(
      io,
      'S5b clean exit',
      s.snaps === 0 && maxX < 1,
      `release at t ${f2(rel, 2)} s with slip ${deg(relSlip, p)}, snaps ${s.snaps}, max|x| ${f2(maxX)}`,
    );
  }
  // (c) release with large slip
  {
    const s = steadyHard();
    const slip0 = slipOf(s);
    const v0 = s.speed;
    step(s, { steer: 0, drift: false }, C.hard, dt, p);
    const vxJerk = s.vx;
    verdict(
      io,
      'S5c snap',
      s.snaps === 1,
      `slip ${deg(slip0, p)} > ${deg(p.slipSnapMax, p)}: speed ${f2(v0)} -> ${f2(s.speed)} (-${f2(s.lastSnapLoss)} vmax), vx jerk to ${f2(vxJerk)} hw/s`,
    );
  }
}

// ---------------------------------------------------------------- bot
export interface BotCfg {
  look: number; // s, feed-forward look-ahead
  flickLook: number; // s, look-ahead for the drift decision
  releaseLook: number; // s
  gripMargin: number; // drift when needed grip slip > gripMargin * slipGripMax
  releaseCurve: number; // release when curve ahead * dir < this
  lineIn: number; // target x toward the inside in DRIFT (half-widths)
}
export const BOT: BotCfg = {
  look: 0.15,
  flickLook: 0.35,
  releaseLook: 0.25,
  gripMargin: 1.0,
  releaseCurve: 2.2,
  lineIn: 0.3,
};

interface BotState {
  dip: boolean;
  cool: number;
}

function botInput(s: S, b: BotState, t: Track, p: P, cfg: BotCfg, prevSteer: number): In {
  const sp = s.speed / p.vmax;
  const segPerS = s.speed * SEG_PER_UNIT;
  const cFF = curveAt(t, s.z + segPerS * cfg.look);
  const cFl = curveAt(t, s.z + segPerS * cfg.flickLook);
  const cRel = curveAt(t, s.z + segPerS * cfg.releaseLook);
  if (b.cool > 0) b.cool--;
  if (s.drift) {
    // release when the corner ends or turns the other way
    const flip = cRel * s.dir < -0.5; // the next corner turns the other way: release now
    const ending = cRel * s.dir < cfg.releaseCurve && Math.abs(slipOf(s)) < p.slipSnapMax * 0.95;
    if (flip || ending) {
      return { steer: holdSteer(s, 0, cFF, p), drift: false };
    }
    return { steer: holdSteer(s, cfg.lineIn * s.dir, cFF, p), drift: true };
  }
  const need = (Math.abs(cFl) * sp * p.kYaw) / p.grip;
  if (
    need > cfg.gripMargin * p.slipGripMax &&
    s.speed > p.driftEnterSpeed * p.vmax &&
    b.cool === 0
  ) {
    const dir = Math.sign(cFl);
    if (b.dip || Math.abs(dir - prevSteer) >= p.flickDelta + 0.05) {
      b.dip = false;
      b.cool = 20;
      return { steer: dir, drift: true };
    }
    b.dip = true; // one tick toward the other side, drift not yet held
    return { steer: prevSteer - dir * 0.6, drift: false };
  }
  return { steer: holdSteer(s, 0, cFF, p), drift: false };
}

interface LapStats {
  laps: number[];
  driftShare: number;
  minSpeed: number;
  maxAbsX: number;
  offTicks: number;
  snaps: number;
  entries: number;
  nan: boolean;
  meanSpeed: number;
  worstZ: number;
}

function runBot(p: P, track: Track, dt: number, lapsN = 3, cfg: BotCfg = BOT): LapStats {
  const n = track.segments.length;
  const s = makeState(0);
  const b: BotState = { dip: false, cool: 0 };
  let prev = 0;
  const laps: number[] = [];
  let lastLap = 0;
  let drift = 0;
  let ticks = 0;
  let minSpeed = Infinity;
  let maxAbsX = 0;
  let worstZ = 0;
  let off = 0;
  let nan = false;
  let sum = 0;
  const maxT = 400;
  for (let t = 0; t < maxT && laps.length < lapsN; t += dt) {
    const inp = botInput(s, b, track, p, cfg, prev);
    prev = inp.steer;
    step(s, inp, curveAt(track, s.z), dt, p);
    ticks++;
    if (s.drift) drift++;
    sum += s.speed;
    if (laps.length >= 1 && s.speed < minSpeed) minSpeed = s.speed;
    if (Math.abs(s.x) > maxAbsX) {
      maxAbsX = Math.abs(s.x);
      worstZ = s.z % n;
    }
    if (Math.abs(s.x) > 1) off++;
    if (!Number.isFinite(s.x + s.speed + s.yaw)) {
      nan = true;
      break;
    }
    if (s.z >= (laps.length + 1) * n) {
      laps.push(t + dt - lastLap);
      lastLap = t + dt;
    }
  }
  return {
    laps,
    driftShare: drift / ticks,
    minSpeed,
    maxAbsX,
    offTicks: off,
    snaps: s.snaps,
    entries: s.entries,
    nan,
    meanSpeed: sum / ticks,
    worstZ,
  };
}

function s6(io: Io, p: P, dt: number): boolean {
  const def = resolveSections(
    [
      { enter: 0, hold: 200, leave: 0, curveClass: 'straight', side: 1 },
      ...figureDict.flick!.parts.map((q) => ({ ...q })),
      { enter: 0, hold: 300, leave: 0, curveClass: 'straight', side: 1 },
    ],
    curveClasses,
  );
  const track = buildTrack(def);
  const r = runBot(p, track, dt, 1);
  const ok = r.laps.length === 1 && r.maxAbsX <= 1 && !r.nan;
  verdict(
    io,
    'S6 flick figure',
    ok,
    `time ${f2(r.laps[0] ?? NaN, 2)} s (start at 0), drifts ${r.entries}, snaps ${r.snaps}, max|x| ${f2(r.maxAbsX)}, min speed (after start) n/a, drift share ${f2(r.driftShare, 2)}`,
  );
  // trace through the figure at vmax: start at speed 1 on the straight
  return ok;
}

// ---------------------------------------------------------------- S7 response times
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
function s7(io: Io, p: P, dt: number): void {
  io.log(`\n## S7 response times at vmax on a straight (10-90%)`);
  const rows: (string | number)[][] = [];
  for (const drift of [false, true]) {
    // steer -> yaw: step 0 -> 0.5
    const s = makeState(1);
    s.drift = drift;
    s.dir = 1;
    const yawS: number[] = [];
    for (let t = 0; t < 1.5; t += dt) {
      step(s, { steer: 0.5, drift }, 0, dt, p);
      yawS.push(s.yaw);
    }
    // yaw -> vel: yaw forced to a step, body frozen
    const q = makeState(1);
    q.drift = drift;
    q.dir = 1;
    const velS: number[] = [];
    for (let t = 0; t < 1.5; t += dt) {
      q.yaw = 0.5;
      q.yawRate = 0;
      step(q, { steer: 0, drift }, 0, dt, p);
      q.yaw = 0.5;
      velS.push(q.vel);
    }
    rows.push([drift ? 'DRIFT' : 'GRIP', rise(yawS, dt), rise(velS, dt), yawS[yawS.length - 1]!]);
  }
  table(io, ['state', 'steer->yaw', 'yaw->vel', 'yaw at steer 0.5'], rows);
  const g = rows[0]!;
  const d = rows[1]!;
  verdict(
    io,
    'S7 GRIP steer->yaw',
    (g[1] as number) >= 0.1 && (g[1] as number) <= 0.15,
    `${f2(g[1] as number)} s (0.10-0.15)`,
  );
  verdict(
    io,
    'S7 GRIP yaw->vel',
    (g[2] as number) >= 0.08 && (g[2] as number) <= 0.12,
    `${f2(g[2] as number)} s (0.08-0.12)`,
  );
  verdict(
    io,
    'S7 DRIFT yaw->vel',
    (d[2] as number) >= 0.3 && (d[2] as number) <= 0.4,
    `${f2(d[2] as number)} s (0.30-0.40); DRIFT steer->yaw ${f2(d[1] as number)} s`,
  );
}

// ---------------------------------------------------------------- S8 laps
function s8(io: Io, p: P, dt: number, quiet = false): LapStats {
  const tw = loadTestTwisty();
  const track = buildTrack(tw.def);
  const r = runBot(p, track, dt, 3);
  if (!quiet) {
    io.log(
      `\n## S8 bot, 3 laps of ${tw.name} (${track.segments.length} segments), dt 1/${Math.round(1 / dt)}`,
    );
    table(
      io,
      [
        'laps, s',
        'drift share',
        'min speed (laps 2-3)',
        'mean speed',
        'max|x|',
        'offroad ticks',
        'drifts',
        'snaps',
      ],
      [
        [
          r.laps.map((v) => v.toFixed(2)).join(' / '),
          r.driftShare,
          r.minSpeed,
          r.meanSpeed,
          r.maxAbsX,
          String(r.offTicks),
          String(r.entries),
          String(r.snaps),
        ],
      ],
    );
    verdict(
      io,
      'S8 3 laps on the road',
      r.laps.length === 3 && r.maxAbsX <= 1 && !r.nan,
      `lap ${r.laps.map((v) => v.toFixed(1)).join('/')} s vs current expert 82.4 s, drift share ${f2(r.driftShare, 2)} vs 0.54, worst |x| at ${sectionAt(tw.sections, r.worstZ)}`,
    );
  }
  return r;
}

function sectionAt(
  secs: readonly { enter: number; hold: number; leave: number; curveClass: string; side: number }[],
  z: number,
): string {
  let acc = 0;
  for (let i = 0; i < secs.length; i++) {
    const q = secs[i]!;
    const len = q.enter + q.hold + q.leave;
    if (z < acc + len)
      return `section ${i} ${q.curveClass}${q.side > 0 ? ' R' : ' L'} +${Math.round(z - acc)}/${len}`;
    acc += len;
  }
  return '?';
}

// ---------------------------------------------------------------- S9 robustness
function s9(io: Io, p: P): void {
  io.log(`\n## S9 robustness`);
  const rows: (string | number)[][] = [];
  let ok = true;
  for (const hz of [60, 120, 240]) {
    const dt = 1 / hz;
    const a = s1(io, p, dt, 1, true);
    const h = holdConstSteer(p, C.hard, true, dt, 4);
    const m = holdConstSteer(p, C.medium, false, dt, 3);
    const b = s8(io, p, dt, true);
    rows.push([
      `1/${hz}`,
      a.shift,
      a.lc,
      m.steer,
      h.steer,
      deg(h.slip, p),
      b.laps.map((v) => v.toFixed(2)).join('/'),
      b.maxAbsX,
      b.driftShare,
    ]);
    if (!(b.laps.length === 3 && b.maxAbsX <= 1 && !b.nan)) ok = false;
  }
  table(
    io,
    [
      'dt',
      'S1 shift',
      'S1 2-lane s',
      'grip medium hold',
      'drift hard hold',
      'hard slip',
      'bot laps',
      'max|x|',
      'drift share',
    ],
    rows,
  );
  verdict(io, 'S9 dt', ok, '60/120/240 Hz: same qualitative behaviour (rows above)');
  const r2: (string | number)[][] = [];
  let ok2 = true;
  for (const v of [0.3, 0.5, 0.8, 1.0, 1.13]) {
    const a = s1(io, p, DT, v, true); // S1 at a capped speed
    // drift on hard at this speed with the hold controller: bounded?
    const s = makeState(v);
    s.drift = v > p.driftExitSpeed;
    s.dir = 1;
    let maxSlip = 0;
    let fin = true;
    for (let t = 0; t < 3; t += DT) {
      step(s, { steer: holdSteer(s, 0, C.hard, p), drift: true }, C.hard, DT, p, v);
      maxSlip = Math.max(maxSlip, Math.abs(slipOf(s)));
      if (!Number.isFinite(s.x + s.yaw)) fin = false;
    }
    r2.push([v, a.shift, a.lc, maxSlip, s.x, s.speed, String(fin)]);
    if (!fin || Math.abs(s.x) > 1) ok2 = false;
  }
  table(
    io,
    ['speed', 'S1 shift (hw)', '2-lane s', 'hard drift max slip', 'x 3 s', 'speed 3 s', 'finite'],
    r2,
  );
  verdict(io, 'S9 speed range', ok2, '0.3-1.13 vmax: finite, drift on hard held on the road');
}

/** Time series of a flick on hard (0 -> 1, finger at 1 for 0.06 s, then the hold controller). */
function trace(io: Io, p: P, dt: number): void {
  for (const k of ['medium', 'hard'] as const) {
    const curve = C[k];
    const s = makeState(1);
    for (let t = 0; t < 0.3; t += dt) step(s, { steer: 0, drift: false }, 0, dt, p);
    io.log(`\n## TRACE flick 0 -> 1 on ${k}`);
    const rows: (string | number)[][] = [];
    for (let i = 0; i < Math.round(1.2 / dt); i++) {
      const tt = i * dt;
      const steer = tt < 0.06 ? 1 : holdSteer(s, 0, curve, p);
      step(s, { steer, drift: true }, curve, dt, p);
      if (i % Math.round(0.04 / dt) === 0)
        rows.push([
          f2(tt, 2),
          steer,
          s.yawRate,
          s.yaw,
          s.vel,
          slipOf(s),
          deg(slipOf(s), p),
          s.x,
          s.speed,
        ]);
    }
    table(io, ['t', 'steer', 'yawRate', 'yaw', 'vel', 'slip', 'deg', 'x', 'speed'], rows);
  }
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
  io.log(`# yaw-slip spike, dt 1/${hz}`);
  if (want('S1')) {
    const r = s1(io, p, dt);
    verdict(
      io,
      'S1 lane change',
      r.ok,
      `shift ${f2(r.shift)} (в‰€0.25), 2-lane ${f2(r.lc, 2)} s (0.5-0.8), settle/overshoot/oscillation in the line above`,
    );
  }
  if (want('S2')) s2(io, p, dt);
  if (want('S3')) s3(io, p, dt);
  if (want('S4')) s4(io, p, dt);
  if (want('S5')) s5(io, p, dt);
  if (want('S6')) s6(io, p, dt);
  if (want('S7')) s7(io, p, dt);
  if (want('S8')) s8(io, p, dt);
  if (want('S9')) s9(io, p);
  if (only?.includes('TRACE')) trace(io, p, dt);
  io.log(`\n# verdicts: ${pass} pass, ${fail} fail`);
  for (const v of verdicts) io.log(v);
  return 0;
}

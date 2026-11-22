// THROWAWAY SPIKE (docs/research/model-c.md): driving model C, "drift by angle" after the OutRun 2
// decompilation (docs/research/outrun2-decomp-driving.md). Prototype only: src/, data and tests are
// untouched. GRIP ticks run through the REAL src/sim `step` (model B GRIP: R83, R84, R85b-R85f,
// R86b); DRIFT ticks and the entry window are the model C prototype below (stepC). The touch
// mapping of the second axis (throttle) is a pure function here too.
// Run: node tools/run-ts.mjs tools/spike/model-c.ts [--part entry|steady|exit|straight|s|noinput|jitter|tap|lap|sweep|trace|all]
import { baseCar } from '../../src/data/cars';
import sprites from '../../src/data/sprites.json';
import {
  curveClasses,
  loadTestTwisty,
  loadTrackByName,
  resolveSections,
  trackSections,
} from '../../src/data/tracks';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { argValue, type Io } from '../io';

const C = curveClasses as Record<string, number>;
const SLIP_DEG = (sprites as { weight: { slipDeg: number } }).weight.slipDeg;
// Model B GRIP as shipped (variant 3, turbo off); model C reuses it outside DRIFT.
const P: CarParams = { ...baseCar, driftTurbo: 0, driftEntry: 3 };

// ---------------------------------------------------------------- model C parameters (start)
/** Proposed car params of model C (would live in cars/base.json). Angles in degrees. */
export const MC = {
  liftOn: 0.4, // throttle <= -liftOn opens the entry window (edge)
  liftOff: 0.2, // throttle > -liftOff re-arms the edge (hysteresis)
  driftWindow: 0.5, // s, entry window after a lift (OR2: 0.66)
  switchWindow: 0.3, // s, after a drift end: a slip to the other side latches without a lift
  betaEntry: 40, // deg, window slip target at full steer
  entryFloor: 12, // deg, > 0: constant floor of the angle target for the rest of the window; 0: floor u*betaEntry
  winTau: 0.06, // s, window slip filter
  betaOn: 8.4, // deg, drift threshold (OR2 0x600)
  driftEndDelay: 0.2, // s below betaOn before the drift ends (OR2: 12 ticks)
  betaPerA: 3.4, // deg of hold angle per unit of A = curve*sp*kYaw
  refLook: 0.3, // s of road ahead averaged into the reference
  refTau: 0.12, // s, reference smoothing
  uHold: 0.5, // finger share (steer*dir) that holds the reference angle
  betaMax: 70, // deg, physical slip limit (spin guard; OR2 73.1)
  betaTau: 0.12, // s, angle chase
  latPerDeg: 0.02, // half-widths/s (at vmax) of course per degree of angle over the hold angle
  velGripC: 4, // 1/s, course chase in DRIFT
  railK: 6, // 1/s, rails: extra pull of the course to the road, times sin(beta)
  bumpFrom: 0.6, // outer-edge cushion starts at this share of the half-width
  bumpGain: 0.6, // half-widths/s inward at the edge
  thrLat: 0.3, // half-widths/s of course per unit throttle (up = wider)
  missFree: 2, // deg, angle miss that costs nothing
  missLoss: 0.018, // drift speed cap: share of vmax per degree of miss above missFree
  missCap: 15, // deg, the miss counted at most
  missBrake: 0.6, // vmax/s, speed falls to the drift cap at this rate
  exitRamp: 0.3, // s, GRIP lead ramp after a drift end
  outSlide: 0.5, // half-widths/s^2, the most the DRIFT course turns outward per second
  liftDecel: 0.35, // vmax/s at throttle -1 in GRIP
  liftDecelDrift: 0.08, // vmax/s at throttle -1 in DRIFT
  thrAccelUp: 1, // accel multiplier gain at throttle +1 in DRIFT (below the cap)
};
type MCP = typeof MC;

// ---------------------------------------------------------------- model C state (would be Car fields)
export interface CS {
  drift: boolean;
  dir: number;
  beta: number; // deg, >= 0, toward dir
  refA: number; // smoothed A of the road ahead (signed)
  win: number; // ticks left in the entry window
  winDir: number; // 0 = any side, else only this side may latch (switch window)
  wBeta: number; // deg, signed window slip
  armed: boolean; // lift edge re-armed
  endT: number; // ticks below betaOn
  betaI: number; // deg, the reference angle through the angle filter (speed rule)
  sinceEnd: number; // s since the last drift end (GRIP lead ramp)
}
const newCS = (): CS => ({
  drift: false,
  dir: 0,
  beta: 0,
  refA: 0,
  win: 0,
  winDir: 0,
  wBeta: 0,
  armed: true,
  endT: 0,
  betaI: 0,
  sinceEnd: 99,
});

export interface Sim {
  st: RaceState;
  car: Car;
  cs: CS;
  track: Track;
  t: number;
  entries: number;
  windows: number;
}
function mkSim(track: Track, speed = 1, x = 0, z = 0): Sim {
  const st = createRace(1, 1);
  const car = st.cars[0]!;
  car.speed = speed * P.vmax;
  car.x = x;
  car.z = z;
  return { st, car, cs: newCS(), track, t: 0, entries: 0, windows: 0 };
}
const segOf = (s: Sim, z: number): number => {
  const n = s.track.segments.length;
  let i = Math.floor(z) % n;
  if (i < 0) i += n;
  return i;
};
const curveAt = (s: Sim, z: number): number => s.track.segments[segOf(s, z)]!.curve;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const sgn = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
const inp: InputFrame = { steer: 0, brake: false, drift: false };

/** One model C tick. steer, throttle in [-1, 1]. */
function stepC(s: Sim, steer: number, thr: number, m: MCP = MC): void {
  const car = s.car;
  const cs = s.cs;
  const p = P;
  steer = clamp(steer, -1, 1);
  thr = clamp(thr, -1, 1);
  const sp0 = car.speed / p.vmax;
  // C3: reference = mean curve over the road of the next refLook s, as A, smoothed.
  const k = Math.max(1, Math.ceil(sp0 * SEG_PER_UNIT * m.refLook));
  let sum = 0;
  for (let i = 0; i < k; i++) sum += curveAt(s, car.z + i);
  const refRaw = (sum / k) * sp0 * p.kYaw;
  cs.refA += (refRaw - cs.refA) * (1 - Math.exp(-DT / m.refTau));
  // C2: lift edge with hysteresis opens the entry window (not in DRIFT).
  if (thr <= -m.liftOn && cs.armed) {
    cs.armed = false;
    if (!cs.drift) {
      cs.win = Math.round(m.driftWindow / DT);
      cs.winDir = 0;
      cs.wBeta = 0;
      s.windows++;
    }
  }
  if (thr > -m.liftOff) cs.armed = true;
  if (!cs.drift && cs.win > 0) {
    cs.win--;
    cs.wBeta += (steer * m.betaEntry - cs.wBeta) * (1 - Math.exp(-DT / m.winTau));
    const side = sgn(cs.wBeta);
    if (
      Math.abs(cs.wBeta) >= m.betaOn &&
      car.speed > p.driftEnterSpeed * p.vmax &&
      (cs.winDir === 0 || side === cs.winDir)
    ) {
      cs.drift = true;
      cs.dir = side;
      cs.beta = Math.abs(cs.wBeta);
      cs.betaI = cs.beta;
      cs.endT = 0;
      car.relSide = 0;
      car.relV = 0;
      s.entries++;
    }
  }
  if (!cs.drift) {
    // GRIP: model B GRIP via the real step. C5: a lift slows the car (pre-adjust, step adds accel back).
    if (thr < 0) {
      car.speed = Math.max(0, car.speed - m.liftDecel * -thr * p.vmax * DT - p.accel * DT);
    }
    inp.steer = steer;
    // C5: after a drift end the GRIP lead (R85b + R85c) ramps in over exitRamp (as R85d).
    let pp = p;
    if (cs.sinceEnd < m.exitRamp) {
      const r = cs.sinceEnd / m.exitRamp;
      pp = { ...p, gripLead: p.gripLead * r, gripDodge: p.gripDodge * r };
      cs.sinceEnd += DT;
    }
    step(s.st, [inp], s.track, [pp]);
    s.t += DT;
    return;
  }
  // DRIFT (C3, C4).
  const seg = segOf(s, car.z);
  const curve = s.track.segments[seg]!.curve;
  const sp = car.speed / p.vmax;
  const A = curve * sp * p.kYaw;
  const dir = cs.dir;
  const u = steer * dir;
  const bRef = m.betaPerA * cs.refA * dir;
  let bT = clamp((bRef * u) / m.uHold, -m.betaMax, m.betaMax);
  // C2: for the rest of the entry window the finger's window angle is a floor of the target.
  if (cs.win > 0) {
    cs.win--;
    const wT = m.entryFloor > 0 ? (u > 0 ? m.entryFloor : 0) : u * m.betaEntry;
    if (wT > bT) bT = wT;
  }
  cs.beta += (bT - cs.beta) * (1 - Math.exp(-DT / m.betaTau));
  cs.beta = clamp(cs.beta, 0, m.betaMax);
  const bHold = m.betaPerA * A * dir;
  const outer = -car.x * dir;
  const cush = clamp((outer - m.bumpFrom) / (1 - m.bumpFrom), 0, 1);
  const velT = dir * (m.latPerDeg * (cs.beta - bHold) - m.thrLat * thr * 1 + m.bumpGain * cush);
  // thrLat: up (+) = wider = away from dir, so the term is -thrLat*thr toward dir.
  const rate = m.velGripC + m.railK * Math.sin((cs.beta * Math.PI) / 180);
  const vPrev = car.vel;
  car.vel += ((velT * m.velGripC) / rate - car.vel) * (1 - Math.exp(-rate * DT));
  // C4: the course may turn outward (away from dir) by at most outSlide per second.
  if ((car.vel - vPrev) * dir < -m.outSlide * DT) car.vel = vPrev - dir * m.outSlide * DT;
  car.x += car.vel * sp * p.latScale * DT;
  if (car.x > p.xLimit) {
    car.x = p.xLimit;
    if (car.vel > 0) car.vel = 0;
  } else if (car.x < -p.xLimit) {
    car.x = -p.xLimit;
    if (car.vel < 0) car.vel = 0;
  }
  // C4: the angle miss lowers the drift speed cap; above the cap speed falls by driftBrake.
  // betaI: the angle an exact finger (u = uHold) would have now: bRef through the same filter.
  cs.betaI += (clamp(bRef, 0, m.betaMax) - cs.betaI) * (1 - Math.exp(-DT / m.betaTau));
  const miss = Math.min(m.missCap, Math.abs(cs.beta - cs.betaI));
  const cap = p.vmax * (1 - m.missLoss * Math.max(0, miss - m.missFree));
  let v = car.speed;
  if (v > cap) v = Math.max(cap, v - m.missBrake * DT);
  else if (thr >= 0) v = Math.min(cap, v + p.accel * (1 + m.thrAccelUp * thr) * DT);
  if (thr < 0) v -= m.liftDecelDrift * -thr * p.vmax * DT;
  if (car.x > 1 || car.x < -1) v *= Math.pow(p.offroadMul, 60 * DT);
  if (v < 0) v = 0;
  car.speed = v;
  car.vx = car.vel * sp * p.latScale;
  car.steer = steer;
  car.yaw = car.vel + (dir * cs.beta) / SLIP_DEG;
  car.angle = (dir * cs.beta) / (SLIP_DEG * p.slipFull);
  car.heading += curve * v * DT;
  car.z += v * DT * SEG_PER_UNIT;
  s.st.tick++;
  s.t += DT;
  // C2: the drift ends driftEndDelay after the angle fell below betaOn (or by speed).
  cs.endT = cs.beta < m.betaOn ? cs.endT + 1 : 0;
  if (cs.endT * DT >= m.driftEndDelay || car.speed < p.driftExitSpeed * p.vmax) {
    cs.drift = false;
    let sG = A / p.velGrip;
    sG = clamp(sG, -p.slipGripMax, p.slipGripMax);
    car.carry = (dir * cs.beta) / SLIP_DEG - sG;
    car.yaw = car.vel + sG;
    car.yawRate = A;
    car.state = 'GRIP';
    // R85f start as on an R82 exit (finger share 0 or not, steer decides in step).
    const vInf = -A / p.yawAlign - sG;
    if (vInf !== 0 && steer === 0) {
      car.relSide = sgn(vInf);
      car.relV = car.vel * vInf > 0 ? car.vel : 0;
    }
    cs.win = Math.round(m.switchWindow / DT);
    cs.winDir = -dir;
    cs.wBeta = dir * cs.beta;
    cs.dir = 0;
    cs.endT = 0;
    cs.sinceEnd = 0;
  }
}

// ---------------------------------------------------------------- tracks
/** straight pre, enter (t^2) 30, hold len, leave 30, straight after. */
function figTrack(c: number, len: number, pre = 120): Track {
  const segments = [];
  for (let i = 0; i < pre; i++) segments.push({ curve: 0, y: 0 });
  for (let n = 0; n < 30; n++) segments.push({ curve: c * (n / 30) * (n / 30), y: 0 });
  for (let n = 0; n < len; n++) segments.push({ curve: c, y: 0 });
  for (let n = 0; n < 30; n++)
    segments.push({ curve: c * (1 - (0.5 - Math.cos((Math.PI * n) / 30) / 2)), y: 0 });
  for (let i = 0; i < 6000; i++) segments.push({ curve: 0, y: 0 });
  return { segments };
}
/** drift-lab: proposed track JSON (docs/research/model-c.md). */
export const DRIFT_LAB = {
  name: 'drift-lab',
  figures: [
    { figure: 'straight', side: 1 },
    { figure: 'straight', side: 1 },
    { figure: 'sweeper', side: 1 },
    { figure: 'straight', side: 1 },
    { figure: 'hairpin', side: -1 },
    { figure: 'straight', side: 1 },
    { figure: 'kink', side: 1 },
    { figure: 'straight', side: 1 },
    { figure: 'esses', side: 1 },
    { figure: 'straight', side: 1 },
    { figure: 'scurve', side: -1 },
    { figure: 'straight', side: 1 },
    { figure: 'hook', side: 1 },
    { figure: 'straight', side: 1 },
    { figure: 'chicane', side: -1 },
    { figure: 'straight', side: 1 },
    { figure: 'straight', side: 1 },
  ],
};
const labTrack = (): Track => buildTrack(resolveSections(trackSections(DRIFT_LAB), curveClasses));

// ---------------------------------------------------------------- drivers
export interface Lvl {
  name: string;
  drift: boolean;
  lead: number; // s before the corner start (|c| >= 1) to lift; negative = after
  err: number; // finger share error (relative), sign alternates per drift
  useThr: boolean; // line by throttle in DRIFT
  kx: number; // line by steer in DRIFT
  release: boolean; // lets the finger go at the corner end (else holds and lets the drift end by itself)
}
export const IDEAL: Lvl = {
  name: 'ideal',
  drift: true,
  lead: 0.15,
  err: 0,
  useThr: true,
  kx: 0.15,
  release: false,
};
export const MED: Lvl = {
  name: 'mediocre',
  drift: true,
  lead: -0.15,
  err: 0.3,
  useThr: false,
  kx: 0,
  release: true,
};
export const GRIPL: Lvl = {
  name: 'grip-only',
  drift: false,
  lead: 0,
  err: 0,
  useThr: false,
  kx: 0,
  release: true,
};
const C_DRIFT = 4.0; // a corner the drivers drift (medium and steeper)
const gripA = P.yawRateMax / (1 + P.yawAlign / P.velGrip);

interface Drv {
  lvl: Lvl;
  inSince: number;
  lift: number;
  side: number;
  nDrift: number;
}
const mkDrv = (lvl: Lvl): Drv => ({ lvl, inSince: 0, lift: 0, side: 0, nDrift: 0 });

function gripSteer(s: Sim, xT: number): number {
  const car = s.car;
  const sp = car.speed / P.vmax;
  const A = curveAt(s, car.z + sp * SEG_PER_UNIT * 0.1) * sp * P.kYaw;
  const f = Math.min(1, sp / P.yawFullSpeed);
  const sG = clamp(A / P.velGrip, -P.slipGripMax, P.slipGripMax);
  const ff = (A + P.yawAlign * sG) / (P.yawRateMax * f);
  return clamp(ff + 1.5 * (xT - car.x) - 0.4 * car.vel, -1, 1);
}

/** steer, throttle for one tick. */
function drive(s: Sim, d: Drv, out: { steer: number; thr: number }): void {
  const car = s.car;
  const cs = s.cs;
  const sp = Math.max(0.05, car.speed / P.vmax);
  const L = d.lvl;
  if (cs.drift) {
    d.lift = 0;
    d.side = 0;
    const dir = cs.dir;
    // exit: no same-side curve >= 1.5 within 0.25 s ahead -> release
    const kx = Math.ceil(sp * SEG_PER_UNIT * 0.25);
    let keep = false;
    for (let i = 0; i <= kx; i++) if (curveAt(s, car.z + i) * dir >= 1.5) keep = true;
    if (!keep && L.release) {
      out.steer = 0;
      out.thr = 0;
      return;
    }
    // finger error: a slow wobble of +-err around the hold share (period 1.6 s, phase per drift)
    const e = L.err * Math.sin((2 * Math.PI * s.t) / 1.6 + d.nDrift);
    const xi = car.x * dir; // > 0 = inside
    const edge = xi > 0.6 ? -(xi - 0.6) * 1.5 : xi < -0.6 ? (-xi - 0.6) * 1.5 : 0;
    const u = MC.uHold * (1 + e) - L.kx * xi - (L.kx > 0 ? 0.2 * car.vel * dir : 0) + edge;
    out.steer = dir * clamp(u, 0, 1);
    out.thr = L.useThr ? clamp(3 * car.x * dir, -0.3, 1) : 0;
    return;
  }
  out.thr = 0;
  out.steer = gripSteer(s, 0);
  if (!L.drift) {
    // GRIP-only: lift before a corner the grip cannot hold, only with a small steer.
    const k = Math.ceil(sp * SEG_PER_UNIT * 1.0);
    let need = 0;
    for (let i = 0; i <= k; i++)
      need = Math.max(need, (Math.abs(curveAt(s, car.z + i)) * sp * P.kYaw) / gripA);
    if (need > 1.0 && Math.abs(out.steer) < 0.2) out.thr = -1;
    // never latch a drift: inside a lift window the steer stays under betaOn/betaEntry
    if (cs.win > 0) out.steer = clamp(out.steer, -0.2, 0.2);
    return;
  }
  // entry in progress
  if (d.lift > 0 || cs.win > 0) {
    if (d.lift > 0) d.lift--;
    if (d.side !== 0) {
      out.steer = d.side;
      out.thr = d.lift > 0 ? -1 : 0;
      return;
    }
  }
  // find the next drift corner within 2 s and its start (|c| >= 1, same side)
  const k = Math.ceil(sp * SEG_PER_UNIT * 2);
  let ds = -1;
  let side = 0;
  for (let i = 0; i <= k; i++) {
    const c = curveAt(s, car.z + i);
    if (Math.abs(c) >= C_DRIFT) {
      ds = i;
      side = sgn(c);
      break;
    }
  }
  if (ds < 0) {
    d.inSince = 0;
    return;
  }
  let d1 = ds;
  for (let i = 0; i <= ds; i++) {
    if (curveAt(s, car.z + i) * side >= 1) {
      d1 = i;
      break;
    }
  }
  d.inSince = d1 === 0 ? d.inSince + 1 : 0;
  const go = L.lead >= 0 ? d1 <= L.lead * sp * SEG_PER_UNIT : d.inSince * DT >= -L.lead;
  if (go) {
    d.lift = Math.round(0.1 / DT);
    d.side = side;
    d.nDrift++;
    out.steer = side;
    out.thr = -1;
  }
}

interface Lap {
  t: number;
  off: number;
  vmin: number;
  driftT: number;
  entries: number;
}
function lap(track: Track, lvl: Lvl): Lap {
  const s = mkSim(track, 1);
  const d = mkDrv(lvl);
  const o = { steer: 0, thr: 0 };
  const n = track.segments.length;
  let off = 0;
  let vmin = 9;
  let driftT = 0;
  // warm-up lap, then measure the second (flying) lap
  let tStart = 0;
  let measuring = false;
  let prevEntries = 0;
  while (s.car.z < 2 * n && s.t < 600) {
    if (!measuring && s.car.z >= n) {
      measuring = true;
      tStart = s.t;
      prevEntries = s.entries;
    }
    drive(s, d, o);
    stepC(s, o.steer, o.thr);
    if (measuring) {
      if (Math.abs(s.car.x) > 1) off += DT;
      if (s.cs.drift) driftT += DT;
      vmin = Math.min(vmin, s.car.speed);
    }
    if (!s.cs.drift) d.side = s.cs.win > 0 || d.lift > 0 ? d.side : 0;
  }
  return { t: s.t - tStart, off, vmin, driftT, entries: s.entries - prevEntries };
}

// ---------------------------------------------------------------- helpers for parts
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
function table(io: Io, head: string[], rows: string[][]): void {
  io.log('| ' + head.join(' | ') + ' |');
  io.log('|' + head.map(() => ' --- ').join('|') + '|');
  for (const r of rows) io.log('| ' + r.join(' | ') + ' |');
  io.log('');
}
const CL: [string, number][] = [
  ['medium', C.medium!],
  ['hard', C.hard!],
  ['sharp', C.sharp!],
];
/** Enter a steady drift on a long corner of class c (lift + full steer at the corner start). */
function steadyDrift(c: number, settle = 1.5): Sim {
  const s = mkSim(figTrack(c, 4000), 1);
  const o = { steer: 0, thr: 0 };
  while (s.car.z < 120) stepC(s, gripSteer(s, 0), 0);
  let t0 = 0;
  while (!s.cs.drift && t0 < 1) {
    stepC(s, 1, t0 < 0.1 ? -1 : 0);
    t0 += DT;
  }
  for (let t = 0; t < settle; t += DT) {
    o.steer = MC.uHold - 0.15 * s.car.x - 0.2 * s.car.vel;
    stepC(s, o.steer, clamp(3 * s.car.x, -0.3, 1));
  }
  return s;
}

// ---------------------------------------------------------------- parts
function partEntry(io: Io): void {
  io.log('## Entry: lift (throttle -1 for 0.1 s) with steer held, vmax');
  const rows: string[][] = [];
  for (const [name, c] of [
    ['straight', 0],
    ['medium', C.medium!],
    ['hard', C.hard!],
  ] as [string, number][]) {
    for (const st of [0, 0.2, 0.3, 0.5, 1]) {
      const s = mkSim(figTrack(c, 4000, 0), 1, 0, 60);
      // steer settles 0.5 s first (GRIP), then the lift
      for (let t = 0; t < 0.5; t += DT) stepC(s, st, 0);
      let tLatch = NaN;
      const v0 = s.car.speed;
      let vmin = v0;
      for (let t = 0; t < 0.8; t += DT) {
        stepC(s, st, t < 0.1 ? -1 : 0);
        vmin = Math.min(vmin, s.car.speed);
        if (s.cs.drift && !Number.isFinite(tLatch)) tLatch = t + DT;
      }
      rows.push([
        name,
        f(st, 1),
        Number.isFinite(tLatch) ? f(tLatch * 1000, 0) + ' ms' : 'no drift',
        f(vmin - v0, 3),
        f(s.car.speed - v0, 3),
      ]);
    }
  }
  table(
    io,
    ['road', 'steer', 'lift -> latch', 'min speed change', 'speed change after 0.8 s'],
    rows,
  );
  // lift and steer at the same moment (finger goes down-and-sideways)
  const rows2: string[][] = [];
  for (const st of [0.5, 1]) {
    const s = mkSim(figTrack(0, 4000, 0), 1, 0, 60);
    let tL = NaN;
    for (let t = 0; t < 0.6; t += DT) {
      stepC(s, st, t < 0.1 ? -1 : 0);
      if (s.cs.drift && !Number.isFinite(tL)) tL = t + DT;
    }
    rows2.push(['straight', f(st, 1), f(tL * 1000, 0) + ' ms']);
  }
  table(io, ['road', 'steer from the lift tick', 'lift -> latch'], rows2);
}

function partSteady(io: Io): void {
  io.log('## Steady drift: 1.5 s at uHold, then (u, throttle) for 1 s; vmax entry');
  for (const [name, c] of CL) {
    const rows: string[][] = [];
    for (const u of [-1, -0.5, 0, 0.5, 1]) {
      for (const thr of [-1, 0, 1]) {
        const s = steadyDrift(c);
        const dir = s.cs.dir;
        const x0 = s.car.x;
        const v0 = s.car.speed;
        let endT = NaN;
        for (let t = 0; t < 1; t += DT) {
          stepC(s, dir * u, thr);
          if (!s.cs.drift && !Number.isFinite(endT)) endT = t + DT;
        }
        rows.push([
          f(u, 1),
          f(thr, 0),
          s.cs.drift ? f(s.cs.beta, 1) : 'GRIP',
          f((s.car.x - x0) * dir, 3),
          f(v0, 3) + ' → ' + f(s.car.speed, 3),
          Number.isFinite(endT) ? f(endT, 2) + ' s' : '',
        ]);
      }
    }
    io.log(`### ${name}`);
    table(
      io,
      [
        'u = steer·dir',
        'throttle',
        'beta after 1 s, deg',
        'inward Δx in 1 s',
        'speed',
        'drift ended at',
      ],
      rows,
    );
  }
  // hold angles
  const rows: string[][] = [];
  for (const [name, c] of [['easy', C.easy!], ...CL] as [string, number][]) {
    const s = steadyDrift(c, 2.5);
    rows.push([
      name,
      f(MC.betaPerA * c * P.kYaw, 1),
      f(s.cs.beta, 1),
      f(s.car.speed, 3),
      f(s.car.x, 3),
    ]);
  }
  table(
    io,
    ['class', 'hold angle at vmax, deg', 'beta after 2.5 s (ideal finger), deg', 'speed', 'x'],
    rows,
  );
}

function partExit(io: Io): void {
  io.log('## Exit inside the corner: steady drift, then release (steer 0) / counter (-1)');
  const rows: string[][] = [];
  for (const [name, c] of CL) {
    for (const [mode, u] of [
      ['release', 0],
      ['counter -1', -1],
      ['counter -0.3', -0.3],
    ] as [string, number][]) {
      const s = steadyDrift(c);
      const dir = s.cs.dir;
      const x0 = s.car.x;
      const at: number[] = [];
      let endT = NaN;
      let maxStep = 0;
      let prevVx = s.car.vx;
      for (let t = 0; t < 1.0 + 1e-9; t += DT) {
        stepC(s, dir * u, 0);
        if (!s.cs.drift && !Number.isFinite(endT)) endT = t + DT;
        const outV = -s.car.vx * dir;
        const outPrev = -prevVx * dir;
        if (t < 0.3) maxStep = Math.max(maxStep, Math.max(0, outV) - Math.max(0, outPrev));
        prevVx = s.car.vx;
        for (const m of [0.1, 0.3, 0.6, 1.0])
          if (Math.abs(t + DT - m) < DT / 2) at.push(-(s.car.x - x0) * dir);
      }
      rows.push([name, mode, ...at.map((v) => f(v, 3)), f(endT, 2), f(maxStep, 3)]);
    }
  }
  table(
    io,
    [
      'class',
      'input',
      'out 0.1 s',
      'out 0.3 s',
      'out 0.6 s',
      'out 1.0 s',
      'drift end, s',
      'max outward vx rise / tick (0.3 s)',
    ],
    rows,
  );
}

function partStraight(io: Io): void {
  io.log('## Drift on a straight: lift + steer, steer held (1 / 0.5)');
  const rows: string[][] = [];
  for (const st of [1, 0.5]) {
    const s = mkSim(figTrack(0, 4000, 0), 1, 0, 60);
    const marks = [0.1, 0.25, 0.5, 0.75, 1.0, 1.5];
    const r: string[] = [f(st, 1)];
    let endT = NaN;
    let lat = NaN;
    for (let t = 0; t < 1.5 + 1e-9; t += DT) {
      stepC(s, st, t < 0.1 ? -1 : 0);
      if (s.cs.drift && !Number.isFinite(lat)) lat = t;
      if (Number.isFinite(lat) && !s.cs.drift && !Number.isFinite(endT)) endT = t;
      for (const m of marks)
        if (Math.abs(t + DT - m) < DT / 2)
          r.push((s.cs.drift ? f(s.cs.beta, 0) + '°' : 'G') + ' / ' + f(s.car.speed, 3));
    }
    r.push(f(endT, 2), f(s.car.x, 2));
    rows.push(r);
  }
  table(
    io,
    ['steer', '0.1 s', '0.25 s', '0.5 s', '0.75 s', '1.0 s', '1.5 s', 'drift end, s', 'x at 1.5 s'],
    rows,
  );
}

function figureRun(
  track: Track,
  lvl: Lvl,
  z1: number,
): { t: number; vmin: number; xmin: number; xmax: number; entries: number } {
  const s = mkSim(track, 1);
  const d = mkDrv(lvl);
  const o = { steer: 0, thr: 0 };
  let vmin = 9;
  let xmin = 9;
  let xmax = -9;
  while (s.car.z < z1 && s.t < 60) {
    drive(s, d, o);
    stepC(s, o.steer, o.thr);
    if (!s.cs.drift) d.side = s.cs.win > 0 || d.lift > 0 ? d.side : 0;
    if (s.car.z > 60) {
      vmin = Math.min(vmin, s.car.speed);
      xmin = Math.min(xmin, s.car.x);
      xmax = Math.max(xmax, s.car.x);
    }
  }
  return { t: s.t, vmin, xmin, xmax, entries: s.entries };
}
function figTrackOf(name: string): { track: Track; len: number } {
  const def = {
    name: 'x',
    figures: [
      { figure: 'straight', side: 1 },
      { figure: 'straight', side: 1 },
      { figure: name, side: 1 },
      { figure: 'straight', side: 1 },
      { figure: 'straight', side: 1 },
      { figure: 'straight', side: 1 },
    ],
  };
  const track = buildTrack(resolveSections(trackSections(def), curveClasses));
  return { track, len: track.segments.length - 120 };
}

function partS(io: Io): void {
  io.log(
    '## S-bends and corners by the scripted drivers (figure from a straight, 120 seg after it)',
  );
  const rows: string[][] = [];
  for (const fig of [
    'sweeper',
    'hairpin',
    'hook',
    'chicane',
    'scurve',
    'esses',
    'flick',
    'switchback',
  ]) {
    const { track, len } = figTrackOf(fig);
    const r: string[] = [fig];
    for (const lvl of [IDEAL, MED, GRIPL]) {
      const q = figureRun(track, lvl, len);
      r.push(
        `${f(q.t, 2)} s, vmin ${f(q.vmin, 2)}, x ${f(q.xmin, 2)}…${f(q.xmax, 2)}, ${q.entries}`,
      );
    }
    rows.push(r);
  }
  table(io, ['figure', 'ideal: time, vmin, x range, entries', 'mediocre', 'grip-only'], rows);
}

function partNoInput(io: Io): void {
  io.log('## No input in a corner (GRIP, from x 0 at vmax, steer 0 from the corner start)');
  const rows: string[][] = [];
  for (const [name, c] of [['easy', C.easy!], ...CL] as [string, number][]) {
    const s = mkSim(figTrack(c, 4000, 0), 1, 0, 30);
    const r: string[] = [name];
    let edge = NaN;
    for (let t = 0; t < 2 + 1e-9; t += DT) {
      stepC(s, 0, 0);
      if (Math.abs(s.car.x) >= 1 && !Number.isFinite(edge)) edge = t + DT;
      for (const m of [0.3, 0.6, 1.0, 2.0])
        if (Math.abs(t + DT - m) < DT / 2) r.push(f(s.car.x, 3));
    }
    r.push(f(edge, 2), String(s.entries));
    rows.push(r);
  }
  table(io, ['class', 'x 0.3 s', 'x 0.6 s', 'x 1.0 s', 'x 2.0 s', 'edge at, s', 'drifts'], rows);
}

// ---------------------------------------------------------------- touch: the second axis
/** Proposed zone-stick vertical mapping (input.json touch): fractions of R = stickRadius*width. */
export const TI = {
  stickRadius: 0.16,
  thrDead: 0.5,
  thrFull: 1.3,
  thrExp: 1.4,
  edgeMargin: 8,
  thrTauMs: 25,
};
/** dy > 0 = finger below the touch-down point (screen y down). bottomGap = px from touch-down to the screen bottom. */
export function throttleOf(dy: number, bottomGap: number, width = 360): number {
  const R = TI.stickRadius * width;
  let full = TI.thrFull * R;
  let dead = TI.thrDead * R;
  if (dy > 0) {
    const room = Math.max(4, bottomGap - TI.edgeMargin);
    if (room < full) {
      dead *= room / full;
      full = room;
    }
  }
  const a = Math.abs(dy);
  if (a <= dead) return 0;
  const t = Math.pow(Math.min(1, (a - dead) / (full - dead)), TI.thrExp);
  return dy > 0 ? -t : t;
}

function partJitter(io: Io): void {
  const R = TI.stickRadius * 360;
  io.log(
    `## Touch vertical: R ${f(R, 1)} px, dead ${f(TI.thrDead * R, 1)} px, full ${f(TI.thrFull * R, 1)} px`,
  );
  const pull: string[][] = [];
  for (const gap of [200, 110, 60, 30]) {
    let need = NaN;
    for (let dy = 0; dy < 200; dy += 0.5)
      if (throttleOf(dy, gap) <= -MC.liftOn) {
        need = dy;
        break;
      }
    pull.push([String(gap), f(need, 1), f(throttleOf(Math.min(gap, 200), gap), 2)]);
  }
  table(
    io,
    [
      'px to the screen bottom',
      'pull for a lift (thr ≤ −liftOn), px',
      'throttle at the bottom edge',
    ],
    pull,
  );
  io.log(
    '### Vertical finger wander while steering (meander ±1 at 0.5 Hz, 20 s on drift-lab, GRIP driver steer)',
  );
  const rows: string[][] = [];
  const track = labTrack();
  for (const gap of [110, 50]) {
    for (const amp of [25, 30, 40, 55]) {
      for (const hz of [2, 5]) {
        const s = mkSim(track, 1);
        let thrS = 0;
        let thrMin = 0;
        for (let t = 0; t < 20; t += DT) {
          const dy = amp * Math.sin(2 * Math.PI * hz * t + 0.7);
          const raw = throttleOf(dy, gap);
          thrS += (raw - thrS) * (1 - Math.exp(-(DT * 1000) / TI.thrTauMs));
          thrMin = Math.min(thrMin, thrS);
          const steer = clamp(gripSteer(s, 0) + 0.6 * Math.sin(2 * Math.PI * 0.5 * t), -1, 1);
          stepC(s, steer, thrS);
        }
        rows.push([
          String(gap),
          `±${amp}`,
          `${hz} Hz`,
          f(thrMin, 2),
          String(s.windows),
          String(s.entries),
        ]);
      }
    }
  }
  table(
    io,
    ['px to bottom', 'wander px', 'freq', 'min throttle', 'windows opened', 'drift entries'],
    rows,
  );
  // latency: finger pulled down at 400 / 800 px/s with full steer held, straight
  const lat: string[][] = [];
  for (const vPx of [300, 600, 1200]) {
    const s = mkSim(figTrack(0, 4000, 0), 1, 0, 60);
    let thrS = 0;
    let tDead = NaN;
    let tLift = NaN;
    let tLatch = NaN;
    for (let t = 0; t < 0.6; t += DT) {
      const dy = Math.min(80, vPx * t);
      const raw = throttleOf(dy, 110);
      if (raw < 0 && !Number.isFinite(tDead)) tDead = t;
      thrS += (raw - thrS) * (1 - Math.exp(-(DT * 1000) / TI.thrTauMs));
      if (thrS <= -MC.liftOn && !Number.isFinite(tLift)) tLift = t;
      stepC(s, 1, thrS);
      if (s.cs.drift && !Number.isFinite(tLatch)) tLatch = t + DT;
    }
    lat.push([
      String(vPx),
      f(tDead * 1000, 0),
      f(tLift * 1000, 0),
      f(tLatch * 1000, 0),
      f((tLatch - tDead) * 1000, 0),
    ]);
  }
  table(
    io,
    [
      'pull speed px/s',
      'leaves dead zone, ms',
      'lift edge, ms',
      'drift latch, ms',
      'dead zone → latch, ms',
    ],
    lat,
  );
}

function partTap(io: Io): void {
  io.log('## Tap-drifts vs a held drift (hairpin, hook from a straight)');
  const rows: string[][] = [];
  for (const fig of ['hairpin', 'hook', 'sweeper']) {
    const { track, len } = figTrackOf(fig);
    const held = figureRun(track, IDEAL, len).t;
    const grip = figureRun(track, GRIPL, len).t;
    for (const [on, offT] of [
      [0.25, 0.25],
      [0.15, 0.15],
      [0.4, 0.2],
    ] as [number, number][]) {
      // ideal driver, but in DRIFT it counter-steers after `on` s and stays GRIP for `offT` s
      const s = mkSim(track, 1);
      const d = mkDrv(IDEAL);
      const o = { steer: 0, thr: 0 };
      let inD = 0;
      let gripT = 0;
      while (s.car.z < len && s.t < 60) {
        drive(s, d, o);
        if (s.cs.drift) {
          inD += DT;
          if (inD > on) o.steer = -s.cs.dir;
          gripT = 0;
        } else {
          if (inD > 0) gripT += DT;
          if (gripT > 0 && gripT < offT) {
            d.lift = 0;
            o.thr = 0;
            o.steer = gripSteer(s, 0);
          }
          if (gripT >= offT) {
            inD = 0;
            gripT = 0;
          }
        }
        stepC(s, o.steer, o.thr);
        if (!s.cs.drift) d.side = s.cs.win > 0 || d.lift > 0 ? d.side : 0;
      }
      rows.push([
        fig,
        `${on}/${offT}`,
        f(s.t, 3),
        f(held, 3),
        f(grip, 3),
        f(((s.t - held) / held) * 100, 1) + '%',
      ]);
    }
  }
  table(io, ['figure', 'drift/grip s', 'tap time', 'held drift', 'grip-only', 'tap vs held'], rows);
}

function partLap(io: Io): void {
  io.log('## Flying lap (second lap), scripted drivers');
  const rows: string[][] = [];
  const tracks: [string, Track][] = [
    ['drift-lab', labTrack()],
    ['drift-run', buildTrack(loadTrackByName('drift-run').def)],
    ['test-twisty', buildTrack(loadTestTwisty().def)],
  ];
  for (const [name, track] of tracks) {
    const a = lap(track, IDEAL);
    const b = lap(track, MED);
    const g = lap(track, GRIPL);
    const pct = (x: Lap): string => f(((x.t - a.t) / a.t) * 100, 1) + '%';
    const cell = (x: Lap): string =>
      `${f(x.t, 2)} s (${pct(x)}), off ${f(x.off, 2)} s, drift ${f(x.driftT, 1)} s, ${x.entries} entries, vmin ${f(x.vmin, 2)}`;
    rows.push([name, cell(a), cell(b), cell(g)]);
  }
  table(io, ['track', 'ideal', 'mediocre (±30% angle, +0.3 s late)', 'grip-only'], rows);
  // decomposition: only the error / only the lateness
  const r2: string[][] = [];
  for (const [name, track] of tracks) {
    const a = lap(track, IDEAL).t;
    const pc = (l: Lvl): string => f(((lap(track, l).t - a) / a) * 100, 1) + '%';
    r2.push([
      name,
      pc({ ...MED, lead: IDEAL.lead }),
      pc({ ...MED, lead: IDEAL.lead, err: 0.15 }),
      pc({ ...MED, lead: IDEAL.lead, err: 0 }),
      pc({ ...IDEAL, lead: -0.15 }),
      pc({ ...IDEAL, lead: -0.45 }),
      pc({ ...IDEAL, lead: -0.85 }),
      pc({ ...IDEAL, release: true }),
    ]);
  }
  table(
    io,
    [
      'track',
      'only ±30% angle',
      'only ±15% angle',
      'mediocre style, 0% angle error',
      'ideal 0.3 s late',
      'ideal 0.6 s late',
      'ideal 1.0 s late',
      'ideal + release at corner end',
    ],
    r2,
  );
}

export function main(io: Io): number {
  const part = argValue(io.argv, 'part') ?? 'all';
  const all = part === 'all';
  if (all || part === 'entry') partEntry(io);
  if (all || part === 'steady') partSteady(io);
  if (all || part === 'exit') partExit(io);
  if (all || part === 'straight') partStraight(io);
  if (all || part === 's') partS(io);
  if (all || part === 'noinput') partNoInput(io);
  if (all || part === 'jitter') partJitter(io);
  if (all || part === 'tap') partTap(io);
  if (all || part === 'lap') partLap(io);
  if (part === 'sweep') sweep(io);
  if (part === 'trace')
    trace(
      io,
      argValue(io.argv, 'lvl') === 'med'
        ? MED
        : argValue(io.argv, 'lvl') === 'grip'
          ? GRIPL
          : IDEAL,
      argValue(io.argv, 'track') ?? 'drift-lab',
      Number(argValue(io.argv, 't') ?? 30),
    );
  return 0;
}

export function trace(io: Io, lvl: Lvl, which = 'drift-lab', t1 = 30): void {
  const track = which === 'drift-lab' ? labTrack() : buildTrack(loadTrackByName(which).def);
  const s = mkSim(track, 1);
  const d = mkDrv(lvl);
  const o = { steer: 0, thr: 0 };
  let next = 0;
  while (s.t < t1 && Number.isFinite(s.car.z)) {
    drive(s, d, o);
    stepC(s, o.steer, o.thr);
    if (!s.cs.drift) d.side = s.cs.win > 0 || d.lift > 0 ? d.side : 0;
    if (s.t >= next) {
      next += 0.1;
      io.log(
        `${f(s.t, 1)} z${f(s.car.z, 0)} c${f(curveAt(s, s.car.z), 1)} x${f(s.car.x, 2)} v${f(s.car.speed, 2)} ${s.cs.drift ? 'D' + f(s.cs.beta, 0) + ' ref' + f(MC.betaPerA * s.cs.refA * s.cs.dir, 0) : 'G'} st${f(o.steer, 2)} th${f(o.thr, 1)} vel${f(s.car.vel, 2)}`,
      );
    }
  }
}

export function sweep(io: Io): void {
  const tracks: [string, Track][] = [
    ['drift-lab', labTrack()],
    ['drift-run', buildTrack(loadTrackByName('drift-run').def)],
    ['test-twisty', buildTrack(loadTestTwisty().def)],
  ];
  const base = { ...MC };
  const rows: string[][] = [];
  for (const [ml, mf, br] of [
    [0.006, 3, 0.3],
    [0.01, 3, 0.3],
    [0.015, 2, 0.3],
    [0.015, 2, 0.6],
    [0.018, 2, 0.6],
    [0.02, 2, 0.6],
  ] as [number, number, number][]) {
    MC.missLoss = ml;
    MC.missFree = mf;
    const r: string[] = [`${ml} / ${mf}° / brake ${br}`];
    MC.missBrake = br;
    for (const [, tr] of tracks) {
      const a = lap(tr, IDEAL).t;
      const b = lap(tr, MED).t;
      const g = lap(tr, GRIPL).t;
      r.push(`${f(a, 2)} / ${f(((b - a) / a) * 100, 1)}% / grip ${f(((g - a) / a) * 100, 1)}%`);
    }
    rows.push(r);
  }
  Object.assign(MC, base);
  table(
    io,
    [
      'missLoss / missFree / brake to cap',
      'drift-lab ideal / mediocre / grip',
      'drift-run',
      'test-twisty',
    ],
    rows,
  );
}

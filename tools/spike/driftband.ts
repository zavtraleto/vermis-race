// THROWAWAY SPIKE (docs/research/drift-band-spike.md): the finger in a model B drift as an arc band
// on the drift side only (docs/research/drift-systems.md §5.1 D1) and variants, against today's R84.
// The model B tick of ONE car (R80-R88 without slipstream/lamps/traffic) is copied below so the
// drift branch can be swapped; V0 of the copy is checked against the REAL src/sim `step` first.
// GRIP, R81/R82/R82b/R85/R86 are today's rules in every variant. src/ and data are not touched.
// Run: node tools/run-ts.mjs tools/spike/driftband.ts [--wp 0.08,0.1,...] [--set k=v,...]
import { baseCar } from '../../src/data/cars';
import inputCfg from '../../src/data/input.json';
import sprites from '../../src/data/sprites.json';
import curves from '../../src/data/tracks/curves.json';
import { DT, SEG_PER_UNIT, STEER_HIST } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, Track } from '../../src/sim/types';
import { argValue, type Io } from '../io';

const C = curves as { easy: number; medium: number; hard: number; sharp: number };
const LANE = 0.25;
const SLIP_DEG = sprites.weight.slipDeg;
const RELEASE_S = inputCfg.touch.releaseMs / 1000;
const BAND_T = 3.5; // s: about a hairpin / sweeper hold (200-240 segments at ~0.9 vmax)
const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  offroadSteerMul: 1,
  offroadGrip: p.grip,
  offroadVelMul: 1,
  crashMinSpeed: 1e9,
});
let P: CarParams = free({ ...baseCar, model: 1 });
const PA: CarParams = free({ ...baseCar, model: 0 });
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const approach = (cur: number, target: number, rampS: number): number => {
  const d = DT / rampS;
  return cur < target ? Math.min(target, cur + d) : Math.max(target, cur - d);
};

// ---------------------------------------------------------------- variants
interface V {
  name: string;
  band: boolean; // false = today's R83-R85 (clamp(u,0,1) + min(0,u) term)
  half: boolean; // extra (not in the task): uEff = uMin + (1 - uMin)*clamp(u, 0, 1), finger < 0 = finger 0
  uMin: number;
  wrongPush: number; // 0 = driftPush everywhere; else road push when A*dir < 0
  tWrong: number; // 0 = off; else auto-exit after this long with A*dir < 0
}

// ---------------------------------------------------------------- copied model B tick
class Rig {
  race = createRace(1, 1);
  car: Car = this.race.cars[0]!;
  wrongT = 0;
  autoExits = 0;
  dx = 0;
  curve = 0;
  segs: number[] | null = null; // curve per segment (S-bend); null = constant `curve`
  constructor(
    public v: V,
    public p: CarParams = P,
    speed = 1,
  ) {
    this.car.speed = speed;
  }
  curveNow(): number {
    if (this.segs === null) return this.curve;
    const i = Math.floor(this.car.z);
    return i < this.segs.length ? this.segs[i]! : this.segs[this.segs.length - 1]!;
  }
  /** Steady DRIFT dir +1 at raw finger s, put directly (as tests/sim/modelb_calibration enterDrift). */
  enterDrift(s: number): void {
    const c = this.car;
    const p = this.p;
    c.state = 'DRIFT';
    c.dir = 1;
    c.driftHeld = true;
    const A = this.curveNow() * (c.speed / p.vmax) * p.kYaw;
    const ue = uEff(this.v, s);
    const slip = p.slipFull * ue;
    c.vel = latT(this.v, p, 1, s, slip, A);
    c.yaw = c.vel + slip;
    c.yawRate = 0;
  }
  tick(steerIn: number, drift: boolean): void {
    const c = this.car;
    const p = this.p;
    const v = this.v;
    const x0 = c.x;
    const curve = this.curveNow();
    const off = c.x > 1 || c.x < -1;
    c.offTicks = off ? c.offTicks + 1 : 0;
    const steer = clamp(steerIn, -1, 1); // R80
    c.steer = steer;
    c.driftHeld = drift;
    // R81 flick entry
    const hist = c.steerHist;
    if (c.state === 'GRIP' && drift && c.speed > p.driftEnterSpeed * p.vmax) {
      let kMax = Math.round(p.flickWindow / DT);
      if (kMax > c.steerHistCount) kMax = c.steerHistCount;
      let best = 0;
      for (let k = 1; k <= kMax; k++) {
        let j = c.steerHistHead - k;
        if (j < 0) j += STEER_HIST;
        const d = steer - hist[j]!;
        if (Math.abs(d) > Math.abs(best)) best = d;
      }
      if (best >= p.flickDelta || best <= -p.flickDelta) {
        c.state = 'DRIFT';
        const dir = best > 0 ? 1 : -1;
        c.dir = dir;
        const vis = c.yaw - c.vel + c.carry;
        const slip0 = vis * dir > 0 ? vis : 0;
        c.yaw = c.vel + slip0;
        c.carry = vis - slip0;
        c.yawRate = dir * (p.kickBase + p.kickGain * (Math.abs(best) - p.flickDelta));
        this.wrongT = 0;
      }
    }
    if (drift) {
      hist[c.steerHistHead] = steer;
      c.steerHistHead = c.steerHistHead + 1 >= STEER_HIST ? 0 : c.steerHistHead + 1;
      if (c.steerHistCount < STEER_HIST) c.steerHistCount++;
    } else c.steerHistCount = 0;

    const sp = c.speed / p.vmax;
    const A = curve * sp * p.kYaw;
    // V3: wrong-way timer (A*dir < 0), counted on DRIFT ticks
    if (c.state === 'DRIFT' && A * c.dir < 0) this.wrongT += DT;
    else this.wrongT = 0;
    const auto = v.tWrong > 0 && c.state === 'DRIFT' && this.wrongT > v.tWrong + 1e-9;
    // R82 exit
    if (c.state === 'DRIFT' && (!drift || c.speed < p.driftExitSpeed * p.vmax || auto)) {
      if (auto) this.autoExits++;
      c.state = 'GRIP';
      c.dir = 0;
      const sG = clamp(A / p.velGrip, -p.slipGripMax, p.slipGripMax);
      c.carry = c.yaw - c.vel + c.carry - sG;
      c.yaw = c.vel + sG;
      c.yawRate = A;
      this.wrongT = 0;
    }
    const inDrift = c.state === 'DRIFT';
    c.carry *= Math.exp(-p.carryDecay * DT); // R82b

    let slip: number;
    let lead = 0;
    if (inDrift) {
      const dir = c.dir;
      const ue = uEff(v, steer * dir);
      const slipT = dir * p.slipFull * ue;
      const w = p.slipResponse;
      slip = c.yaw - c.vel;
      c.yawRate += (w * w * (slipT - slip) - 2 * w * c.yawRate) * DT;
      slip += c.yawRate * DT;
      if (slip * dir < 0) {
        slip = 0;
        c.yawRate = 0;
      }
      const velT = latT(v, p, dir, steer * dir, slip, A);
      c.vel += (velT - c.vel) * (1 - Math.exp(-p.velGripDrift * DT));
      c.yaw = c.vel + slip;
      lead = dir * p.driftLead * (ue - (slip * dir) / p.slipFull) * sp * p.latScale; // R85
    } else {
      const f = Math.min(1, sp / p.yawFullSpeed);
      c.yawRate +=
        (steer * p.yawRateMax * f - p.yawAlign * c.yaw - c.yawRate) *
        (1 - Math.exp(-p.yawResponse * DT));
      c.yaw += (c.yawRate - A) * DT;
      let g = p.velGrip;
      let smax = p.slipGripMax;
      if (off) {
        g *= p.offroadVelMul;
        smax *= p.offroadVelMul;
      }
      const force = clamp(c.yaw - c.vel, -smax, smax);
      c.vel += (g * force - A) * DT;
      const lim = p.slipGripLimit;
      slip = c.yaw - c.vel;
      if (slip > lim) {
        c.yaw = c.vel + lim;
        if (c.yawRate > A) c.yawRate = A;
      } else if (slip < -lim) {
        c.yaw = c.vel - lim;
        if (c.yawRate < A) c.yawRate = A;
      }
      slip = c.yaw - c.vel;
    }
    c.x += (c.vel * sp * p.latScale + lead) * DT;
    if (c.x > p.xLimit) {
      c.x = p.xLimit;
      if (c.vel > 0) c.vel = 0;
    } else if (c.x < -p.xLimit) {
      c.x = -p.xLimit;
      if (c.vel < 0) c.vel = 0;
    }
    if (inDrift) c.yaw = c.vel + slip;
    c.vx = c.vel * sp * p.latScale + lead;
    // R86 (no slipstream)
    let cap = p.vmax;
    if (inDrift) {
      const a = 1 - (p.driftSpeedLoss * Math.abs(slip)) / p.slipFull;
      if (a < 1) cap = p.vmax * a;
    }
    let speed: number;
    if (c.speed > cap) speed = Math.max(cap, c.speed - p.driftBrake * DT);
    else speed = Math.min(cap, c.speed + p.accel * DT);
    if (!inDrift) {
      const vis = c.yaw - c.vel + c.carry;
      speed = Math.max(0, speed - p.slipDrag * vis * vis * DT);
    }
    if (c.x > 1 || c.x < -1) speed *= Math.pow(p.offroadMul, 60 * DT);
    c.speed = speed;
    c.angle = inDrift ? (c.yaw - c.vel) / p.slipFull : 0;
    c.heading += curve * speed * DT;
    c.z += speed * DT * SEG_PER_UNIT;
    this.dx = (c.x - x0) / DT;
  }
  get slip(): number {
    return this.car.yaw - this.car.vel + this.car.carry;
  }
}

/** Finger u = steer*dir -> the share of the full angle the drift aims at. */
function uEff(v: V, u: number): number {
  if (!v.band) return clamp(u, 0, 1);
  if (v.half) return v.uMin + (1 - v.uMin) * clamp(u, 0, 1);
  const uc = clamp(u, -1, 1);
  return v.uMin + ((1 - v.uMin) * (uc + 1)) / 2;
}
/** R84 DRIFT lateral target (V0) or the band variants. */
function latT(v: V, p: CarParams, dir: number, u: number, slip: number, A: number): number {
  if (!v.band)
    return dir * p.driftLat * ((slip * dir) / p.slipFull + (u < 0 ? u : 0)) - p.driftPush * A;
  const push = v.wrongPush > 0 && A * dir < 0 ? v.wrongPush : p.driftPush;
  return dir * p.driftLat * ((slip * dir) / p.slipFull) - push * A;
}

// ---------------------------------------------------------------- V0 copy vs real step
function validate(): number {
  let worst = 0;
  for (const curve of [0, C.medium, C.hard, -C.hard]) {
    const t: Track = { segments: Array.from({ length: 4000 }, () => ({ curve })) };
    const real = createRace(1, 1);
    real.cars[0]!.speed = 1;
    const mine = new Rig(V0);
    mine.curve = curve;
    const f: InputFrame = { steer: 0, brake: false, drift: false };
    for (let i = 0; i < 900; i++) {
      const tt = i * DT;
      const drift = tt > 0.2 && !(tt > 4.5 && tt < 4.7);
      const s =
        tt < 0.5
          ? 0
          : tt < 2
            ? 0.6
            : tt < 3
              ? -1
              : tt < 4.5
                ? 0.9
                : tt < 4.8
                  ? 0
                  : tt < 4.85
                    ? 1
                    : 0.4;
      f.steer = s;
      f.drift = drift;
      step(real, [f], t, [P]);
      mine.tick(s, drift);
      const a = real.cars[0]!;
      const b = mine.car;
      worst = Math.max(
        worst,
        Math.abs(a.x - b.x),
        Math.abs(a.vel - b.vel),
        Math.abs(a.speed - b.speed),
      );
      if (a.state !== b.state) worst = Infinity;
    }
  }
  return worst;
}

// ---------------------------------------------------------------- measurements
const runN = (r: Rig, s: number, drift: boolean, sec: number): void => {
  for (let i = 0; i < Math.round(sec / DT); i++) r.tick(s, drift);
};
/** Mean dx/dt over the last second of `secs` at raw finger s in DRIFT dir +1; pinned or free. */
function lat(v: V, curve: number, s: number, pin: boolean, secs: number) {
  const r = new Rig(v);
  r.curve = curve;
  r.enterDrift(s);
  let sum = 0;
  let sl = 0;
  let n = 0;
  const N = Math.round(secs / DT);
  for (let i = 0; i < N; i++) {
    if (pin) r.car.speed = 1;
    r.tick(s, true);
    if (pin) r.car.speed = 1;
    if (i * DT >= secs - 1) {
      sum += r.dx;
      sl += r.slip;
      n++;
    }
  }
  return { vx: sum / n, slip: sl / n, speed: r.car.speed, state: r.car.state };
}
function hold(v: V, curve: number, pin: boolean) {
  let lo = -1;
  let hi = 1;
  const secs = pin ? 3 : 8;
  if (lat(v, curve, 1, pin, secs).vx < 0) return { steer: NaN, slip: NaN, speed: NaN };
  if (lat(v, curve, -1, pin, secs).vx > 0) return { steer: -Infinity, slip: NaN, speed: NaN };
  let res = lat(v, curve, 0, pin, secs);
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2;
    res = lat(v, curve, m, pin, secs);
    if (res.vx > 0) hi = m;
    else lo = m;
  }
  return { steer: (lo + hi) / 2, slip: res.slip, speed: res.speed };
}
type Hold = ReturnType<typeof hold>;
/** Steady drift at the free hold (6 s), returns the rig. */
function steady(v: V, curve: number, h: number): Rig {
  const r = new Rig(v);
  r.curve = curve;
  r.enterDrift(h);
  runN(r, h, true, 6);
  return r;
}

// (1) wrong way: steady drift dir +1 on a straight at finger 0.5, then a corner to the LEFT
// (curve -C, A*dir < 0) with the finger fully against dir (-1); outward = +x. From x = 0.
interface Wrong {
  tOff: number;
  v: number; // mean dx/dt over 0.5-1.5 s (+ = outward, toward the drift side)
  exitAt: number; // V3: time of the auto-exit
  runOut: number; // V3: max x - x(exit) after the exit
  speed: number;
}
function wrongWay(v: V, cAbs: number): Wrong {
  const r = new Rig(v);
  runN(r, 0, true, 0.2);
  r.tick(1, true); // flick 0 -> 1
  runN(r, 0.5, true, 2);
  r.curve = -cAbs;
  r.car.x = 0;
  const out: Wrong = { tOff: NaN, v: NaN, exitAt: NaN, runOut: NaN, speed: NaN };
  let xa = 0;
  let xExit = NaN;
  let maxAfter = -Infinity;
  for (let i = 1; i <= 720; i++) {
    const was = r.car.state;
    r.tick(-1, true);
    const t = i * DT;
    if (was === 'DRIFT' && r.car.state === 'GRIP' && Number.isNaN(out.exitAt)) {
      out.exitAt = t;
      xExit = r.car.x;
    }
    if (!Number.isNaN(xExit)) maxAfter = Math.max(maxAfter, r.car.x);
    if (i === 60) xa = r.car.x;
    if (i === 180) out.v = r.car.x - xa;
    if (Number.isNaN(out.tOff) && r.car.x > 1) out.tOff = t;
  }
  out.speed = r.car.speed;
  if (!Number.isNaN(xExit)) out.runOut = maxAfter - xExit;
  return out;
}
/** GRIP from the straight at vmax into a left corner with steer s (outward = +x). */
function gripOff(cAbs: number, s: number): number {
  const r = new Rig(V0);
  runN(r, 0, false, 1);
  r.curve = -cAbs;
  for (let i = 1; i <= 720; i++) {
    r.tick(s, false);
    if (r.car.x > 1) return i * DT;
  }
  return NaN;
}

// (2) skill band: from the steady hold, the finger moves to u and stays BAND_T s; inside the band
// while max |x - x0| <= 0.6 (the car started on the centre line). Scan with step 0.01.
function band(v: V, curve: number, h: number): { lo: number; hi: number } {
  const base = steady(v, curve, h);
  const snap = JSON.stringify(base.car);
  const ok = (u: number): boolean => {
    const r = new Rig(v);
    r.curve = curve;
    Object.assign(r.car, JSON.parse(snap));
    const x0 = r.car.x;
    for (let i = 0; i < Math.round(BAND_T / DT); i++) {
      r.tick(u, true);
      if (Math.abs(r.car.x - x0) > 0.6) return false;
    }
    return true;
  };
  let lo = h;
  let hi = h;
  while (lo - 0.01 >= -1 && ok(lo - 0.01)) lo -= 0.01;
  while (hi + 0.01 <= 1 && ok(hi + 0.01)) hi += 0.01;
  return { lo, hi };
}

// (3) straight: lane time from the steady drift at finger 0 (3 s), finger to +1 / -1.
function laneTime(v: V, curve: number, h: number, s: number): number {
  const r = steady(v, curve, h);
  const x0 = r.car.x;
  const side = s > h ? 1 : -1;
  for (let i = 1; i <= 360; i++) {
    r.tick(s, true);
    if ((r.car.x - x0) * side >= LANE) return i * DT;
  }
  return NaN;
}

// (5) guards
function wobble(v: V, h: number): number {
  let worst = 0;
  for (let seed = 1; seed <= 5; seed++) {
    let rng = seed * 7919;
    const rnd = (): number => {
      rng = (Math.imul(rng, 1103515245) + 12345) | 0;
      return ((rng >>> 8) & 0xffff) / 0xffff;
    };
    const r = steady(v, C.hard, h);
    const x0 = r.car.x;
    let noise = 0;
    for (let i = 0; i < 1200; i++) {
      if (i % 6 === 0) noise = (rnd() * 2 - 1) * 0.1;
      r.tick(h + noise, true);
      worst = Math.max(worst, Math.abs(r.car.x - x0));
    }
  }
  return worst;
}
/** R89b T5 normal flick (from 0) into hard: x at 0.6 s (+ inward), kick-vs-no-kick, t90, overshoot. */
function entry(v: V, h: number) {
  const go = (p: CarParams) => {
    const r = new Rig(v, p);
    runN(r, 0, true, 0.13);
    r.curve = C.hard;
    const xs: number[] = [];
    const vis: number[] = [];
    for (let i = 0; i < 300; i++) {
      r.tick(i * DT < 0.06 ? 1 : h, true);
      xs.push(r.car.x);
      vis.push(r.slip);
    }
    return { xs, vis };
  };
  const a = go(P);
  const b = go({ ...P, kickBase: 0, kickGain: 0 });
  let d = 0;
  for (let i = 0; i < 72; i++) d = Math.max(d, Math.abs(a.xs[i]! - b.xs[i]!));
  const tail = a.vis.slice(180);
  const st = tail.reduce((s, x) => s + x, 0) / tail.length;
  let t90 = NaN;
  for (let i = 0; i < a.vis.length; i++)
    if (Number.isNaN(t90) && a.vis[i]! >= 0.9 * st) t90 = (i + 1) * DT;
  return { x06: a.xs[71]!, kick: d, t90, over: Math.max(...a.vis) / st - 1 };
}
/** R89b exit: steady hard 4 s at hold, release, steer 1 GRIP 1 s: dx (- = outward). */
function runOut(v: V, h: number): number {
  const r = new Rig(v);
  r.curve = C.hard;
  r.enterDrift(h);
  runN(r, h, true, 4);
  const x0 = r.car.x;
  runN(r, 1, false, 1);
  return r.car.x - x0;
}
/** R89b agility: straight, finger held at 0 for 0.3 s, steer 0 -> 1 in 80 ms: lane time; coast back. */
function sharpFlick(v: V, back: boolean): { t1: number; coast: number } {
  const r = new Rig(v);
  runN(r, 0, true, 0.3);
  let st = 0;
  let t1 = NaN;
  let xStop = NaN;
  let maxAfter = -Infinity;
  for (let i = 1; i <= 480; i++) {
    const b = !Number.isNaN(t1) && back;
    st = approach(st, b ? 0 : 1, 0.08);
    r.tick(st, true);
    if (Number.isNaN(t1) && r.car.x >= LANE) t1 = i * DT;
    if (b) {
      if (Number.isNaN(xStop) && st === 0) xStop = r.car.x;
      if (!Number.isNaN(xStop)) maxAfter = Math.max(maxAfter, r.car.x);
    }
    if (!back && !Number.isNaN(t1)) break;
  }
  return { t1, coast: maxAfter - xStop };
}
/** R89b T9 closeness to model A (driftLead 0), A through the real step. */
function closeA(v: V): number {
  const hA = (() => {
    // model A free hold through the real step (bisection as the test)
    const latA = (s: number): number => {
      const race = createRace(1, 1);
      const c = race.cars[0]!;
      c.speed = 1;
      c.state = 'DRIFT';
      c.dir = 1;
      c.driftHeld = true;
      c.angle = clamp(s, 0, 1);
      c.steer = s;
      const t: Track = { segments: [{ curve: C.hard }] };
      const f: InputFrame = { steer: s, brake: false, drift: true };
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 960; i++) {
        const x0 = c.x;
        step(race, [f], t, [PA]);
        if (i * DT >= 7) {
          sum += (c.x - x0) / DT;
          n++;
        }
      }
      return sum / n;
    };
    let lo = -1;
    let hi = 1;
    for (let i = 0; i < 22; i++) {
      const m = (lo + hi) / 2;
      if (latA(m) > 0) hi = m;
      else lo = m;
    }
    return (lo + hi) / 2;
  })();
  const seq = (t: number): number => (t < 2 ? hA : t < 2.5 ? hA + 0.2 : hA - 0.2);
  const ra = createRace(1, 1);
  ra.cars[0]!.speed = 1;
  const b = new Rig(v, { ...P, driftLead: 0 });
  const f: InputFrame = { steer: 0, brake: false, drift: false };
  const t0: Track = { segments: [{ curve: 0 }] };
  const th: Track = { segments: [{ curve: C.hard }] };
  for (let i = 0; i < 36; i++) {
    f.drift = i >= 30;
    step(ra, [f], t0, [PA]);
    b.tick(0, f.drift);
  }
  b.curve = C.hard;
  let maxD = 0;
  f.drift = true;
  for (let i = 0; i < 360; i++) {
    f.steer = seq(i * DT);
    step(ra, [f], th, [PA]);
    b.tick(f.steer, true);
    maxD = Math.max(maxD, Math.abs(b.car.x - ra.cars[0]!.x));
  }
  return maxD;
}

// S-bend (scurve figure): right hard 120 seg, leave 15, enter 15, left hard 180 seg. Start in the
// steady right drift on the centre line. Finger law in DRIFT: u = uh + (kx*(d*xIn - x)*d - kv*vx*d)/S
// with the variant's own hold uh and slope S (finger units -> half-widths/s). Release at tr s
// relative to the curve crossing 0 (steer -> 0 in releaseMs, finger up 0.1 s), re-touch at 0, flick
// to -1 in 60 ms, then the law with d = -1. GRIP between: steer 0. Time lost vs a car at the steady
// vmax all the way (the same for all variants); road used = max |x|.
const KX = 1.5;
const KV = 0.6;
const X_IN = 0.2;
function sbend(v: V, hHard: Hold, slope: number, tr: number) {
  const segs: number[] = [];
  for (let i = 0; i < 120; i++) segs.push(C.hard);
  for (let i = 0; i < 15; i++) segs.push(C.hard * (1 - (i + 1) / 15));
  for (let i = 0; i < 15; i++) segs.push(-C.hard * ((i + 1) / 15));
  for (let i = 0; i < 400; i++) segs.push(-C.hard);
  const zCross = 135;
  const r = new Rig(v);
  r.segs = segs;
  r.car.speed = hHard.speed;
  r.enterDrift(hHard.steer);
  const law = (d: number): number => {
    const c = r.car;
    const u = hHard.steer + (KX * (d * X_IN - c.x) * d - KV * c.vx * d) / slope;
    return clamp(u * d, -1, 1);
  };
  let phase = 0; // 0 drift right, 1 released, 2 re-touch, 3 flick, 4 drift left / law
  let tPh = 0;
  let st = hHard.steer;
  let maxX = 0;
  let t = 0;
  let tCross = NaN;
  const vIdeal = 1 * SEG_PER_UNIT; // a car at vmax all the way (upper bound)
  for (let i = 0; i < 1200; i++) {
    t = i * DT;
    if (Number.isNaN(tCross) && r.car.z >= zCross) tCross = t;
    const rel = Number.isNaN(tCross)
      ? -((zCross - r.car.z) / (r.car.speed * SEG_PER_UNIT))
      : t - tCross;
    let drift = true;
    if (phase === 0) {
      st = law(1);
      if (rel >= tr) {
        phase = 1;
        tPh = t;
      }
    }
    if (phase === 1) {
      drift = false;
      st = approach(st, 0, RELEASE_S);
      if (t - tPh >= 0.1) {
        phase = 2;
        tPh = t;
      }
    } else if (phase === 2) {
      st = 0;
      if (t - tPh >= 2 * DT) {
        phase = 3;
        tPh = t;
      }
    } else if (phase === 3) {
      st = approach(st, -1, 0.06);
      if (r.car.state === 'DRIFT' && r.car.dir === -1) phase = 4;
      if (t - tPh > 0.3) phase = 4; // flick failed: hold the law anyway (GRIP steer)
    }
    if (phase === 4) st = r.car.state === 'DRIFT' ? law(r.car.dir) : -1;
    r.tick(st, drift);
    maxX = Math.max(maxX, Math.abs(r.car.x));
    if (!Number.isNaN(tCross) && t - tCross >= 3) break;
  }
  const lost = (vIdeal * (t + DT) - r.car.z) / vIdeal;
  return { maxX, lost, dir: r.car.dir, auto: r.autoExits };
}

// ---------------------------------------------------------------- evaluate one variant
interface M {
  v: V;
  wrong: Record<'easy' | 'medium' | 'hard', Wrong>;
  holds: Record<'medium' | 'hard' | 'sharp', Hold & { band: { lo: number; hi: number } }>;
  straight: { vmin: number; vmax: number; v0: number; lanePlus: number; laneMinus: number };
  dodge: { inT: number; outT: number; out05: number };
  wob: number;
  ent: ReturnType<typeof entry>;
  runOut: number;
  flick: number;
  coast: number;
  r89: { hard0: number; hard1: number; slope: number; med0: number; med1: number; hpin: number };
  close: number;
  s: {
    tr: number;
    maxX: number;
    lost: number;
    auto: number;
    ok: boolean;
    okLo: number;
    okHi: number;
    lost0: number;
    max0: number;
  };
}
const V0: V = { name: 'V0 today', band: false, half: false, uMin: 0, wrongPush: 0, tWrong: 0 };

function evaluate(v: V): M {
  const holdsP = {} as M['holds'];
  for (const k of ['medium', 'hard', 'sharp'] as const) {
    const h = hold(v, C[k], false);
    holdsP[k] = {
      ...h,
      band: Number.isFinite(h.steer) ? band(v, C[k], h.steer) : { lo: NaN, hi: NaN },
    };
  }
  const wrong = {} as M['wrong'];
  for (const k of ['easy', 'medium', 'hard'] as const) wrong[k] = wrongWay(v, C[k]);
  let vmin = Infinity;
  let vmx = -Infinity;
  for (let u = -1; u <= 1 + 1e-9; u += 0.1) {
    const x = lat(v, 0, u, true, 3).vx;
    vmin = Math.min(vmin, x);
    vmx = Math.max(vmx, x);
  }
  const hh = holdsP.hard.steer;
  const hp = hold(v, C.hard, true).steer;
  const e = 0.05;
  const slope = (lat(v, C.hard, hp + e, true, 3).vx - lat(v, C.hard, hp - e, true, 3).vx) / (2 * e);
  // S-bend: best release time
  let best = {
    tr: NaN,
    maxX: Infinity,
    lost: Infinity,
    auto: 0,
    ok: false,
    okLo: NaN,
    okHi: NaN,
    lost0: NaN,
    max0: NaN,
  };
  for (let k = -24; k <= 16; k++) {
    const tr = k * 0.05;
    const s = sbend(v, holdsP.hard, Math.max(0.05, slope), tr);
    const ok = s.maxX <= 1 && s.dir === -1;
    if (k === 0) {
      best.lost0 = s.lost;
      best.max0 = s.maxX;
    }
    if (ok) {
      if (Number.isNaN(best.okLo)) best.okLo = tr;
      best.okHi = tr;
    }
    if ((ok && !best.ok) || (ok === best.ok && s.lost < best.lost))
      best = {
        ...best,
        tr: Math.round(tr * 100) / 100,
        maxX: s.maxX,
        lost: s.lost,
        auto: s.auto,
        ok,
      };
  }
  const fl = sharpFlick(v, false);
  const co = sharpFlick(v, true);
  return {
    v,
    wrong,
    holds: holdsP,
    straight: {
      vmin,
      vmax: vmx,
      v0: lat(v, 0, 0, true, 3).vx,
      lanePlus: laneTime(v, 0, 0, 1),
      laneMinus: laneTime(v, 0, 0, -1),
    },
    dodge: {
      inT: laneTime(v, C.hard, hh, 1),
      outT: laneTime(v, C.hard, hh, -1),
      out05: laneTime(v, C.hard, hh, hh - 0.5),
    },
    wob: wobble(v, hh),
    ent: entry(v, hh),
    runOut: runOut(v, hh),
    flick: fl.t1,
    coast: co.coast,
    r89: {
      hard0: lat(v, C.hard, 0, true, 3).vx,
      hard1: lat(v, C.hard, 1, true, 3).vx,
      slope,
      med0: lat(v, C.medium, 0, true, 3).vx,
      med1: lat(v, C.medium, 1, true, 3).vx,
      hpin: hp,
    },
    close: closeA(v),
    s: best,
  };
}

// ---------------------------------------------------------------- output
const f2 = (v: number, d = 2): string =>
  Number.isFinite(v) ? v.toFixed(d) : Number.isNaN(v) ? '—' : String(v);
const tOff = (w: Wrong): string => (Number.isNaN(w.tOff) ? 'держит' : f2(w.tOff));
function table(io: Io, head: string[], rows: string[][]): void {
  io.log('| ' + head.join(' | ') + ' |');
  io.log('|' + head.map(() => ' --- ').join('|') + '|');
  for (const r of rows) io.log('| ' + r.join(' | ') + ' |');
  io.log('');
}

export function main(io: Io): number {
  const set = argValue(io.argv, 'set');
  if (set)
    for (const kv of set.split(',')) {
      const [k, val] = kv.split('=');
      P = { ...P, [k!]: Number(val) };
    }
  const wpList = (argValue(io.argv, 'wp') ?? '0.06,0.08,0.09,0.1,0.11,0.12,0.14')
    .split(',')
    .map(Number);
  io.log(
    `validate V0 copy vs real step: max |dx|,|dvel|,|dspeed| = ${validate().toExponential(2)}`,
  );
  io.log('');

  // reference: GRIP into the same left corner
  const gripRows: string[][] = [];
  const grip0: Record<string, number> = {};
  for (const k of ['easy', 'medium', 'hard'] as const) {
    grip0[k] = gripOff(C[k], 0);
    gripRows.push([k, f2(grip0[k]), f2(gripOff(C[k], -1))]);
  }
  io.log('GRIP reference, from x = 0 at vmax into the corner: time to |x| = 1');
  table(io, ['поворот', 'руль 0', 'полный руль внутрь'], gripRows);

  // V2 sweep of wrongPush per uMin: match GRIP steer-0 time in medium and hard
  const uMins = [0.2, 0.3, 0.4];
  const halfMins = [0, 0.2]; // extra mapping H (not in the task), see V.half
  io.log(
    'V2 sweep: wrong-way drift, finger fully against dir, time to leave the road (medium / hard); target = GRIP steer 0',
  );
  const swRows: string[][] = [];
  const bestWp = (half: boolean, uMin: number): number => {
    let bestErr = Infinity;
    let best = NaN;
    for (const wp of wpList) {
      const v: V = { name: '', band: true, half, uMin, wrongPush: wp, tWrong: 0 };
      const m = wrongWay(v, C.medium).tOff;
      const h = wrongWay(v, C.hard).tOff;
      const err = Math.log(m / grip0.medium!) ** 2 + Math.log(h / grip0.hard!) ** 2;
      if (err < bestErr) {
        bestErr = err;
        best = wp;
      }
      swRows.push([
        half ? 'H' : 'D1',
        f2(uMin, 1),
        f2(wp, 3),
        f2(m),
        f2(h),
        f2(wrongWay(v, C.easy).v, 3),
      ]);
    }
    return best;
  };
  const wpD = uMins.map((u) => bestWp(false, u));
  const wpH = halfMins.map((u) => bestWp(true, u));
  table(
    io,
    ['отображение', 'uMin', 'wrongPush', 'medium, с', 'hard, с', 'easy, пш/с наружу'],
    swRows,
  );

  const mk = (name: string, half: boolean, uMin: number, wp: number, tw: number): V => ({
    name,
    band: true,
    half,
    uMin,
    wrongPush: wp,
    tWrong: tw,
  });
  const vs: V[] = [V0];
  uMins.forEach((u) => vs.push(mk(`V1 uMin ${u}`, false, u, 0, 0)));
  uMins.forEach((u, i) => vs.push(mk(`V2 uMin ${u} wp ${wpD[i]}`, false, u, wpD[i]!, 0)));
  uMins.forEach((u, i) => vs.push(mk(`V3 uMin ${u} wp ${wpD[i]} T 0.3`, false, u, wpD[i]!, 0.3)));
  halfMins.forEach((u, i) => vs.push(mk(`H uMin ${u} wp ${wpH[i]}`, true, u, wpH[i]!, 0)));
  halfMins.forEach((u, i) => vs.push(mk(`H uMin ${u} wp ${wpH[i]} T 0.3`, true, u, wpH[i]!, 0.3)));
  const only = argValue(io.argv, 'only');
  const ms = vs
    .filter((v) => !only || only.split(';').some((o) => v.name.startsWith(o)))
    .map(evaluate);

  io.log(
    '(1) Wrong way: steady drift (dir +1, finger 0.5 on a straight) into a corner the other way, finger fully against dir. Time to leave the road from x = 0; v = mean dx/dt over 0.5-1.5 s (+ outward); V3: auto-exit time and run-out after it.',
  );
  table(
    io,
    [
      'вариант',
      'easy t / v',
      'medium t / v',
      'hard t / v',
      'V3 выход, с',
      'V3 вынос после, пш (m / h)',
    ],
    ms.map((m) => [
      m.v.name,
      `${tOff(m.wrong.easy)} / ${f2(m.wrong.easy.v, 3)}`,
      `${tOff(m.wrong.medium)} / ${f2(m.wrong.medium.v, 3)}`,
      `${tOff(m.wrong.hard)} / ${f2(m.wrong.hard.v, 3)}`,
      f2(m.wrong.hard.exitAt),
      `${f2(m.wrong.medium.runOut)} / ${f2(m.wrong.hard.runOut)}`,
    ]),
  );
  io.log(
    `(2) Right way: free hold (raw finger u), on-screen angle slip*slipDeg, speed; skill band = finger range where max |x - x0| <= 0.6 over ${BAND_T} s from the steady hold.`,
  );
  table(
    io,
    [
      'вариант',
      'medium u / ° / v',
      'medium полоса (ширина)',
      'hard u / ° / v',
      'hard полоса (ширина)',
      'sharp u / ° / v',
      'sharp полоса (ширина)',
    ],
    ms.map((m) => {
      const c = (k: 'medium' | 'hard' | 'sharp') => {
        const h = m.holds[k];
        return [
          `${f2(h.steer)} / ${f2(h.slip * SLIP_DEG, 1)} / ${f2(h.speed, 3)}`,
          `${f2(h.band.lo)}…${f2(h.band.hi)} (${f2(h.band.hi - h.band.lo)})`,
        ];
      };
      return [m.v.name, ...c('medium'), ...c('hard'), ...c('sharp')];
    }),
  );
  io.log(
    '(3) Straight (pinned vmax): lateral speed over the whole finger range (+ = to the drift side), finger 0; lane time from the steady drift at finger 0 to +1 / -1. (4) Steady hard drift: one lane inward (+1) / outward (-1) / outward with hold-0.5 (R89b <= 1.0).',
  );
  table(
    io,
    [
      'вариант',
      'прямая min…max',
      'прямая u=0',
      'полоса +1 / −1, с',
      'hard внутрь / наружу / h−0.5, с',
    ],
    ms.map((m) => [
      m.v.name,
      `${f2(m.straight.vmin, 3)}…${f2(m.straight.vmax, 3)}`,
      f2(m.straight.v0, 3),
      `${f2(m.straight.lanePlus)} / ${f2(m.straight.laneMinus)}`,
      `${f2(m.dodge.inT)} / ${f2(m.dodge.outT)} / ${f2(m.dodge.out05)}`,
    ]),
  );
  io.log(
    '(5) Guards: noise ±0.1 20 Hz in hard (worst of 5 seeds, 10 s); entry (normal flick into hard): x at 0.6 s (+ inward), kick vs no kick, t90, overshoot; exit run-out (release + full steer, 1 s); flick on a straight lane time and coast; closeness to A; S-bend best release tr (s from the curve crossing 0), max |x|, time lost.',
  );
  table(
    io,
    [
      'вариант',
      'шум',
      'вход x0.6 / толчок / t90 / перелёт',
      'вынос',
      'рывок полоса / докат',
      'близость A',
      'S: tr (окно) / max|x| / потеря, с / автовыход',
    ],
    ms.map((m) => [
      m.v.name,
      f2(m.wob, 3),
      `${f2(m.ent.x06, 3)} / ${f2(m.ent.kick, 3)} / ${f2(m.ent.t90)} / ${f2(m.ent.over * 100, 0)}%`,
      f2(m.runOut, 3),
      `${f2(m.flick)} / ${f2(m.coast, 3)}`,
      f2(m.close, 3),
      `${f2(m.s.tr)} (${f2(m.s.okLo)}…${f2(m.s.okHi)}) / ${f2(m.s.maxX)}${m.s.ok ? '' : ' (нет)'} / ${f2(m.s.lost, 3)} / ${m.s.auto}; tr 0: ${f2(m.s.max0)} / ${f2(m.s.lost0, 3)}`,
    ]),
  );
  io.log(
    'R89b windows (raw finger, pinned vmax as the tests): hard u=0 out 0.3-0.5, u=1 in <= 0.2, slope 0.4-0.8, hold 0.70-0.85, angle 30-40; medium u=0 out 0.2-0.35, u=1 in 0.15-0.3, hold 0.45-0.55, angle 15-25; straight u=1 <= 0.6, u=0 <= 0.05.',
  );
  table(
    io,
    [
      'вариант',
      'hard u=0',
      'hard u=1',
      'наклон',
      'hard удерж. (своб.)',
      'medium u=0',
      'medium u=1',
      'medium удерж.',
      'hard ° / medium °',
      'v hard / medium',
    ],
    ms.map((m) => [
      m.v.name,
      f2(-m.r89.hard0, 3),
      f2(m.r89.hard1, 3),
      f2(m.r89.slope, 3),
      f2(m.holds.hard.steer, 3),
      f2(-m.r89.med0, 3),
      f2(m.r89.med1, 3),
      f2(m.holds.medium.steer, 3),
      `${f2(m.holds.hard.slip * SLIP_DEG, 1)} / ${f2(m.holds.medium.slip * SLIP_DEG, 1)}`,
      `${f2(m.holds.hard.speed, 3)} / ${f2(m.holds.medium.speed, 3)}`,
    ]),
  );
  return 0;
}

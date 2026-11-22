// Model C helpers (docs/brief.md R150-R164, docs/research/model-c.md; spike tools/spike/model-c.ts).
// The runs of R163 repeated through the real `step`. The model C numbers below are the brief's start
// numbers, spread from a variable so the sim tests do not depend on cars/base.json (its numbers have
// their own test, tests/sim/modelc_data.test.ts).
import { baseCar } from '../../src/data/cars';
import sprites from '../../src/data/sprites.json';
import { curveClasses, resolveSections, trackSections } from '../../src/data/tracks';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';

export const C = curveClasses as Record<string, number>;
/** R89 slipDeg (sprites.json weight), used by R156 / R158 / R87 in model C. */
export const SLIP_DEG = (sprites as { weight: { slipDeg: number } }).weight.slipDeg;

/** Brief start numbers of model C (R153-R159). Angles in degrees. */
export const MC_START = {
  liftOn: 0.4, // R154
  liftOff: 0.2,
  driftWindow: 0.5,
  betaEntry: 40,
  winTau: 0.06,
  betaOn: 8.4,
  betaPerA: 3.4, // R153
  refLook: 0.3,
  refTau: 0.12,
  uHold: 0.5, // R155
  betaMax: 70,
  betaTau: 0.12,
  entryFloor: 12,
  latPerDeg: 0.02, // R156
  thrLat: 0.3,
  velGripC: 4,
  railK: 6,
  bumpFrom: 0.6,
  bumpGain: 0.6,
  outSlide: 0.5,
  missFree: 2, // R157
  missLoss: 0.018,
  missCap: 15,
  missBrake: 0.6,
  liftDecelDrift: 0.08,
  thrAccelUp: 1,
  driftEndDelay: 0.2, // R158
  switchWindow: 0.3,
  liftDecel: 0.35, // R159
  exitRamp: 0.3,
} as const;

/**
 * The criteria car of R163: the spike's car (real base car, model B GRIP numbers, variant 3, turbo
 * off) on model 2 with the start numbers above.
 */
export const PC: CarParams = {
  ...baseCar,
  driftTurbo: 0,
  driftEntry: 3,
  ...MC_START,
  slipDeg: SLIP_DEG,
  model: 2,
};
/** The same car on model B (H14 = B, R150: model B stays in code as model 1). */
export const PB1: CarParams = { ...PC, model: 1 };

/** The new Car fields of R152, read through a cast until they exist in the type. */
export interface CFields {
  beta: number;
  betaI: number;
  refA: number;
  winTicks: number;
  winDir: number;
  wBeta: number;
  liftArmed: number;
  endTicks: number;
  exitTicks: number;
}
export const C_FIELDS = [
  'beta',
  'betaI',
  'refA',
  'winTicks',
  'winDir',
  'wBeta',
  'liftArmed',
  'endTicks',
  'exitTicks',
] as const;
export const cf = (c: Car): CFields => c as unknown as CFields;

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const sgn = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

// ------------------------------------------------------------------------------------------ tracks
const figCache = new Map<string, Track>();
/** Spike figTrack: straight pre, enter (t^2) 30, hold len, leave 30 (cosine), straight 6000. */
export function figTrack(c: number, len: number, pre = 120): Track {
  const key = `${c}/${len}/${pre}`;
  let t = figCache.get(key);
  if (t) return t;
  const segments = [];
  for (let i = 0; i < pre; i++) segments.push({ curve: 0, y: 0 });
  for (let n = 0; n < 30; n++) segments.push({ curve: c * (n / 30) * (n / 30), y: 0 });
  for (let n = 0; n < len; n++) segments.push({ curve: c, y: 0 });
  for (let n = 0; n < 30; n++)
    segments.push({ curve: c * (1 - (0.5 - Math.cos((Math.PI * n) / 30) / 2)), y: 0 });
  for (let i = 0; i < 6000; i++) segments.push({ curve: 0, y: 0 });
  t = { segments };
  figCache.set(key, t);
  return t;
}
/** Mirror of a track (curve -> -curve). */
export const mirrorTrack = (t: Track): Track => ({
  segments: t.segments.map((g) => ({ curve: g.curve === 0 ? 0 : -g.curve, y: 0 })),
});
/** Spike figTrackOf: straight x2, the figure (side +1), straight x3; len = segments - 120. */
export function figTrackOf(name: string): { track: Track; len: number } {
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

// ------------------------------------------------------------------------------------------ runner
/** One car on model C through the real step. t = seconds stepped. */
export class Sim {
  readonly st: RaceState;
  readonly car: Car;
  readonly fr: InputFrame = { steer: 0, brake: false, drift: false, throttle: 0 };
  t = 0;
  entries = 0;
  /** dir of every GRIP -> DRIFT change, in order. */
  readonly entryDirs: number[] = [];
  /** Speed / vmax and curve of the segment at the start of the last tick (R83 sp, A). */
  sp0 = 1;
  curve0 = 0;
  constructor(
    readonly track: Track,
    readonly p: CarParams = PC,
    speed = 1,
    x = 0,
    z = 0,
  ) {
    this.st = createRace(1, 1);
    this.car = this.st.cars[0]!;
    this.car.speed = speed * p.vmax;
    this.car.x = x;
    this.car.z = z;
  }
  curveAt(z: number): number {
    const n = this.track.segments.length;
    let i = Math.floor(z) % n;
    if (i < 0) i += n;
    return this.track.segments[i]!.curve;
  }
  get drift(): boolean {
    return this.car.state === 'DRIFT';
  }
  tick(steer: number, thr: number): void {
    const was = this.car.state;
    this.sp0 = this.car.speed / this.p.vmax;
    this.curve0 = this.curveAt(this.car.z);
    this.fr.steer = steer;
    this.fr.throttle = thr;
    step(this.st, [this.fr], this.track, [this.p]);
    this.t += DT;
    if (was === 'GRIP' && this.car.state === 'DRIFT') {
      this.entries++;
      this.entryDirs.push(this.car.dir);
    }
  }
}

/** Spike gripSteer: model B GRIP line feed-forward to xT (R83/R84 hold steer + feedback). */
export function gripSteer(s: Sim, xT: number): number {
  const p = s.p;
  const car = s.car;
  const sp = car.speed / p.vmax;
  const A = s.curveAt(car.z + sp * SEG_PER_UNIT * 0.1) * sp * p.kYaw;
  const f = Math.min(1, sp / p.yawFullSpeed);
  const sG = clamp(A / p.velGrip, -p.slipGripMax, p.slipGripMax);
  const ff = (A + p.yawAlign * sG) / (p.yawRateMax * f);
  return clamp(ff + 1.5 * (xT - car.x) - 0.4 * car.vel, -1, 1);
}

/**
 * Spike steadyDrift: a long corner of class c (figTrack(c, 4000), pre 120) at vmax; GRIP line to the
 * corner, then full steer with a 0.1 s lift until DRIFT, then `settle` s at the exact finger
 * (u = uHold with a small line correction) and the throttle line clamp(3x, -0.3, 1). c > 0: dir +1.
 */
export function steadyDrift(c: number, settle = 1.5, p: CarParams = PC): Sim {
  const s = new Sim(figTrack(c, 4000), p, 1);
  let guard = 0;
  while (s.car.z < 120 && guard++ < 100000) s.tick(gripSteer(s, 0), 0);
  const side = sgn(c);
  let i = 0;
  while (!s.drift && i < 120) {
    s.tick(side, i < 12 ? -1 : 0);
    i++;
  }
  const n = Math.round(settle / DT);
  for (let k = 0; k < n; k++) {
    const xi = s.car.x * side;
    s.tick(side * (MC_START.uHold - 0.15 * xi - 0.2 * s.car.vel * side), clamp(3 * xi, -0.3, 1));
  }
  return s;
}

// ------------------------------------------------------------------------------------------ scripted drivers (spike)
export interface Lvl {
  drift: boolean;
  lead: number; // s before the corner start (|c| >= 1) to lift; negative = after
  err: number; // relative finger error around uHold
  useThr: boolean;
  kx: number;
  release: boolean;
}
export const IDEAL: Lvl = {
  drift: true,
  lead: 0.15,
  err: 0,
  useThr: true,
  kx: 0.15,
  release: false,
};
export const MED: Lvl = { drift: true, lead: -0.15, err: 0.3, useThr: false, kx: 0, release: true };
export const GRIPL: Lvl = { drift: false, lead: 0, err: 0, useThr: false, kx: 0, release: true };

export interface Drv {
  lvl: Lvl;
  inSince: number;
  lift: number;
  side: number;
  nDrift: number;
}
export const mkDrv = (lvl: Lvl): Drv => ({ lvl, inSince: 0, lift: 0, side: 0, nDrift: 0 });

/** Spike `drive` on the real car state (state, dir, winTicks). */
export function drive(s: Sim, d: Drv, out: { steer: number; thr: number }): void {
  const p = s.p;
  const car = s.car;
  const sp = Math.max(0.05, car.speed / p.vmax);
  const L = d.lvl;
  const uHold = MC_START.uHold;
  if (s.drift) {
    d.lift = 0;
    d.side = 0;
    const dir = car.dir;
    const kx = Math.ceil(sp * SEG_PER_UNIT * 0.25);
    let keep = false;
    for (let i = 0; i <= kx; i++) if (s.curveAt(car.z + i) * dir >= 1.5) keep = true;
    if (!keep && L.release) {
      out.steer = 0;
      out.thr = 0;
      return;
    }
    const e = L.err * Math.sin((2 * Math.PI * s.t) / 1.6 + d.nDrift);
    const xi = car.x * dir;
    const edge = xi > 0.6 ? -(xi - 0.6) * 1.5 : xi < -0.6 ? (-xi - 0.6) * 1.5 : 0;
    const u = uHold * (1 + e) - L.kx * xi - (L.kx > 0 ? 0.2 * car.vel * dir : 0) + edge;
    out.steer = dir * clamp(u, 0, 1);
    out.thr = L.useThr ? clamp(3 * car.x * dir, -0.3, 1) : 0;
    return;
  }
  out.thr = 0;
  out.steer = gripSteer(s, 0);
  const win = cf(car).winTicks;
  if (!L.drift) {
    const gripA = p.yawRateMax / (1 + p.yawAlign / p.velGrip);
    const k = Math.ceil(sp * SEG_PER_UNIT * 1.0);
    let need = 0;
    for (let i = 0; i <= k; i++)
      need = Math.max(need, (Math.abs(s.curveAt(car.z + i)) * sp * p.kYaw) / gripA);
    if (need > 1.0 && Math.abs(out.steer) < 0.2) out.thr = -1;
    if (win > 0) out.steer = clamp(out.steer, -0.2, 0.2);
    return;
  }
  if (d.lift > 0 || win > 0) {
    if (d.lift > 0) d.lift--;
    if (d.side !== 0) {
      out.steer = d.side;
      out.thr = d.lift > 0 ? -1 : 0;
      return;
    }
  }
  const k = Math.ceil(sp * SEG_PER_UNIT * 2);
  let ds = -1;
  let side = 0;
  for (let i = 0; i <= k; i++) {
    const c = s.curveAt(car.z + i);
    if (Math.abs(c) >= 4.0) {
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
    if (s.curveAt(car.z + i) * side >= 1) {
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
/** After each tick (spike): in GRIP the entry side is kept only while the lift or window lives. */
export function afterTick(s: Sim, d: Drv): void {
  if (!s.drift) d.side = cf(s.car).winTicks > 0 || d.lift > 0 ? d.side : 0;
}

export interface FigRun {
  t: number;
  vmin: number;
  xmin: number;
  xmax: number;
  entries: number;
  entryDirs: number[];
}
/** Spike figureRun: drive the figure from a straight to z1; vmin / x range over z > 60. */
export function figureRun(track: Track, lvl: Lvl, z1: number): FigRun {
  const s = new Sim(track, PC, 1);
  const d = mkDrv(lvl);
  const o = { steer: 0, thr: 0 };
  let vmin = 9;
  let xmin = 9;
  let xmax = -9;
  while (s.car.z < z1 && s.t < 60) {
    drive(s, d, o);
    s.tick(o.steer, o.thr);
    afterTick(s, d);
    if (s.car.z > 60) {
      vmin = Math.min(vmin, s.car.speed / PC.vmax);
      xmin = Math.min(xmin, s.car.x);
      xmax = Math.max(xmax, s.car.x);
    }
  }
  return { t: s.t, vmin, xmin, xmax, entries: s.entries, entryDirs: s.entryDirs };
}

/** Spike partTap: the ideal driver, but in DRIFT it counter-steers after `on` s and stays GRIP `off` s. */
export function tapRun(track: Track, len: number, on: number, off: number): number {
  const s = new Sim(track, PC, 1);
  const d = mkDrv(IDEAL);
  const o = { steer: 0, thr: 0 };
  let inD = 0;
  let gripT = 0;
  while (s.car.z < len && s.t < 60) {
    drive(s, d, o);
    if (s.drift) {
      inD += DT;
      if (inD > on) o.steer = -s.car.dir;
      gripT = 0;
    } else {
      if (inD > 0) gripT += DT;
      if (gripT > 0 && gripT < off) {
        d.lift = 0;
        o.thr = 0;
        o.steer = gripSteer(s, 0);
      }
      if (gripT >= off) {
        inD = 0;
        gripT = 0;
      }
    }
    s.tick(o.steer, o.thr);
    afterTick(s, d);
  }
  return s.t;
}

/** Runs of maximal same-sign corner segments (|curve| >= 4) of a track up to z1: their signs. */
export function cornerSides(track: Track, z1: number): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < z1; i++) {
    const c = track.segments[i]!.curve;
    const sd = Math.abs(c) >= 4 ? sgn(c) : 0;
    if (sd !== 0 && sd !== prev) out.push(sd);
    prev = sd;
  }
  return out;
}

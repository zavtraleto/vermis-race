// THROWAWAY SPIKE (docs/research/drift-feel-diagnosis.md): four playtest complaints about model B.
// P1 GRIP lane change feel, P2 counter-steer in DRIFT, P3 inward cap in DRIFT, P4 tap-drift cheese.
// Everything runs through the REAL src/sim `step`; parameters are overridden in memory only.
// Prototype rule changes are emulated as wrappers (input shaping before `step`, x post-shift after).
// Run: node tools/run-ts.mjs tools/spike/drift-feel.ts [--part 1|2|3|4|all] [--seeds N]
import { botInput, createBot, type BotParams } from '../../src/bot/driver';
import { botParams } from '../../src/data/bots';
import { baseCar } from '../../src/data/cars';
import road from '../../src/data/road.json';
import sprites from '../../src/data/sprites.json';
import {
  curveClasses,
  expandFigures,
  figureDict,
  parseSections,
  resolveSections,
  type ClassedSection,
} from '../../src/data/tracks';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, Track } from '../../src/sim/types';
import { loadTracks, type LoadedTrack } from '../botlib';
import { argValue, type Io } from '../io';

const R = road as { lanes: number; halfWidth: number; segmentLength: number };
const LANE = 2 / R.lanes;
const W = (sprites as { weight: { slipDeg: number; velDeg: number } }).weight;
const C = curveClasses as Record<string, number>;
// Author 2026-11-20: drift exit turbo off for now.
const P0: CarParams = { ...baseCar, driftTurbo: 0 };
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
function table(io: Io, head: string[], rows: string[][]): void {
  io.log('| ' + head.join(' | ') + ' |');
  io.log('|' + head.map(() => ' --- ').join('|') + '|');
  for (const r of rows) io.log('| ' + r.join(' | ') + ' |');
  io.log('');
}
/** Path angle on screen/world, degrees: lateral speed (hw/s) vs forward speed (world units). */
const pathDeg = (vx: number, sp: number): number =>
  (Math.atan2(vx * R.halfWidth, Math.max(sp, 1e-6) * SEG_PER_UNIT * R.segmentLength) * 180) /
  Math.PI;
/** R89 body yaw on screen, degrees. */
const bodyDeg = (c: Car): number => (c.yaw - c.vel + c.carry) * W.slipDeg + c.vel * W.velDeg;

const trackCache = new Map<number, Track>();
function constTrack(curve: number): Track {
  let t = trackCache.get(curve);
  if (!t) {
    const segments = [];
    for (let i = 0; i < 6000; i++) segments.push({ curve });
    t = { segments };
    trackCache.set(curve, t);
  }
  return t;
}
const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  crashMinSpeed: 1e9,
});

// ---------------------------------------------------------------- prototype wrappers
/** Prototype knobs (0 = today's rules). */
interface Proto {
  /** P1 dive: extra GRIP lateral term diveGain*(steer*V - vel)*sp, only x (like gripLead). */
  dive?: number;
  /** P1 dodge: GRIP x term dodge*steer*sp*max(0, 1 - |A|/dodgeFade), only x. */
  dodge?: number;
  dodgeFade?: number;
  /** P2: DRIFT steer floor toward dir (u = max(uMin, steer*dir)). */
  uMin?: number;
  /** P3: DRIFT extra inward x term dir*driftDive*max(0, uc - aKnee)/(1 - aKnee)*sp. */
  driftDive?: number;
  aKnee?: number;
  /** P4: entry lead off until the drift has lasted leadDelay s (ticks counted in wrapper). */
  leadDelay?: number;
  /** P4 alt: R86b scrub in DRIFT scaled by (1 - min(1, a/scrubAngle)). */
  scrubDrift?: boolean;
  scrubAngle?: number;
  /** P4: scrub debt forgiven only after debtTime s of drift. */
  debtTime?: number;
}
interface Rig {
  race: ReturnType<typeof createRace>;
  car: Car;
  frame: InputFrame;
  p: CarParams;
  pr: Proto;
  driftT: number;
  debt: number;
}
function rig(p: CarParams, pr: Proto = {}, speed = p.vmax): Rig {
  const race = createRace(1, 1);
  race.cars[0]!.speed = speed;
  return {
    race,
    car: race.cars[0]!,
    frame: { steer: 0, brake: false, drift: false },
    p,
    pr,
    driftT: 0,
    debt: 0,
  };
}
/** One real step plus the prototype wrappers. */
function stepR(r: Rig, track: Track, steer: number, drift: boolean, pin?: number): void {
  const c = r.car;
  const p = r.p;
  const pr = r.pr;
  if (pin !== undefined) c.speed = pin * p.vmax;
  let s = steer;
  if (pr.uMin && c.state === 'DRIFT' && drift) {
    const u = s * c.dir;
    if (u < pr.uMin) s = c.dir * pr.uMin;
  }
  r.frame.steer = s;
  r.frame.drift = drift;
  const sp = c.speed / p.vmax;
  const n = track.segments.length;
  const A = track.segments[Math.floor(c.z) % n]!.curve * sp * p.kYaw;
  step(r.race, [r.frame], track, [p]);
  let add = 0;
  if (c.state === 'GRIP' && pr.dodge) {
    // P1 dodge: steer-only lateral term, full on a straight, 0 from |A| >= dodgeFade
    const fade = Math.max(0, 1 - Math.abs(A) / (pr.dodgeFade ?? 4));
    add += pr.dodge * clamp(s, -1, 1) * sp * fade;
  }
  if (c.state === 'GRIP' && pr.dive) {
    const V = (clamp(s, -1, 1) * p.yawRateMax * Math.min(1, sp / p.yawFullSpeed) - A) / p.yawAlign;
    add += pr.dive * (V - c.vel) * sp;
  }
  if (c.state === 'DRIFT') {
    r.driftT += DT;
    const uc = clamp(s * c.dir, 0, 1);
    const a = ((c.yaw - c.vel) * c.dir) / p.slipFull; // built angle (slip after R83)
    if (pr.driftDive) {
      // P3 dive on the BUILT angle a (not the finger), so it cannot fire on the entry tick
      const k = pr.aKnee ?? 0.8;
      add += ((c.dir * pr.driftDive * Math.max(0, Math.min(a, uc) - k)) / (1 - k)) * sp;
    }
    if (pr.leadDelay !== undefined && r.driftT < pr.leadDelay) {
      // P4: the R85 entry lead ramps in linearly over leadDelay s of drift age
      const keep = r.driftT / pr.leadDelay;
      add -= (1 - keep) * c.dir * p.driftLead * (uc - a) * sp * p.latScale;
    }
    if (pr.scrubDrift) {
      // P4 alt: R86b scrub also in DRIFT while the built angle is below scrubAngle
      const gA = p.yawRateMax / (1 + p.yawAlign / p.velGrip);
      const need = Math.abs(A) / gA;
      const cover = Math.min(1, a / (pr.scrubAngle ?? 0.5)); // a built angle pays the turn
      if (need > p.scrubStart)
        c.speed -= (1 - cover) * p.scrubRate * (need - p.scrubStart) * p.vmax * DT;
    }
    if (pr.debtTime !== undefined && r.driftT <= pr.debtTime) {
      // P4: scrub debt. While the drift is younger than debtTime the R86b scrub GRIP would pay
      // accumulates; a drift that lives debtTime forgives it, an earlier exit pays it at once.
      const gA = p.yawRateMax / (1 + p.yawAlign / p.velGrip);
      const need = Math.abs(A) / gA;
      if (need > p.scrubStart) r.debt += p.scrubRate * (need - p.scrubStart) * p.vmax * DT;
    }
  } else {
    if (pr.debtTime !== undefined && r.driftT > 0 && r.driftT <= pr.debtTime) {
      c.speed -= r.debt;
      if (c.speed < 0) c.speed = 0;
    }
    r.debt = 0;
    r.driftT = 0;
  }
  if (c.state === 'DRIFT' && pr.debtTime !== undefined && r.driftT > pr.debtTime) r.debt = 0;
  if (add !== 0) {
    c.x += add * DT;
    c.vx += add;
  }
  if (pin !== undefined) c.speed = pin * p.vmax;
}

// ---------------------------------------------------------------- P1 GRIP lane change
interface LaneRes {
  tLane: number;
  vx: number[]; // at sample times
  vxMax: number;
  bodyMax: number;
  body60: number; // body yaw 60 ms after steer
  pathMax: number;
  over: number; // x beyond the lane after release
  stop: number; // s after release until |dx/dt| <= 0.02 for good
}
const SAMPLES = [1 / 120, 0.033, 0.067, 0.1, 0.15, 0.2, 0.3];
function laneChange(p: CarParams, pr: Proto, sp: number, releaseMs: number): LaneRes {
  const r = rig(free(p), pr, sp * p.vmax);
  const tr = constTrack(0);
  const res: LaneRes = {
    tLane: NaN,
    vx: [],
    vxMax: 0,
    bodyMax: 0,
    body60: 0,
    pathMax: 0,
    over: 0,
    stop: NaN,
  };
  let t = 0;
  let si = 0;
  // hold full steer until the lane is reached, then release (touch: linear ramp releaseMs)
  let relT = NaN;
  const dxs: number[] = [];
  for (let k = 0; k < Math.round(2 / DT); k++) {
    let s = 1;
    if (!Number.isNaN(relT))
      s = releaseMs > 0 ? Math.max(0, 1 - ((t - relT) * 1000) / releaseMs) : 0;
    const x0 = r.car.x;
    stepR(r, tr, s, false, sp);
    t += DT;
    const vx = (r.car.x - x0) / DT;
    if (Number.isNaN(relT)) {
      while (si < SAMPLES.length && t >= SAMPLES[si]! - 1e-9) {
        res.vx.push(vx);
        si++;
      }
      if (vx > res.vxMax) res.vxMax = vx;
      const b = bodyDeg(r.car);
      if (b > res.bodyMax) res.bodyMax = b;
      if (Math.abs(t - 0.06) < DT / 2) res.body60 = b;
      const pa = pathDeg(vx, sp);
      if (pa > res.pathMax) res.pathMax = pa;
      if (r.car.x >= LANE) {
        res.tLane = t;
        relT = t;
      }
    } else {
      dxs.push(vx);
      if (r.car.x - LANE > res.over) res.over = r.car.x - LANE;
    }
  }
  while (res.vx.length < SAMPLES.length) res.vx.push(NaN);
  let last = -1;
  for (let i = 0; i < dxs.length; i++) if (Math.abs(dxs[i]!) > 0.02) last = i;
  res.stop = (last + 1) * DT;
  return res;
}
/** Steady outward speed in a constant corner, GRIP, steer s, speed pinned at sp (hw/s). */
function gripSteady(p: CarParams, pr: Proto, curve: number, s: number, sp: number): number {
  const r = rig(free(p), pr, sp * p.vmax);
  const tr = constTrack(curve);
  let x0 = 0;
  for (let k = 0; k < Math.round(3 / DT); k++) {
    if (k === Math.round(2.5 / DT)) x0 = r.car.x;
    stepR(r, tr, s, false, sp);
  }
  return (r.car.x - x0) / 0.5;
}

function part1(io: Io): void {
  io.log('## P1. GRIP: lane change, full steer at once (straight, speed pinned)');
  const cands: [string, Partial<CarParams>, Proto][] = [
    ['today (gripLead 0.9)', {}, {}],
    ['gripLead 0 (no lead)', { gripLead: 0 }, {}],
    ['V 1.5: yawRateMax 12.9, yawAlign 8.6 (gripA const)', { yawRateMax: 12.9, yawAlign: 8.6 }, {}],
    [
      'V 2.0: yawRateMax 11.95, yawAlign 5.98 (gripA const)',
      { yawRateMax: 11.95, yawAlign: 5.98 },
      {},
    ],
    ['gripLead 1.0', { gripLead: 1 }, {}],
    ['dodge 0.45 (fade |A| 4), gripLead 0.9', {}, { dodge: 0.45, dodgeFade: 4 }],
    ['dodge 0.75 (fade |A| 4), gripLead 0.9', {}, { dodge: 0.75, dodgeFade: 4 }],
    ['V 1.5 + gripLead 1.0', { yawRateMax: 12.9, yawAlign: 8.6, gripLead: 1 }, {}],
    ['V 1.5 + gripLead 1.3 (dive)', { yawRateMax: 12.9, yawAlign: 8.6, gripLead: 1.3 }, {}],
  ];
  const rows: string[][] = [];
  for (const [nm, po, pr] of cands) {
    const p = { ...P0, ...po };
    const gA = p.yawRateMax / (1 + p.yawAlign / p.velGrip);
    for (const sp of [0.6, 0.8, 1.0]) {
      const a = laneChange(p, pr, sp, 0);
      const b = laneChange(p, pr, sp, 100);
      rows.push([
        `${nm}; V ${f(p.yawRateMax / p.yawAlign)}, gripA ${f(gA, 1)}`,
        f(sp, 1),
        f(a.tLane, 3),
        a.vx.map((v) => f(v, 2)).join(' / '),
        `${f(a.pathMax, 1)}°`,
        `${f(a.body60, 1)}° / ${f(a.bodyMax, 1)}°`,
        `${f(a.over, 3)} / ${f(a.stop, 3)}`,
        `${f(b.over, 3)} / ${f(b.stop, 3)}`,
      ]);
    }
  }
  table(
    io,
    [
      'вариант',
      'v (vmax)',
      'время полосы, с',
      `dx/dt, полуш./с, при t = ${SAMPLES.map((s) => f(s, 3)).join(' / ')} с`,
      'угол траектории max',
      'кузов на экране (R89) 60 мс / max',
      'отпуск мгновенный: перелёт / остановка, с',
      'отпуск касанием (releaseMs 100): перелёт / остановка',
    ],
    rows,
  );
  // what the corner rules see (R89b): hold steer depends only on gripA; steer-0 drift scales with V
  const rows2: string[][] = [];
  for (const [nm, po, pr] of cands) {
    const p = { ...P0, ...po };
    rows2.push([
      nm,
      f(gripSteady(p, pr, 0, 1, 1), 3),
      f(gripSteady(p, pr, C.hard!, 0, 1), 3),
      f(gripSteady(p, pr, C.hard!, 1, 1), 3),
      f(gripSteady(p, pr, C.medium!, 0, 1), 3),
    ]);
  }
  io.log('Steady lateral speed at vmax (hw/s; + = right/inside, − = outward):');
  table(
    io,
    [
      'вариант',
      'прямая, руль 1 (R89b 1.0–1.1)',
      'hard, руль 0 (1.3–1.8 наружу)',
      'hard, руль 1 (0.4–0.7 наружу)',
      'medium, руль 0 (0.9–1.1)',
    ],
    rows2,
  );
}

// ---------------------------------------------------------------- P2/P3 DRIFT steer sweep
interface DriftSteady {
  vx: number; // mean lateral speed toward dir (hw/s), t 2.5..3 s
  path: number; // path angle deg toward dir
  sp: number;
  body: number; // deg
  angle: number;
}
/** Enter a drift toward +1 (entry tick at full steer), hold steer s; speed free from vmax. */
function driftSteady(p: CarParams, pr: Proto, curve: number, s: number, T = 3): DriftSteady {
  const r = rig(free(p), pr, p.vmax);
  const tr = constTrack(curve);
  let x0 = 0;
  let spSum = 0;
  let bSum = 0;
  let aSum = 0;
  let n = 0;
  const t0 = Math.round((T - 0.5) / DT);
  for (let k = 0; k < Math.round(T / DT); k++) {
    stepR(r, tr, k === 0 ? 1 : s, true);
    if (k === t0) x0 = r.car.x;
    if (k > t0) {
      spSum += r.car.speed / p.vmax;
      bSum += bodyDeg(r.car);
      aSum += r.car.angle;
      n++;
    }
  }
  const vx = (r.car.x - x0) / 0.5;
  const sp = spSum / n;
  return { vx, path: pathDeg(vx, sp), sp, body: bSum / n, angle: aSum / n };
}
const STEERS = [-1, -0.5, 0, 0.3, 0.5, 0.7, 0.85, 1];

function part23(io: Io): void {
  io.log(
    '## P2/P3. DRIFT toward +1: steady lateral speed vs held steer (speed free, 3 s, mean of the last 0.5 s)',
  );
  const cases: [string, Partial<CarParams>, Proto][] = [
    ['today', {}, {}],
    ['P2 uMin 0.4', {}, { uMin: 0.4 }],
    ['P3 driftLat 0.9', { driftLat: 0.9 }, {}],
    ['P3 driftDive 1.2 knee 0.8', {}, { driftDive: 1.2, aKnee: 0.8 }],
    ['P2+P3: uMin 0.4 + driftDive 1.2 knee 0.8', {}, { uMin: 0.4, driftDive: 1.2, aKnee: 0.8 }],
    ['P2+P3: uMin 0.4 + driftDive 1.2 knee 0.85', {}, { uMin: 0.4, driftDive: 1.2, aKnee: 0.85 }],
    ['P2+P3: uMin 0.4 + driftDive 1.5 knee 0.9', {}, { uMin: 0.4, driftDive: 1.5, aKnee: 0.9 }],
  ];
  for (const [cn, curve] of [
    ['straight', 0],
    ['medium', C.medium!],
    ['hard', C.hard!],
    ['sharp', C.sharp!],
  ] as const) {
    const rows: string[][] = [];
    for (const [nm, po, pr] of cases) {
      const p = { ...P0, ...po };
      const cells = STEERS.map((s) => {
        const d = driftSteady(p, pr, curve, s);
        return `${f(d.vx, 2)} (${f(d.path, 1)}°, ${f(d.body, 0)}°)`;
      });
      // hold steer: bisection on vx = 0 (only meaningful in corners)
      let hold = NaN;
      if (curve !== 0) {
        let lo = 0;
        let hi = 1;
        if (driftSteady(p, pr, curve, 1).vx < 0) hold = Infinity;
        else {
          for (let i = 0; i < 12; i++) {
            const m = (lo + hi) / 2;
            if (driftSteady(p, pr, curve, m).vx < 0) lo = m;
            else hi = m;
          }
          hold = (lo + hi) / 2;
        }
      }
      rows.push([
        nm,
        ...cells,
        curve !== 0 ? (Number.isFinite(hold) ? f(hold, 3) : 'не держит') : '—',
      ]);
    }
    io.log(
      `${cn} (curve ${curve}); cell = vx toward the drift side hw/s (path angle, body yaw on screen)`,
    );
    table(io, ['вариант', ...STEERS.map((s) => `руль ${s}`), 'руль удержания (vx = 0)'], rows);
  }
  // counter-steer transient on a straight: full steer drift 1.5 s, then steer -1
  const rows: string[][] = [];
  for (const [nm, po, pr] of cases.slice(0, 2)) {
    const p = { ...P0, ...po };
    const r = rig(free(p), pr, p.vmax);
    const tr = constTrack(0);
    for (let k = 0; k < Math.round(1.5 / DT); k++) stepR(r, tr, 1, true);
    const vx0 = r.car.vx;
    let tHalf = NaN;
    let tZero = NaN;
    let xs = r.car.x;
    for (let k = 1; k <= Math.round(2 / DT); k++) {
      const x0 = r.car.x;
      stepR(r, tr, -1, true);
      const vx = (r.car.x - x0) / DT;
      if (Number.isNaN(tHalf) && vx < vx0 / 2) tHalf = k * DT;
      if (Number.isNaN(tZero) && vx < 0.05) tZero = k * DT;
    }
    xs = r.car.x - xs;
    rows.push([nm, f(vx0, 2), f(tHalf, 3), f(tZero, 3), f(xs, 3)]);
  }
  io.log('Straight: drift full steer 1.5 s, then steer −1 (drift held):');
  table(io, ['вариант', 'vx до, полуш./с', 'vx/2, с', 'vx < 0.05, с', 'сдвиг за 2 с'], rows);
}

// ---------------------------------------------------------------- P4 tap-drift
/** Controlled: steady GRIP full steer in a corner, then a tap of drift (tapS) and release; 1.2 s. */
function tapProbe(p: CarParams, pr: Proto, curve: number, tapS: number, sp0 = 1) {
  const r = rig(free(p), pr, sp0 * p.vmax);
  const tr = constTrack(curve);
  for (let k = 0; k < Math.round(1 / DT); k++) stepR(r, tr, 1, false, sp0);
  const x0 = r.car.x;
  const z0 = r.car.z;
  const v0 = r.car.speed;
  let maxVx = -Infinity;
  for (let k = 0; k < Math.round(1.2 / DT); k++) {
    const xb = r.car.x;
    stepR(r, tr, 1, k * DT < tapS);
    const vx = (r.car.x - xb) / DT;
    if (vx > maxVx) maxVx = vx;
  }
  return { dx: r.car.x - x0, dz: r.car.z - z0, dv: (r.car.speed - v0) / p.vmax, maxVx };
}

const LEAD = 240;
const TAIL = 300;
const straightSec = (len: number): ClassedSection => ({
  enter: 0,
  hold: len,
  leave: 0,
  curveClass: 'straight',
  side: 1,
});
function windowTrack(fig: ClassedSection[]) {
  const secs = [straightSec(LEAD), ...fig, straightSec(TAIL)];
  const figLen = fig.reduce((s, x) => s + x.enter + x.hold + x.leave, 0);
  return {
    track: buildTrack(resolveSections(parseSections(secs), curveClasses)),
    total: LEAD + figLen + TAIL,
  };
}

interface Tap {
  periodS: number;
  tapS: number;
}
interface RunOut {
  T: number; // s for the whole run (laps 2..: mean flying lap; window: total)
  ok: boolean; // no crash, <= 1% off the asphalt
  entries: number;
  driftShare: number;
}
/**
 * Driver: the expert bot (CLEAN, no noise). Grip mode = drift 'never' with margin m; tap mode adds
 * a drift input for tapS every periodS while |bot steer| >= 0.5 (keyboard: steer = sign, full).
 */
const CLEAN: BotParams = { ...botParams.expert, noiseAmp: 0, reactionDelay: 0 };
const KB = { on: false };
const PROPOSAL: Proto = { leadDelay: 0.4, debtTime: 0.5, uMin: 0.4, driftDive: 1.2, aKnee: 0.85 };
function drive(
  track: Track,
  p: CarParams,
  bp: BotParams,
  tap: Tap | null,
  laps: number | null,
  total: number,
  pr: Proto = {},
): RunOut {
  const r = rig(p, pr, laps === null ? p.vmax : 0);
  const bot = createBot(1);
  const n = track.segments.length;
  const goal = laps === null ? total : laps * n;
  let tapT = Infinity; // s since the current tap started
  let sinceTap = Infinity;
  let off = 0;
  let crash = 0;
  let wasCrash = false;
  let entries = 0;
  let dTicks = 0;
  let wasDrift = false;
  const lapT: number[] = [];
  let lapStart = 0;
  const maxT = Math.ceil((laps === null ? 60 : laps * 200) / DT);
  while (r.car.z < goal && r.race.tick < maxT) {
    botInput(bot, bp, r.car, track, p, r.frame);
    let steer = r.frame.steer;
    let drift = r.frame.drift;
    if (tap) {
      const want = Math.abs(steer) >= 0.5;
      sinceTap += DT;
      tapT += DT;
      if (want && sinceTap >= tap.periodS) {
        sinceTap = 0;
        tapT = 0;
      }
      drift = tapT < tap.tapS;
      if (drift || want) steer = steer > 0 ? 1 : -1; // keyboard: full arrow
    }
    // keyboard model for every driver: arrows give -1 / 0 / +1 (threshold 0.5 on the bot steer)
    if (KB.on) steer = steer >= 0.5 ? 1 : steer <= -0.5 ? -1 : 0;
    stepR(r, track, steer, drift);
    const c = r.car;
    if (Math.abs(c.x) > 1) off++;
    if (c.crashTicks > 0 && !wasCrash) crash++;
    wasCrash = c.crashTicks > 0;
    const dr = c.state === 'DRIFT';
    if (dr) dTicks++;
    if (dr && !wasDrift) entries++;
    wasDrift = dr;
    if (laps !== null && Math.floor(c.z / n) > lapT.length) {
      lapT.push((r.race.tick - lapStart) * DT);
      lapStart = r.race.tick;
    }
  }
  const done = r.car.z >= goal;
  const ticks = r.race.tick;
  const T =
    laps === null
      ? done
        ? ticks * DT
        : NaN
      : done
        ? lapT.slice(1).reduce((s, x) => s + x, 0) / (lapT.length - 1)
        : NaN;
  return { T, ok: done && crash === 0 && off / ticks <= 0.01, entries, driftShare: dTicks / ticks };
}
const MARGINS = [0.8, 1.0, 1.2, 1.45, 1.8, 2.4, 3.5];
function best(
  track: Track,
  p: CarParams,
  tap: Tap | null,
  laps: number | null,
  total: number,
  drift: boolean,
  pr: Proto = {},
) {
  if (drift) {
    const o = drive(track, p, CLEAN, null, laps, total, pr);
    return { o, m: NaN };
  }
  let b: { o: RunOut; m: number } | undefined;
  for (const m of MARGINS) {
    const o = drive(track, p, { ...CLEAN, drift: 'never', bGripMargin: m }, tap, laps, total, pr);
    if (o.ok && (!b || o.T < b.o.T)) b = { o, m };
  }
  return b ?? { o: { T: NaN, ok: false, entries: 0, driftShare: 0 }, m: NaN };
}

function part4(io: Io, tracks: LoadedTrack[]): void {
  io.log('## P4. Tap-drift cheese (driftTurbo 0, scrub on, entry R81c)');
  // controlled probe
  const rows: string[][] = [];
  const probes: [string, Partial<CarParams>, Proto][] = [
    ['today', {}, {}],
    ['driftLead 0', { driftLead: 0 }, {}],
    ['lead ramp 0.4 s', {}, { leadDelay: 0.4 }],
    ['ALL: ramp 0.4 + debt 0.5 + uMin 0.4 + dive 1.2/0.85', {}, PROPOSAL],
  ];
  for (const [nm, po, pr] of probes) {
    const p = { ...P0, ...po };
    for (const [cn, curve] of [
      ['straight', 0],
      ['medium', C.medium!],
      ['hard', C.hard!],
      ['sharp', C.sharp!],
    ] as const) {
      const base = tapProbe(p, pr, curve, 0);
      const cells = [0.1, 0.15, 0.3].map((t) => {
        const q = tapProbe(p, pr, curve, t);
        return `${f(q.dx - base.dx, 3)} / ${f(q.dv - base.dv, 3)} / ${f(q.maxVx, 2)}`;
      });
      rows.push([nm, cn, `${f(base.dx, 3)} / ${f(base.dv, 3)}`, ...cells]);
    }
  }
  io.log(
    'Probe: GRIP full steer 1 s (speed pinned vmax), then 1.2 s free with full steer; a drift tap at its start. Cells: Δx vs no tap (+ = inside) / Δspeed vs no tap (vmax) / max dx/dt.',
  );
  table(
    io,
    ['вариант', 'поворот', 'без тапа: x за 1.2 с / Δv', 'тап 0.10 с', 'тап 0.15 с', 'тап 0.30 с'],
    rows,
  );

  for (const kb of [false, true]) {
    KB.on = kb;
    io.log(`### ${kb ? 'KEYBOARD steer (-1/0/+1) for every driver' : 'analog steer (bot)'}`);
    windowsAndLaps(io, tracks);
  }
  KB.on = false;
}

function windowsAndLaps(io: Io, tracks: LoadedTrack[]): void {
  const taps: Tap[] = [
    { periodS: 0.6, tapS: 0.15 },
    { periodS: 0.4, tapS: 0.1 },
    { periodS: 1.0, tapS: 0.25 },
  ];
  const variants: [string, Partial<CarParams>, Proto][] = [
    ['today', {}, {}],
    ['P4: lead ramp 0.4 s', {}, { leadDelay: 0.4 }],
    ['P4: ramp 0.4 + debt 0.5 s', {}, { leadDelay: 0.4, debtTime: 0.5 }],
    ['ALL: ramp 0.4 + debt 0.5 + uMin 0.4 + dive 1.2/0.85', {}, PROPOSAL],
  ];
  const wins: [string, ClassedSection[]][] = [
    ['hard 120', [{ enter: 30, hold: 120, leave: 30, curveClass: 'hard', side: 1 }]],
    ['hard 240', [{ enter: 30, hold: 240, leave: 30, curveClass: 'hard', side: 1 }]],
    ['sharp 120', [{ enter: 30, hold: 120, leave: 30, curveClass: 'sharp', side: 1 }]],
    ['hairpin', expandFigures([{ figure: 'hairpin', side: 1 }], figureDict)],
    ['switchback', expandFigures([{ figure: 'switchback', side: 1 }], figureDict)],
    ['chicane', expandFigures([{ figure: 'chicane', side: 1 }], figureDict)],
  ];
  for (const [vn, po, pr] of variants) {
    const p = { ...P0, ...po };
    const rowsW: string[][] = [];
    for (const [wn, sec] of wins) {
      const w = windowTrack(sec);
      const g = best(w.track, p, null, null, w.total, false, pr);
      const d = best(w.track, p, null, null, w.total, true, pr);
      const cells = taps.map((t) => {
        const b = best(w.track, p, t, null, w.total, false, pr);
        return `${f(b.o.T, 2)} (m ${b.m}, ${b.o.entries} вх.)`;
      });
      rowsW.push([
        wn,
        `${f(g.o.T, 2)} (m ${g.m})`,
        `${f(d.o.T, 2)}${d.o.ok ? '' : ' (x)'}`,
        ...cells,
      ]);
    }
    io.log(
      `${vn}: corner windows (${LEAD} straight + figure + ${TAIL} straight, start at vmax), T s; best clean margin.`,
    );
    table(
      io,
      [
        'окно',
        'GRIP',
        'держаный дрифт (expert)',
        ...taps.map((t) => `тап ${t.tapS} с / ${t.periodS} с`),
      ],
      rowsW,
    );
  }
  for (const tr of tracks) {
    const rowsL: string[][] = [];
    for (const [vn, po, pr] of variants) {
      const p = { ...P0, ...po };
      const g = best(tr.track, p, null, 3, 0, false, pr);
      const d = best(tr.track, p, null, 3, 0, true, pr);
      const cells = taps.map((t) => {
        const b = best(tr.track, p, t, 3, 0, false, pr);
        return `${f(b.o.T, 2)} (m ${b.m}, ${f(b.o.entries / 3, 0)} вх./круг)`;
      });
      rowsL.push([
        vn,
        `${f(g.o.T, 2)} (m ${g.m})`,
        `${f(d.o.T, 2)}${d.o.ok ? '' : ' (x)'} (${f(100 * d.o.driftShare, 0)}% в дрифте)`,
        ...cells,
      ]);
    }
    io.log(`${tr.name}: flying laps 2–3, s (expert without noise; clean = no crash, ≤ 1% off)`);
    table(
      io,
      ['вариант', 'GRIP', 'держаный дрифт', ...taps.map((t) => `тап ${t.tapS} с / ${t.periodS} с`)],
      rowsL,
    );
  }
}

/** P4 breakdown: hard 240 window, GRIP vs tap vs tap with tapS 0 (same keyboard steer), per-tick stats. */
function part5(io: Io): void {
  const w = windowTrack([{ enter: 30, hold: 240, leave: 30, curveClass: 'hard', side: 1 }]);
  const rows: string[][] = [];
  const cases: [string, Tap | null, Proto, Partial<CarParams>][] = [
    ['GRIP', null, {}, {}],
    ['tap 0 s (same steer, no drift)', { periodS: 0.6, tapS: 0 }, {}, {}],
    ['tap 0.15/0.6', { periodS: 0.6, tapS: 0.15 }, {}, {}],
    ['tap 0.15/0.6, scrub off', { periodS: 0.6, tapS: 0.15 }, {}, { gripScrub: 0 }],
    ['GRIP, scrub off', null, {}, { gripScrub: 0 }],
    ['tap 0.15/0.6, lead ramp 0.4', { periodS: 0.6, tapS: 0.15 }, { leadDelay: 0.4 }, {}],
    ['tap 0.15/0.6, scrub in DRIFT too', { periodS: 0.6, tapS: 0.15 }, { scrubDrift: true }, {}],
    ['tap 0.15/0.6, debt 0.5 s', { periodS: 0.6, tapS: 0.15 }, { debtTime: 0.5 }, {}],
    ['tap 0.25/1.0, debt 0.5 s', { periodS: 1.0, tapS: 0.25 }, { debtTime: 0.5 }, {}],
    ['tap 0.6/1.0, debt 0.5 s', { periodS: 1.0, tapS: 0.6 }, { debtTime: 0.5 }, {}],
  ];
  for (const [nm, tap, pr, po] of cases) {
    const p = { ...P0, ...po };
    const bp = { ...CLEAN, drift: 'never' as const, bGripMargin: 1.8 };
    const r = rig(p, pr, p.vmax);
    const bot = createBot(1);
    let tapT = Infinity;
    let since = Infinity;
    let vSum = 0;
    let vMin = 9;
    let nT = 0;
    let dT = 0;
    let maxX = 0;
    const start = LEAD;
    const end = w.total - TAIL;
    while (r.car.z < w.total && r.race.tick < 60 / DT) {
      botInput(bot, bp, r.car, w.track, p, r.frame);
      let steer = r.frame.steer;
      let drift = false;
      if (tap) {
        const want = Math.abs(steer) >= 0.5;
        since += DT;
        tapT += DT;
        if (want && since >= tap.periodS) {
          since = 0;
          tapT = 0;
        }
        drift = tapT < tap.tapS;
        if (drift || want) steer = steer > 0 ? 1 : -1;
      }
      stepR(r, w.track, steer, drift);
      if (r.car.z >= start && r.car.z < end) {
        const sp = r.car.speed / p.vmax;
        vSum += sp;
        nT++;
        if (sp < vMin) vMin = sp;
        if (r.car.state === 'DRIFT') dT++;
        if (Math.abs(r.car.x) > maxX) maxX = Math.abs(r.car.x);
      }
    }
    rows.push([
      nm,
      f(r.race.tick * DT, 2),
      f(nT * DT, 2),
      f(vSum / nT, 3),
      f(vMin, 3),
      f(dT / nT, 2),
      f(maxX, 2),
    ]);
  }
  io.log('P4 breakdown, hard 240 window, expert GRIP margin 1.8:');
  table(
    io,
    ['случай', 'T окна, с', 'в фигуре, с', 'ср. v', 'мин. v', 'доля DRIFT', 'max |x|'],
    rows,
  );
}

export function main(io: Io): number {
  if (argValue(io.argv, 'part') === '5') part5(io);
  const part = argValue(io.argv, 'part') ?? 'all';
  if (part === 'all' || part === '1') part1(io);
  if (part === 'all' || part === '2' || part === '3') part23(io);
  if (part === 'all' || part === '4') {
    const tracks = loadTracks(io).filter((t) => t.name === 'drift-run' || t.name === 'test-twisty');
    part4(io, tracks);
  }
  return 0;
}

// THROWAWAY SPIKE (T71): "drift in every corner", driftEntry 5 (R81f). Everything runs through the
// REAL src/sim `step` with driftEntry 3 (R81c); variant 5 is emulated around it:
//  - entry/exit: the wrapper passes input.drift = true only while variant 5 wants DRIFT (entry on the
//    tick the car is on a corner segment with the finger down; exit on release, corner end or flip),
//    and on the entry tick steer = side*uc, so R81c enters with dir = corner side;
//  - R83g line share: in DRIFT the wrapper feeds steer' = dir*uc with driftMinU 0, so R83/R85 see
//    exactly uc = clamp(h + cornerSpan*u, cornerMinU, 1), h = driftPush*max(0, A*dir)/driftLat;
//  - R86f no drift speed loss: driftSpeedLoss 0, debtTime 0 (R86e withdrawn), and after a GRIP step
//    the speed the carry cost (slipDrag*(vis^2 - own^2)) is given back.
// src/ and data are not touched. Run: node tools/run-ts.mjs tools/spike/corner-drift.ts [--part a..g|all]
import { botInput, createBot, type BotParams } from '../../src/bot/driver';
import type { MeasureConfig, RunResult, CornerRun } from '../../src/bot/run';
import { botParams, BOT_NAMES } from '../../src/data/bots';
import { baseCar } from '../../src/data/cars';
import {
  curveClasses,
  figureDict,
  expandFigures,
  parseSections,
  resolveSections,
} from '../../src/data/tracks';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, Track } from '../../src/sim/types';
import { loadTracks, summarize, type Entry, type Results } from '../botlib';
import { readGateConfig } from '../gateConfig';
import { argValue, type Io } from '../io';

const C = curveClasses as Record<string, number>;
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
function table(io: Io, head: string[], rows: string[][]): void {
  io.log('| ' + head.join(' | ') + ' |');
  io.log('|' + head.map(() => ' --- ').join('|') + '|');
  for (const r of rows) io.log('| ' + r.join(' | ') + ' |');
  io.log('');
}

export interface V5 {
  cornerCurve: number; // |curve| at or above this: the segment is a corner segment
  cornerGap: number; // segments: a same-side corner segment this close ahead keeps the drift
  cornerSpan: number; // line share per unit of steer around the hold share h
  cornerMinU: number; // lowest line share (steer against the drift side)
  flip: 'gap' | 'direct';
  noCarryCost: boolean;
}
let V: V5 = {
  cornerCurve: 0.5,
  cornerGap: 30,
  cornerSpan: 0.3,
  cornerMinU: 0.1,
  flip: 'gap',
  noCarryCost: true,
};
const OLD: CarParams = { ...baseCar, driftTurbo: 0, driftEntry: 3 };
const P5 = (p: CarParams): CarParams => ({
  ...p,
  driftTurbo: 0,
  driftEntry: 3,
  driftMinU: 0,
  driftSpeedLoss: 0,
  debtTime: 0,
});
const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  crashMinSpeed: 1e9,
});

type Mode = 'v5' | 'old' | 'grip';
type Reason = 'enter' | 'release' | 'end' | 'flip' | 'speed' | 'other';
interface Tr {
  tick: number;
  z: number;
  to: 'GRIP' | 'DRIFT';
  why: Reason;
}

/** One car driven through the real step; mode v5 emulates R81f/R83g/R86f around driftEntry 3. */
class Drv {
  race = createRace(1, 1);
  car: Car;
  frame: InputFrame = { steer: 0, brake: false, drift: false };
  p: CarParams;
  trs: Tr[] = [];
  constructor(
    public mode: Mode,
    p: CarParams,
    sp = 1,
    z = 0,
    x = 0,
  ) {
    this.p = mode === 'v5' ? P5(p) : p;
    this.car = this.race.cars[0]!;
    this.car.speed = sp * this.p.vmax;
    this.car.z = z;
    this.car.x = x;
  }
  /** One tick: raw steer and held (finger down / space). Returns nothing; trs records changes. */
  tick(track: Track, steer: number, held: boolean, brake = false): void {
    const c = this.car;
    const p = this.p;
    const was = c.state;
    let why: Reason = 'other';
    this.frame.brake = brake;
    if (this.mode === 'grip') {
      this.frame.steer = steer;
      this.frame.drift = false;
    } else if (this.mode === 'old') {
      this.frame.steer = steer;
      this.frame.drift = held;
    } else {
      const segs = track.segments;
      const n = segs.length;
      let seg = Math.floor(c.z) % n;
      if (seg < 0) seg += n;
      const cur = segs[seg]!.curve;
      const onSide = Math.abs(cur) >= V.cornerCurve ? Math.sign(cur) : 0;
      let dir = 0; // drift side wanted this tick, 0 = GRIP
      if (c.crashTicks > 0) dir = 0;
      else if (c.state === 'GRIP') {
        if (held && onSide !== 0 && c.speed > p.driftEnterSpeed * p.vmax) dir = onSide;
      } else {
        const d = c.dir;
        if (!held) why = 'release';
        else if (onSide === d) dir = d;
        else if (onSide === -d) why = 'flip';
        else {
          let first = 0;
          let j = seg;
          for (let i = 1; i <= V.cornerGap; i++) {
            j = j + 1 >= n ? 0 : j + 1;
            const cc = segs[j]!.curve;
            if (Math.abs(cc) >= V.cornerCurve) {
              first = Math.sign(cc);
              break;
            }
          }
          if (first === d) dir = d;
          else if (first === -d) {
            if (V.flip === 'direct') dir = d;
            else why = 'flip';
          } else why = 'end';
        }
      }
      if (dir !== 0) {
        const sp = c.speed / p.vmax;
        const A = cur * sp * p.kYaw;
        let h = (p.driftPush * Math.max(0, A * dir)) / p.driftLat;
        if (h > 1) h = 1;
        const u = Math.max(-1, Math.min(1, steer * dir));
        let uc = h + V.cornerSpan * u;
        if (uc < V.cornerMinU) uc = V.cornerMinU;
        if (uc > 1) uc = 1;
        this.frame.steer = dir * Math.max(uc, 1e-6);
        this.frame.drift = true;
      } else {
        this.frame.steer = steer;
        this.frame.drift = false;
      }
    }
    step(this.race, [this.frame], track, [p]);
    if (this.mode === 'v5' && V.noCarryCost && c.state === 'GRIP' && c.crashTicks === 0) {
      const own = c.yaw - c.vel;
      const vis = own + c.carry;
      if (c.speed > 0) c.speed += p.slipDrag * (vis * vis - own * own) * DT;
    }
    if (c.state !== was) {
      if (c.state === 'DRIFT') why = 'enter';
      else if (why === 'other' && c.speed < p.driftExitSpeed * p.vmax) why = 'speed';
      this.trs.push({ tick: this.race.tick, z: c.z, to: c.state, why });
    }
  }
}

// ---------------------------------------------------------------- tracks
const cache = new Map<string, Track>();
/** A real section (enter t^2 ramp, hold, cosine leave) after `pre` straight segments, then straight. */
function cornerTrack(
  curve: number,
  pre: number,
  enter: number,
  hold: number,
  leave: number,
): Track {
  const key = `${curve}/${pre}/${enter}/${hold}/${leave}`;
  let t = cache.get(key);
  if (!t) {
    t = buildTrack({
      sections: [
        { enter: 0, hold: pre, leave: 0, curve: 0 },
        { enter, hold, leave, curve },
        { enter: 0, hold: 8000, leave: 0, curve: 0 },
      ],
    });
    cache.set(key, t);
  }
  return t;
}
function figureTrack(name: string, side: 1 | -1, pre = 240): Track {
  const key = `fig/${name}/${side}/${pre}`;
  let t = cache.get(key);
  if (!t) {
    const secs = parseSections(expandFigures([{ figure: name, side }], figureDict));
    const def = resolveSections(secs, curveClasses as never);
    t = buildTrack({
      sections: [
        { enter: 0, hold: pre, leave: 0, curve: 0 },
        ...def.sections,
        { enter: 0, hold: 2000, leave: 0, curve: 0 },
      ],
    });
    cache.set(key, t);
  }
  return t;
}
/** First and last segment with curve != 0. */
function span(t: Track): [number, number] {
  let a = -1;
  let b = -1;
  t.segments.forEach((s, i) => {
    if (s.curve !== 0) {
      if (a < 0) a = i;
      b = i;
    }
  });
  return [a, b];
}

// ---------------------------------------------------------------- controllers (old references)
/** PD line keeper to x = 0 in GRIP with the R83/R84 hold steer as feed-forward (old GRIP driver). */
function gripCtl(d: Drv, track: Track): number {
  const c = d.car;
  const p = d.p;
  const sp = c.speed / p.vmax;
  const seg = Math.floor(c.z) % track.segments.length;
  const A = track.segments[seg]!.curve * sp * p.kYaw;
  const fF = Math.min(1, sp / p.yawFullSpeed);
  const ff = (A * (1 + p.yawAlign / p.velGrip)) / (p.yawRateMax * fF);
  return Math.max(-1, Math.min(1, ff + 1.5 * (0 - c.x) - 0.4 * c.vx));
}
/** Old drift (variant 3) line keeper: hold share driftPush*A/driftLat as feed-forward + PD. */
function oldDriftCtl(d: Drv, track: Track): number {
  const c = d.car;
  const p = d.p;
  if (c.state !== 'DRIFT') return gripCtl(d, track) >= 0 ? 1 : -1; // enter toward the corner
  const sp = c.speed / p.vmax;
  const seg = Math.floor(c.z) % track.segments.length;
  const A = track.segments[seg]!.curve * sp * p.kYaw;
  const ff = (p.driftPush * A * c.dir) / p.driftLat;
  return c.dir * Math.max(-1, Math.min(1, ff + 1.2 * (0 - c.x) * c.dir - 0.6 * c.vx * c.dir));
}

interface CornerOut {
  t: number; // s from the first curved segment to the last
  vIn: number;
  vMin: number;
  vOut: number;
  xMin: number;
  xMax: number;
  trs: Tr[];
  driftShare: number;
}
function runCorner(
  mode: Mode,
  track: Track,
  sp0: number,
  steerFn: (d: Drv) => number,
  held = true,
  p: CarParams = OLD,
  x0 = 0,
): CornerOut {
  const [a, b] = span(track);
  const d = new Drv(mode, free(p), sp0, a - 0.3 * 60 * sp0, x0);
  let t0 = NaN;
  let t1 = NaN;
  let vIn = NaN;
  let vMin = Infinity;
  let vOut = NaN;
  let xMin = Infinity;
  let xMax = -Infinity;
  let dt = 0;
  let tot = 0;
  for (let i = 0; i < 30 / DT && Number.isNaN(t1); i++) {
    const z0 = d.car.z;
    d.tick(track, steerFn(d), held);
    const z = d.car.z;
    const sp = d.car.speed / d.p.vmax;
    if (z0 < a && z >= a) {
      t0 = i * DT;
      vIn = sp;
    }
    if (!Number.isNaN(t0)) {
      vMin = Math.min(vMin, sp);
      xMin = Math.min(xMin, d.car.x);
      xMax = Math.max(xMax, d.car.x);
      tot++;
      if (d.car.state === 'DRIFT') dt++;
    }
    if (z0 < b + 1 && z >= b + 1) {
      t1 = i * DT;
      vOut = sp;
    }
  }
  return { t: t1 - t0, vIn, vMin, vOut, xMin, xMax, trs: d.trs, driftShare: dt / tot };
}

const CLS = ['easy', 'medium', 'hard', 'sharp'] as const;
const SHAPE = { enter: 30, hold: 240, leave: 30 };

// ---------------------------------------------------------------- (a) per class: time, speed, line
function partA(io: Io): void {
  io.log(
    '## (a) corner classes, enter 30 / hold 240 / leave 30, right turn, x0 = 0, free speed (autogas)',
  );
  const rows: string[][] = [];
  for (const cls of CLS) {
    const tr = cornerTrack(C[cls]!, 300, SHAPE.enter, SHAPE.hold, SHAPE.leave);
    for (const sp0 of [0.6, 0.8, 1.0]) {
      const g = runCorner('grip', tr, sp0, (d) => gripCtl(d, tr), false);
      const o = runCorner('old', tr, sp0, (d) => oldDriftCtl(d, tr), true);
      for (const [nm, s] of [
        ['0', 0],
        ['+1', 1],
        ['−1', -1],
      ] as const) {
        const v = runCorner('v5', tr, sp0, (d) => (d.car.state === 'DRIFT' ? s : gripCtl(d, tr)), true);
        rows.push([
          cls,
          f(sp0, 1),
          nm,
          f(v.t, 3),
          f((100 * (v.t - g.t)) / g.t, 1) + '%',
          f((100 * (v.t - o.t)) / o.t, 1) + '%',
          `${f(v.vIn)}/${f(v.vMin)}/${f(v.vOut)}`,
          `${f(g.vMin)} · ${f(o.vMin)}`,
          `${f(v.xMin)}…${f(v.xMax)}`,
          `${f(g.xMin)}…${f(g.xMax)}`,
          String(v.trs.length),
        ]);
      }
    }
  }
  table(
    io,
    [
      'class',
      'sp0',
      'steer',
      'v5 t s',
      'Δ vs GRIP',
      'Δ vs old drift',
      'v5 speed in/min/out',
      'min speed GRIP · old',
      'v5 x range',
      'GRIP x range',
      'changes',
    ],
    rows,
  );
}

// ---------------------------------------------------------------- (b) entry / exit timeline
function partB(io: Io): void {
  io.log(
    '## (b) entry/exit timeline, finger held, steer 0 (ms from first / after last curved segment)',
  );
  const rows: string[][] = [];
  for (const cls of CLS) {
    const tr = cornerTrack(C[cls]!, 300, SHAPE.enter, SHAPE.hold, SHAPE.leave);
    const [a, b] = span(tr);
    for (const sp0 of [0.6, 1.0]) {
      const d = new Drv('v5', free(OLD), sp0, a - 60, 0);
      const zs: number[] = [];
      for (let i = 0; i < 12 / DT && d.car.z < b + 200; i++) {
        d.tick(tr, 0, true);
        zs.push(d.car.z);
      }
      const tAt = (z: number): number => zs.findIndex((v) => v >= z) + 1;
      const tA = tAt(a);
      const tB = tAt(b + 1);
      const e = d.trs.find((t) => t.to === 'DRIFT');
      const x = d.trs.find((t) => t.to === 'GRIP');
      rows.push([
        cls,
        f(sp0, 1),
        e
          ? `${f((e.tick - tA) * DT * 1000, 0)} (seg ${f(e.z - a, 0)}, curve ${f(tr.segments[Math.floor(e.z - 1)]!.curve)})`
          : '—',
        x ? `${f((x.tick - tB) * DT * 1000, 0)} ${x.why}` : '—',
        String(d.trs.length),
      ]);
    }
  }
  table(
    io,
    ['class', 'sp0', 'entry after corner start, ms', 'exit after corner end, ms', 'changes'],
    rows,
  );
}

// ---------------------------------------------------------------- (c) figures: S-bends, doubles, flicker
function partC(io: Io): void {
  io.log(`## (c) figures, finger held: changes and reasons (flip = ${V.flip})`);
  const rows: string[][] = [];
  for (const name of Object.keys(figureDict)) {
    if (name === 'straight') continue;
    const tr = figureTrack(name, 1);
    const [a, b] = span(tr);
    for (const sp0 of [0.7, 1.0]) {
      for (const st of [0, 'ctl'] as const) {
        const d = new Drv('v5', free(OLD), sp0, a - 60, 0);
        let xMin = Infinity;
        let xMax = -Infinity;
        let t0 = NaN;
        let t1 = NaN;
        let vMin = Infinity;
        let gripIn = 0;
        for (let i = 0; i < 30 / DT && Number.isNaN(t1); i++) {
          const z0 = d.car.z;
          // ctl: steer 0 in DRIFT, line keeper in GRIP (a player who only aims in GRIP)
          const s = st === 0 || d.car.state === 'DRIFT' ? 0 : gripCtl(d, tr);
          d.tick(tr, s, true);
          if (z0 < a && d.car.z >= a) t0 = i * DT;
          if (!Number.isNaN(t0)) {
            xMin = Math.min(xMin, d.car.x);
            xMax = Math.max(xMax, d.car.x);
            vMin = Math.min(vMin, d.car.speed);
            const cc = tr.segments[Math.floor(d.car.z) % tr.segments.length]!.curve;
            if (d.car.state === 'GRIP' && Math.abs(cc) >= V.cornerCurve) gripIn++;
          }
          if (z0 < b + 1 && d.car.z >= b + 1) t1 = i * DT;
        }
        const seq = d.trs
          .map((t) => `${t.to === 'DRIFT' ? 'D' : 'G'}:${t.why}@${f(t.z - a, 0)}`)
          .join(' ');
        rows.push([
          name,
          f(sp0, 1),
          String(st),
          String(d.trs.length),
          seq,
          f(gripIn * DT * 1000, 0),
          `${f(xMin)}…${f(xMax)}`,
          f(vMin),
          f(t1 - t0, 3),
        ]);
      }
    }
  }
  table(
    io,
    [
      'figure',
      'sp0',
      'steer',
      'changes',
      'sequence (seg from start)',
      'GRIP on corner segs ms',
      'x range',
      'v min',
      't s',
    ],
    rows,
  );
}

// ---------------------------------------------------------------- (d) straights never drift (real tracks)
function partD(io: Io): void {
  io.log(
    '## (d) real tracks, finger always down, random steer: DRIFT ticks where no corner is near',
  );
  const tracks = loadTracks(io);
  const rows: string[][] = [];
  for (const t of tracks) {
    const segs = t.track.segments;
    const n = segs.length;
    // segment is "corner-near" if a corner segment is within cornerGap behind it (hold window)
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k <= V.cornerGap; k++) {
        if (Math.abs(segs[(i - k + n) % n]!.curve) >= V.cornerCurve) {
          near[i] = 1;
          break;
        }
      }
    }
    for (let seed = 1; seed <= 5; seed++) {
      let s = seed * 7919;
      const rnd = (): number => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
      };
      const d = new Drv('v5', OLD, 0.5, 0, 0);
      let bad = 0;
      let driftT = 0;
      let cornerT = 0;
      let cur = 0;
      let until = 0;
      for (let i = 0; i < 120 / DT; i++) {
        const tt = i * DT;
        if (tt >= until) {
          cur = rnd() * 2 - 1;
          until = tt + 0.05 + rnd();
        }
        // random steer on straights, line keeper + noise in GRIP corners, noise in DRIFT
        const st =
          d.car.state === 'DRIFT'
            ? cur
            : Math.max(-1, Math.min(1, gripCtl(d, t.track) + 0.5 * cur));
        d.tick(t.track, st, true);
        const seg = Math.floor(d.car.z) % n;
        if (d.car.state === 'DRIFT') {
          driftT++;
          if (!near[seg]) bad++;
        }
        if (Math.abs(segs[seg]!.curve) >= V.cornerCurve) cornerT++;
      }
      rows.push([
        t.name,
        String(seed),
        String(bad),
        f((100 * driftT) / cornerT, 1) + '%',
        String(d.trs.filter((x) => x.to === 'DRIFT').length),
        d.trs
          .filter((x) => x.to === 'GRIP')
          .reduce((m, x) => ((m[x.why] = (m[x.why] ?? 0) + 1), m), {} as Record<string, number>)
          .toString === Object.prototype.toString
          ? JSON.stringify(
              d.trs
                .filter((x) => x.to === 'GRIP')
                .reduce(
                  (m, x) => ((m[x.why] = (m[x.why] ?? 0) + 1), m),
                  {} as Record<string, number>,
                ),
            )
          : '',
      ]);
    }
  }
  table(
    io,
    [
      'track',
      'seed',
      'DRIFT ticks off corners',
      'DRIFT ticks / corner ticks',
      'entries',
      'exits by reason',
    ],
    rows,
  );
}

// ---------------------------------------------------------------- (e) release and retouch inside a corner
function partE(io: Io): void {
  io.log('## (e) hard + sharp at vmax, steady drift, steer 0: lift the finger for T, touch again');
  const rows: string[][] = [];
  for (const cls of ['medium', 'hard', 'sharp'] as const) {
    const tr = cornerTrack(C[cls]!, 300, 30, 900, 30);
    const [a] = span(tr);
    for (const T of [0.05, 0.1, 0.3, 0.6]) {
      const d = new Drv('v5', free(OLD), 1, a - 60, 0);
      for (let i = 0; i < 2.5 / DT; i++) d.tick(tr, 0, true);
      const x0 = d.car.x;
      const v0 = d.car.speed;
      const n0 = d.trs.length;
      for (let i = 0; i < T / DT; i++) d.tick(tr, 0, false);
      const xr = d.car.x;
      const vL = d.car.speed;
      let back = NaN;
      for (let i = 0; i < 1 / DT && Number.isNaN(back); i++) {
        d.tick(tr, 0, true);
        if (d.car.state === 'DRIFT') back = (i + 1) * DT;
      }
      for (let i = 0; i < 1 / DT; i++) d.tick(tr, 0, true);
      rows.push([
        cls,
        f(T),
        f(xr - x0, 3),
        f(back * 1000, 0),
        `${f(v0 / d.p.vmax, 3)} → ${f(vL / d.p.vmax, 3)} → ${f(d.car.speed / d.p.vmax, 3)}`,
        String(d.trs.length - n0),
      ]);
    }
  }
  table(
    io,
    [
      'class',
      'lift s',
      'x moved during lift (− = outward)',
      'retouch → DRIFT ms',
      'speed before → end of lift → 1 s after retouch',
      'changes',
    ],
    rows,
  );
}

// ---------------------------------------------------------------- (f) GRIP weight on straights
const LANE = 0.25;
function lane(p: CarParams, sp: number): { tLane: number; over: number; tStop: number } {
  const tr = cornerTrack(0, 10, 0, 0, 0);
  const d = new Drv('grip', { ...p, crashMinSpeed: 1e9 }, sp, 10, 0);
  let tLane = NaN;
  for (let i = 1; i <= 240 && Number.isNaN(tLane); i++) {
    d.car.speed = sp * p.vmax;
    d.tick(tr, 1, false);
    if (d.car.x >= LANE) tLane = i * DT;
  }
  let maxX = -Infinity;
  let last = -1;
  for (let i = 0; i < 1.5 / DT; i++) {
    d.car.speed = sp * p.vmax;
    d.tick(tr, 0, false);
    maxX = Math.max(maxX, d.car.x);
    if (Math.abs(d.car.vx) > 0.02) last = i;
  }
  return { tLane, over: maxX - LANE, tStop: (last + 1) * DT };
}
function partF(io: Io): void {
  io.log('## (f) GRIP lane change (0.25 hw), instant full steer, speed pinned; then steer 0');
  const rows: string[][] = [];
  for (const gd of [0.45, 0.3, 0.2, 0.15, 0.1, 0]) {
    for (const gl of [0.9, 0.6]) {
      const p = { ...OLD, gripDodge: gd, gripLead: gl };
      const a = lane(p, 1);
      const b = lane(p, 0.6);
      rows.push([
        f(gd),
        f(gl),
        f(a.tLane, 3),
        f(a.over, 3),
        f(a.tStop, 3),
        f(b.tLane, 3),
        f(b.over, 3),
        f(b.tStop, 3),
      ]);
    }
  }
  table(
    io,
    ['gripDodge', 'gripLead', 'vmax tLane', 'over', 'tStop', '0.6 tLane', 'over', 'tStop'],
    rows,
  );
}

// ---------------------------------------------------------------- (g) bots under variant 5
/** Variant 5 bot: drift bots hold the input all lap; the stock driver steers (drift law in DRIFT). */
function botV5(
  bot: ReturnType<typeof createBot>,
  bp: BotParams,
  d: Drv,
  track: Track,
  pBot: CarParams,
  out: InputFrame,
): boolean {
  botInput(bot, bp, d.car, track, pBot, out);
  if (bp.drift === 'corners') {
    out.brake = false;
    return true;
  }
  return false;
}
function runBotV5(
  bp: BotParams,
  p: CarParams,
  t: {
    track: Track;
    sections: { enter: number; hold: number; leave: number; curveClass: string }[];
  },
  seed: number,
  m: MeasureConfig,
  mode: Mode,
): RunResult {
  const track = t.track;
  const sections = t.sections;
  const n = track.segments.length;
  const sectionOf = new Int32Array(n);
  const holdStart = new Int32Array(sections.length);
  let acc = 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    holdStart[i] = acc + s.enter;
    for (let j = 0; j < s.enter + s.hold + s.leave; j++) sectionOf[acc + j] = i;
    acc += s.enter + s.hold + s.leave;
  }
  const corners: CornerRun[] = sections.map(() => ({
    entrySpeed: [],
    maxAbsX: 0,
    minSpeed: Infinity,
    offroadEvents: 0,
  }));
  const r: RunResult = {
    seed,
    finished: false,
    ticks: 0,
    lapTimes: [],
    offroadTicks: 0,
    offroadEvents: 0,
    offroadEventsByClass: { easy: 0, medium: 0, hard: 0, sharp: 0 },
    saturationTicks: 0,
    brakeTicks: 0,
    driftTicks: 0,
    driftEntries: 0,
    straightTicks: 0,
    deadTicks: 0,
    speedSum: 0,
    minSpeedFlying: Infinity,
    wallHits: 0,
    crashes: 0,
    nan: false,
    corners,
    fingerprint: '',
  };
  const d = new Drv(mode, p, 0, 0, 0);
  d.race = createRace(seed, 1);
  d.car = d.race.cars[0]!;
  const car = d.car;
  const bot = createBot(seed);
  const pBot: CarParams = {
    ...p,
    yawRateMax: mode === 'v5' ? 1e-9 : p.yawRateMax,
    driftEnterSpeed: mode === 'v5' ? 1e9 : p.driftEnterSpeed,
  };
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const goal = m.laps * n;
  const maxTicks = Math.ceil((m.laps * m.maxSecondsPerLap) / DT);
  let lapStart = 0;
  let wasOff = false;
  let wasWall = false;
  let wasCrash = false;
  let wasDrift = false;
  while (car.z < goal && d.race.tick < maxTicks) {
    let held: boolean;
    if (mode === 'v5') held = botV5(bot, bp, d, track, bp.drift === 'corners' ? pBot : p, frame);
    else {
      botInput(bot, bp, car, track, p, frame);
      held = frame.drift;
    }
    const segBefore = Math.floor(car.z) % n;
    const zBefore = car.z;
    d.tick(track, frame.steer, held, frame.brake);
    const x = car.x;
    const sp = car.speed / p.vmax;
    if (!Number.isFinite(x) || !Number.isFinite(car.speed)) {
      r.nan = true;
      break;
    }
    const as = Math.abs(frame.steer);
    if (as > m.saturationSteer) r.saturationTicks++;
    if (frame.brake) r.brakeTicks++;
    const drifting = car.state === 'DRIFT';
    if (drifting) r.driftTicks++;
    if (drifting && !wasDrift) r.driftEntries++;
    wasDrift = drifting;
    const c = track.segments[segBefore]!.curve;
    if (Math.abs(c) <= m.straightCurveMax) {
      r.straightTicks++;
      if (as < m.deadSteer && !frame.brake) r.deadTicks++;
    }
    r.speedSum += sp;
    const seg = Math.floor(car.z) % n;
    const si = sectionOf[seg]!;
    const corner = corners[si]!;
    const ax = Math.abs(x);
    if (ax > corner.maxAbsX) corner.maxAbsX = ax;
    if (car.z >= n && sp < corner.minSpeed) corner.minSpeed = sp;
    const off = ax > 1;
    if (off) r.offroadTicks++;
    if (off && !wasOff) {
      r.offroadEvents++;
      corner.offroadEvents++;
      const cls = sections[si]!.curveClass as 'easy';
      if ((cls as string) !== 'straight')
        r.offroadEventsByClass[cls] = (r.offroadEventsByClass[cls] ?? 0) + 1;
    }
    wasOff = off;
    const wall = ax >= p.xLimit;
    if (wall && !wasWall) r.wallHits++;
    wasWall = wall;
    const crashing = car.crashTicks > 0;
    if (crashing && !wasCrash) r.crashes = (r.crashes ?? 0) + 1;
    wasCrash = crashing;
    const hs = holdStart[si]!;
    const lapBase = Math.floor(car.z / n) * n;
    if (zBefore < lapBase + hs && car.z >= lapBase + hs) corner.entrySpeed.push(sp);
    if (car.z >= n && Math.floor(car.z / n) > r.lapTimes.length) {
      r.lapTimes.push((d.race.tick - lapStart) * DT);
      lapStart = d.race.tick;
    }
    if (r.lapTimes.length >= 1 && sp < r.minSpeedFlying) r.minSpeedFlying = sp;
  }
  r.ticks = d.race.tick;
  r.finished = !r.nan && car.z >= goal && r.lapTimes.length === m.laps;
  (r as RunResult & { trs?: Tr[] }).trs = d.trs;
  return r;
}
function partG(io: Io): void {
  const cfg = readGateConfig(io.read('gate.config.json'));
  const m = cfg.measure;
  const nSeeds = Number(argValue(io.argv, 'seeds') ?? '10');
  const seeds = Array.from({ length: nSeeds }, (_, i) => i + 1);
  const out = argValue(io.argv, 'out');
  const tracks = loadTracks(io);
  for (const mode of ['old', 'v5'] as const) {
    io.log(`## (g) bots, mode ${mode}, ${nSeeds} seeds x ${m.laps} laps`);
    const entries: Entry[] = [];
    for (const t of tracks) {
      for (const b of BOT_NAMES) {
        const runs = seeds.map((s) => runBotV5(botParams[b], OLD, t, s, m, mode));
        const e = summarize(b, t, runs, m);
        entries.push(e);
        let flick = 0;
        let ent = 0;
        for (const r of runs) {
          const trs = (r as RunResult & { trs?: Tr[] }).trs ?? [];
          ent += trs.filter((x) => x.to === 'DRIFT').length;
          flick += trs.filter((x) => x.to === 'GRIP' && x.why === 'flip').length;
        }
        io.log(
          `${t.name.padEnd(12)} ${b.padEnd(8)} lap ${f(e.lapTime.mean)} s (sd ${f(e.lapTime.stdev)})  off ${f(100 * e.offroadFraction, 1)}%  crashes/lap ${f(e.crashesPerLap)}  drift ${f(100 * (e as unknown as { driftFraction: number }).driftFraction, 1)}%  entries/lap ${f(ent / runs.length / m.laps, 1)}  flips/lap ${f(flick / runs.length / m.laps, 1)}  finished ${e.finishedFraction * runs.length}/${runs.length}`,
        );
      }
    }
    if (out && mode === 'v5') {
      const res: Results = {
        version: 1,
        car: 'base',
        laps: m.laps,
        seeds,
        measure: m,
        tracks: tracks.map((t) => t.name),
        entries,
        traffic: [],
        recovery: {
          curveClass: cfg.recovery.curveClass,
          speed: cfg.recovery.speed,
          depth: cfg.recovery.depth,
          seconds: null,
        },
      } as unknown as Results;
      io.write(out, JSON.stringify(res, null, 2) + '\n');
      io.log(`wrote ${out}`);
    }
  }
}


// ---------------------------------------------------------------- (h) line authority in steady drift
function partH(io: Io): void {
  io.log('## (h) steady drift at vmax, steer 0 for 2 s, then steer ±1: time to move one lane (0.25), then steer 0: stop');
  const rows: string[][] = [];
  for (const spn of [0.3, 0.5, 0.7]) {
    V = { ...V, cornerSpan: spn };
    for (const cls of CLS) {
      const tr = cornerTrack(C[cls]!, 300, 30, 900, 30);
      const [a] = span(tr);
      const cells: string[] = [];
      for (const s of [1, -1]) {
        const d = new Drv('v5', free(OLD), 1, a - 18, 0);
        for (let i = 0; i < 2 / DT; i++) d.tick(tr, 0, true);
        const x0 = d.car.x;
        let tl = NaN;
        for (let i = 1; i <= 4 / DT && Number.isNaN(tl); i++) {
          d.tick(tr, s, true);
          if (Math.abs(d.car.x - x0) >= LANE) tl = i * DT;
        }
        let last = -1;
        const x1 = d.car.x;
        let over = 0;
        for (let i = 0; i < 1.5 / DT; i++) {
          d.tick(tr, 0, true);
          over = Math.max(over, s * (d.car.x - x1));
          if (Math.abs(d.car.vx) > 0.02) last = i;
        }
        cells.push(`${f(tl, 2)} s / +${f(over, 2)} / ${f((last + 1) * DT, 2)} s`);
      }
      rows.push([f(spn, 1), cls, ...cells]);
    }
  }
  table(io, ['cornerSpan', 'class', 'steer +1 (in): t lane / drift on after 0 / stop', 'steer −1 (out)'], rows);
}

// ---------------------------------------------------------------- sweep of V5 numbers on (a)/(c)
function partS(io: Io): void {
  io.log(
    '## (s) sweep: worst steer-0 |x| drift over classes (sp 0.6/0.8/1.0) and flicker over figures',
  );
  const rows: string[][] = [];
  for (const cc of [0.25, 0.5, 1.0]) {
    for (const gap of [20, 30, 45]) {
      for (const flip of ['gap', 'direct'] as const) {
        V = { ...V, cornerCurve: cc, cornerGap: gap, flip };
        let worstX = 0;
        for (const cls of CLS) {
          const tr = cornerTrack(C[cls]!, 300, SHAPE.enter, SHAPE.hold, SHAPE.leave);
          for (const sp0 of [0.6, 0.8, 1.0]) {
            const v = runCorner('v5', tr, sp0, () => 0, true);
            worstX = Math.max(worstX, Math.abs(v.xMin), Math.abs(v.xMax));
          }
        }
        let extra = 0;
        let worstFigX = 0;
        for (const name of Object.keys(figureDict)) {
          if (name === 'straight') continue;
          const tr = figureTrack(name, 1);
          // expected changes: one entry + one exit per run of same-side corner parts
          const secs = figureDict[name]!.parts.filter((q) => q.curveClass !== 'straight');
          let runs = 0;
          let prev = 0;
          for (const q of secs) {
            if (q.side !== prev) runs++;
            prev = q.side;
          }
          if (name === 'switchback') runs = 2;
          for (const sp0 of [0.7, 1.0]) {
            const v = runCorner('v5', tr, sp0, () => 0, true);
            extra += Math.max(0, v.trs.length - 2 * runs);
            worstFigX = Math.max(worstFigX, Math.abs(v.xMin), Math.abs(v.xMax));
          }
        }
        rows.push([f(cc), String(gap), flip, f(worstX, 3), String(extra), f(worstFigX, 2)]);
      }
    }
  }
  table(
    io,
    [
      'cornerCurve',
      'cornerGap',
      'flip',
      'classes: worst |x| steer 0',
      'figures: extra changes',
      'figures: worst |x|',
    ],
    rows,
  );
}

export function main(io: Io): number {
  const part = argValue(io.argv, 'part') ?? 'all';
  const cc = argValue(io.argv, 'cc');
  if (cc) V.cornerCurve = Number(cc);
  const gap = argValue(io.argv, 'gap');
  if (gap) V.cornerGap = Number(gap);
  const sp = argValue(io.argv, 'span');
  if (sp) V.cornerSpan = Number(sp);
  const mu = argValue(io.argv, 'minu');
  if (mu) V.cornerMinU = Number(mu);
  if (io.argv.includes('--direct')) V.flip = 'direct';
  if (io.argv.includes('--carry')) V.noCarryCost = false;
  io.log(`V5 ${JSON.stringify(V)}`);
  const all = part === 'all';
  if (all || part === 'a') partA(io);
  if (all || part === 'b') partB(io);
  if (all || part === 'c') partC(io);
  if (all || part === 'd') partD(io);
  if (all || part === 'e') partE(io);
  if (all || part === 'f') partF(io);
  if (part === 's') partS(io);
  if (part === 'h') partH(io);
  if (part === 'g') partG(io);
  return 0;
}

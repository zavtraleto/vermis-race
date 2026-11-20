// THROWAWAY SPIKE (docs/research/auto-drift-slipstream.md, variant A; T70): automatic drift entry,
// "the road decides, the finger releases". Everything runs through the REAL src/sim `step` with
// driftEntry 3 (R81c); variant 4 is emulated around it: the wrapper keeps autoTicks and passes
// input.drift = true to `step` only on the tick the auto entry fires (variant 3 then enters with
// dir = sign(steer) = side) and, in DRIFT, input.drift = control held. src/ and data are not touched.
// Run: node tools/run-ts.mjs tools/spike/auto-drift.ts [--part a|b|c|d|e|f|tune|all]
import { baseCar } from '../../src/data/cars';
import { curveClasses } from '../../src/data/tracks';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, Segment, Track } from '../../src/sim/types';
import { argValue, type Io } from '../io';

const C = curveClasses as Record<string, number>;
const P0: CarParams = { ...baseCar, driftTurbo: 0, driftEntry: 3 };
const GRIP_A = P0.yawRateMax / (1 + P0.yawAlign / P0.velGrip);
const HOLD: Record<string, number> = { medium: 0.537, hard: 0.817, sharp: 0.956, easy: 0.3 };
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
function table(io: Io, head: string[], rows: string[][]): void {
  io.log('| ' + head.join(' | ') + ' |');
  io.log('|' + head.map(() => ' --- ').join('|') + '|');
  for (const r of rows) io.log('| ' + r.join(' | ') + ' |');
  io.log('');
}

interface Auto {
  autoSteer: number;
  autoHold: number;
  autoLook: number;
  autoNeed: number;
}
// T70 final (start 0.7 / 0.15 / 0.25 / 0.8 from the research note; hold and need changed by this spike).
const AUTO0: Auto = { autoSteer: 0.7, autoHold: 0.1, autoLook: 0.25, autoNeed: 1.0 };

/** R81e needAhead and side over the road covered in autoLook s at the current speed. */
function needAhead(segs: readonly Segment[], car: Car, p: CarParams, a: Auto): [number, number] {
  const n = segs.length;
  const sp = car.speed / p.vmax;
  const k = Math.ceil(sp * SEG_PER_UNIT * a.autoLook);
  let j = Math.floor(car.z) % n;
  if (j < 0) j += n;
  let best = 0;
  for (let i = 0; i <= k; i++) {
    const c = segs[j]!.curve;
    if (Math.abs(c) > Math.abs(best)) best = c;
    j = j + 1 >= n ? 0 : j + 1;
  }
  return [(Math.abs(best) * sp * p.kYaw) / GRIP_A, Math.sign(best)];
}

interface Rig {
  race: ReturnType<typeof createRace>;
  car: Car;
  frame: InputFrame;
  p: CarParams;
  a: Auto;
  mode: 'auto' | 'zone' | 'grip';
  autoTicks: number;
  blocked: boolean;
  entries: number;
  lastEntryTick: number;
  speedPin?: number;
}
function rig(mode: Rig['mode'], a: Auto = AUTO0, p: CarParams = P0, speed = 1, z = 0, x = 0): Rig {
  const race = createRace(1, 1);
  const car = race.cars[0]!;
  car.speed = speed * p.vmax;
  car.z = z;
  car.x = x;
  return {
    race,
    car,
    frame: { steer: 0, brake: false, drift: false },
    p,
    a,
    mode,
    autoTicks: 0,
    blocked: false,
    entries: 0,
    lastEntryTick: -1,
  };
}
/** One real step. held = finger down / steer key held. zone mode: drift = held (R81c latch). */
function stepR(r: Rig, track: Track, steer: number, held: boolean): void {
  const c = r.car;
  const p = r.p;
  if (r.speedPin !== undefined) c.speed = r.speedPin;
  let drift = held;
  if (r.mode === 'grip') drift = false;
  else if (r.mode === 'auto') {
    if (!held) r.blocked = false;
    if (c.state === 'GRIP') {
      const [need, side] = needAhead(track.segments, c, p, r.a);
      const ok =
        held &&
        !r.blocked &&
        c.crashTicks === 0 &&
        c.speed > p.driftEnterSpeed * p.vmax &&
        need >= r.a.autoNeed &&
        side !== 0 &&
        steer * side >= r.a.autoSteer;
      r.autoTicks = ok ? r.autoTicks + 1 : 0;
      drift = r.autoTicks > Math.round(r.a.autoHold / DT); // as R81b C: after autoHold/DT full ticks
      if (drift) r.autoTicks = 0;
    } else r.autoTicks = 0;
  }
  const was = c.state;
  r.frame.steer = steer;
  r.frame.drift = drift;
  step(r.race, [r.frame], track, [p]);
  if (was === 'GRIP' && c.state === 'DRIFT') {
    r.entries++;
    r.lastEntryTick = r.race.tick;
  }
  if (r.mode === 'auto' && was === 'DRIFT' && c.state === 'GRIP' && held) r.blocked = true;
}

// ---------------------------------------------------------------- tracks
const cache = new Map<string, Track>();
/** Straight 0..start, curve `curve` for len segments, then straight to 8000. */
function cornerTrack(curve: number, start: number, len: number): Track {
  const key = `${curve}/${start}/${len}`;
  let t = cache.get(key);
  if (!t) {
    const segments: Segment[] = [];
    for (let i = 0; i < 8000; i++)
      segments.push({ curve: i >= start && i < start + len ? curve : 0 });
    t = { segments };
    cache.set(key, t);
  }
  return t;
}
const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  crashMinSpeed: 1e9,
});

class Lcg {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
}

// ---------------------------------------------------------------- (a) straights and easy
function partA(io: Io, a: Auto): void {
  io.log('## (a) straights and easy: DRIFT entries under any input');
  const rows: string[][] = [];
  const pats: [string, (t: number, rng: Lcg, st: { v: number; until: number }) => number][] = [
    ['full lock +1 held', () => 1],
    ['full lock −1 held', () => -1],
    ['square ±1, 0.2 s', (t) => (Math.floor(t / 0.2) % 2 ? 1 : -1)],
    ['square ±1, 0.6 s', (t) => (Math.floor(t / 0.6) % 2 ? 1 : -1)],
    ['square ±1, 2 s', (t) => (Math.floor(t / 2) % 2 ? 1 : -1)],
    ['dodge 1 for 0.3 s every 1 s', (t) => (t % 1 < 0.3 ? 1 : 0)],
    [
      'random ±1 holds 0.05–1.5 s',
      (t, rng, st) => {
        if (t >= st.until) {
          st.v = rng.next() < 0.5 ? -1 : rng.next() < 0.5 ? 1 : rng.next() * 2 - 1;
          st.until = t + 0.05 + rng.next() * 1.45;
        }
        return st.v;
      },
    ],
  ];
  for (const cls of ['straight', 'easy']) {
    const curve = cls === 'straight' ? 0 : C.easy!;
    for (const pin of [1, 1.13]) {
      for (const sign of [1, -1]) {
        const track = cornerTrack(sign * curve, 0, 8000);
        for (const [nm, fn] of pats) {
          let entries = 0;
          let maxNeed = 0;
          for (let seed = 1; seed <= (nm.startsWith('random') ? 20 : 1); seed++) {
            const r = rig('auto', a, free(P0), pin, 10);
            r.speedPin = pin;
            const rng = new Lcg(seed);
            const st = { v: 0, until: 0 };
            for (let i = 0; i < 20 / DT; i++) {
              const t = i * DT;
              maxNeed = Math.max(maxNeed, needAhead(track.segments, r.car, r.p, a)[0]);
              stepR(r, track, fn(t, rng, st), true);
            }
            entries += r.entries;
          }
          if (sign === -1 && cls === 'straight') continue;
          rows.push([
            cls + (cls === 'easy' ? (sign > 0 ? ' R' : ' L') : ''),
            f(pin),
            nm,
            String(entries),
            f(maxNeed, 3),
          ]);
        }
      }
    }
  }
  table(io, ['road', 'sp', 'input (20 s, finger down)', 'DRIFT entries', 'max needAhead'], rows);
}

// ---------------------------------------------------------------- corner run
interface Run {
  entryT: number; // s after corner start (negative = before), NaN = none
  cornerT: number; // s from corner start to corner end
  vMean: number;
  vMin: number;
  vExit: number;
  xOut: number; // max outward x (x*side, most negative -> positive number)
  xIn: number; // max inward x*side
  xStart: number;
}
/**
 * Corner of class `cls` and side `side` of `len` segments starting at segment 3000. The car starts
 * at `lead` seconds of road before the corner at speed v0 (speed free). Steer: full into the corner
 * from `steerFrom` s relative to corner start (before = on the approach straight); until then 0.
 * After DRIFT: line controller around the class hold steer toward x = xLine*side. GRIP mode: same
 * controller with the GRIP target (full steer + line).
 */
function cornerRun(
  mode: Rig['mode'],
  cls: string,
  side: number,
  len: number,
  v0: number,
  steerFrom = 0,
  a: Auto = AUTO0,
  x0 = 0,
): Run {
  const start = 3000;
  const lead = Math.max(0.6, -steerFrom + 0.3);
  const z0 = start - v0 * SEG_PER_UNIT * lead;
  const track = cornerTrack(side * C[cls]!, start, len);
  const r = rig(mode, a, P0, v0, z0, x0 * side);
  // keep the approach speed fixed until 0.3 s before the corner so v0 is the speed at the corner
  const out: Run = {
    entryT: NaN,
    cornerT: NaN,
    vMean: 0,
    vMin: 9,
    vExit: 0,
    xOut: 0,
    xIn: -9,
    xStart: NaN,
  };
  let tStart = NaN;
  let n = 0;
  const hold = HOLD[cls] ?? 0.8;
  for (let i = 0; i < 30 / DT; i++) {
    const c = r.car;
    const t = i * DT;
    const zRel = c.z - start;
    const tc = zRel / (v0 * SEG_PER_UNIT); // approx seconds relative to corner start (approach)
    if (tc < steerFrom && tc < 0) c.speed = v0 * P0.vmax; // approach speed held until steering starts
    let s = 0;
    if (c.state === 'DRIFT') {
      s = side * (hold + 0.8 * (0 - c.x * side) - 0.3 * c.vx * side);
    } else if (tc >= steerFrom) {
      s = mode === 'grip' && zRel >= 0 ? side * (1 + 0.8 * (0 - c.x * side)) : side;
    }
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    if (c.z >= start + len) s = 0; // corner over: release
    const held = c.z < start + len;
    stepR(r, track, s, held);
    if (r.lastEntryTick === r.race.tick && Number.isNaN(out.entryT))
      out.entryT = Number.isNaN(tStart) ? -(start - c.z) / (c.speed * SEG_PER_UNIT) : t - tStart;
    if (c.z >= start && Number.isNaN(tStart)) {
      tStart = t;
      out.xStart = c.x * side;
    }
    if (c.z >= start && c.z < start + len) {
      out.vMean += c.speed;
      n++;
      out.vMin = Math.min(out.vMin, c.speed);
      out.xOut = Math.max(out.xOut, -c.x * side);
      out.xIn = Math.max(out.xIn, c.x * side);
    }
    if (c.z < start) out.xIn = Math.max(out.xIn, c.x * side);
    if (c.z >= start + len) {
      out.cornerT = t - tStart;
      out.vExit = c.speed;
      break;
    }
  }
  out.vMean /= n;
  return out;
}

// ---------------------------------------------------------------- (b) hard / sharp / medium
function partB(io: Io, a: Auto): void {
  io.log(
    '## (b) full steer into the corner from corner start: auto (R81e) vs zone stick (R81c) vs GRIP',
  );
  const rows: string[][] = [];
  const cases: [string, number][] = [
    ['hard', 240],
    ['hard', 120],
    ['sharp', 120],
    ['sharp', 60],
    ['medium', 240],
  ];
  for (const [cls, len] of cases) {
    for (const v0 of [1, 0.9, 0.85, 0.8, 0.7, 0.55]) {
      const au = cornerRun('auto', cls, 1, len, v0, 0, a);
      const zo = cornerRun('zone', cls, 1, len, v0, 0, a);
      const gr = cornerRun('grip', cls, 1, len, v0, 0, a);
      rows.push([
        `${cls} ${len}`,
        f(v0),
        f(au.entryT, 3),
        f(au.cornerT, 3),
        f(zo.cornerT, 3),
        f((100 * (au.cornerT - zo.cornerT)) / zo.cornerT, 2) + '%',
        `${f(au.vMean, 3)} / ${f(zo.vMean, 3)}`,
        `${f(au.vExit, 3)} / ${f(zo.vExit, 3)}`,
        `${f(au.xOut, 2)} / ${f(zo.xOut, 2)}`,
        f(gr.cornerT, 3),
      ]);
    }
  }
  table(
    io,
    [
      'corner',
      'v0',
      'auto entry, s',
      'T auto, s',
      'T zone, s',
      'ΔT',
      'v mean auto/zone',
      'v exit auto/zone',
      'max out auto/zone',
      'T GRIP, s',
    ],
    rows,
  );
}

// ---------------------------------------------------------------- (c) steer against / below autoSteer
function partC(io: Io, a: Auto): void {
  io.log(
    '## (c) inside hard/sharp/medium at vmax: steer against the corner or |steer| < autoSteer',
  );
  const rows: string[][] = [];
  for (const cls of ['medium', 'hard', 'sharp']) {
    const track = cornerTrack(C[cls]!, 0, 8000);
    const pats: [string, (t: number, rng: Lcg) => number][] = [
      ['−1 held (against)', () => -1],
      ['−0.3 held', () => -0.3],
      ['0', () => 0],
      [`+${f(a.autoSteer - 0.01)} held (just below)`, () => a.autoSteer - 0.01],
      [
        'weave ±(autoSteer−0.01), 0.3 s',
        (t) => (Math.floor(t / 0.3) % 2 ? 1 : -1) * (a.autoSteer - 0.01),
      ],
      ['random in [−1, autoSteer)', (_t, rng) => -1 + rng.next() * (1 + a.autoSteer - 0.001)],
      [
        `+1 pulses ${f(a.autoHold - 2 * DT, 3)} s / 0.1 s at −1`,
        (t) => (t % (a.autoHold - 2 * DT + 0.1) < a.autoHold - 2 * DT ? 1 : -1),
      ],
      ['+1 held (control)', () => 1],
    ];
    for (const [nm, fn] of pats) {
      const r = rig('auto', a, free(P0), 1, 10);
      r.speedPin = 1;
      const rng = new Lcg(7);
      let hold = 0;
      let tEntry = NaN;
      for (let i = 0; i < 10 / DT; i++) {
        const s = fn(i * DT, rng);
        hold = s;
        stepR(r, track, s, true);
        if (r.entries === 1 && Number.isNaN(tEntry)) tEntry = (i + 1) * DT;
      }
      void hold;
      rows.push([cls, nm, String(r.entries), f(tEntry, 3)]);
    }
  }
  table(io, ['corner (10 s, sp 1)', 'input', 'DRIFT entries', 'first entry, s'], rows);
}

// ---------------------------------------------------------------- (d) drop and re-touch
function partD(io: Io, a: Auto): void {
  io.log(
    '## (d) hard at vmax: steady drift 1.5 s, release for g s (steer 0), touch again full into',
  );
  const rows: string[][] = [];
  const track = cornerTrack(C.hard!, 0, 8000);
  for (const g of [0.02, 0.05, 0.1, 0.2, 0.4, 0.8]) {
    const r = rig('auto', a, P0, 1, 10);
    let tRel = NaN;
    let tRe = NaN;
    let x0 = 0;
    let xMinOut = 0;
    let xAtRe = 0;
    let vRel = 0;
    let vRe = 0;
    for (let i = 0; i < 6 / DT; i++) {
      const t = i * DT;
      const c = r.car;
      let s = 0;
      let held = true;
      if (t < 0.2) s = 1;
      else if (t < 1.7) s = c.state === 'DRIFT' ? 0.817 + 0.8 * (0 - c.x) - 0.3 * c.vx : 1;
      else if (t < 1.7 + g) held = false;
      else s = c.state === 'DRIFT' ? 0.817 + 0.8 * (0 - c.x) - 0.3 * c.vx : 1;
      if (s > 1) s = 1;
      if (Math.abs(t - 1.7) < DT / 2) {
        x0 = c.x;
        vRel = c.speed;
      }
      stepR(r, track, s, held);
      if (t >= 1.7 && Number.isNaN(tRel) && c.state === 'GRIP') tRel = t;
      if (t >= 1.7 && !Number.isNaN(tRel) && Number.isNaN(tRe) && c.state === 'DRIFT') {
        tRe = t;
        xAtRe = c.x;
        vRe = c.speed;
      }
      if (t >= 1.7 && Number.isNaN(tRe)) xMinOut = Math.min(xMinOut, c.x - x0);
    }
    rows.push([
      f(g, 2),
      f(tRe - tRel, 3),
      f(tRe - tRel - g, 3),
      f(xAtRe - x0, 3),
      f(xMinOut, 3),
      `${f(vRel, 3)} → ${f(vRe, 3)}`,
    ]);
  }
  table(
    io,
    [
      'released, s',
      'GRIP total, s',
      'GRIP after re-touch, s',
      'Δx to re-entry (− = out)',
      'min Δx',
      'speed release → re-entry',
    ],
    rows,
  );
  // Dodge outward by releasing: x vs holding the drift, 0.3/0.6 s after release.
  const rows2: string[][] = [];
  for (const cls of ['medium', 'hard', 'sharp']) {
    const tr = cornerTrack(C[cls]!, 0, 8000);
    const xs: number[][] = [];
    for (const rel of [false, true]) {
      const r = rig('auto', a, free(P0), 1, 10);
      const row: number[] = [];
      let x0 = 0;
      for (let i = 0; i < 3 / DT; i++) {
        const t = i * DT;
        const c = r.car;
        let s = c.state === 'DRIFT' ? HOLD[cls]! + 0.8 * (0 - c.x) - 0.3 * c.vx : 1;
        if (s > 1) s = 1;
        const held = !(rel && t >= 2);
        if (rel && t >= 2) s = 0;
        if (Math.abs(t - 2) < DT / 2) x0 = c.x;
        stepR(r, tr, s, held);
        if (Math.abs(t - 2.3) < DT / 2 || Math.abs(t - 2.6) < DT / 2) row.push(c.x - x0);
      }
      xs.push(row);
    }
    rows2.push([cls, f(xs[0]![0]!, 3), f(xs[1]![0]!, 3), f(xs[0]![1]!, 3), f(xs[1]![1]!, 3)]);
  }
  io.log(
    'Drop to straighten (vmax, steady drift 2 s, then release with steer 0 vs keep the drift):',
  );
  table(
    io,
    ['corner', 'Δx 0.3 s hold', 'Δx 0.3 s released', 'Δx 0.6 s hold', 'Δx 0.6 s released'],
    rows2,
  );
}

// ---------------------------------------------------------------- (e) late entry from the approach
function partE(io: Io, base: Auto, x0 = -0.5): void {
  io.log(`## (e) full steer from before the corner (approach straight), x0 = ${x0} (− = outside)`);
  const rows: string[][] = [];
  for (const look of [0.1, 0.25, 0.4, 0.6]) {
    const a: Auto = { ...base, autoLook: look };
    for (const [cls, len] of [
      ['hard', 240],
      ['sharp', 120],
    ] as [string, number][]) {
      for (const from of [-0.5, -0.3, -0.15, 0]) {
        const au = cornerRun('auto', cls, 1, len, 1, from, a, x0);
        const gr = cornerRun('grip', cls, 1, len, 1, from, a, x0);
        const zo = cornerRun('zone', cls, 1, len, 1, 0, a, x0);
        rows.push([
          f(look, 2),
          `${cls} ${len}`,
          f(from, 2),
          f(au.entryT, 3),
          `${f(au.xStart, 2)} / ${f(gr.xStart, 2)}`,
          `${f(au.xIn, 2)} / ${f(zo.xIn, 2)}`,
          f(au.xOut, 2),
          `${f(au.cornerT, 3)} / ${f(zo.cornerT, 3)}`,
        ]);
      }
    }
  }
  table(
    io,
    [
      'autoLook',
      'corner',
      'steer from, s',
      'entry rel. corner, s',
      'x at corner start auto/GRIP (+ = inside)',
      'max inside auto / zone@0',
      'max out auto',
      'T auto / zone@0',
    ],
    rows,
  );
}

// ---------------------------------------------------------------- (f) R86e chain
function partF(io: Io, a: Auto): void {
  io.log('## (f) R86e: chain of short auto drifts vs pure GRIP vs held drift (vmax approach)');
  const rows: string[][] = [];
  for (const [cls, len] of [
    ['hard', 240],
    ['hard', 120],
    ['sharp', 120],
  ] as [string, number][]) {
    const track = cornerTrack(C[cls]!, 3000, len);
    const run = (kind: string, dT: number, rT: number): [number, number] => {
      const mode: Rig['mode'] = kind === 'grip' ? 'grip' : 'auto';
      const r = rig(mode, a, P0, 1, 3000 - 30);
      let tStart = NaN;
      let phaseT = 0;
      let released = false;
      let xo = 0;
      for (let i = 0; i < 20 / DT; i++) {
        const t = i * DT;
        const c = r.car;
        let s = 0;
        let held = true;
        if (c.z >= 3000) {
          if (Number.isNaN(tStart)) tStart = t;
          if (kind === 'chain') {
            if (c.state === 'DRIFT') {
              phaseT += DT;
              if (phaseT >= dT) {
                released = true;
                phaseT = 0;
              }
            } else if (released) {
              phaseT += DT;
              if (phaseT >= rT) {
                released = false;
                phaseT = 0;
              }
            }
          }
          held = !released;
          if (c.state === 'DRIFT') s = HOLD[cls]! + 0.8 * (0 - c.x) - 0.3 * c.vx;
          else s = held ? 1 + 0.8 * (0 - c.x) : 0;
          if (s > 1) s = 1;
          if (s < -1) s = -1;
          xo = Math.max(xo, -c.x);
        }
        if (c.z >= 3000 + len) return [t - tStart, xo];
        stepR(r, track, s, held);
      }
      return [NaN, xo];
    };
    const g = run('grip', 0, 0);
    const h = run('held', 0, 0);
    const res: string[] = [`${cls} ${len}`, f(g[0], 3), f(h[0], 3)];
    for (const [dT, rT] of [
      [0.1, 0.05],
      [0.2, 0.05],
      [0.3, 0.1],
      [0.45, 0.05],
    ] as [number, number][]) {
      const ch = run('chain', dT, rT);
      res.push(`${f(ch[0], 3)} (${f(ch[0] - g[0], 3)})`);
    }
    rows.push(res);
  }
  table(
    io,
    [
      'window',
      'T GRIP',
      'T held drift',
      'chain 0.10/0.05 (Δ GRIP)',
      'chain 0.20/0.05',
      'chain 0.30/0.10',
      'chain 0.45/0.05',
    ],
    rows,
  );
  io.log(
    'Tap shorter than autoHold: a touch of k ticks with full steer never reaches DRIFT (see (c) pulses).',
  );
}

// ---------------------------------------------------------------- tune sweep
function partTune(io: Io): void {
  io.log(
    '## tune: autoHold × autoSteer on hard 240 / sharp 120 at vmax (ΔT vs zone) and medium threshold',
  );
  const rows: string[][] = [];
  for (const hold of [0.05, 0.067, 0.083, 0.1, 0.12, 0.15]) {
    for (const st of [0.7]) {
      const a: Auto = { ...AUTO0, autoHold: hold, autoSteer: st };
      const cells: string[] = [f(hold, 2), f(st, 2)];
      for (const [cls, len] of [
        ['hard', 240],
        ['hard', 120],
        ['sharp', 120],
        ['sharp', 60],
      ] as [string, number][]) {
        let worst = -9;
        let at = 0;
        for (const v0 of [1, 0.9, 0.85, 0.8, 0.7, 0.6]) {
          const au = cornerRun('auto', cls, 1, len, v0, 0, a);
          const zo = cornerRun('zone', cls, 1, len, v0, 0, a);
          const d = (100 * (au.cornerT - zo.cornerT)) / zo.cornerT;
          if (d > worst) {
            worst = d;
            at = v0;
          }
        }
        cells.push(`${f(worst, 2)}% @${f(at, 2)}`);
      }
      rows.push(cells);
    }
  }
  table(
    io,
    ['autoHold', 'autoSteer', 'worst ΔT hard 240', 'hard 120', 'sharp 120', 'sharp 60'],
    rows,
  );
  const rows2: string[][] = [];
  for (const need of [0.7, 0.8, 0.9, 1.0]) {
    const vMed = (need * GRIP_A) / (C.medium! * P0.kYaw);
    const vHard = (need * GRIP_A) / (C.hard! * P0.kYaw);
    const vEasy = (need * GRIP_A) / (C.easy! * P0.kYaw);
    rows2.push([
      f(need, 2),
      f(vEasy, 3),
      f(vMed, 3),
      f(vHard, 3),
      f((need * GRIP_A) / (C.sharp! * P0.kYaw), 3),
    ]);
  }
  io.log(`gripA = ${f(GRIP_A, 3)}; lowest sp at which needAhead ≥ autoNeed:`);
  table(io, ['autoNeed', 'easy', 'medium', 'hard', 'sharp'], rows2);
}

export function main(io: Io): number {
  const part = argValue(io.argv, 'part') ?? 'all';
  const num = (k: string, d: number): number => {
    const v = argValue(io.argv, k);
    return v === undefined ? d : Number(v);
  };
  const a: Auto = {
    autoSteer: num('steer', AUTO0.autoSteer),
    autoHold: num('hold', AUTO0.autoHold),
    autoLook: num('look', AUTO0.autoLook),
    autoNeed: num('need', AUTO0.autoNeed),
  };
  io.log(`auto: ${JSON.stringify(a)}`);
  if (part === 'all' || part === 'a') partA(io, a);
  if (part === 'all' || part === 'b') partB(io, a);
  if (part === 'all' || part === 'c') partC(io, a);
  if (part === 'all' || part === 'd') partD(io, a);
  if (part === 'all' || part === 'e') partE(io, a, num('x0', -0.5));
  if (part === 'all' || part === 'f') partF(io, a);
  if (part === 'all' || part === 'tune') partTune(io);
  return 0;
}

// THROWAWAY SPIKE (docs/research/drift-payoff.md): does drift pay off against GRIP? Numbers for
// corners (empty road), where speed goes, rivals' drift share, and 4 candidate levers.
// Everything runs through the REAL src/sim `step` and the real bots (src/bot/driver.ts, rivals.ts).
// Levers (i) scrub and (iii) exit boost are wrappers around `step` (post-processing car.speed / the
// player's car.band, which `step` only touches for rivals); (ii) and (iv) are CarParams overrides.
// src/, tests and data are not touched.
// Run: node tools/run-ts.mjs tools/spike/drift-payoff.ts [--part 1|2|3|4|all] [--seeds N]
import { botInput, createBot, type BotParams } from '../../src/bot/driver';
import { createRivalDrivers, fillRivalInputs } from '../../src/bot/rivals';
import { botParams } from '../../src/data/bots';
import { baseCar } from '../../src/data/cars';
import road from '../../src/data/road.json';
import { mistakeConfig, rivalConfig } from '../../src/data/rivals';
import driftRunDef from '../../src/data/tracks/drift-run.json';
import {
  curveClasses,
  expandFigures,
  figureDict,
  parseSections,
  resolveSections,
  type ClassedSection,
  type CurveClass,
  type FigureRef,
} from '../../src/data/tracks';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, placeRivals, placeTraffic, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, RivalConfig, Track } from '../../src/sim/types';
import { TRAFFIC, loadTracks, type LoadedTrack } from '../botlib';
import { argValue, type Io } from '../io';

const P: CarParams = { ...baseCar };
const EXPERT: BotParams = botParams.expert;
const CLEAN: BotParams = { ...EXPERT, noiseAmp: 0, reactionDelay: 0 }; // deterministic "ideal" driver
const f2 = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(100 * v).toFixed(d)}%` : '—');
function table(io: Io, head: string[], rows: string[][]): void {
  io.log('| ' + head.join(' | ') + ' |');
  io.log('|' + head.map(() => ' --- ').join('|') + '|');
  for (const r of rows) io.log('| ' + r.join(' | ') + ' |');
  io.log('');
}

// ------------------------------------------------------------------------------------ run loop
interface Hook {
  pre?: (car: Car, p: CarParams) => void;
  post?: (car: Car, prevState: string, curve: number, p: CarParams) => void;
}
interface Out {
  lapTimes: number[];
  finished: boolean;
  offTicks: number;
  offEvents: number;
  walls: number;
  crashes: number;
  ticks: number;
  driftTicks: number;
  entries: number;
  /** speed deficit (1 - sp) * DT summed over flying ticks, s, by cause */
  def: { drift: number; exit: number; gripBrake: number; gripFree: number };
  flyTicks: number;
}
const EXIT_S = 1.5; // s after a drift exit counted as "exit"

function runLaps(
  track: Track,
  bp: BotParams,
  p: CarParams,
  seed: number,
  laps: number,
  hook?: Hook,
): Out {
  const n = track.segments.length;
  const race = createRace(seed, 1, 0);
  const car = race.cars[0]!;
  const bot = createBot(seed);
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const inputs = [frame];
  const params = [p];
  const goal = laps * n;
  const maxTicks = Math.ceil((laps * 180) / DT);
  const o: Out = {
    lapTimes: [],
    finished: false,
    offTicks: 0,
    offEvents: 0,
    walls: 0,
    crashes: 0,
    ticks: 0,
    driftTicks: 0,
    entries: 0,
    def: { drift: 0, exit: 0, gripBrake: 0, gripFree: 0 },
    flyTicks: 0,
  };
  let lapStart = 0;
  let wasOff = false;
  let wasWall = false;
  let wasCrash = false;
  let wasDrift = false;
  let sinceExit = Infinity;
  while (car.z < goal && race.tick < maxTicks) {
    botInput(bot, bp, car, track, p, frame);
    hook?.pre?.(car, p);
    const prev = car.state;
    const seg = Math.floor(car.z) % n;
    const curve = track.segments[seg]!.curve;
    step(race, inputs, track, params);
    hook?.post?.(car, prev, curve, p);
    const ax = car.x < 0 ? -car.x : car.x;
    const off = ax > 1;
    if (off) o.offTicks++;
    if (off && !wasOff) o.offEvents++;
    wasOff = off;
    const wall = ax >= p.xLimit;
    if (wall && !wasWall) o.walls++;
    wasWall = wall;
    const crash = car.crashTicks > 0;
    if (crash && !wasCrash) o.crashes++;
    wasCrash = crash;
    const dr = car.state === 'DRIFT';
    if (dr) o.driftTicks++;
    if (dr && !wasDrift) o.entries++;
    if (wasDrift && !dr) sinceExit = 0;
    else sinceExit += DT;
    wasDrift = dr;
    if (car.z >= n) {
      o.flyTicks++;
      const d = (1 - car.speed / p.vmax) * DT;
      if (dr) o.def.drift += d;
      else if (sinceExit < EXIT_S) o.def.exit += d;
      else if (frame.brake) o.def.gripBrake += d;
      else o.def.gripFree += d;
    }
    if (Math.floor(car.z / n) > o.lapTimes.length) {
      o.lapTimes.push((race.tick - lapStart) * DT);
      lapStart = race.tick;
    }
  }
  o.ticks = race.tick;
  o.finished = car.z >= goal && o.lapTimes.length === laps;
  return o;
}
const mean = (v: readonly number[]): number => v.reduce((s, x) => s + x, 0) / (v.length || 1);

// ------------------------------------------------------------------------------------ corner windows
const straightSec = (len: number): ClassedSection => ({
  enter: 0,
  hold: len,
  leave: 0,
  curveClass: 'straight',
  side: 1,
});
const LEAD = 240; // segments of straight before the figure (4 s at vmax)
const TAIL = 300; // after it: the car recovers speed here (5 s)

function figureSections(name: string): ClassedSection[] {
  return expandFigures([{ figure: name, side: 1 }], figureDict);
}
function windowTrack(fig: ClassedSection[]): {
  track: Track;
  start: number;
  end: number;
  total: number;
} {
  const secs = [straightSec(LEAD), ...fig, straightSec(TAIL)];
  const figLen = fig.reduce((s, x) => s + x.enter + x.hold + x.leave, 0);
  return {
    track: buildTrack(resolveSections(parseSections(secs), curveClasses)),
    start: LEAD,
    end: LEAD + figLen,
    total: LEAD + figLen + TAIL,
  };
}
interface Win {
  T: number; // s from the start (speed vmax) to the end of the tail
  tFig: number; // s inside the figure itself
  vEnd: number; // speed at the end of the figure
  vMin: number; // minimum speed from the figure start to its end
  maxX: number;
  offS: number;
  crash: number;
  ok: boolean; // finished, no crash, never beyond |x| = 1
  driftShare: number; // share of figure ticks in DRIFT
  dSpeed: number; // mean speed in DRIFT ticks (vmax)
  dAngle: number; // mean |angle| = slip/slipFull in DRIFT ticks
  scrub: number; // deficit s in GRIP ticks in the figure
}
function runWindow(
  w: ReturnType<typeof windowTrack>,
  bp: BotParams,
  p: CarParams,
  hook?: Hook,
): Win {
  const car = createRace(1, 1, 0).cars[0]!; // placeholder for types only
  void car;
  const race = createRace(1, 1, 0);
  const c = race.cars[0]!;
  c.speed = p.vmax;
  const bot = createBot(1);
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const inputs = [frame];
  const params = [p];
  const w0: Win = {
    T: NaN,
    tFig: NaN,
    vEnd: NaN,
    vMin: Infinity,
    maxX: 0,
    offS: 0,
    crash: 0,
    ok: false,
    driftShare: 0,
    dSpeed: 0,
    dAngle: 0,
    scrub: 0,
  };
  let tStart = NaN;
  let tEnd = NaN;
  let figTicks = 0;
  let dTicks = 0;
  let wasCrash = false;
  const max = Math.ceil(60 / DT);
  while (c.z < w.total && race.tick < max) {
    botInput(bot, bp, c, w.track, p, frame);
    hook?.pre?.(c, p);
    const prev = c.state;
    const curve = w.track.segments[Math.floor(c.z)]!.curve;
    step(race, inputs, w.track, params);
    hook?.post?.(c, prev, curve, p);
    const t = race.tick * DT;
    if (Number.isNaN(tStart) && c.z >= w.start) tStart = t;
    if (Number.isNaN(tEnd) && c.z >= w.end) {
      tEnd = t;
      w0.vEnd = c.speed / p.vmax;
    }
    if (c.z >= w.start && c.z < w.end) {
      figTicks++;
      const sp = c.speed / p.vmax;
      if (sp < w0.vMin) w0.vMin = sp;
      const ax = c.x < 0 ? -c.x : c.x;
      if (ax > w0.maxX) w0.maxX = ax;
      if (ax > 1) w0.offS += DT;
      if (c.state === 'DRIFT') {
        dTicks++;
        w0.dSpeed += sp;
        w0.dAngle += c.angle < 0 ? -c.angle : c.angle;
      } else w0.scrub += (1 - sp) * DT;
    } else {
      const ax = c.x < 0 ? -c.x : c.x;
      if (ax > w0.maxX) w0.maxX = ax;
      if (ax > 1) w0.offS += DT;
    }
    if (c.crashTicks > 0 && !wasCrash) w0.crash++;
    wasCrash = c.crashTicks > 0;
  }
  const done = c.z >= w.total;
  w0.T = done ? race.tick * DT : NaN;
  w0.tFig = tEnd - tStart;
  w0.driftShare = figTicks ? dTicks / figTicks : 0;
  w0.dSpeed = dTicks ? w0.dSpeed / dTicks : NaN;
  w0.dAngle = dTicks ? w0.dAngle / dTicks : NaN;
  w0.ok = done && w0.crash === 0 && w0.maxX <= 1;
  return w0;
}

const gripBp = (m: number): BotParams => ({ ...CLEAN, drift: 'never', bGripMargin: m });
const MARGINS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8, 2.2];
/** Fastest GRIP window with the margin sweep; clean = ok (no crash, never off the asphalt). */
function bestGrip(w: ReturnType<typeof windowTrack>, p: CarParams) {
  let best: { m: number; r: Win } | undefined;
  let fast: { m: number; r: Win } | undefined;
  for (const m of MARGINS) {
    const r = runWindow(w, gripBp(m), p);
    if (Number.isNaN(r.T)) continue;
    if (!fast || r.T < fast.r.T) fast = { m, r };
    if (r.ok && (!best || r.T < best.r.T)) best = { m, r };
  }
  return { best, fast };
}

interface FigRow {
  name: string;
  count: number;
  segs: number;
  g1: Win; // margin 1.0
  gb: { m: number; r: Win } | undefined; // fastest clean margin
  gf: { m: number; r: Win } | undefined; // fastest of all (may leave the road)
  d: Win;
  late: Win;
  early: Win;
}
function figRow(name: string, count: number, p: CarParams): FigRow {
  const sec = figureSections(name);
  const w = windowTrack(sec);
  const g = bestGrip(w, p);
  return {
    name,
    count,
    segs: w.end - w.start,
    g1: runWindow(w, gripBp(1.0), p),
    gb: g.best,
    gf: g.fast,
    d: runWindow(w, CLEAN, p),
    late: runWindow(w, { ...CLEAN, bFlickLook: CLEAN.bFlickLook - 0.2 }, p),
    early: runWindow(w, { ...CLEAN, bFlickLook: CLEAN.bFlickLook + 0.2 }, p),
  };
}
const dt2 = (a: number, b: number): string =>
  Number.isFinite(a - b) ? (a - b >= 0 ? '+' : '') + (a - b).toFixed(2) : '—';

function part1(io: Io): void {
  io.log('## Q1. Corners on an empty road');
  io.log(
    `Window = ${LEAD} segments of straight at vmax, the corner, ${TAIL} segments of straight; T = time for the whole window. Drivers: expert, noise 0 and reaction 0. G1 = GRIP only, margin bGripMargin 1.0 (bot default); G* = the fastest GRIP margin of ${MARGINS.join(', ')} that stays on the asphalt (|x| <= 1) and does not crash; D = drift as bots.json (bFlickLook 0.35 s); D-late/D-early = bFlickLook -/+0.2 s. dT = T(GRIP) - T(variant): + means the variant is faster.`,
  );
  io.log('');
  // pure classes
  const rows: string[][] = [];
  const cls: CurveClass[] = ['easy', 'medium', 'hard', 'sharp'];
  for (const k of cls)
    for (const hold of [60, 120, 240]) {
      const sec: ClassedSection[] = [{ enter: 30, hold, leave: 30, curveClass: k, side: 1 }];
      const w = windowTrack(sec);
      const g1 = runWindow(w, gripBp(1.0), P);
      const g = bestGrip(w, P);
      const d = runWindow(w, CLEAN, P);
      const la = runWindow(w, { ...CLEAN, bFlickLook: CLEAN.bFlickLook - 0.2 }, P);
      const ea = runWindow(w, { ...CLEAN, bFlickLook: CLEAN.bFlickLook + 0.2 }, P);
      const gb = g.best;
      rows.push([
        `${k} (${curveClasses[k]}) hold ${hold}`,
        `${f2(g1.T)} / ${f2(g1.vEnd, 3)} / ${f2(g1.maxX)}`,
        gb ? `${f2(gb.r.T)} / ${f2(gb.r.vEnd, 3)} (m ${gb.m})` : 'нет чистого',
        `${f2(d.T)} / ${f2(d.vEnd, 3)} / ${f2(d.maxX)}`,
        gb ? dt2(gb.r.T, d.T) : '—',
        `${f2(la.T)} (${dt2(gb ? gb.r.T : NaN, la.T)}) / ${f2(la.maxX)}`,
        `${f2(ea.T)} (${dt2(gb ? gb.r.T : NaN, ea.T)}) / ${f2(ea.maxX)}`,
        `${f2(d.dAngle, 2)} / ${f2(d.dSpeed, 3)} / ${f2(d.vMin, 3)}`,
      ]);
    }
  table(
    io,
    [
      'класс, удержание (сегм.)',
      'G1: T / v выхода / max|x|',
      'G*: T / v выхода',
      'D: T / v выхода / max|x|',
      'dT G*−D, с',
      'D-late: T (dT vs G*) / max|x|',
      'D-early: T (dT vs G*) / max|x|',
      'D: угол / v в дрифте / v мин.',
    ],
    rows,
  );

  // figures of drift-run
  const refs = (driftRunDef as { figures: FigureRef[] }).figures;
  const counts = new Map<string, number>();
  for (const r of refs)
    if (r.figure !== 'straight') counts.set(r.figure, (counts.get(r.figure) ?? 0) + 1);
  const figs: FigRow[] = [];
  for (const [name, c] of counts) figs.push(figRow(name, c, P));
  const frows = figs.map((f) => [
    f.name,
    String(f.count),
    String(f.segs),
    `${f2(f.g1.T)} / ${f2(f.g1.vEnd, 3)} / ${f2(f.g1.maxX)}`,
    f.gb ? `${f2(f.gb.r.T)} / ${f2(f.gb.r.vEnd, 3)} (m ${f.gb.m})` : 'нет чистого',
    f.gf && (!f.gb || f.gf.r.T < f.gb.r.T - 1e-9)
      ? `${f2(f.gf.r.T)} (m ${f.gf.m}, max|x| ${f2(f.gf.r.maxX)})`
      : '=',
    `${f2(f.d.T)} / ${f2(f.d.vEnd, 3)} / ${f2(f.d.maxX)}`,
    f.gb ? dt2(f.gb.r.T, f.d.T) : '—',
    `${f2(f.late.T)} (${dt2(f.gb ? f.gb.r.T : NaN, f.late.T)}) / ${f2(f.late.maxX)}`,
    `${f2(f.early.T)} (${dt2(f.gb ? f.gb.r.T : NaN, f.early.T)}) / ${f2(f.early.maxX)}`,
  ]);
  io.log('Figures of drift-run (side +1; counts = placements per lap):');
  table(
    io,
    [
      'фигура',
      'раз/круг',
      'сегм.',
      'G1: T / v выхода / max|x|',
      'G*: T / v выхода',
      'G* быстрее, но с выездом',
      'D: T / v выхода / max|x|',
      'dT G*−D',
      'D-late: T (dT) / max|x|',
      'D-early: T (dT) / max|x|',
    ],
    frows,
  );

  // lap share
  const lapSegs = refs.reduce(
    (s, r) => s + figureSections(r.figure).reduce((a, x) => a + x.enter + x.hold + x.leave, 0),
    0,
  );
  let cornerSegs = 0;
  let fasterSegs = 0;
  let fasterTime = 0;
  let totalFigTime = 0;
  let sumDT = 0;
  for (const f of figs) {
    cornerSegs += f.segs * f.count;
    totalFigTime += f.d.tFig * f.count;
    if (f.gb) sumDT += (f.gb.r.T - f.d.T) * f.count;
    if (f.gb && f.gb.r.T - f.d.T > 0.02) {
      fasterSegs += f.segs * f.count;
      fasterTime += f.d.tFig * f.count;
    }
  }
  const lapT = lapSegs / SEG_PER_UNIT; // upper bound at vmax; the real lap is longer by the slow parts
  io.log(
    `drift-run lap = ${lapSegs} segments (${f2(lapT, 1)} s at vmax). Corner figures: ${cornerSegs} segments = ${pct(cornerSegs / lapSegs)} of the lap by length. Figures where D beats G* by more than 0.02 s: ${fasterSegs} segments = ${pct(fasterSegs / lapSegs)} of the lap by length, ${pct(fasterSegs / cornerSegs)} of the corner length; time in them (D) ${f2(fasterTime, 1)} s of ${f2(totalFigTime, 1)} s spent in corner figures. Sum of per-lap gain G*−D over all placements: ${f2(sumDT, 2)} s.`,
  );
  io.log('');
}


function timing(io: Io): void {
  io.log(
    'Timing sensitivity: the flick starts `off` s earlier (+) / later (-) than bots.json (bFlickLook 0.35 s + off). T of the window, s; the column "G*" is the fastest clean GRIP.',
  );
  const offs = [-0.35, -0.2, 0, 0.2, 0.5, 0.8, 1.2];
  const cases: [string, ClassedSection[]][] = [
    ['hard 120', [{ enter: 30, hold: 120, leave: 30, curveClass: 'hard', side: 1 }]],
    ['hard 240', [{ enter: 30, hold: 240, leave: 30, curveClass: 'hard', side: 1 }]],
    ['sharp 120', [{ enter: 30, hold: 120, leave: 30, curveClass: 'sharp', side: 1 }]],
    ['sharp 240', [{ enter: 30, hold: 240, leave: 30, curveClass: 'sharp', side: 1 }]],
    ['scurve', figureSections('scurve')],
    ['switchback', figureSections('switchback')],
  ];
  const rows: string[][] = [];
  for (const [nm, sec] of cases) {
    const w = windowTrack(sec);
    const g = bestGrip(w, P).best;
    const cells = offs.map((o) => {
      const r = runWindow(w, { ...CLEAN, bFlickLook: Math.max(0.02, CLEAN.bFlickLook + o) }, P);
      return `${f2(r.T)}${r.ok ? '' : ' (x)'}`;
    });
    rows.push([nm, g ? f2(g.r.T) : '—', ...cells]);
  }
  table(io, ['случай', 'G*', ...offs.map((o) => `${o > 0 ? '+' : ''}${o} с`)], rows);
  io.log('(x) = the drift run left the asphalt (|x| > 1), crashed or did not finish.');
  io.log('');
}

function holdSweep(io: Io): void {
  io.log(
    'GRIP at full speed without braking (speed never, margin 1.0): the longest hold (segments, enter/leave 30) that still stays on the asphalt (max |x| <= 1); and the highest steady speed (share of vmax, pinned) at which the GRIP bot stays on the asphalt for a 240 hold (pinned speed: car.speed reset to it every tick).',
  );
  const holds = [30, 45, 60, 75, 90, 105, 120, 135, 150, 180, 240];
  const rows: string[][] = [];
  for (const k of ['hard', 'sharp'] as const) {
    let last = 0;
    let firstBad = NaN;
    for (const h of holds) {
      const w = windowTrack([{ enter: 30, hold: h, leave: 30, curveClass: k, side: 1 }]);
      const r = runWindow(w, { ...gripBp(1.0), speed: 'never' }, P);
      if (r.maxX <= 1 && !(r.crash > 0)) last = h;
      else if (Number.isNaN(firstBad)) firstBad = h;
    }
    // pinned speed bisection on hold 240
    const w = windowTrack([{ enter: 30, hold: 240, leave: 30, curveClass: k, side: 1 }]);
    const pinned = (v: number): boolean => {
      const hook: Hook = {
        pre: (c) => {
          c.speed = v * P.vmax;
        },
      };
      const r = runWindowPinned(w, { ...gripBp(1.0), speed: 'never' }, P, hook);
      return r <= 1;
    };
    let lo = 0.3;
    let hi = 1;
    for (let i = 0; i < 14; i++) {
      const m = (lo + hi) / 2;
      if (pinned(m)) lo = m;
      else hi = m;
    }
    rows.push([k, String(last), Number.isNaN(firstBad) ? '—' : String(firstBad), f2(lo, 3)]);
  }
  table(io, ['класс', 'макс. удержание без выезда', 'первое с выездом', 'макс. v на hold 240 (закреплённая)'], rows);
}
/** max |x| over a window with the speed pinned by the hook (pre) every tick. */
function runWindowPinned(
  w: ReturnType<typeof windowTrack>,
  bp: BotParams,
  p: CarParams,
  hook: Hook,
): number {
  const race = createRace(1, 1, 0);
  const c = race.cars[0]!;
  c.speed = p.vmax;
  const bot = createBot(1);
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  let maxX = 0;
  while (c.z < w.total && race.tick < Math.ceil(60 / DT)) {
    botInput(bot, bp, c, w.track, p, frame);
    hook.pre?.(c, p);
    step(race, [frame], w.track, [p]);
    const ax = c.x < 0 ? -c.x : c.x;
    if (c.z >= w.start && ax > maxX) maxX = ax;
  }
  return maxX;
}

/** Does a wider inside line (insideX) or later steering (bLookahead) rescue GRIP in the long hard corners? */
function lineProbe(io: Io): void {
  io.log(
    'GRIP line probe: the best clean GRIP T over margins x insideX {0.5, 0.7, 0.85, 1.0} x bLookahead {0.15, 0.3, 0.5}; D = drift T (bots.json).',
  );
  const cases: [string, ClassedSection[]][] = [
    ['hard 240', [{ enter: 30, hold: 240, leave: 30, curveClass: 'hard', side: 1 }]],
    ['sharp 240', [{ enter: 30, hold: 240, leave: 30, curveClass: 'sharp', side: 1 }]],
    ['hairpin', figureSections('hairpin')],
    ['switchback', figureSections('switchback')],
  ];
  const rows: string[][] = [];
  for (const [nm, sec] of cases) {
    const w = windowTrack(sec);
    let best = { T: Infinity, m: 0, ix: 0, la: 0 };
    for (const ix of [0.5, 0.7, 0.85, 1.0])
      for (const la of [0.15, 0.3, 0.5])
        for (const m of MARGINS) {
          const r = runWindow(w, { ...gripBp(m), insideX: ix, bLookahead: la }, P);
          if (r.ok && r.T < best.T) best = { T: r.T, m, ix, la };
        }
    const d = runWindow(w, CLEAN, P);
    rows.push([nm, f2(best.T), `m ${best.m}, insideX ${best.ix}, look ${best.la}`, f2(d.T), dt2(best.T, d.T)]);
  }
  table(io, ['случай', 'лучший чистый GRIP, с', 'при', 'D, с', 'G**−D'], rows);
}

// ------------------------------------------------------------------------------------ Q2
function part2(io: Io, tr: LoadedTrack): void {
  io.log('## Q2. Where speed goes');
  // (a) deficit budget on a flying lap, drift expert vs always-grip expert, noise 0
  const rows: string[][] = [];
  const variants: [string, BotParams][] = [
    ['D expert (drift)', CLEAN],
    ['G expert m 1.0', gripBp(1.0)],
    ['G expert m 1.45', gripBp(1.45)],
  ];
  for (const [nm, bp] of variants) {
    const o = runLaps(tr.track, bp, P, 1, 3, undefined);
    const lap = mean(o.lapTimes.slice(1));
    const per = (v: number): string => `${f2(v / 2, 2)} s (${pct(v / 2 / lap)})`;
    rows.push([
      nm,
      f2(lap),
      per(o.def.drift),
      per(o.def.exit),
      per(o.def.gripBrake),
      per(o.def.gripFree),
      `${o.offEvents} / ${o.crashes}`,
    ]);
  }
  io.log(
    `Speed deficit integral sum((1 - speed/vmax)*dt) on flying laps 2-3 of ${tr.name}, mean per lap, by what the car is doing. Cause = where the car is: DRIFT (cap vmax*(1 - driftSpeedLoss*|slip|/slipFull), R86) / EXIT (GRIP within ${EXIT_S} s after a drift: carry slip, slipDrag) / GRIP with brake / GRIP without brake (acceleration back, slipDrag*vis^2).`,
  );
  table(
    io,
    [
      'водитель',
      'круг, с',
      'в DRIFT',
      `выход ${EXIT_S} с`,
      'GRIP + тормоз',
      'GRIP без тормоза',
      'выезды / аварии (за 3 круга)',
    ],
    rows,
  );
  // (b) formulae at the measured steady state
  const rows2: string[][] = [];
  for (const k of ['medium', 'hard', 'sharp'] as const) {
    const w = windowTrack([{ enter: 30, hold: 240, leave: 30, curveClass: k, side: 1 }]);
    const d = runWindow(w, CLEAN, P);
    const cap = 1 - (P.driftSpeedLoss * d.dAngle * P.slipFull) / P.slipFull; // angle = slip/slipFull
    rows2.push([k, f2(d.dAngle, 3), f2(cap, 4), f2(d.dSpeed, 4), f2(d.vMin, 3)]);
  }
  io.log(
    `Steady drift in a long corner (hold 240): R86 cap = 1 - driftSpeedLoss*angle (angle = slip/slipFull); measured mean speed in DRIFT ticks. driftSpeedLoss = ${P.driftSpeedLoss}, slipDrag = ${P.slipDrag}, accel = ${P.accel}/s, driftBrake = ${P.driftBrake}/s.`,
  );
  table(
    io,
    ['класс', 'ср. |angle| в дрифте', 'потолок R86', 'ср. v в дрифте', 'v мин. в фигуре'],
    rows2,
  );
  // (c) GRIP cost: no brake, full speed, medium and below
  const rows3: string[][] = [];
  for (const k of ['easy', 'medium', 'hard', 'sharp'] as const) {
    const w = windowTrack([{ enter: 30, hold: 240, leave: 30, curveClass: k, side: 1 }]);
    const free = runWindow(w, { ...gripBp(1.0), speed: 'never' }, P);
    const g1 = runWindow(w, gripBp(1.0), P);
    rows3.push([
      `${k} (${curveClasses[k]})`,
      `${f2(free.vMin, 4)} / ${f2(free.maxX)} / ${f2(free.offS)} / ${free.crash}`,
      `${f2(g1.vMin, 3)} / ${f2(g1.maxX)} / ${f2(g1.T)}`,
      f2(P.yawRateMax / (1 + P.yawAlign / P.velGrip) / (curveClasses[k] * P.kYaw), 3),
    ]);
  }
  io.log(
    `GRIP at full speed, hold 240, never braking (speed 'never') vs the GRIP bot that brakes (m 1.0). Last column = the speed (share of vmax) at which full steer exactly holds the corner: yawRateMax/(1+yawAlign/velGrip)/(curve*kYaw); >= 1 means no limit.`,
  );
  table(
    io,
    [
      'класс',
      'без тормоза: v мин. / max|x| / с вне дороги / аварий',
      'с тормозом: v мин. / max|x| / T',
      'предельная v GRIP',
    ],
    rows3,
  );
}

// ------------------------------------------------------------------------------------ Q3
interface Grp {
  ticks: number;
  sp: number;
  band: number;
  drift: number;
  entries: number;
  dz: number;
  pace: number;
  n: number;
}
function rivalsRace(tr: LoadedTrack, bot: BotParams, seeds: number, seconds: number, band: 0 | 1) {
  const rc: RivalConfig = { ...rivalConfig, lanes: road.lanes, rubberBand: band };
  const names = ['player', 'rival novice', 'rival average', 'rival expert'];
  const g: Grp[] = names.map(() => ({
    ticks: 0,
    sp: 0,
    band: 0,
    drift: 0,
    entries: 0,
    dz: 0,
    pace: 0,
    n: 0,
  }));
  const ticks = Math.round(seconds / DT);
  for (let seed = 1; seed <= seeds; seed++) {
    const race = createRace(seed, 1 + rc.rivalCount, TRAFFIC.trafficMax);
    placeRivals(race, rc);
    placeTraffic(race, TRAFFIC, baseCar.vmax);
    const cars = race.cars;
    const params: CarParams[] = cars.map(() => ({ ...baseCar }));
    const inputs: InputFrame[] = cars.map(() => ({ steer: 0, brake: false, drift: false }));
    const player = cars[0]!;
    const pb = createBot(seed);
    const drivers = createRivalDrivers(race, seed);
    const n = cars.length;
    const prevName = new Int32Array(n);
    const prevDrift = new Uint8Array(n);
    const prevZ = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      prevName[i] = cars[i]!.nameId;
      prevZ[i] = cars[i]!.z;
      const c = cars[i]!;
      if (c.kind === 'rival') {
        g[1 + Math.min(2, Math.max(0, c.skill))]!.pace += c.pace;
        g[1 + Math.min(2, Math.max(0, c.skill))]!.n++;
      }
    }
    for (let k = 0; k < ticks; k++) {
      botInput(pb, bot, player, tr.track, baseCar, inputs[0]!, cars);
      fillRivalInputs(drivers, race, tr.track, params, mistakeConfig, inputs);
      step(race, inputs, tr.track, params, TRAFFIC, rc);
      for (let i = 0; i < n; i++) {
        const c = cars[i]!;
        if (c.kind === 'traffic') continue;
        const respawn = c.kind === 'rival' && c.nameId !== prevName[i];
        prevName[i] = c.nameId;
        if (respawn) {
          prevDrift[i] = 0;
          prevZ[i] = c.z;
          continue;
        }
        const gi = c.kind === 'player' ? 0 : 1 + Math.min(2, Math.max(0, c.skill));
        const gr = g[gi]!;
        gr.ticks++;
        gr.sp += c.speed / baseCar.vmax;
        gr.band += c.band;
        const dr = c.state === 'DRIFT' ? 1 : 0;
        gr.drift += dr;
        if (dr && !prevDrift[i]) gr.entries++;
        prevDrift[i] = dr;
        gr.dz += c.z - prevZ[i]!;
        prevZ[i] = c.z;
      }
    }
  }
  return { names, g, laps: (z: number): number => z / tr.track.segments.length };
}

function soloRival(tr: LoadedTrack, skill: number, seed: number, mistakes: boolean): number {
  const race = createRace(seed, 2, 0);
  const cars = race.cars;
  const r = cars[1]!;
  r.skill = skill;
  r.speed = 1;
  r.nameId = 0;
  const params = cars.map(() => P);
  const inputs: InputFrame[] = cars.map(() => ({ steer: 0, brake: false, drift: false }));
  const d = createRivalDrivers(race, seed);
  const n = tr.track.segments.length;
  const times: number[] = [];
  let start = 0;
  const cfg = mistakes
    ? mistakeConfig
    : { ...mistakeConfig, mistakePeriod: [1e9, 1e9, 1e9] as [number, number, number] };
  while (times.length < 3 && race.tick < (3 * 200) / DT) {
    fillRivalInputs(d, race, tr.track, params, cfg, inputs);
    step(race, inputs, tr.track, params);
    if (Math.floor(r.z / n) > times.length) {
      times.push((race.tick - start) * DT);
      start = race.tick;
    }
  }
  return mean(times.slice(1));
}

function part3(io: Io, tr: LoadedTrack, seeds: number): void {
  io.log('## Q3. Rivals');
  const seconds = 180;
  const res: Record<string, ReturnType<typeof rivalsRace>> = {};
  // players: bots as human proxies; the "-grip" ones never drift (a human who does not use drift)
  const players: [string, BotParams][] = [
    ['average', botParams.average],
    ['expert', botParams.expert],
    ['novice', botParams.novice],
    ['average-grip', { ...botParams.average, drift: 'never' }],
  ];
  for (const [nm, bp] of players)
    for (const band of [1, 0] as const) res[`${nm}/${band}`] = rivalsRace(tr, bp, seeds, seconds, band);
  const rows: string[][] = [];
  for (const [nm] of players)
    for (const band of [1, 0] as const) {
      const r = res[`${nm}/${band}`]!;
      for (let i = 0; i < 4; i++) {
        const gr = r.g[i]!;
        const lapsDone = gr.dz / tr.track.segments.length;
        rows.push([
          `${nm}, band ${band ? 'вкл' : 'выкл'}`,
          r.names[i]!,
          pct(gr.drift / gr.ticks),
          f2(gr.entries / lapsDone, 2),
          f2(gr.sp / gr.ticks, 3),
          f2(gr.band / gr.ticks, 3),
          i === 0 ? '1' : f2(gr.pace / gr.n, 3),
        ]);
      }
    }
  io.log(
    `${tr.name}, ${seeds} seeds x ${seconds} s, traffic pool, rivals as the game (R60-R67, mistakes R63c), "player" = the listed bot (noise/reaction as bots.json). Share in DRIFT = ticks in DRIFT / ticks; drifts per lap = GRIP->DRIFT entries / (distance / lap length); pace = mean personal vmax multiplier.`,
  );
  table(
    io,
    ['игрок / band', 'машина', 'доля в DRIFT', 'дрифтов/круг', 'ср. v (vmax)', 'ср. band', 'pace'],
    rows,
  );
  // lead decomposition
  const lead: string[][] = [];
  for (const [nm] of players) {
    const on = res[`${nm}/1`]!;
    const off = res[`${nm}/0`]!;
    const vp = (r: typeof on, i: number): number => r.g[i]!.sp / r.g[i]!.ticks;
    for (let i = 1; i < 4; i++) {
      const total = vp(on, i) / vp(on, 0) - 1;
      const pure = vp(off, i) / vp(off, 0) - 1;
      lead.push([nm, on.names[i]!, pct(pure, 2), pct(total, 2), pct(total - pure, 2)]);
    }
  }
  io.log(
    'Mean-speed lead of a rival over the player bot: pure (band off, H15 B) / total (band on) / band part = total - pure.',
  );
  table(io, ['игрок', 'соперник', 'чистое вождение', 'с band', 'вклад band'], lead);
  // solo laps
  const solo: string[][] = [];
  for (let s = 0; s < 3; s++) {
    const withM = mean([1, 2, 3].map((sd) => soloRival(tr, s, sd, true)));
    const without = mean([1, 2, 3].map((sd) => soloRival(tr, s, sd, false)));
    const bp = [botParams.novice, botParams.average, botParams.expert][s]!;
    const player = mean(
      [1, 2, 3].map((sd) => mean(runLaps(tr.track, bp, P, sd, 3).lapTimes.slice(1))),
    );
    solo.push([
      ['novice', 'average', 'expert'][s]!,
      f2(withM),
      f2(without),
      f2(player),
      pct(withM / without - 1),
    ]);
  }
  io.log(
    'Solo flying laps on an empty road, pace 1, no band (mean of 3 seeds): rival driver with / without mistakes (src/bot/rivals.ts), and the same bot as a player (runBot-like loop, own seed).',
  );
  table(
    io,
    ['уровень', 'соперник с ошибками, с', 'соперник без ошибок, с', 'игрок-бот, с', 'цена ошибок'],
    solo,
  );
}

// ------------------------------------------------------------------------------------ Q4
interface Lever {
  name: string;
  p?: Partial<CarParams>;
  hook?: (p: CarParams) => Hook;
}
const GRIP_A = (p: CarParams): number => p.yawRateMax / (1 + p.yawAlign / p.velGrip);

/** (i) GRIP speed scrub: rate kS*max(0, |A|/GRIP_A - dT) vmax/s while in GRIP. */
function scrub(dT: number, kS: number): (p: CarParams) => Hook {
  return () => ({
    post: (car, _prev, curve, p) => {
      if (car.state !== 'GRIP') return;
      const a = (curve < 0 ? -curve : curve) * (car.speed / p.vmax) * p.kYaw;
      const ex = a / GRIP_A(p) - dT;
      if (ex > 0) {
        car.speed -= kS * ex * p.vmax * DT;
        if (car.speed < 0) car.speed = 0;
      }
    },
  });
}
/** (iii) exit boost: charge |angle|*DT/chargeT in DRIFT; on exit boost for boostT*charge s: cap +B (player band), accel x accelMul. */
function turbo(
  chargeT: number,
  boostT: number,
  B: number,
  accelMul: number,
): (p: CarParams) => Hook {
  return () => {
    let charge = 0;
    let left = 0;
    return {
      pre: (car) => {
        car.band = left > 0 ? B : 0;
      },
      post: (car, prev, _curve, p) => {
        if (car.state === 'DRIFT') {
          const a = car.angle < 0 ? -car.angle : car.angle;
          charge += (a * DT) / chargeT;
          if (charge > 1) charge = 1;
        } else if (prev === 'DRIFT') {
          left = boostT * charge;
          charge = 0;
        }
        if (left > 0) {
          left -= DT;
          const cap = p.vmax * (1 + B);
          car.speed += (accelMul - 1) * p.accel * DT;
          if (car.speed > cap) car.speed = cap;
        }
      },
    };
  };
}

interface Eval {
  lapD: number;
  fD: number;
  driftShare: number;
  entriesLap: number;
  lapG: number; // best clean grip
  mG: number;
  fG: number;
  offG: number;
  lapGany: number; // best finishing grip regardless of road
  mGany: number;
  offGany: number;
  crashGany: number;
}
const GMARG = [0.8, 1.0, 1.2, 1.45, 1.8, 2.4, 3.5];
function evalLever(tr: LoadedTrack, lv: Lever, seeds: number): Eval {
  const p: CarParams = { ...P, ...lv.p };
  const sd = Array.from({ length: seeds }, (_, i) => i + 1);
  const dRuns = sd.map((s) => runLaps(tr.track, EXPERT, p, s, 3, lv.hook?.(p)));
  const ok = (rs: Out[]): boolean => rs.every((r) => r.finished);
  const lapOf = (rs: Out[]): number => mean(rs.map((r) => mean(r.lapTimes.slice(1))));
  const lapsAll = dRuns.reduce((s, r) => s + r.lapTimes.length, 0);
  const ev: Eval = {
    lapD: ok(dRuns) ? lapOf(dRuns) : NaN,
    fD: dRuns.filter((r) => r.finished).length / seeds,
    driftShare:
      dRuns.reduce((s, r) => s + r.driftTicks, 0) / dRuns.reduce((s, r) => s + r.ticks, 0),
    entriesLap: dRuns.reduce((s, r) => s + r.entries, 0) / lapsAll,
    lapG: NaN,
    mG: NaN,
    fG: 0,
    offG: NaN,
    lapGany: NaN,
    mGany: NaN,
    offGany: NaN,
    crashGany: NaN,
  };
  for (const m of GMARG) {
    const rs = sd.map((s) =>
      runLaps(tr.track, { ...EXPERT, drift: 'never', bGripMargin: m }, p, s, 3, lv.hook?.(p)),
    );
    if (!ok(rs)) continue;
    const lap = lapOf(rs);
    const laps = rs.reduce((s, r) => s + r.lapTimes.length, 0);
    const off = rs.reduce((s, r) => s + r.offEvents, 0) / laps;
    const crash = rs.reduce((s, r) => s + r.crashes, 0) / laps;
    const offFrac = rs.reduce((s, r) => s + r.offTicks, 0) / rs.reduce((s, r) => s + r.ticks, 0);
    if (Number.isNaN(ev.lapGany) || lap < ev.lapGany) {
      ev.lapGany = lap;
      ev.mGany = m;
      ev.offGany = off;
      ev.crashGany = crash;
    }
    // clean = no crash, <= 1% of time off the asphalt
    if (crash === 0 && offFrac <= 0.01 && (Number.isNaN(ev.lapG) || lap < ev.lapG)) {
      ev.lapG = lap;
      ev.mG = m;
      ev.offG = off;
      ev.fG = 1;
    }
  }
  return ev;
}

function part4(io: Io, tracks: LoadedTrack[], seeds: number): void {
  io.log('## Q4. Levers');
  const levers: Lever[] = [
    { name: 'today' },
    { name: '(ii) driftSpeedLoss 0.04', p: { driftSpeedLoss: 0.04 } },
    { name: '(ii) driftSpeedLoss 0', p: { driftSpeedLoss: 0 } },
    { name: '(i) scrub dT 0.8 kS 0.3', hook: scrub(0.8, 0.3) },
    { name: '(i) scrub dT 0.8 kS 0.6', hook: scrub(0.8, 0.6) },
    { name: '(i) scrub dT 0.8 kS 1.2', hook: scrub(0.8, 1.2) },
    { name: '(i) scrub dT 0.5 kS 0.3', hook: scrub(0.5, 0.3) },
    { name: '(i) scrub dT 0.5 kS 0.6', hook: scrub(0.5, 0.6) },
    { name: '(i) scrub dT 0.5 kS 1.2', hook: scrub(0.5, 1.2) },
    { name: '(iii) turbo charge 2 s, boost 2 s, +13%', hook: turbo(2, 2, 0.13, 1.6) },
    { name: '(iii) turbo charge 1 s, boost 2 s, +13%', hook: turbo(1, 2, 0.13, 1.6) },
    { name: '(iii) turbo charge 1 s, boost 2 s, +6%', hook: turbo(1, 2, 0.06, 1.6) },
    { name: '(iv) yawRateMax 13', p: { yawRateMax: 13 } },
    { name: '(iv) yawRateMax 11', p: { yawRateMax: 11 } },
    { name: '(iv) yawRateMax 9', p: { yawRateMax: 9 } },
  ];
  const only = argValue(io.argv, 'only');
  for (const tr of tracks) {
    const rows: string[][] = [];
    for (const lv of levers) {
      if (only && !lv.name.includes(only)) continue;
      const e = evalLever(tr, lv, seeds);
      const gap = e.lapG / e.lapD - 1;
      const gapAny = e.lapGany / e.lapD - 1;
      rows.push([
        lv.name,
        f2(e.lapD),
        pct(e.driftShare, 0),
        f2(e.entriesLap, 1),
        Number.isNaN(e.lapG) ? 'нет чистого' : `${f2(e.lapG)} (m ${e.mG})`,
        Number.isNaN(e.lapG) ? '—' : pct(gap),
        `${f2(e.lapGany)} (m ${e.mGany}, выездов ${f2(e.offGany, 1)}/круг, аварий ${f2(e.crashGany, 2)}/круг)`,
        pct(gapAny),
      ]);
    }
    io.log(
      `${tr.name}, expert, ${seeds} seeds x 3 laps (flying laps 2-3). gap = T(grip)/T(drift) - 1; + means drift is faster. "clean" grip = no crash and <= 1% of the time off the asphalt; "any" = fastest of the margin sweep ${GMARG.join(', ')} that finishes, even off the road.`,
    );
    table(
      io,
      [
        'рычаг',
        'drift-эксперт, с',
        'доля DRIFT',
        'дрифтов/круг',
        'grip-эксперт чистый, с',
        'gap чистый',
        'grip-эксперт любой',
        'gap любой',
      ],
      rows,
    );
  }
}

export function main(io: Io): number {
  const part = argValue(io.argv, 'part') ?? 'all';
  const seeds = Number(argValue(io.argv, 'seeds') ?? '4');
  const tracks = loadTracks(io);
  const dr = tracks.find((t) => t.name === 'drift-run')!;
  const tw = tracks.find((t) => t.name === 'test-twisty')!;
  if (part === 'all' || part === '1') part1(io);
  if (part === 'all' || part === '1') timing(io);
  if (part === 'all' || part === '1') lineProbe(io);
  if (part === 'all' || part === '2') part2(io, dr);
  if (part === 'all' || part === '2') holdSweep(io);
  if (part === 'all' || part === '3') part3(io, dr, Number(argValue(io.argv, 'rseeds') ?? '8'));
  if (part === 'all' || part === '4') part4(io, [dr, tw], seeds);
  return 0;
}

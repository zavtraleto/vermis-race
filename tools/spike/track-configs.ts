// THROWAWAY SPIKE (docs/research/track-configurations.md): which corners are drift-only today, and
// what a track layout with more of them does to the bots and the gate. Everything runs through the
// REAL src/sim `step` and the real bots (src/bot/driver.ts, src/bot/run.ts), car src/data/cars/base.json.
// src/, tests and data are not touched; candidate layouts live in this file.
// Run: node tools/run-ts.mjs tools/spike/track-configs.ts [--part 1|2|3|4|5|all] [--seeds N]
import { botInput, createBot, type BotParams } from '../../src/bot/driver';
import { runBot } from '../../src/bot/run';
import { botParams } from '../../src/data/bots';
import { baseCar } from '../../src/data/cars';
import {
  curveClasses,
  expandFigures,
  figureDict,
  parseSections,
  resolveSections,
  type ClassedSection,
  type FigureDef,
  type FigureRef,
} from '../../src/data/tracks';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { CarParams, InputFrame, Track, TrackSection } from '../../src/sim/types';
import { TRAFFIC, loadTracks, summarize, type Entry, type LoadedTrack } from '../botlib';
import { GATE_CONFIG, readGateConfig } from '../gateConfig';
import { argValue, type Io } from '../io';

const P: CarParams = { ...baseCar };
const CLEAN: BotParams = { ...botParams.expert, noiseAmp: 0, reactionDelay: 0 };
const NOVICE = botParams.novice;
const AVERAGE = botParams.average;
const GRIP_A = P.yawRateMax / (1 + P.yawAlign / P.velGrip);
const f2 = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(100 * v).toFixed(d)}%` : '—');
function table(io: Io, head: string[], rows: string[][]): void {
  io.log('| ' + head.join(' | ') + ' |');
  io.log('|' + head.map(() => ' --- ').join('|') + '|');
  for (const r of rows) io.log('| ' + r.join(' | ') + ' |');
  io.log('');
}
/** Sim-equivalent radius: lateral road acceleration A = curve*kYaw (half-widths/s^2) at vmax = 60 seg/s,
 * half-width = 5 segments (road.json halfWidth 1000 / segmentLength 200): R = 60^2/(5*A) segments. */
const radiusSeg = (c: number): number => 3600 / (5 * c * P.kYaw);
const turnDeg = (segCurveSum: number): number =>
  ((segCurveSum * 5 * P.kYaw) / 3600) * (180 / Math.PI);

// ------------------------------------------------------------------------------------ part 1: inventory
function inventory(io: Io, t: LoadedTrack): void {
  const n = t.track.segments.length;
  const by: Record<string, number> = { straight: 0, easy: 0, medium: 0, hard: 0, sharp: 0 };
  for (const s of t.sections) by[s.curveClass]! += s.enter + s.hold + s.leave;
  io.log(
    `### ${t.name}: ${n} segments (${(n / SEG_PER_UNIT).toFixed(1)} s at vmax), ${t.sections.length} sections`,
  );
  io.log('');
  table(
    io,
    ['class', 'curve', 'A at vmax', 'need = A/gripA', 'R, seg', 'segments', 'share of lap'],
    Object.keys(by).map((k) => {
      const c = curveClasses[k as keyof typeof curveClasses];
      return [
        k,
        f2(c, 1),
        f2(c * P.kYaw, 1),
        k === 'straight' ? '0' : f2((c * P.kYaw) / GRIP_A),
        k === 'straight' ? '∞' : f2(radiusSeg(c), 0),
        String(by[k]),
        pct(by[k]! / n),
      ];
    }),
  );
  // corner list (consecutive non-straight sections merged into one corner group)
  const rows: string[][] = [];
  let i = 0;
  let pos = 0;
  while (i < t.sections.length) {
    const s = t.sections[i]!;
    const len = s.enter + s.hold + s.leave;
    if (s.curveClass === 'straight') {
      pos += len;
      i++;
      continue;
    }
    const start = pos;
    const parts: string[] = [];
    let sum = 0;
    let holdHS = 0;
    while (i < t.sections.length && t.sections[i]!.curveClass !== 'straight') {
      const q = t.sections[i]!;
      parts.push(`${q.curveClass}${q.side > 0 ? 'R' : 'L'} ${q.enter}/${q.hold}/${q.leave}`);
      const l = q.enter + q.hold + q.leave;
      for (let k = pos; k < pos + l; k++) sum += Math.abs(t.track.segments[k]!.curve);
      if (q.curveClass === 'hard' || q.curveClass === 'sharp') holdHS = Math.max(holdHS, q.hold);
      pos += l;
      i++;
    }
    rows.push([
      String(start),
      parts.join(' + '),
      String(pos - start),
      f2(turnDeg(sum), 0),
      String(holdHS),
    ]);
  }
  table(
    io,
    [
      'starts at seg',
      'sections (class side enter/hold/leave)',
      'length',
      'turn, deg (sim-equiv.)',
      'longest hard/sharp hold',
    ],
    rows,
  );
}

// ------------------------------------------------------------------------------------ windows
const LEAD = 240;
const TAIL = 300;
interface Win {
  T: number;
  tFig: number;
  vMean: number;
  vMin: number;
  vEnd: number;
  maxX: number;
  offS: number;
  crash: number;
  ok: boolean;
  drift: number;
}
function windowOf(secs: TrackSection[]): {
  track: Track;
  start: number;
  end: number;
  total: number;
} {
  const len = secs.reduce((s, x) => s + x.enter + x.hold + x.leave, 0);
  return {
    track: buildTrack({
      sections: [
        { enter: 0, hold: LEAD, leave: 0, curve: 0 },
        ...secs,
        { enter: 0, hold: TAIL, leave: 0, curve: 0 },
      ],
    }),
    start: LEAD,
    end: LEAD + len,
    total: LEAD + len + TAIL,
  };
}
function runWin(w: ReturnType<typeof windowOf>, bp: BotParams, seed = 1, p: CarParams = P): Win {
  const race = createRace(seed, 1, 0);
  const c = race.cars[0]!;
  c.speed = p.vmax;
  const bot = createBot(seed);
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const o: Win = {
    T: NaN,
    tFig: NaN,
    vMean: 0,
    vMin: Infinity,
    vEnd: NaN,
    maxX: 0,
    offS: 0,
    crash: 0,
    ok: false,
    drift: 0,
  };
  let tS = NaN;
  let tE = NaN;
  let fig = 0;
  let wasCrash = false;
  while (c.z < w.total && race.tick < Math.ceil(90 / DT)) {
    botInput(bot, bp, c, w.track, p, frame);
    step(race, [frame], w.track, [p]);
    const t = race.tick * DT;
    if (Number.isNaN(tS) && c.z >= w.start) tS = t;
    if (Number.isNaN(tE) && c.z >= w.end) {
      tE = t;
      o.vEnd = c.speed / p.vmax;
    }
    const ax = Math.abs(c.x);
    if (ax > o.maxX) o.maxX = ax;
    if (ax > 1) o.offS += DT;
    if (c.z >= w.start && c.z < w.end) {
      fig++;
      const sp = c.speed / p.vmax;
      o.vMean += sp;
      if (sp < o.vMin) o.vMin = sp;
      if (c.state === 'DRIFT') o.drift++;
    }
    if (c.crashTicks > 0 && !wasCrash) o.crash++;
    wasCrash = c.crashTicks > 0;
  }
  const done = c.z >= w.total;
  o.T = done ? race.tick * DT : NaN;
  o.tFig = tE - tS;
  o.vMean = fig ? o.vMean / fig : NaN;
  o.drift = fig ? o.drift / fig : 0;
  o.ok = done && o.crash === 0 && o.maxX <= 1;
  return o;
}
const MARGINS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8, 2.2];
const gripBp = (m: number): BotParams => ({ ...CLEAN, drift: 'never', bGripMargin: m });
function bestGrip(w: ReturnType<typeof windowOf>): { m: number; r: Win } | undefined {
  let best: { m: number; r: Win } | undefined;
  for (const m of MARGINS) {
    const r = runWin(w, gripBp(m));
    if (r.ok && (!best || r.T < best.r.T)) best = { m, r };
  }
  return best;
}
const corner = (c: number, hold: number, e = 30, l = 30): TrackSection[] => [
  { enter: e, hold, leave: l, curve: c },
];

// ------------------------------------------------------------------------------------ part 2: pinned GRIP probe
/** Full inside steer, GRIP only, speed pinned to v*vmax every tick, constant curve c, from x = 0:
 * seconds until |x| > 1 (Infinity = holds 8 s). */
function pinnedGrip(c: number, v: number): number {
  const track = buildTrack({ sections: [{ enter: 0, hold: 20000, leave: 0, curve: c }] });
  const race = createRace(1, 1, 0);
  const car = race.cars[0]!;
  const frame: InputFrame = { steer: 1, brake: false, drift: false };
  for (let k = 0; k < Math.ceil(8 / DT); k++) {
    car.speed = v * P.vmax;
    // full inside steer while outside the centre line, light steer when inside (no inside exits)
    frame.steer = car.x < 0 ? 1 : 0.2;
    step(race, [frame], track, [P]);
    if (car.x < -1) return race.tick * DT; // left the asphalt on the outside (curve > 0 = right)
  }
  return Infinity;
}
function part2(io: Io): void {
  io.log('## Part 2. GRIP limit: full inside steer, speed pinned, constant curve, start x = 0');
  io.log('');
  const curves = [4.5, 6, 7, 8.3, 10, 12, 14, 15.6, 17, 20];
  const vs = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
  const rows: string[][] = [];
  for (const c of curves) {
    let vMax = 0;
    const cells: string[] = [];
    for (const v of vs) {
      const t = pinnedGrip(c, v);
      cells.push(t === Infinity ? 'holds' : `${t.toFixed(1)} s`);
      if (t === Infinity && v > vMax) vMax = v;
    }
    const theory = Math.min(1, GRIP_A / (c * P.kYaw));
    rows.push([
      f2(c, 1),
      f2((c * P.kYaw) / GRIP_A),
      f2(theory, 2),
      vMax ? f2(vMax, 1) : 'none',
      ...cells,
    ]);
  }
  table(
    io,
    [
      'curve',
      'need at vmax',
      'theory v_lim = gripA/(c*kYaw)',
      'measured max v that holds',
      ...vs.map((v) => `v ${v}`),
    ],
    rows,
  );
  io.log(
    `gripA = yawRateMax/(1+yawAlign/velGrip) = ${f2(GRIP_A, 3)}; below yawFullSpeed ${P.yawFullSpeed} the steer authority f = sp/yawFullSpeed falls with speed, so a curve above gripA/(kYaw*yawFullSpeed) = ${f2(GRIP_A / (P.kYaw * P.yawFullSpeed), 1)} cannot be held in GRIP at any speed.`,
  );
  io.log('');
}

// ------------------------------------------------------------------------------------ part 3: corner sweep
function part3(io: Io): void {
  io.log(
    '## Part 3. Corner windows: GRIP vs held DRIFT (empty road, 240 straight + corner (enter 30, leave 30) + 300 straight)',
  );
  io.log('');
  io.log(
    'G* = fastest clean GRIP-only expert (noise 0, margin sweep, never |x| > 1, no crash); N = novice bot (no drift, full throttle, noise as bots.json, seed 1); A = average (drifts); D = expert without noise (held drift). vMean/vMin = speed in the corner (share of vmax). loss = T(G*) - T(D).',
  );
  io.log('');
  const curves = [4.5, 7, 8.3, 10, 12, 14];
  const holds = [60, 120, 240, 480];
  const rows: string[][] = [];
  for (const c of curves) {
    for (const h of holds) {
      const w = windowOf(corner(c, h));
      const g = bestGrip(w);
      const nv = runWin(w, NOVICE);
      const av = runWin(w, AVERAGE);
      const d = runWin(w, CLEAN);
      const loss = g ? g.r.T - d.T : NaN;
      const cls = !g
        ? 'drift-only (no clean GRIP)'
        : g.r.vMin < 0.9 && d.vMin >= 0.9
          ? 'drift-only (GRIP vMin < 0.9)'
          : loss > 0.1
            ? 'drift pays'
            : 'either';
      rows.push([
        `${f2(c, 1)} hold ${h}`,
        g ? `${f2(g.r.T)} / ${f2(g.r.vMean)} / ${f2(g.r.vMin)} (m ${g.m})` : 'none',
        `${f2(nv.T)} / ${f2(nv.vMin)} / x ${f2(nv.maxX)} / off ${f2(nv.offS, 1)} s${nv.crash ? ` / crash ${nv.crash}` : ''}`,
        `${f2(av.T)} / ${f2(av.vMin)} / x ${f2(av.maxX)}${av.ok ? '' : ' (!)'}`,
        `${f2(d.T)} / ${f2(d.vMean)} / ${f2(d.vMin)} / x ${f2(d.maxX)} / ${pct(d.drift, 0)}${d.ok ? '' : ' (!)'}`,
        f2(loss),
        f2(nv.T - d.T),
        cls,
      ]);
    }
  }
  table(
    io,
    [
      'curve, hold',
      'G*: T / vMean / vMin',
      'N: T / vMin / max x / offroad',
      'A: T / vMin / max x',
      'D: T / vMean / vMin / max x / drift share',
      'T(G*)−T(D)',
      'T(N)−T(D)',
      'verdict',
    ],
    rows,
  );
  io.log('(!) = left the asphalt, crashed or did not finish.');
  io.log('');
}

// ------------------------------------------------------------------------------------ candidate figures
/** Candidate new figures (not in src/data); classes only from curves.json. */
const NEW_FIGS: Record<string, FigureDef> = {
  // long full-drift sweeper: sharp held 6 s
  longsharp: { parts: [{ enter: 40, hold: 360, leave: 40, curveClass: 'sharp', side: 1 }] },
  // hard carousel tightening to sharp without a break, long
  tighten2: {
    parts: [
      { enter: 40, hold: 180, leave: 0, curveClass: 'hard', side: 1 },
      { enter: 0, hold: 200, leave: 35, curveClass: 'sharp', side: 1 },
    ],
  },
  // drift transfer: long sharp left, flick straight into long hard right (no straight)
  transfer: {
    parts: [
      { enter: 40, hold: 200, leave: 15, curveClass: 'sharp', side: 1 },
      { enter: 15, hold: 200, leave: 40, curveClass: 'hard', side: -1 },
    ],
  },
  // horseshoe: hard - sharp - hard, all one side, one long held drift with changing angle
  horseshoe: {
    parts: [
      { enter: 40, hold: 120, leave: 0, curveClass: 'hard', side: 1 },
      { enter: 0, hold: 160, leave: 0, curveClass: 'sharp', side: 1 },
      { enter: 0, hold: 120, leave: 35, curveClass: 'hard', side: 1 },
    ],
  },
  // fake straight: medium then sharp hook hidden at the end (late apex)
  latehook: {
    parts: [
      { enter: 30, hold: 120, leave: 0, curveClass: 'medium', side: 1 },
      { enter: 0, hold: 160, leave: 30, curveClass: 'sharp', side: 1 },
    ],
  },
  // triple switch: three long hard/sharp arcs alternating sides, short transfers
  snake: {
    parts: [
      { enter: 40, hold: 160, leave: 15, curveClass: 'hard', side: 1 },
      { enter: 15, hold: 160, leave: 15, curveClass: 'sharp', side: -1 },
      { enter: 15, hold: 160, leave: 40, curveClass: 'hard', side: 1 },
    ],
  },
};
const DICT: Record<string, FigureDef> = { ...figureDict, ...NEW_FIGS };
function figWindow(name: string): ReturnType<typeof windowOf> {
  const secs = expandFigures([{ figure: name, side: 1 }], DICT);
  return windowOf(resolveSections(parseSections(secs), curveClasses).sections);
}
function part4(io: Io): void {
  io.log('## Part 4. Figures (existing + candidates), same window and drivers as part 3');
  io.log('');
  const names = [...Object.keys(figureDict), ...Object.keys(NEW_FIGS)];
  const rows: string[][] = [];
  for (const nm of names) {
    const w = figWindow(nm);
    const g = bestGrip(w);
    const nv = runWin(w, NOVICE);
    const av = runWin(w, AVERAGE);
    const d = runWin(w, CLEAN);
    const loss = g ? g.r.T - d.T : NaN;
    const cls = !g
      ? 'drift-only (no clean GRIP)'
      : g.r.vMin < 0.9 && d.vMin >= 0.9
        ? 'drift-only (GRIP vMin < 0.9)'
        : loss > 0.1
          ? 'drift pays'
          : 'either';
    rows.push([
      nm + (NEW_FIGS[nm] ? ' (new)' : ''),
      String(w.end - w.start),
      g ? `${f2(g.r.T)} / ${f2(g.r.vMin)} (m ${g.m})` : 'none',
      `${f2(nv.T)} / ${f2(nv.vMin)} / off ${f2(nv.offS, 1)} s${nv.crash ? ` / crash ${nv.crash}` : ''}`,
      `${f2(av.T)} / ${f2(av.vMin)}${av.ok ? '' : ' (!)'}`,
      `${f2(d.T)} / ${f2(d.vMin)} / x ${f2(d.maxX)}${d.ok ? '' : ' (!)'}`,
      f2(loss),
      f2(nv.T - d.T),
      f2(av.T - d.T),
      cls,
    ]);
  }
  table(
    io,
    [
      'figure',
      'segments',
      'G*: T / vMin',
      'N: T / vMin / offroad',
      'A: T / vMin',
      'D: T / vMin / max x',
      'T(G*)−T(D)',
      'T(N)−T(D)',
      'T(A)−T(D)',
      'verdict',
    ],
    rows,
  );
}

// ------------------------------------------------------------------------------------ part 5: full laps + gate
const CANDIDATE: { name: string; figures: FigureRef[] } = {
  name: 'drift-run-b',
  figures: [
    { figure: 'straight', side: 1 },
    { figure: 'kink', side: 1, hill: 20 },
    { figure: 'sweeper', side: -1, hill: -20 },
    { figure: 'hairpin', side: 1, hill: 30 },
    { figure: 'straight', side: 1, hill: -30 },
    { figure: 'horseshoe', side: -1, hill: 40 },
    { figure: 'straight', side: 1 },
    { figure: 'scurve', side: 1, hill: -40 },
    { figure: 'straight', side: 1 },
    { figure: 'longsharp', side: 1, hill: 30 },
    { figure: 'kink', side: -1 },
    { figure: 'transfer', side: -1, hill: -30 },
    { figure: 'straight', side: 1 },
    { figure: 'straight', side: 1 },
    { figure: 'tighten2', side: 1, hill: 50 },
    { figure: 'straight', side: 1 },
    { figure: 'snake', side: -1, hill: -50 },
    { figure: 'straight', side: 1 },
    { figure: 'latehook', side: 1, hill: 40 },
    { figure: 'flick', side: -1, hill: -40 },
    { figure: 'straight', side: 1 },
    { figure: 'switchback', side: 1, hill: 60 },
    { figure: 'straight', side: 1 },
    { figure: 'spiral', side: -1, hill: -60 },
    { figure: 'kink', side: 1 },
    { figure: 'straight', side: 1 },
    { figure: 'straight', side: 1 },
  ],
};
/** Revised drift-run that keeps R31b: >= 24 figures, the first third teaches (straights, kink,
 * sweeper, one hairpin), drift-needed share of corner length 45-65%, straights between groups. */
const CANDIDATE2: { name: string; figures: FigureRef[] } = {
  name: 'drift-run-v2',
  figures: [
    { figure: 'straight', side: 1 },
    { figure: 'kink', side: 1, hill: 20 },
    { figure: 'sweeper', side: -1, hill: -20 },
    { figure: 'straight', side: 1 },
    { figure: 'hairpin', side: 1, hill: 30 },
    { figure: 'sweeper', side: 1, hill: -30 },
    { figure: 'straight', side: 1 },
    { figure: 'sweeper', side: -1 },
    { figure: 'straight', side: 1 },
    { figure: 'longsharp', side: 1, hill: 40 },
    { figure: 'kink', side: -1 },
    { figure: 'sweeper', side: -1, hill: -40 },
    { figure: 'straight', side: 1 },
    { figure: 'transfer', side: -1, hill: 30 },
    { figure: 'straight', side: 1 },
    { figure: 'tighten2', side: 1, hill: -30 },
    { figure: 'sweeper', side: -1 },
    { figure: 'straight', side: 1 },
    { figure: 'horseshoe', side: -1, hill: 50 },
    { figure: 'kink', side: 1 },
    { figure: 'esses', side: 1, hill: -50 },
    { figure: 'straight', side: 1 },
    { figure: 'longsharp', side: -1, hill: 60 },
    { figure: 'straight', side: 1 },
    { figure: 'snake', side: 1, hill: -60 },
    { figure: 'straight', side: 1 },
    { figure: 'spiral', side: 1 },
    { figure: 'straight', side: 1 },
    { figure: 'straight', side: 1 },
  ],
};
function r31bShare(t: LoadedTrack): number {
  let corners = 0;
  let drift = 0;
  for (const q of t.sections) {
    const l = q.enter + q.hold + q.leave;
    if (q.curveClass === 'straight') continue;
    corners += l;
    if (q.curveClass === 'hard' || q.curveClass === 'sharp') drift += l;
  }
  return drift / corners;
}
function part6(io: Io, seeds: number): void {
  const m = readGateConfig(io.read(GATE_CONFIG)).measure;
  const tracks = [
    ...loadTracks(io).filter((t) => t.name === 'drift-run'),
    loadCandidate(CANDIDATE2),
  ];
  io.log(
    `## Part 6. With the traffic pool (src/data/traffic.json), ${seeds} seeds x ${m.laps} laps`,
  );
  io.log('');
  const rows: string[][] = [];
  for (const t of tracks) {
    const lap: Record<string, number> = {};
    for (const b of ['novice', 'average', 'expert'] as const) {
      const runs = [];
      for (let s = 1; s <= seeds; s++)
        runs.push(runBot(botParams[b], P, t.track, t.sections, s, m, TRAFFIC));
      const e = summarize(b, t, runs, m);
      lap[b] = e.lapTime.mean;
      let bumps = 0;
      let inDrift = 0;
      for (const r of runs) {
        bumps += r.traffic?.bumps ?? 0;
        inDrift += r.traffic?.bumpsInDrift ?? 0;
      }
      const laps = seeds * m.laps;
      rows.push([
        t.name,
        b,
        f2(e.lapTime.mean),
        f2(bumps / laps),
        f2(inDrift / laps),
        f2(e.crashesPerLap),
      ]);
    }
    rows.push([
      t.name,
      'gaps',
      `drift-required ${pct((lap.novice! - lap.average!) / lap.novice!)}, expert-gap ${pct((lap.average! - lap.expert!) / lap.average!)}`,
      '',
      '',
      '',
    ]);
  }
  table(io, ['track', 'bot', 'lap, s', 'bumps/lap', 'bumps in drift/lap', 'crashes/lap'], rows);
}
function loadCandidate(c: { name: string; figures: FigureRef[] }): LoadedTrack {
  const sections: ClassedSection[] = parseSections(expandFigures(c.figures, DICT));
  return { name: c.name, sections, track: buildTrack(resolveSections(sections, curveClasses)) };
}
function shareDriftOnly(t: LoadedTrack): number {
  // segments of hard/sharp sections with hold >= 150 (hard) / 90 (sharp): drift-only today (part 3)
  let s = 0;
  for (const q of t.sections) {
    if ((q.curveClass === 'hard' && q.hold >= 150) || (q.curveClass === 'sharp' && q.hold >= 90))
      s += q.enter + q.hold + q.leave;
  }
  return s / t.track.segments.length;
}
function part5(io: Io, seeds: number): void {
  const cfg = readGateConfig(io.read(GATE_CONFIG));
  const m = cfg.measure;
  const tracks = [
    ...loadTracks(io).filter((t) => t.name === 'drift-run' || t.name === 'test-twisty'),
    loadCandidate(CANDIDATE),
    loadCandidate(CANDIDATE2),
  ];
  io.log(
    `## Part 5. Full laps, ${seeds} seeds x ${m.laps} laps, no traffic (as npm run bot / gate)`,
  );
  io.log('');
  const rows: string[][] = [];
  const gate: string[][] = [];
  for (const t of tracks) {
    const e: Record<string, Entry> = {};
    for (const b of ['novice', 'average', 'expert'] as const) {
      const runs = [];
      for (let s = 1; s <= seeds; s++)
        runs.push(runBot(botParams[b], P, t.track, t.sections, s, m));
      e[b] = summarize(b, t, runs, m);
      const x = e[b];
      rows.push([
        t.name,
        b,
        f2(x.lapTime.mean),
        pct(x.driftFraction),
        pct(x.offroadFraction),
        f2(x.offroadEventsPerLap.hard),
        f2(x.offroadEventsPerLap.sharp),
        f2(x.speed.longHardMin ?? NaN),
        String(x.wallHits.total),
        f2(x.crashesPerLap),
        `${x.finishedFraction * x.runs}/${x.runs}`,
      ]);
    }
    const nv = e.novice!.lapTime.mean;
    const av = e.average!.lapTime.mean;
    const ex = e.expert!.lapTime.mean;
    gate.push([
      t.name,
      String(t.track.segments.length),
      pct(shareDriftOnly(t)) + ' / R31b ' + pct(r31bShare(t)),
      pct((nv - av) / nv) + ((nv - av) / nv >= 0.15 ? ' PASS' : ' FAIL'),
      pct((av - ex) / av) + ((av - ex) / av >= 0.03 && (av - ex) / av <= 0.15 ? ' PASS' : ' FAIL'),
      f2(e.novice!.offroadEventsPerLap.hard) +
        (e.novice!.offroadEventsPerLap.hard >= 1 ? ' PASS' : ' FAIL'),
      pct(e.expert!.driftFraction) +
        (e.expert!.driftFraction >= 0.4 && e.expert!.driftFraction <= 0.9 ? ' PASS' : ' FAIL'),
      pct(e.average!.driftFraction) + (e.average!.driftFraction >= 0.3 ? ' PASS' : ' FAIL'),
      pct(e.expert!.offroadFraction) + (e.expert!.offroadFraction <= 0.02 ? ' PASS' : ' FAIL'),
      f2(e.expert!.speed.longHardMin ?? NaN) +
        ((e.expert!.speed.longHardMin ?? 1) >= 0.95 ? ' PASS' : ' FAIL'),
      pct(e.average!.offroadFraction) + (e.average!.offroadFraction <= 0.05 ? ' PASS' : ' FAIL'),
      `${e.average!.wallHits.total + e.expert!.wallHits.total}`,
    ]);
  }
  table(
    io,
    [
      'track',
      'bot',
      'lap, s',
      'drift share',
      'offroad time',
      'offroad ev/lap hard',
      'sharp',
      'longHardMin',
      'walls',
      'crashes/lap',
      'finished',
    ],
    rows,
  );
  table(
    io,
    [
      'track',
      'segments',
      'drift-only share (hard hold>=150, sharp hold>=90)',
      'drift-required ≥15%',
      'expert-gap 3–15%',
      'novice-offroad-hard ≥1',
      'expert-drift-used 40–90%',
      'average-drift-used ≥30%',
      'expert-offroad ≤2%',
      'expert-drift-holds-speed ≥0.95',
      'average-offroad ≤5%',
      'walls avg+exp',
    ],
    gate,
  );
}

export function main(io: Io): number {
  const part = argValue(io.argv, 'part') ?? 'all';
  const seeds = Number(argValue(io.argv, 'seeds') ?? '5');
  if (part === '1' || part === 'all') {
    io.log('## Part 1. Inventory');
    io.log('');
    for (const t of loadTracks(io))
      if (t.name === 'drift-run' || t.name === 'test-twisty') inventory(io, t);
    inventory(io, loadCandidate(CANDIDATE));
    inventory(io, loadCandidate(CANDIDATE2));
  }
  if (part === '2' || part === 'all') part2(io);
  if (part === '3' || part === 'all') part3(io);
  if (part === '4' || part === 'all') part4(io);
  if (part === '5' || part === 'all') part5(io, seeds);
  if (part === 'json') io.log(JSON.stringify({ v2: CANDIDATE2, figures: NEW_FIGS }, null, 2));
  if (part === '6' || part === 'all') part6(io, seeds);
  return 0;
}

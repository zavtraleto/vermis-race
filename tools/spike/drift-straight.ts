// THROWAWAY SPIKE (docs/research/drift-straight.md): "on the straight I can keep drifting and drive
// straight" (author, 2026-11-21). Decision: the drift always turns, and on a straight it brakes.
// Proto rules (emulated as wrappers around the REAL src/sim `step`; production code untouched):
//   R80b support: sup in [0, 1] from the road under / around the car toward dir.
//   R86g brake:   in DRIFT, accel below the cap x sup, and speed -= driftSlow*(1 - sup)*vmax*DT.
//   R83d turn:    in DRIFT, velT += dir*driftTurn*(1 - sup) (before the R84 vel chase).
// Run: node tools/run-ts.mjs tools/spike/drift-straight.ts [--part a|b|c|d|e|f|g|h|all]
import { botInput, createBot, type BotParams } from '../../src/bot/driver';
import { botParams } from '../../src/data/bots';
import { baseCar } from '../../src/data/cars';
import sprites from '../../src/data/sprites.json';
import driftRun from '../../src/data/tracks/drift-run.json';
import twisty from '../../src/data/tracks/test-twisty.json';
import {
  curveClasses,
  expandFigures,
  figureDict,
  parseSections,
  resolveSections,
  trackSections,
  type ClassedSection,
} from '../../src/data/tracks';
import { bodyYawDeg } from '../../src/render/carWeight';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, Track } from '../../src/sim/types';
import { argValue, type Io } from '../io';

const C = curveClasses as Record<string, number>;
const SW = (
  sprites as unknown as {
    weight: { slipDeg: number; velDeg: number; leadDeg: number; minSpeed: number };
  }
).weight;
const P0: CarParams = { ...baseCar, driftTurbo: 0, driftEntry: 3 };
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pc = (v: number, d = 2): string =>
  Number.isFinite(v) ? (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%' : '—';
function table(io: Io, head: string[], rows: string[][]): void {
  io.log('| ' + head.join(' | ') + ' |');
  io.log('|' + head.map(() => ' --- ').join('|') + '|');
  for (const r of rows) io.log('| ' + r.join(' | ') + ' |');
  io.log('');
}

// ---------------------------------------------------------------- proto rule
interface Rule {
  supLo: number; // curve toward dir at which support starts (> 0)
  supHi: number; // curve toward dir of full support
  supLook: number; // s of road ahead, weight 1 -> 0
  supTail: number; // s of road behind, weight 1 -> 0
  driftSlow: number; // vmax/s at sup 0 (0 = R86g off)
  driftTurn: number; // half-widths/s of extra inward target at sup 0 (0 = R83d off)
  turnRamp?: boolean; // R83d grows in with the R85d ramp
}
const OFF: Rule = { supLo: 2, supHi: 4.5, supLook: 0.35, supTail: 0.5, driftSlow: 0, driftTurn: 0 };
const ON: Rule = { ...OFF, driftSlow: 0.1, driftTurn: 0.3, turnRamp: true };

function supShare(c: number, r: Rule): number {
  const s = (c - r.supLo) / (r.supHi - r.supLo);
  return s < 0 ? 0 : s > 1 ? 1 : s;
}
/** R80b: sup = max over seg-kb..seg+ka of share(curve*dir)*w, w linear 1 -> 0 over each window. */
export function support(tr: Track, seg: number, dir: number, sp: number, r: Rule): number {
  const segs = tr.segments;
  const n = segs.length;
  let best = supShare(segs[seg]!.curve * dir, r);
  const ka = Math.ceil(sp * SEG_PER_UNIT * r.supLook);
  const kb = Math.ceil(sp * SEG_PER_UNIT * r.supTail);
  let j = seg;
  for (let d = 1; d <= ka && best < 1; d++) {
    j = j + 1 >= n ? 0 : j + 1;
    const v = supShare(segs[j]!.curve * dir, r) * (1 - d / (ka + 1));
    if (v > best) best = v;
  }
  j = seg;
  for (let d = 1; d <= kb && best < 1; d++) {
    j = j - 1 < 0 ? n - 1 : j - 1;
    const v = supShare(segs[j]!.curve * dir, r) * (1 - d / (kb + 1));
    if (v > best) best = v;
  }
  return best;
}

/** One tick: real step + the proto rule as a wrapper. Single player car, no flow, no turbo. */
function tick(
  race: ReturnType<typeof createRace>,
  fr: InputFrame,
  tr: Track,
  p: CarParams,
  r: Rule,
): number {
  const car = race.cars[0]!;
  const n = tr.segments.length;
  const seg0 = Math.floor(car.z) % n;
  const s0 = car.speed;
  const sp = s0 / p.vmax;
  step(race, [fr], tr, [p]);
  if (car.state !== 'DRIFT' || car.crashTicks > 0) return 1;
  const sup = support(tr, seg0, car.dir, sp, r);
  const u = 1 - sup;
  if (u <= 0) return sup;
  if (r.driftTurn !== 0) {
    // R83d: the extra velT enters vel through the R84 chase of this tick (no wall in these runs)
    // R85d ramp (driftTicks before R87 added 1): the extra turn grows in with the lead
    let ramp = 1;
    if (r.turnRamp && p.leadRamp > 0) ramp = Math.min(1, ((car.driftTicks - 1) * DT) / p.leadRamp);
    const dv = r.driftTurn * car.dir * u * ramp * (1 - Math.exp(-p.velGripDrift * DT));
    car.vel += dv;
    car.yaw += dv;
    car.x += dv * sp * p.latScale * DT;
    car.vx += dv * sp * p.latScale;
  }
  if (r.driftSlow !== 0) {
    // R86g: redo R86 for DRIFT (cap = vmax: player, no flow, no turbo, driftSpeedLoss 0) then R15
    const cap = p.vmax;
    let v: number;
    if (fr.brake) v = s0 - p.brake * DT;
    else if (s0 > cap) v = Math.max(cap, s0 - p.driftBrake * DT);
    else v = Math.min(cap, s0 + p.accel * sup * DT);
    v -= r.driftSlow * u * p.vmax * DT;
    if (v < 0) v = 0;
    if (car.x > 1 || car.x < -1) v *= Math.pow(p.offroadMul, 60 * DT);
    car.speed = v;
  }
  return sup;
}

// ---------------------------------------------------------------- tracks
function secTrack(secs: ClassedSection[]): { track: Track; len: number } {
  const len = secs.reduce((s, x) => s + x.enter + x.hold + x.leave, 0);
  return { track: buildTrack(resolveSections(parseSections(secs), curveClasses)), len };
}
const st = (len: number): ClassedSection => ({
  enter: 0,
  hold: len,
  leave: 0,
  curveClass: 'straight',
  side: 1,
});
const cs = (cls: string, hold: number, side = 1, ramp = 30): ClassedSection => ({
  enter: ramp,
  hold,
  leave: ramp,
  curveClass: cls as ClassedSection['curveClass'],
  side: side as 1 | -1,
});
const body = (c: Car, p: CarParams): number =>
  bodyYawDeg(c.yaw, c.vel, c.carry, c.vx, c.speed / p.vmax, p.latScale, SW);
const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  crashMinSpeed: 1e9,
});

// ---------------------------------------------------------------- (a) drift on a straight
function partA(io: Io): void {
  io.log(
    '## (a) Дрифт на прямой из центра, `vmax`, вход с рулём +1 на тике 0, дальше руль удержан',
  );
  const tr = secTrack([st(20000)]).track;
  for (const steer of [0, 1]) {
    const rows: string[][] = [];
    for (const [name, r] of [
      ['до', OFF],
      ['после', ON],
    ] as const) {
      const race = createRace(1, 1);
      const c = race.cars[0]!;
      c.speed = P0.vmax;
      c.z = 100;
      const p = free(P0);
      const fr: InputFrame = { steer: 1, brake: false, drift: true };
      let edge = NaN;
      let exit = NaN;
      const at: Record<number, string> = {};
      for (let i = 1; i <= 12 / DT; i++) {
        fr.steer = i === 1 ? 1 : steer;
        tick(race, fr, tr, p, r);
        const t = i * DT;
        if (Number.isNaN(edge) && c.x >= 1) edge = t;
        if (Number.isNaN(exit) && c.state !== 'DRIFT') exit = t;
        for (const T of [0.5, 1, 2, 3, 4]) {
          if (Math.abs(t - T) < DT / 2)
            at[T] = `${f(c.x, 2)} / ${f(c.speed, 3)} / ${f(body(c, p), 1)}°`;
        }
      }
      rows.push([name, at[0.5]!, at[1]!, at[2]!, at[3]!, at[4]!, f(edge, 2), f(exit, 2)]);
    }
    io.log(`руль ${steer === 0 ? '0 (пол R83b)' : '1'}; ячейки: x / скорость / угол кузова`);
    table(
      io,
      ['', '0.5 с', '1 с', '2 с', '3 с', '4 с', 'край x=1, с', 'выход R82 по скорости, с'],
      rows,
    );
  }
  // auto exit by speed with the real edge (offroad R15 on) — straight, finger held, steer 0
  const rows: string[][] = [];
  for (const [name, r] of [
    ['до', OFF],
    ['после', ON],
  ] as const) {
    for (const edgeOn of [false, true]) {
      const race = createRace(1, 1);
      const c = race.cars[0]!;
      c.speed = P0.vmax;
      c.z = 100;
      const p = edgeOn ? { ...P0, crashMinSpeed: 1e9 } : free(P0);
      const fr: InputFrame = { steer: 1, brake: false, drift: true };
      let exit = NaN;
      for (let i = 1; i <= 20 / DT; i++) {
        fr.steer = i === 1 ? 1 : 0;
        tick(race, fr, tr, p, r);
        if (c.state !== 'DRIFT') {
          exit = i * DT;
          break;
        }
      }
      rows.push([name, edgeOn ? 'обочина R15 и стена `xLimit`' : 'дорога без края', f(exit, 2)]);
    }
  }
  io.log('Выход R82 по скорости (`driftExitSpeed` 0.3) при удержании на прямой, руль 0:');
  table(io, ['', 'дорога', 'через, с'], rows);
}

// ---------------------------------------------------------------- (b) late release after a corner
/** Corner of class cls (30/hold/30) toward +1 from vmax, drift from the corner start; release
 * `late` s after the end of the leave ramp (negative = before). Returns time to z goal. */
function exitRun(
  p: CarParams,
  r: Rule,
  cls: string,
  hold: number,
  late: number,
  after: ClassedSection[] = [st(1200)],
  steerLate = 0,
): { T: number; vMin: number; xMax: number; xAtRel: number; vAtRel: number } {
  const pre = 120;
  const { track, len } = secTrack([st(pre), cs(cls, hold), ...after]);
  const race = createRace(1, 1);
  const c = race.cars[0]!;
  c.speed = p.vmax;
  c.z = pre - 60;
  const zEnd = pre + 30 + hold + 30;
  const goal = len - 10;
  const fr: InputFrame = { steer: 0, brake: false, drift: false };
  let tEnd = NaN;
  let released = false;
  let vMin = 9;
  let xMax = 0;
  let xAtRel = NaN;
  let vAtRel = NaN;
  for (let i = 0; i < 60 / DT; i++) {
    const t = i * DT;
    if (c.z >= goal) return { T: t, vMin, xMax, xAtRel, vAtRel };
    if (Number.isNaN(tEnd) && c.z >= zEnd) tEnd = t;
    const zRel = pre + 30 + hold + 30 + late * 60; // late < 0: release before the end (vmax segs)
    const relNow = late < 0 ? c.z >= zRel : !Number.isNaN(tEnd) && t >= tEnd + late;
    if (relNow && !released) {
      released = true;
      xAtRel = c.x;
      vAtRel = c.speed;
    }
    if (c.z >= pre) {
      if (!released) {
        fr.drift = true;
        if (c.state !== 'DRIFT') fr.steer = 1;
        else if (Number.isNaN(tEnd) || late < 0) {
          // corner: hold line x = 0.3 inside by a feedback steer
          const s = 0.75 + 0.8 * (0.3 - c.x) - 0.3 * c.vx;
          fr.steer = Math.max(-1, Math.min(1, s));
        } else fr.steer = steerLate; // after the corner: finger held, steer at the floor
      } else {
        fr.drift = false;
        const s = 1.5 * (0 - c.x) - 0.4 * c.vx;
        fr.steer = Math.max(-1, Math.min(1, s));
      }
    }
    tick(race, fr, track, p, r);
    if (released) {
      if (c.speed < vMin) vMin = c.speed;
    }
    if (!Number.isNaN(tEnd) && c.x > xMax) xMax = c.x;
  }
  return { T: NaN, vMin, xMax, xAtRel, vAtRel };
}
function partB(io: Io): void {
  io.log(
    '## (б) Выход из поворота на прямую: удержание после конца фигуры (30/240/30) и отпускание',
  );
  io.log(
    'Потеря — время до точки через 1200 сегм. после фигуры против отпускания ровно на конце фигуры; x на отпускании (внутрь +); скорость на отпускании.',
  );
  const p = free(P0);
  for (const cls of ['medium', 'hard', 'sharp']) {
    const rows: string[][] = [];
    for (const [name, r] of [
      ['до', OFF],
      ['после', ON],
    ] as const) {
      const base = exitRun(p, r, cls, 240, 0);
      for (const late of [-0.25, 0, 0.3, 1, 2]) {
        const o = exitRun(p, r, cls, 240, late);
        rows.push([
          name,
          f(late, 2),
          f(o.T - base.T, 3),
          pc((o.T - base.T) / base.T, 2),
          f(o.xAtRel, 2),
          f(o.vAtRel, 3),
          f(o.xMax, 2),
        ]);
      }
    }
    io.log(`### ${cls}`);
    table(
      io,
      [
        '',
        'удержание после конца, с',
        'ΔT, с',
        'ΔT к участку',
        'x на отпускании',
        'скорость на отпускании',
        'max x после конца',
      ],
      rows,
    );
  }
}

// ---------------------------------------------------------------- (c) laps with a late bot
function lapRun(track: Track, p: CarParams, r: Rule, bp: BotParams, late: number, laps = 3) {
  const race = createRace(1, 1);
  const c = race.cars[0]!;
  c.speed = 0;
  const fr: InputFrame = { steer: 0, brake: false, drift: false };
  const bot = createBot(1);
  const n = track.segments.length;
  const lapT: number[] = [];
  let lapStart = 0;
  let off = 0;
  let crash = 0;
  let wasCrash = false;
  let lateT = -1;
  let driftT = 0;
  let unsupT = 0;
  let slowExit = 0;
  const maxT = Math.ceil((laps * 250) / DT);
  while (c.z < laps * n && race.tick < maxT) {
    botInput(bot, bp, c, track, p, fr);
    if (c.state === 'DRIFT' && !fr.drift) {
      if (lateT < 0) lateT = 0;
      if (lateT < late) {
        fr.drift = true;
        lateT += DT;
      }
    } else if (c.state !== 'DRIFT') lateT = -1;
    const wasDrift = c.state === 'DRIFT';
    const sup = tick(race, fr, track, p, r);
    if (c.state === 'DRIFT') {
      driftT += DT;
      unsupT += (1 - sup) * DT;
    }
    if (wasDrift && c.state !== 'DRIFT' && fr.drift) slowExit++;
    if (Math.abs(c.x) > 1) off++;
    if (c.crashTicks > 0 && !wasCrash) crash++;
    wasCrash = c.crashTicks > 0;
    if (Math.floor(c.z / n) > lapT.length) {
      lapT.push((race.tick - lapStart) * DT);
      lapStart = race.tick;
    }
  }
  const fly = lapT.slice(1);
  return {
    T: fly.length ? fly.reduce((s, x) => s + x, 0) / fly.length : NaN,
    off: off / Math.max(1, race.tick),
    crash,
    unsup: driftT > 0 ? unsupT / laps : 0,
    slowExit,
  };
}
function lapTrack(raw: unknown): Track {
  return buildTrack(
    resolveSections(trackSections(raw as { figures?: unknown; sections?: unknown }), curveClasses),
  );
}
function partC(io: Io): void {
  io.log(
    '## (в) Круг: бот `expert` без шума и `average` (как есть), запаздывание отпускания 0 / 0.3 / 1 с на каждом выходе',
  );
  io.log(
    'Средний летящий круг 2–3; «вне опоры» — ∫(1 − sup) dt в дрифте за круг; обочина — доля тиков |x| > 1.',
  );
  const clean: BotParams = { ...botParams.expert, noiseAmp: 0, reactionDelay: 0 };
  for (const [tn, raw] of [
    ['drift-run', driftRun],
    ['test-twisty', twisty],
  ] as const) {
    const track = lapTrack(raw);
    const rows: string[][] = [];
    for (const [bn, bp] of [
      ['expert (чистый)', clean],
      ['average', botParams.average],
    ] as const) {
      for (const [name, r] of [
        ['до', OFF],
        ['после', ON],
      ] as const) {
        const b = lapRun(track, P0, r, bp, 0);
        for (const late of [0, 0.3, 1]) {
          const o = late === 0 ? b : lapRun(track, P0, r, bp, late);
          rows.push([
            bn,
            name,
            f(late, 1),
            f(o.T, 2),
            pc(o.T / b.T - 1, 2),
            f(o.unsup, 2),
            pc(o.off, 2),
            String(o.crash),
            String(o.slowExit),
          ]);
        }
      }
    }
    io.log(`### ${tn}`);
    table(
      io,
      [
        'бот',
        '',
        'запаздывание, с',
        'круг, с',
        'к запаздыванию 0',
        'вне опоры, с/круг',
        'обочина',
        'аварий',
        'выходов по скорости',
      ],
      rows,
    );
  }
}

// ---------------------------------------------------------------- (d) tap-drift
// (d1) tests/sim/modelb_tapdrift_r86e.test.ts windows (expert, no noise; pinned T70 numbers as the test,
// and today's base); (d2) the chain of tests/sim/modelb_auto_criteria.test.ts (f) re-done on variant 3
// (the chain in a corner from the first tick of the corner).
const T70 = { driftSpeedLoss: 0.08, debtTime: 0.5, gripDodge: 0.45 };
const MARGINS = [0.8, 1.0, 1.2, 1.45, 1.8, 2.4, 3.5];
interface Tap {
  periodS: number;
  tapS: number;
}
function tapWindow(fig: ClassedSection[]) {
  const secs = [st(240), ...fig, st(300)];
  const len = secs.reduce((s, x) => s + x.enter + x.hold + x.leave, 0);
  return { track: buildTrack(resolveSections(parseSections(secs), curveClasses)), total: len };
}
function tapDrive(
  track: Track,
  p: CarParams,
  r: Rule,
  bp: BotParams,
  tap: Tap | null,
  total: number,
) {
  const race = createRace(1, 1);
  const c = race.cars[0]!;
  c.speed = p.vmax;
  const fr: InputFrame = { steer: 0, brake: false, drift: false };
  const bot = createBot(1);
  let tapT = Infinity;
  let since = Infinity;
  let off = 0;
  let crash = 0;
  let wasCrash = false;
  let entries = 0;
  let wasDrift = false;
  let unsup = 0;
  while (c.z < total && race.tick < 60 / DT) {
    botInput(bot, bp, c, track, p, fr);
    if (tap) {
      const want = Math.abs(fr.steer) >= 0.5;
      since += DT;
      tapT += DT;
      if (want && since >= tap.periodS) {
        since = 0;
        tapT = 0;
      }
      fr.drift = tapT < tap.tapS;
      if (fr.drift || want) fr.steer = fr.steer > 0 ? 1 : -1;
    }
    const sup = tick(race, fr, track, p, r);
    if (Math.abs(c.x) > 1) off++;
    if (c.crashTicks > 0 && !wasCrash) crash++;
    wasCrash = c.crashTicks > 0;
    const dr = c.state === 'DRIFT';
    if (dr) unsup += (1 - sup) * DT;
    if (dr && !wasDrift) entries++;
    wasDrift = dr;
  }
  const done = c.z >= total;
  return {
    T: done ? race.tick * DT : NaN,
    ok: done && crash === 0 && off / race.tick <= 0.01,
    entries,
    unsup,
  };
}
function bestGrip(track: Track, p: CarParams, r: Rule, tap: Tap | null, total: number) {
  const clean: BotParams = { ...botParams.expert, noiseAmp: 0, reactionDelay: 0 };
  let best: ReturnType<typeof tapDrive> | null = null;
  for (const m of MARGINS) {
    const o = tapDrive(track, p, r, { ...clean, drift: 'never', bGripMargin: m }, tap, total);
    if (o.ok && (!best || o.T < best.T)) best = o;
  }
  return best;
}
const WINDOWS: [string, ClassedSection[]][] = [
  ['hard 120', [cs('hard', 120)]],
  ['hard 240', [cs('hard', 240)]],
  ['sharp 120', [cs('sharp', 120)]],
  ['hairpin', expandFigures([{ figure: 'hairpin', side: 1 }], figureDict)],
  ['switchback', expandFigures([{ figure: 'switchback', side: 1 }], figureDict)],
  ['chicane', expandFigures([{ figure: 'chicane', side: 1 }], figureDict)],
];
const TAPS: Tap[] = [
  { periodS: 0.6, tapS: 0.15 },
  { periodS: 0.4, tapS: 0.1 },
  { periodS: 1.0, tapS: 0.25 },
];
function partD(io: Io): void {
  io.log(
    '## (г) Тап-дрифт: окна R86e (бот expert без шума, лучший чистый результат по запасам GRIP)',
  );
  for (const [pn, pp] of [
    ['T70-закреплённые числа (как тест R86e)', { ...P0, ...T70 }],
    ['текущая машина', P0],
  ] as const) {
    const rows: string[][] = [];
    for (const [wn, fig] of WINDOWS) {
      const w = tapWindow(fig);
      for (const [name, r] of [
        ['до', OFF],
        ['после', ON],
      ] as const) {
        const g = bestGrip(w.track, pp, r, null, w.total);
        const clean: BotParams = { ...botParams.expert, noiseAmp: 0, reactionDelay: 0 };
        const h = tapDrive(w.track, pp, r, clean, null, w.total);
        const cells = [wn, name, f(g?.T ?? NaN, 3), `${f(h.T, 3)}${h.ok ? '' : ' (не чисто)'}`];
        for (const t of TAPS) {
          const b = bestGrip(w.track, pp, r, t, w.total);
          cells.push(
            b
              ? `${f(b.T, 3)} (${pc(b.T / g!.T - 1, 2)}; вне опоры ${f(b.unsup, 2)} с)`
              : 'нет чистого',
          );
        }
        rows.push(cells);
      }
    }
    io.log(`### ${pn}`);
    table(
      io,
      [
        'окно',
        '',
        'GRIP, с',
        'держаный дрифт (expert), с',
        'тап 0.15/0.6',
        'тап 0.10/0.4',
        'тап 0.25/1.0',
      ],
      rows,
    );
  }
  // (d2) chain inside a corner (variant 3 version of R81e (f)): corner at 3000 without ramps.
  io.log(
    '### Цепочка «касание → дрифт d → отпустить rl» в повороте без съездов (как R81e (f), но вариант 3, текущая машина)',
  );
  const HOLD: Record<string, number> = { hard: 0.817, sharp: 0.956 };
  const rows: string[][] = [];
  for (const [cls, len] of [
    ['hard', 240],
    ['hard', 120],
    ['sharp', 120],
  ] as const) {
    const segs = [];
    for (let i = 0; i < 8000; i++) segs.push({ curve: i >= 3000 && i < 3000 + len ? C[cls]! : 0 });
    const track: Track = { segments: segs };
    const run = (kind: 'grip' | 'held' | 'chain', r: Rule, d = 0, rl = 0): number => {
      const race = createRace(1, 1);
      const c = race.cars[0]!;
      const p = free(P0);
      c.speed = p.vmax;
      c.z = 2970;
      const fr: InputFrame = { steer: 0, brake: false, drift: false };
      let tStart = NaN;
      let ph = 0;
      let rel = false;
      for (let i = 0; i < 20 / DT; i++) {
        const t = i * DT;
        let s = 0;
        let held = kind !== 'grip';
        if (c.z >= 3000) {
          if (Number.isNaN(tStart)) tStart = t;
          if (kind === 'chain') {
            if (c.state === 'DRIFT') {
              ph += DT;
              if (ph >= d) {
                rel = true;
                ph = 0;
              }
            } else if (rel) {
              ph += DT;
              if (ph >= rl) {
                rel = false;
                ph = 0;
              }
            }
          }
          held = kind !== 'grip' && !rel;
          if (c.state === 'DRIFT') s = HOLD[cls]! + 0.8 * (0 - c.x) - 0.3 * c.vx;
          else s = held || kind === 'grip' ? 1 + 0.8 * (0 - c.x) : 0;
          s = Math.max(-1, Math.min(1, s));
        } else held = false;
        if (c.z >= 3000 + len) return t - tStart;
        fr.steer = s;
        fr.drift = held;
        tick(race, fr, track, p, r);
      }
      return NaN;
    };
    for (const [name, r] of [
      ['до', OFF],
      ['после', ON],
    ] as const) {
      const g = run('grip', r);
      const h = run('held', r);
      const cells = [`${cls} ${len}`, name, f(g, 3), f(h, 3)];
      for (const [d, rl] of [
        [0.1, 0.05],
        [0.2, 0.05],
        [0.3, 0.1],
        [0.45, 0.05],
      ] as const) {
        const ch = run('chain', r, d, rl);
        cells.push(`${f(ch, 3)} (${pc(ch / g - 1, 2)})`);
      }
      rows.push(cells);
    }
  }
  table(
    io,
    ['поворот', '', 'GRIP', 'держаный дрифт', '0.1/0.05', '0.2/0.05', '0.3/0.1', '0.45/0.05'],
    rows,
  );
}

// ---------------------------------------------------------------- (e) drift against the corner, (g) easy
function holdIn(io: Io, title: string, cls: string, side: number): void {
  // steady corner forever; drift toward +1 entered with steer +1, then steer s held
  const { track } = secTrack([st(200), cs(cls, 20000, side, 0)]);
  const rows: string[][] = [];
  for (const steer of [0, 1]) {
    for (const [name, r] of [
      ['до', OFF],
      ['после', ON],
    ] as const) {
      const race = createRace(1, 1);
      const c = race.cars[0]!;
      const p = free(P0);
      c.speed = p.vmax;
      c.z = 400;
      const fr: InputFrame = { steer: 1, brake: false, drift: true };
      let edge = NaN;
      let edgeOut = NaN;
      let v2 = NaN;
      let a2 = NaN;
      let x2 = NaN;
      let x3 = NaN;
      for (let i = 1; i <= 6 / DT; i++) {
        fr.steer = i === 1 ? 1 : steer;
        tick(race, fr, track, p, r);
        const t = i * DT;
        if (Number.isNaN(edge) && c.x >= 1) edge = t;
        if (Number.isNaN(edgeOut) && c.x <= -1) edgeOut = t;
        if (Math.abs(t - 2) < DT / 2) {
          v2 = c.speed;
          a2 = body(c, p);
          x2 = c.x;
        }
        if (Math.abs(t - 3) < DT / 2) x3 = c.x;
      }
      rows.push([
        String(steer),
        name,
        f(x2, 2),
        f(x3 - x2, 3),
        f(v2, 3),
        f(a2, 1),
        f(edge, 2),
        f(edgeOut, 2),
      ]);
    }
  }
  io.log(title);
  table(
    io,
    [
      'руль',
      '',
      'x за 2 с',
      'дрейф 2→3 с (к dir +)',
      'скорость за 2 с',
      'угол',
      'x = +1, с',
      'x = −1, с',
    ],
    rows,
  );
}
function partE(io: Io): void {
  io.log(
    '## (д) Дрифт против поворота (дрифт вправо, поворот влево), установившийся поворот, из центра',
  );
  for (const cls of ['easy', 'medium', 'hard']) holdIn(io, `### ${cls}, против`, cls, -1);
}
function partG(io: Io): void {
  io.log('## (ж) easy в сторону дрифта, и для сравнения medium (опора 1 — бит-в-бит)');
  holdIn(io, '### easy, в сторону дрифта', 'easy', 1);
  holdIn(io, '### medium, в сторону дрифта', 'medium', 1);
  const rows: string[][] = [];
  for (const c of [1, 2, 2.5, 3, 3.5, 4, 4.5, 7]) rows.push([String(c), f(supShare(c, ON), 2)]);
  io.log('Доля опоры по кривизне (`supLo` 2, `supHi` 4.5):');
  table(io, ['кривизна к dir', 'sup'], rows);
}

// ---------------------------------------------------------------- (f) S-link and short straights
/** Left corner then right corner with a straight gap; drift left through the first, release at its
 * end (+late), re-enter right drift immediately (re-touch after `pause` s). Time over the figure. */
function sRun(p: CarParams, r: Rule, cls: string, gap: number, pause: number) {
  const pre = 120;
  const secs = [st(pre), cs(cls, 150, -1), ...(gap > 0 ? [st(gap)] : []), cs(cls, 150, 1), st(600)];
  const { track, len } = secTrack(secs);
  const race = createRace(1, 1);
  const c = race.cars[0]!;
  c.speed = p.vmax;
  c.z = pre - 60;
  const fr: InputFrame = { steer: 0, brake: false, drift: false };
  const end1 = pre + 210;
  const start2 = end1 + gap;
  let phase = 0; // 0 approach, 1 drift L, 2 pause, 3 drift R, 4 done
  let pT = 0;
  let vMin = 9;
  let xMin = 9;
  let xMax = -9;
  let sup2min = 9;
  let unsup = 0;
  for (let i = 0; i < 60 / DT; i++) {
    const t = i * DT;
    if (c.z >= len - 10) return { T: t, vMin, xMin, xMax, sup2min, unsup };
    if (phase === 0 && c.z >= pre) phase = 1;
    // release L when the left corner's leave ramp ends (or, with a gap 0, at its end = start of R)
    if (phase === 1 && c.z >= end1 - 15) {
      phase = 2;
      pT = 0;
    }
    if (phase === 2) {
      pT += DT;
      if (pT >= 0.05 && c.z >= start2 - pause * 60) phase = 3;
    }
    if (phase === 3 && c.z >= start2 + 210) phase = 4;
    if (phase === 1) {
      fr.drift = true;
      fr.steer =
        c.state === 'DRIFT'
          ? Math.max(-1, Math.min(1, -0.75 + 0.8 * (-0.3 - c.x) - 0.3 * c.vx))
          : -1;
    } else if (phase === 2) {
      fr.drift = false;
      fr.steer = 0;
    } else if (phase === 3) {
      fr.drift = true;
      fr.steer =
        c.state === 'DRIFT' ? Math.max(-1, Math.min(1, 0.75 + 0.8 * (0.3 - c.x) - 0.3 * c.vx)) : 1;
    } else {
      fr.drift = false;
      fr.steer = Math.max(-1, Math.min(1, 1.5 * (0 - c.x) - 0.4 * c.vx));
    }
    const sup = tick(race, fr, track, p, r);
    if (phase === 3 && c.state === 'DRIFT') {
      if (sup < sup2min) sup2min = sup;
      unsup += (1 - sup) * DT;
    }
    if (phase >= 1) {
      if (c.speed < vMin) vMin = c.speed;
      if (c.x < xMin) xMin = c.x;
      if (c.x > xMax) xMax = c.x;
    }
  }
  return { T: NaN, vMin, xMin, xMax, sup2min, unsup };
}
function partF(io: Io): void {
  io.log(
    '## (е) S-связка: дрифт влево по левому повороту (30/150/30), отпустить за 0.25 с до конца его съезда, не раньше чем через 0.05 с коснуться за `lead` с до начала правого (отрицательное — уже в его съезде), отпустить на конце правого',
  );
  io.log(
    'Прямая между ними 0 (съезд в съезд), 30, 60 сегм. (0.5 с и 1 с на `vmax`); `lead` 0.3 / 0 / −0.25 с.',
  );
  const p = free(P0);
  for (const cls of ['medium', 'hard']) {
    const rows: string[][] = [];
    for (const gap of [0, 30, 60]) {
      for (const pause of [0.3, 0, -0.25]) {
        const a = sRun(p, OFF, cls, gap, pause);
        const b = sRun(p, ON, cls, gap, pause);
        rows.push([
          String(gap),
          f(pause, 2),
          f(a.T, 3),
          f(b.T, 3),
          pc(b.T / a.T - 1, 2),
          f(b.sup2min, 2),
          f(b.unsup, 3),
          `${f(a.vMin, 3)} → ${f(b.vMin, 3)}`,
          `${f(a.xMax, 2)} → ${f(b.xMax, 2)}`,
        ]);
      }
    }
    io.log(`### ${cls}`);
    table(
      io,
      [
        'прямая, сегм.',
        'lead, с',
        'до, с',
        'после, с',
        'Δ',
        'min sup во 2-м дрифте',
        '∫(1−sup), с',
        'min скорость',
        'max x',
      ],
      rows,
    );
  }
  // short straight between two same-side corners, drift held through
  io.log(
    '### Два поворота в одну сторону (hard 30/150/30), между ними прямая; дрифт удержан через прямую (руль на полу) против отпускания на прямой',
  );
  const rows: string[][] = [];
  for (const gap of [30, 60, 120]) {
    for (const [name, r] of [
      ['до', OFF],
      ['после', ON],
    ] as const) {
      const pre = 120;
      const { track, len } = secTrack([
        st(pre),
        cs('hard', 150),
        st(gap),
        cs('hard', 150),
        st(600),
      ]);
      const race = createRace(1, 1);
      const c = race.cars[0]!;
      c.speed = p.vmax;
      c.z = pre - 60;
      const fr: InputFrame = { steer: 0, brake: false, drift: false };
      let vMin = 9;
      let xMax = -9;
      let T = NaN;
      for (let i = 0; i < 60 / DT; i++) {
        if (c.z >= len - 10) {
          T = i * DT;
          break;
        }
        const seg = Math.floor(c.z);
        const inC = track.segments[seg]!.curve > 0;
        if (c.z >= pre && c.z < pre + 420 + gap) {
          fr.drift = true;
          fr.steer =
            c.state !== 'DRIFT'
              ? 1
              : inC
                ? Math.max(-1, Math.min(1, 0.75 + 0.8 * (0.3 - c.x) - 0.3 * c.vx))
                : 0;
        } else {
          fr.drift = false;
          fr.steer = Math.max(-1, Math.min(1, 1.5 * (0 - c.x) - 0.4 * c.vx));
        }
        tick(race, fr, track, p, r);
        if (c.z >= pre) {
          if (c.speed < vMin) vMin = c.speed;
          if (c.x > xMax) xMax = c.x;
        }
      }
      rows.push([String(gap), name, f(T, 3), f(vMin, 3), f(xMax, 2)]);
    }
  }
  table(io, ['прямая, сегм.', '', 'время, с', 'min скорость', 'max x (внутрь +)'], rows);
}

// ---------------------------------------------------------------- (h) sensitivity
function partH(io: Io): void {
  io.log(
    '## (з) Чувствительность: потеря скорости и время до края на прямой, и ΔT выхода hard на 0.3 / 1 с',
  );
  const tr = secTrack([st(20000)]).track;
  const p = free(P0);
  const rows: string[][] = [];
  const sets: [string, Rule][] = [
    ['выбрано', ON],
    ['driftSlow 0.12', { ...ON, driftSlow: 0.12 }],
    ['driftSlow 0.16', { ...ON, driftSlow: 0.16 }],
    ['driftTurn 0.15', { ...ON, driftTurn: 0.15 }],
    ['driftTurn 0.23', { ...ON, driftTurn: 0.23 }],
    ['supTail 0.3', { ...ON, supTail: 0.3 }],
    ['supTail 0.8', { ...ON, supTail: 0.8 }],
    ['supLo 1', { ...ON, supLo: 1 }],
  ];
  for (const [name, r] of sets) {
    const race = createRace(1, 1);
    const c = race.cars[0]!;
    c.speed = p.vmax;
    c.z = 100;
    const fr: InputFrame = { steer: 1, brake: false, drift: true };
    let edge = NaN;
    let v1 = NaN;
    for (let i = 1; i <= 6 / DT; i++) {
      fr.steer = i === 1 ? 1 : 0;
      tick(race, fr, tr, p, r);
      if (Number.isNaN(edge) && c.x >= 1) edge = i * DT;
      if (i === 120) v1 = c.speed;
    }
    const b0 = exitRun(p, r, 'hard', 240, 0);
    const b3 = exitRun(p, r, 'hard', 240, 0.3);
    const b1 = exitRun(p, r, 'hard', 240, 1);
    rows.push([
      name,
      pc(v1 - 1, 1),
      f(edge, 2),
      f(b3.T - b0.T, 3),
      f(b1.T - b0.T, 3),
      f(b3.vAtRel, 3),
      f(b1.vAtRel, 3),
    ]);
  }
  table(
    io,
    [
      'набор',
      'скорость за 1 с прямой',
      'край, с (пол)',
      'ΔT hard +0.3 с',
      'ΔT hard +1 с',
      'скорость на отпускании +0.3',
      '+1',
    ],
    rows,
  );
}

// ---------------------------------------------------------------- (i) corner entry
function entryRun(p: CarParams, r: Rule, cls: string, lead: number) {
  const pre = 240;
  const { track, len } = secTrack([st(pre), cs(cls, 240), st(600)]);
  const race = createRace(1, 1);
  const c = race.cars[0]!;
  c.speed = p.vmax;
  c.z = pre - 120;
  const fr: InputFrame = { steer: 0, brake: false, drift: false };
  const zOn = pre - lead * 60;
  const zEnd = pre + 300;
  let vMin = 9;
  let unsup = 0;
  for (let i = 0; i < 60 / DT; i++) {
    const t = i * DT;
    if (c.z >= len - 10) return { T: t, vMin, unsup };
    if (c.z >= zOn && c.z < zEnd) {
      fr.drift = true;
      fr.steer =
        c.state !== 'DRIFT' ? 1 : Math.max(-1, Math.min(1, 0.75 + 0.8 * (0.3 - c.x) - 0.3 * c.vx));
    } else {
      fr.drift = false;
      fr.steer = Math.max(-1, Math.min(1, 1.5 * (0 - c.x) - 0.4 * c.vx));
    }
    const sup = tick(race, fr, track, p, r);
    if (c.state === 'DRIFT') unsup += (1 - sup) * DT;
    if (c.z >= zOn && c.speed < vMin) vMin = c.speed;
  }
  return { T: NaN, vMin, unsup };
}
function partI(io: Io): void {
  io.log(
    '## (и) Вход в поворот: касание за `lead` с до начала съезда 30 сегм. (0 — на начале съезда, −0.5 — на начале дуги), отпускание на конце фигуры',
  );
  const p = free(P0);
  const rows: string[][] = [];
  for (const cls of ['medium', 'hard', 'sharp']) {
    for (const lead of [0.3, 0.15, 0, -0.25, -0.5]) {
      const a = entryRun(p, OFF, cls, lead);
      const b = entryRun(p, ON, cls, lead);
      rows.push([
        cls,
        f(lead, 2),
        f(a.T, 3),
        f(b.T, 3),
        f(b.T - a.T, 3),
        f(b.unsup, 3),
        f(b.vMin, 3),
      ]);
    }
  }
  table(
    io,
    ['класс', 'lead, с', 'до, с', 'после, с', 'ΔT, с', '∫(1−sup), с', 'min скорость'],
    rows,
  );
}

// ---------------------------------------------------------------- (j) R85d criterion on a straight
function partJ(io: Io): void {
  io.log(
    '## (к) R85d: на прямой `vmax`, полный руль GRIP 0.5 с, затем палец (вход), 0.4 с; наибольший |vx|',
  );
  const tr = secTrack([st(20000)]).track;
  const rows: string[][] = [];
  for (const [name, r] of [
    ['до', OFF],
    ['после', ON],
  ] as const) {
    const race = createRace(1, 1);
    const c = race.cars[0]!;
    const p = free(P0);
    c.speed = p.vmax;
    c.z = 100;
    const fr: InputFrame = { steer: 1, brake: false, drift: false };
    let g = 0;
    let d = 0;
    for (let i = 1; i <= 0.9 / DT; i++) {
      fr.drift = i > 0.5 / DT;
      tick(race, fr, tr, p, r);
      const v = Math.abs(c.vx);
      if (c.state === 'DRIFT') d = Math.max(d, v);
      else g = Math.max(g, v);
    }
    rows.push([name, f(g, 3), f(d, 3)]);
  }
  table(io, ['', 'GRIP max |vx|', 'DRIFT 0.4 с max |vx|'], rows);
}

export function main(io: Io): number {
  const part = argValue(io.argv, 'part') ?? 'all';
  const on = (k: string): boolean => part === 'all' || part === k;
  io.log(
    `Правило: supLo ${ON.supLo}, supHi ${ON.supHi}, supLook ${ON.supLook}, supTail ${ON.supTail}, driftSlow ${ON.driftSlow}, driftTurn ${ON.driftTurn}`,
  );
  io.log('');
  if (on('a')) partA(io);
  if (on('b')) partB(io);
  if (on('c')) partC(io);
  if (on('d')) partD(io);
  if (on('e')) partE(io);
  if (on('f')) partF(io);
  if (on('g')) partG(io);
  if (on('h')) partH(io);
  if (on('i')) partI(io);
  if (on('j')) partJ(io);
  return 0;
}

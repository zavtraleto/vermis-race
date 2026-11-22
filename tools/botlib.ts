// Shared by tools/bot.ts and tools/gate.ts: track discovery, run aggregation, result types.
import { botInput, createBot } from '../src/bot/driver';
import { createRivalDrivers, fillRivalInputs } from '../src/bot/rivals';
import { runBot, type MeasureConfig, type RunResult } from '../src/bot/run';
import { botParams, BOT_NAMES, type BotName } from '../src/data/bots';
import { baseCar } from '../src/data/cars';
import road from '../src/data/road.json';
import { mistakeConfig, rivalConfig } from '../src/data/rivals';
import { trafficConfig } from '../src/data/traffic';
import {
  curveClasses,
  resolveSections,
  trackSections,
  type ClassedSection,
  type CurveClass,
  type SectionClass,
} from '../src/data/tracks';
import { DT, SEG_PER_UNIT } from '../src/sim/constants';
import { createRace, placeRivals, placeTraffic, step } from '../src/sim/race';
import { buildTrack } from '../src/sim/track';
import type { CarParams, InputFrame, RivalConfig, Track, TrafficConfig } from '../src/sim/types';
import type { Io } from './io';

export const TRACK_DIR = 'src/data/tracks';

export interface LoadedTrack {
  name: string;
  file?: string; // file name in TRACK_DIR (set by loadTracks)
  sections: ClassedSection[];
  track: Track;
}

/** Every JSON in src/data/tracks with a "sections" or R31 "figures" array is a track. */
export function loadTracks(io: Io): LoadedTrack[] {
  const out: LoadedTrack[] = [];
  for (const f of io.list(TRACK_DIR)) {
    if (!f.endsWith('.json')) continue;
    const raw = JSON.parse(io.read(`${TRACK_DIR}/${f}`)) as {
      name?: unknown;
      sections?: unknown;
      figures?: unknown;
    };
    if (!Array.isArray(raw.sections) && !Array.isArray(raw.figures)) continue;
    const sections = trackSections(raw);
    const name = typeof raw.name === 'string' ? raw.name : f.replace(/\.json$/, '');
    out.push({
      name,
      file: f,
      sections,
      track: buildTrack(resolveSections(sections, curveClasses)),
    });
  }
  return out;
}

export function runOne(bot: BotName, t: LoadedTrack, seed: number, m: MeasureConfig): RunResult {
  return runBot(botParams[bot], baseCar, t.track, t.sections, seed, m);
}

/** R70/R71 traffic pool of the game (src/data/traffic.json, lanes from road.json). */
export const TRAFFIC: TrafficConfig = { ...trafficConfig, lanes: road.lanes };

/** Same run with the traffic pool (R46). */
export function runOneTraffic(
  bot: BotName,
  t: LoadedTrack,
  seed: number,
  m: MeasureConfig,
): RunResult {
  return runBot(botParams[bot], baseCar, t.track, t.sections, seed, m, TRAFFIC);
}

/** R46: expert parameters with traffic avoidance off (only in the traffic runs, not in the gate). */
export const EXPERT_BLIND = 'expert-blind';

export function runBlindTraffic(t: LoadedTrack, seed: number, m: MeasureConfig): RunResult {
  const bp = { ...botParams.expert, traffic: 'ignore' as const };
  return runBot(bp, baseCar, t.track, t.sections, seed, m, TRAFFIC);
}

/** R46 per bot and track: the same seeds with and without traffic. */
export interface TrafficEntry {
  bot: BotName | typeof EXPERT_BLIND;
  track: string;
  runs: number;
  finishedFraction: number;
  bumpsPerLap: number; // mean R40 contacts per lap
  bumpsInDriftPerLap: number;
  zeroDriftBumpRuns: number; // share of runs with no contact in DRIFT
  passedPerLap: number; // traffic cars overtaken per lap
  boostsPerLap: number; // R52 (H5 B) slipstream boosts started per lap
  crashesPerLap: number; // R47 lamp-post crashes per lap
  lapTime: { traffic: number; clear: number; ratio: number }; // mean lap, s; ratio = traffic / clear
  /** expert-blind only: its lap with traffic / the weaving expert's lap with traffic (R46 >= 1.05). */
  vsWeaving?: number;
}

/** `clear` = the no-traffic entry the lap is compared with; `bot` overrides its name. */
export function summarizeTraffic(
  clear: Entry,
  runs: readonly RunResult[],
  m: MeasureConfig,
  bot: TrafficEntry['bot'] = clear.bot,
): TrafficEntry {
  let bumps = 0;
  let inDrift = 0;
  let zero = 0;
  let passed = 0;
  let boosts = 0;
  let crashes = 0;
  let finished = 0;
  const laps: number[] = [];
  for (const r of runs) {
    const t = r.traffic ?? { bumps: 0, bumpsInDrift: 0, passed: 0, boosts: 0 };
    bumps += t.bumps;
    inDrift += t.bumpsInDrift;
    passed += t.passed;
    boosts += t.boosts;
    if (t.bumpsInDrift === 0) zero++;
    crashes += r.crashes ?? 0;
    if (r.finished) finished++;
    laps.push(...r.lapTimes);
  }
  const lapCount = runs.length * m.laps;
  const lap = stat(laps).mean;
  return {
    bot,
    track: clear.track,
    runs: runs.length,
    finishedFraction: finished / runs.length,
    bumpsPerLap: bumps / lapCount,
    bumpsInDriftPerLap: inDrift / lapCount,
    zeroDriftBumpRuns: zero / runs.length,
    passedPerLap: passed / lapCount,
    boostsPerLap: boosts / lapCount,
    crashesPerLap: crashes / lapCount,
    lapTime: { traffic: lap, clear: clear.lapTime.mean, ratio: lap / clear.lapTime.mean },
  };
}

export interface Stat {
  mean: number;
  stdev: number;
  best: number;
}

export interface CornerSummary {
  index: number;
  curveClass: SectionClass;
  side: -1 | 1;
  entrySpeed: { mean: number; min: number };
  maxAbsX: number;
  minSpeed: number; // min speed/vmax inside the section over flying laps of all seeds
  long: boolean; // hold >= measure.longHoldSeconds at vmax
  offroadEventsPerLap: number;
}

export interface Entry {
  bot: BotName;
  track: string;
  runs: number;
  finishedFraction: number;
  lapTime: Stat; // s, all laps of all runs (lap 1 starts from standstill)
  lapTimeByLap: number[]; // mean per lap number
  flyingLap: Stat; // s, laps 2..N only (no standing start)
  offroadFraction: number;
  offroadEventsPerLap: {
    total: number;
    easy: number;
    medium: number;
    hard: number;
    sharp: number; // R31b
    easyMedium: number;
  };
  steerSaturation: number;
  // fraction of vmax; min over flying laps; longHardMin = the lowest of the per-corner minimum
  // speeds over long hard corners (each long hard must be slowed below a bound), null if none
  speed: { mean: number; min: number; longHardMin: number | null };
  brakeFraction: number;
  driftFraction: number; // share of ticks in DRIFT
  driftsPerLap: number; // GRIP -> DRIFT entries per lap
  deadTimeFraction: number;
  straightFraction: number;
  wallHits: { total: number; perLap: number };
  crashesPerLap: number; // R47 lamp-post crashes per lap (R49 criterion: expert and average 0)
  nan: boolean;
  corners: CornerSummary[];
  fingerprints: Record<string, string>;
}

export interface Results {
  version: 1;
  car: string;
  laps: number;
  seeds: number[];
  measure: MeasureConfig;
  tracks: string[];
  entries: Entry[];
  /** R46: every bot also run with the traffic pool on the same seeds. */
  traffic?: TrafficEntry[];
  /** R15b feel check: seconds back to asphalt after an exit (null = did not return). */
  recovery: { curveClass: CurveClass; speed: number; depth: number; seconds: number | null };
}

function stat(v: readonly number[]): Stat {
  if (v.length === 0) return { mean: NaN, stdev: NaN, best: NaN };
  let s = 0;
  let best = Infinity;
  for (const x of v) {
    s += x;
    if (x < best) best = x;
  }
  const mean = s / v.length;
  let q = 0;
  for (const x of v) q += (x - mean) * (x - mean);
  return { mean, stdev: v.length > 1 ? Math.sqrt(q / (v.length - 1)) : 0, best };
}

export function summarize(
  bot: BotName,
  t: LoadedTrack,
  runs: RunResult[],
  m: MeasureConfig,
): Entry {
  const laps = m.laps;
  let ticks = 0;
  let off = 0;
  let sat = 0;
  let brake = 0;
  let drift = 0;
  let driftEntries = 0;
  let dead = 0;
  let straight = 0;
  let speedSum = 0;
  let minSpeed = Infinity;
  let walls = 0;
  let crashes = 0;
  let nan = false;
  let finished = 0;
  const ev = { easy: 0, medium: 0, hard: 0, sharp: 0 };
  let evTotal = 0;
  const lapTimes: number[] = [];
  const byLap: number[][] = [];
  for (let i = 0; i < laps; i++) byLap.push([]);
  const fingerprints: Record<string, string> = {};
  for (const r of runs) {
    ticks += r.ticks;
    off += r.offroadTicks;
    sat += r.saturationTicks;
    brake += r.brakeTicks;
    drift += r.driftTicks;
    driftEntries += r.driftEntries;
    dead += r.deadTicks;
    straight += r.straightTicks;
    speedSum += r.speedSum;
    if (r.minSpeedFlying < minSpeed) minSpeed = r.minSpeedFlying;
    walls += r.wallHits;
    crashes += r.crashes ?? 0;
    nan = nan || r.nan;
    if (r.finished) finished++;
    evTotal += r.offroadEvents;
    ev.easy += r.offroadEventsByClass.easy;
    ev.medium += r.offroadEventsByClass.medium;
    ev.hard += r.offroadEventsByClass.hard;
    ev.sharp += r.offroadEventsByClass.sharp ?? 0;
    r.lapTimes.forEach((lt, i) => {
      lapTimes.push(lt);
      byLap[i]?.push(lt);
    });
    fingerprints[String(r.seed)] = r.fingerprint;
  }
  const lapCount = runs.length * laps;
  const corners: CornerSummary[] = t.sections.map((s, i) => {
    const speeds: number[] = [];
    let maxX = 0;
    let ce = 0;
    let minSp = Infinity;
    for (const r of runs) {
      const c = r.corners[i]!;
      if (c.minSpeed < minSp) minSp = c.minSpeed;
      speeds.push(...c.entrySpeed);
      if (c.maxAbsX > maxX) maxX = c.maxAbsX;
      ce += c.offroadEvents;
    }
    const st = stat(speeds);
    return {
      index: i,
      curveClass: s.curveClass,
      side: s.side,
      entrySpeed: { mean: st.mean, min: speeds.length ? Math.min(...speeds) : NaN },
      maxAbsX: maxX,
      minSpeed: minSp,
      long: s.hold / SEG_PER_UNIT >= m.longHoldSeconds,
      offroadEventsPerLap: ce / lapCount,
    };
  });
  let longHardMin: number | null = null;
  for (const c of corners) {
    if (c.curveClass !== 'hard' || !c.long) continue;
    if (longHardMin === null || c.minSpeed < longHardMin) longHardMin = c.minSpeed;
  }
  return {
    bot,
    track: t.name,
    runs: runs.length,
    finishedFraction: finished / runs.length,
    lapTime: stat(lapTimes),
    lapTimeByLap: byLap.map((v) => stat(v).mean),
    flyingLap: stat(byLap.slice(1).flat()),
    offroadFraction: off / ticks,
    offroadEventsPerLap: {
      total: evTotal / lapCount,
      easy: ev.easy / lapCount,
      medium: ev.medium / lapCount,
      hard: ev.hard / lapCount,
      sharp: ev.sharp / lapCount,
      easyMedium: (ev.easy + ev.medium) / lapCount,
    },
    steerSaturation: sat / ticks,
    speed: { mean: speedSum / ticks, min: minSpeed, longHardMin },
    brakeFraction: brake / ticks,
    driftFraction: drift / ticks,
    driftsPerLap: driftEntries / lapCount,
    deadTimeFraction: dead / ticks,
    straightFraction: straight / ticks,
    wallHits: { total: walls, perLap: walls / lapCount },
    crashesPerLap: crashes / lapCount,
    nan,
    corners,
    fingerprints,
  };
}

/** Reads a dotted path like "lapTime.mean" from an entry; undefined if absent or not a number. */
export function metricOf(e: Entry, path: string): number | undefined {
  let v: unknown = e;
  for (const k of path.split('.')) {
    if (typeof v !== 'object' || v === null) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return typeof v === 'number' ? v : undefined;
}

export { BOT_NAMES };
export type { BotName };

/** R67 rivals run: what the bot measures per player skill (20 seeds x 3 minutes by default). */
export interface RivalMetrics {
  bot: BotName;
  track: string;
  seeds: number;
  minutes: number;
  placeChangesPerMin: number; // player place changes, both ways
  close3Share: number; // share of ticks with >= 3 rivals within +-closeRadius segments
  inViewShare: number; // share of ticks with >= 1 rival ahead in view (0 < d < viewDist)
  medianPlace: number; // over every tick of every seed
  crashesPerRivalMin: number;
  bumpsPerRivalMin: number;
  poolSwapsPerMin: number;
  bandInViewShare: number; // share of ticks where a non-nemesis rival in view has |band| > bandEps
  nemesisBandInViewShare: number; // the same for the nemesis
}

/** R67 bot check numbers (named in advance in docs/brief.md R67 / research §4.9). */
export const RIVAL_CHECK = { closeRadius: 150, viewDist: 200, bandEps: 0.005 };

/** R60-R67: player bot `bot` with the game's rivals (src/bot/rivals.ts) and traffic pool. */
export function runRivals(
  bot: BotName,
  t: LoadedTrack,
  seeds: readonly number[],
  seconds: number,
): RivalMetrics {
  const rc: RivalConfig = { ...rivalConfig, lanes: road.lanes };
  const ticks = Math.round(seconds / DT);
  const places: number[] = [];
  let placeChanges = 0;
  let close3 = 0;
  let inView = 0;
  let crashes = 0;
  let bumps = 0;
  let swaps = 0;
  let bandView = 0;
  let nemView = 0;
  let total = 0;
  for (const seed of seeds) {
    const race = createRace(seed, 1 + rc.rivalCount, TRAFFIC.trafficMax);
    placeRivals(race, rc);
    placeTraffic(race, TRAFFIC, baseCar.vmax);
    const cars = race.cars;
    const params: CarParams[] = cars.map((c) => (c.kind === 'rival' ? { ...baseCar } : baseCar));
    const inputs: InputFrame[] = cars.map(() => ({ steer: 0, gas: 1, brake: 0, driftTap: false }));
    const player = cars[0]!;
    const pb = createBot(seed);
    const drivers = createRivalDrivers(race, seed);
    const n = cars.length;
    const prevCrash = new Int32Array(n);
    const prevBump = new Int32Array(n);
    const prevName = new Int32Array(n);
    for (let i = 0; i < n; i++) prevName[i] = cars[i]!.nameId;
    let prevPlace = player.place;
    for (let k = 0; k < ticks; k++) {
      botInput(pb, botParams[bot], player, t.track, baseCar, inputs[0]!, cars);
      fillRivalInputs(drivers, race, t.track, params, mistakeConfig, inputs);
      for (let i = 0; i < n; i++) {
        prevCrash[i] = cars[i]!.crashTicks;
        prevBump[i] = cars[i]!.bumpTicks;
      }
      step(race, inputs, t.track, params, TRAFFIC, rc);
      total++;
      if (k > 0 && player.place !== prevPlace) placeChanges++;
      prevPlace = player.place;
      places.push(player.place);
      let near = 0;
      let view = false;
      let bv = false;
      let nv = false;
      for (let i = 1; i < n; i++) {
        const c = cars[i]!;
        if (c.kind !== 'rival') continue;
        if (c.nameId !== prevName[i]) {
          swaps++;
          prevName[i] = c.nameId;
          continue; // a fresh car: its contacts and crashes start from here
        }
        const d = c.z - player.z;
        if (d <= RIVAL_CHECK.closeRadius && d >= -RIVAL_CHECK.closeRadius) near++;
        if (d > 0 && d < RIVAL_CHECK.viewDist) {
          view = true;
          const big = c.band > RIVAL_CHECK.bandEps || c.band < -RIVAL_CHECK.bandEps;
          if (big && c.nemesis === 1) nv = true;
          else if (big) bv = true;
        }
        if (c.crashTicks > 0 && prevCrash[i] === 0) crashes++;
        // R43 contact: bumpTicks rises; the R48 return from a crash also sets it (not a contact).
        else if (c.bumpTicks > prevBump[i]! && prevCrash[i] === 0) bumps++;
      }
      if (near >= 3) close3++;
      if (view) inView++;
      if (bv) bandView++;
      if (nv) nemView++;
    }
  }
  places.sort((a, b) => a - b);
  const minutes = (total * DT) / 60;
  const rivalMinutes = minutes * rc.rivalCount;
  return {
    bot,
    track: t.name,
    seeds: seeds.length,
    minutes: seconds / 60,
    placeChangesPerMin: placeChanges / minutes,
    close3Share: close3 / total,
    inViewShare: inView / total,
    medianPlace: places[Math.floor(places.length / 2)]!,
    crashesPerRivalMin: crashes / rivalMinutes,
    bumpsPerRivalMin: bumps / rivalMinutes,
    poolSwapsPerMin: swaps / minutes,
    bandInViewShare: bandView / total,
    nemesisBandInViewShare: nemView / total,
  };
}

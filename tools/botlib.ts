// Shared by tools/bot.ts and tools/gate.ts: track discovery, run aggregation, result types.
import { runBot, type MeasureConfig, type RunResult } from '../src/bot/run';
import { botParams, BOT_NAMES, type BotName } from '../src/data/bots';
import { baseCar } from '../src/data/cars';
import {
  curveClasses,
  resolveSections,
  trackSections,
  type ClassedSection,
  type CurveClass,
  type SectionClass,
} from '../src/data/tracks';
import { SEG_PER_UNIT } from '../src/sim/constants';
import { buildTrack } from '../src/sim/track';
import type { Track } from '../src/sim/types';
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
  let nan = false;
  let finished = 0;
  const ev = { easy: 0, medium: 0, hard: 0 };
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
    nan = nan || r.nan;
    if (r.finished) finished++;
    evTotal += r.offroadEvents;
    ev.easy += r.offroadEventsByClass.easy;
    ev.medium += r.offroadEventsByClass.medium;
    ev.hard += r.offroadEventsByClass.hard;
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

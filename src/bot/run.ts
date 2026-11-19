// T16 headless bot run: one bot, one track, one seed, N laps, metrics collected per tick.
// Setup allocates; the tick loop does not.
import type { ClassedSection, CurveClass } from '../data/tracks';
import { DT } from '../sim/constants';
import { createRace, placeTraffic, step } from '../sim/race';
import type { CarParams, InputFrame, Track, TrafficConfig } from '../sim/types';
import { botInput, createBot, type BotParams } from './driver';

/** How metrics are measured (from gate.config.json "measure"). */
export interface MeasureConfig {
  laps: number;
  maxSecondsPerLap: number; // a run that needs longer is "not finished"
  saturationSteer: number; // |steer| above this counts as saturated
  deadSteer: number; // |steer| below this on a straight without brake counts as dead time
  straightCurveMax: number; // |curve| at or below this is a straight
  longHoldSeconds: number; // a section whose hold lasts at least this long at vmax is a long corner
}

export interface CornerRun {
  /** Speed (fraction of vmax) when the car reaches the start of the section's hold part, per lap. */
  entrySpeed: number[];
  maxAbsX: number;
  minSpeed: number; // lowest speed/vmax inside the section (flying laps 2..N)
  offroadEvents: number;
}

export interface RunResult {
  seed: number;
  finished: boolean;
  ticks: number;
  lapTimes: number[]; // s
  offroadTicks: number;
  offroadEvents: number;
  offroadEventsByClass: Record<Exclude<CurveClass, 'sharp'>, number> & { sharp?: number }; // sharp: R31b
  saturationTicks: number;
  brakeTicks: number;
  driftTicks: number; // ticks ending in DRIFT (R20-R22)
  driftEntries: number; // GRIP -> DRIFT transitions
  straightTicks: number;
  deadTicks: number;
  speedSum: number; // sum of speed/vmax per tick
  minSpeedFlying: number; // min speed/vmax over laps 2..N (lap 1 starts from standstill)
  wallHits: number; // entries into |x| = xLimit (R18)
  crashes?: number; // R47 lamp-post crashes (absent = 0)
  nan: boolean;
  corners: CornerRun[]; // one per track section
  fingerprint: string; // FNV-1a over the per-tick state, for determinism checks
  /** Only in a run with traffic (R70, R71): contacts (R40) and traffic cars overtaken. */
  traffic?: { bumps: number; bumpsInDrift: number; passed: number; boosts: number };
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

function mix(h: number, v: number): number {
  f64[0] = v;
  h = Math.imul(h ^ u32[0]!, 16777619);
  return Math.imul(h ^ u32[1]!, 16777619);
}

export function runBot(
  bp: BotParams,
  p: CarParams,
  track: Track,
  sections: readonly ClassedSection[],
  seed: number,
  m: MeasureConfig,
  traffic?: TrafficConfig,
): RunResult {
  const n = track.segments.length;
  // Segment -> section index, and the segment where each section's hold begins.
  const sectionOf = new Int32Array(n);
  const holdStart = new Int32Array(sections.length);
  let acc = 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    holdStart[i] = acc + s.enter;
    const len = s.enter + s.hold + s.leave;
    for (let j = 0; j < len; j++) sectionOf[acc + j] = i;
    acc += len;
  }
  if (acc !== n) throw new Error(`sections cover ${acc} segments, track has ${n}`);

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

  const race = createRace(seed, 1, traffic ? traffic.trafficMax : 0);
  if (traffic) placeTraffic(race, traffic, p.vmax);
  const car = race.cars[0]!;
  const bot = createBot(seed);
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const idle: InputFrame = { steer: 0, brake: false, drift: false };
  const inputs = race.cars.map((_, i) => (i === 0 ? frame : idle));
  const params = race.cars.map(() => p);
  const cars = race.cars;
  const tz = new Float64Array(cars.length);
  const tr = traffic ? { bumps: 0, bumpsInDrift: 0, passed: 0, boosts: 0 } : null;
  const goal = m.laps * n;
  const maxTicks = Math.ceil((m.laps * m.maxSecondsPerLap) / DT);
  let lapStartTick = 0;
  let wasOff = false;
  let wasWall = false;
  let wasCrash = false;
  let wasDrift = false;
  let hash = 2166136261;

  while (car.z < goal && race.tick < maxTicks) {
    botInput(bot, bp, car, track, p, frame, cars);
    const segBefore = Math.floor(car.z) % n;
    const zBefore = car.z;
    const bumpBefore = car.bumpTicks;
    const boostBefore = car.boostTicks;
    for (let i = 1; i < cars.length; i++) tz[i] = cars[i]!.z;
    step(race, inputs, track, params, traffic);
    if (tr) {
      // R43: bumpTicks only rises on a contact.
      if (car.bumpTicks > bumpBefore) {
        tr.bumps++;
        if (car.state === 'DRIFT') tr.bumpsInDrift++;
      }
      // R52 (H5 B): boostTicks only rises when a boost starts.
      if (car.boostTicks > boostBefore) tr.boosts++;
      // Overtaken: was ahead of the player before the step, level or behind after it.
      for (let i = 1; i < cars.length; i++) {
        if (tz[i]! > zBefore && cars[i]!.z <= car.z) tr.passed++;
      }
    }

    const x = car.x;
    const sp = car.speed / p.vmax;
    if (!Number.isFinite(x) || !Number.isFinite(car.speed) || !Number.isFinite(frame.steer)) {
      r.nan = true;
      break;
    }
    hash = mix(mix(mix(mix(hash, x), car.speed), car.vx), frame.steer);

    const as = frame.steer < 0 ? -frame.steer : frame.steer;
    if (as > m.saturationSteer) r.saturationTicks++;
    if (frame.brake) r.brakeTicks++;
    const drifting = car.state === 'DRIFT';
    if (drifting) r.driftTicks++;
    if (drifting && !wasDrift) r.driftEntries++;
    wasDrift = drifting;
    const c = track.segments[segBefore]!.curve;
    if ((c < 0 ? -c : c) <= m.straightCurveMax) {
      r.straightTicks++;
      if (as < m.deadSteer && !frame.brake) r.deadTicks++;
    }
    r.speedSum += sp;

    const seg = Math.floor(car.z) % n;
    const si = sectionOf[seg]!;
    const corner = corners[si]!;
    const ax = x < 0 ? -x : x;
    if (ax > corner.maxAbsX) corner.maxAbsX = ax;
    if (car.z >= n && sp < corner.minSpeed) corner.minSpeed = sp;
    const off = ax > 1; // R15 asphalt is |x| <= 1
    if (off) r.offroadTicks++;
    if (off && !wasOff) {
      r.offroadEvents++;
      corner.offroadEvents++;
      const cls = sections[si]!.curveClass;
      if (cls !== 'straight') r.offroadEventsByClass[cls] = (r.offroadEventsByClass[cls] ?? 0) + 1;
    }
    wasOff = off;
    const wall = ax >= p.xLimit;
    if (wall && !wasWall) r.wallHits++;
    wasWall = wall;
    // R49 criterion: lamp-post crashes (R47), counted on the hit tick.
    const crashing = car.crashTicks > 0;
    if (crashing && !wasCrash) r.crashes = (r.crashes ?? 0) + 1;
    wasCrash = crashing;

    // Hold start crossed this tick (z may cross a lap boundary: compare positions in lap space).
    const hs = holdStart[si]!;
    const lapBase = Math.floor(car.z / n) * n;
    if (zBefore < lapBase + hs && car.z >= lapBase + hs) corner.entrySpeed.push(sp);

    if (car.z >= n && Math.floor(car.z / n) > r.lapTimes.length) {
      r.lapTimes.push((race.tick - lapStartTick) * DT);
      lapStartTick = race.tick;
    }
    if (r.lapTimes.length >= 1 && sp < r.minSpeedFlying) r.minSpeedFlying = sp;
  }
  r.ticks = race.tick;
  r.finished = !r.nan && car.z >= goal && r.lapTimes.length === m.laps;
  r.fingerprint = (hash >>> 0).toString(16).padStart(8, '0');
  if (tr) r.traffic = tr;
  return r;
}

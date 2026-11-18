// T16 headless bot run: one bot, one track, one seed, N laps, metrics collected per tick.
// Setup allocates; the tick loop does not.
import type { ClassedSection, CurveClass } from '../data/tracks';
import { DT } from '../sim/constants';
import { createRace, step } from '../sim/race';
import type { CarParams, InputFrame, Track } from '../sim/types';
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
  offroadEventsByClass: Record<CurveClass, number>;
  saturationTicks: number;
  brakeTicks: number;
  straightTicks: number;
  deadTicks: number;
  speedSum: number; // sum of speed/vmax per tick
  minSpeedFlying: number; // min speed/vmax over laps 2..N (lap 1 starts from standstill)
  wallHits: number; // entries into |x| = xLimit (R18)
  nan: boolean;
  corners: CornerRun[]; // one per track section
  fingerprint: string; // FNV-1a over the per-tick state, for determinism checks
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
    offroadEventsByClass: { easy: 0, medium: 0, hard: 0 },
    saturationTicks: 0,
    brakeTicks: 0,
    straightTicks: 0,
    deadTicks: 0,
    speedSum: 0,
    minSpeedFlying: Infinity,
    wallHits: 0,
    nan: false,
    corners,
    fingerprint: '',
  };

  const race = createRace(seed, 1);
  const car = race.cars[0]!;
  const bot = createBot(seed);
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const inputs = [frame];
  const params = [p];
  const goal = m.laps * n;
  const maxTicks = Math.ceil((m.laps * m.maxSecondsPerLap) / DT);
  let lapStartTick = 0;
  let wasOff = false;
  let wasWall = false;
  let hash = 2166136261;

  while (car.z < goal && race.tick < maxTicks) {
    botInput(bot, bp, car, track, p, frame);
    const segBefore = Math.floor(car.z) % n;
    const zBefore = car.z;
    step(race, inputs, track, params);

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
      r.offroadEventsByClass[sections[si]!.curveClass]++;
    }
    wasOff = off;
    const wall = ax >= p.xLimit;
    if (wall && !wasWall) r.wallHits++;
    wasWall = wall;

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
  return r;
}

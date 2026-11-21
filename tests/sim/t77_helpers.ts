// T77 helpers (docs/brief.md R84c, R85e, R85f; docs/research/release-pullback.md, spike
// tools/spike/release-pullback.ts): the same runs as the spike, through the real `step`.
import { baseCar } from '../../src/data/cars';
import { curveClasses, loadTestTwisty } from '../../src/data/tracks';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { Lcg } from './corner_helpers';

export const C = curveClasses as Record<string, number>;
/** The spike's car: the real base car, drift exit turbo off, variant 3 (H16 D). */
export const P0: CarParams = { ...baseCar, driftTurbo: 0, driftEntry: 3 };
/** "дорога без края" of the criteria: no walls, no off-road loss, no lamps. */
export const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  crashMinSpeed: 1e9,
});
/** R85f start numbers (brief R85f "Параметры машины"); spread from a variable (not in CarParams yet). */
export const H20_ON = { releaseHold: 1, releaseSlide: 0.25 };
export const H20_OFF = { releaseHold: 0 };
export const rail = (r: number) => ({ driftRail: r });

/** New Car fields of R85f (relSide, relV); read through a cast until they exist in the type. */
export const relSide = (c: Car): unknown => (c as unknown as Record<string, unknown>).relSide;
export const relV = (c: Car): unknown => (c as unknown as Record<string, unknown>).relV;

const trackCache = new Map<string, Track>();
/** Straight `pre` segments, curve c for `len` segments (len < 0: forever), then straight. */
export function track(c: number, pre = 0, len = -1): Track {
  const key = `${c}/${pre}/${len}`;
  let t = trackCache.get(key);
  if (!t) {
    const segments = [];
    for (let i = 0; i < 12000; i++) {
      const inC = i >= pre && (len < 0 || i < pre + len);
      segments.push({ curve: inC ? c : 0 });
    }
    t = { segments };
    trackCache.set(key, t);
  }
  return t;
}

export interface Sample {
  x: number;
  vx: number;
  vel: number;
  speed: number;
  state: 'GRIP' | 'DRIFT';
}
export type Script = (t: number, c: Car, fr: InputFrame) => void;

/** Spike `run`: speed vmax at the start, input at tick i from t = i*DT; sample i is after tick i. */
export function run(p: CarParams, tr: Track, T: number, inp: Script, race?: RaceState): Sample[] {
  const r = race ?? createRace(1, 1);
  const car = r.cars[0]!;
  if (!race) car.speed = p.vmax;
  const fr: InputFrame = { steer: 0, brake: false, drift: false };
  const out: Sample[] = [];
  const n = Math.round(T / DT);
  for (let i = 0; i < n; i++) {
    inp(i * DT, car, fr);
    step(r, [fr], tr, [p]);
    out.push({ x: car.x, vx: car.vx, vel: car.vel, speed: car.speed, state: car.state });
  }
  return out;
}

/** Steady drift of side dir: finger down, steer dir for 0.05 s, then dir*u (spike S5/S6/S10). */
export const driftThen =
  (dir: number, u: number, tRel: number): Script =>
  (t, _c, fr) => {
    fr.drift = t < tRel;
    fr.steer = t < tRel ? (t < 0.05 ? dir : dir * u) : 0;
  };
/** GRIP, full steer s for tIn seconds, then 0 (spike S3/S10). */
export const gripThen =
  (s: number, tIn: number): Script =>
  (t, _c, fr) => {
    fr.drift = false;
    fr.steer = t < tIn ? s : 0;
  };

const holdCache = new Map<string, number>();
/**
 * Spike `holdSteer`: the steer toward dir that keeps the mean vx of the last second of a 3 s steady
 * drift on curve c at 0 (bisection on [-1, 1], 24 steps). Depends on p (driftRail moves it, R84c).
 */
export function holdSteer(p: CarParams, c: number, dir: number): number {
  const key = JSON.stringify([p, c, dir]);
  const h = holdCache.get(key);
  if (h !== undefined) return h;
  const tr = track(c);
  let lo = -1;
  let hi = 1;
  for (let it = 0; it < 24; it++) {
    const u = (lo + hi) / 2;
    const S = run(p, tr, 3, driftThen(dir, u, 1e9));
    let m = 0;
    for (let k = S.length - 120; k < S.length; k++) m += S[k]!.vx;
    m /= 120;
    if (m * dir > 0) hi = u;
    else lo = u;
  }
  const u = (lo + hi) / 2;
  holdCache.set(key, u);
  return u;
}

export const REL_TS = [0.3, 0.6, 1.0, 1.5, 3.0] as const;
export interface Release {
  out: Record<string, number>; // outward displacement from x at the release, by "0.3" ... "3"
  jump: number; // largest per-tick growth of max(0, outward vx) in the first 0.3 s
  first: number; // outward vx on the first tick after the release
  out01: number; // outward displacement at 0.1 s
  tEdge: number; // s until 1 half-width outward (NaN: not within the run)
}
/** Spike `relRow`: release at tRel, outward sign `o` (+1: outward = +x). */
export function release(S: Sample[], tRel: number, o: number): Release {
  const i0 = Math.round(tRel / DT) - 1;
  const a = S[i0]!;
  const at = (dt: number): Sample => S[Math.min(S.length - 1, i0 + Math.round(dt / DT))]!;
  const out: Record<string, number> = {};
  for (const t of REL_TS) out[String(t)] = o * (at(t).x - a.x);
  // Only growth of the outward component counts (R85f: a throw OUTWARD); braking a sideways motion
  // inward (e.g. vx 0.042 -> 0.004 toward the corner) is not a jump.
  let jump = 0;
  for (let k = 1; k <= Math.round(0.3 / DT); k++) {
    const d = Math.max(0, o * S[i0 + k]!.vx) - Math.max(0, o * S[i0 + k - 1]!.vx);
    if (d > jump) jump = d;
  }
  let tEdge = NaN;
  for (let k = 1; i0 + k < S.length; k++) {
    if (o * (S[i0 + k]!.x - a.x) >= 1) {
      tEdge = k * DT;
      break;
    }
  }
  return { out, jump, first: o * S[i0 + 1]!.vx, out01: o * (at(0.1).x - a.x), tEdge };
}

// ------------------------------------------------------------------------------------------ pins
/**
 * FNV-1a over the float64 bytes of the pre-T77 car fields of every tick (z, x, speed, vx, steer,
 * yaw, yawRate, vel, carry, angle, state, dir, driftTicks). The T77 fields are not hashed, so a hash
 * recorded before T77 pins the old trajectory bit for bit.
 */
export function traceHash(p: CarParams, tr: Track, T: number, inp: Script): string {
  const race = createRace(1, 1);
  const car = race.cars[0]!;
  car.speed = p.vmax;
  const fr: InputFrame = { steer: 0, brake: false, drift: false };
  const buf = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  const mix = (v: number): void => {
    buf.setFloat64(0, v);
    for (let b = 0; b < 8; b++) {
      h ^= buf.getUint8(b);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const n = Math.round(T / DT);
  for (let i = 0; i < n; i++) {
    inp(i * DT, car, fr);
    step(race, [fr], tr, [p]);
    mix(car.z);
    mix(car.x);
    mix(car.speed);
    mix(car.vx);
    mix(car.steer);
    mix(car.yaw);
    mix(car.yawRate);
    mix(car.vel);
    mix(car.carry);
    mix(car.angle);
    mix(car.state === 'DRIFT' ? 1 : 0);
    mix(car.dir);
    mix(car.driftTicks);
  }
  return h.toString(16).padStart(8, '0') + ':' + car.x.toPrecision(17);
}

let twisty: Track | undefined;
export function twistyTrack(): Track {
  twisty ??= buildTrack(loadTestTwisty().def);
  return twisty;
}

/** Seeded steer/drift script: steer redrawn every 0.25 s (a quarter of the draws exactly 0). */
export function randomScript(seed: number, withDrift: boolean): Script {
  const g = new Lcg(seed);
  let steer = 0;
  let drift = false;
  return (t, _c, fr) => {
    if (Math.round(t / DT) % 30 === 0) {
      const r = g.next();
      steer = r < 0.25 ? 0 : 2 * g.next() - 1;
      drift = withDrift && g.next() < 0.4;
    }
    fr.steer = steer;
    fr.drift = drift;
  };
}

/** Pin scenarios: [name, track, seconds, script]. */
export type Scenario = [string, () => Track, number, () => Script];
/** Straight-road scenarios (R85e, R85f, R84c: nothing may change, bit for bit). */
export const STRAIGHT_SCENARIOS: Scenario[] = [
  ['grip steer 1 for 0.6 s -> 0', () => track(0), 2, () => gripThen(1, 0.6)],
  ['grip steer -0.5 for 0.3 s -> 0', () => track(0), 2, () => gripThen(-0.5, 0.3)],
  [
    'lane change: full steer until x >= 0.25, then 0',
    () => track(0),
    2,
    () => (_t, c, fr) => {
      fr.drift = false;
      fr.steer = c.x < 0.25 ? 1 : 0;
    },
  ],
  ['drift left 1 s, release', () => track(0), 2.5, () => driftThen(-1, 1, 1)],
  ['drift right at the floor 1 s, release', () => track(0), 2.5, () => driftThen(1, 0, 1)],
  ['seeded steer and drift, straight', () => track(0), 15, () => randomScript(7, true)],
];
/** Held drift in corners from the first tick (all ticks DRIFT): R84c at driftRail 0 = as it was. */
export const HELD_DRIFT_SCENARIOS: Scenario[] = [];
for (const cls of ['easy', 'medium', 'hard', 'sharp'])
  for (const [dir, u] of [
    [-1, 0],
    [-1, 0.5],
    [-1, 1],
    [1, 0],
    [1, 1],
  ] as const)
    HELD_DRIFT_SCENARIOS.push([
      `held drift ${cls}, dir ${dir}, steer ${u} toward dir`,
      () => track(dir * C[cls]!),
      3,
      () => driftThen(dir, u, 1e9),
    ]);
HELD_DRIFT_SCENARIOS.push([
  'held drift against the corner (hard right, dir -1, steer -1)',
  () => track(C.hard!),
  1.5,
  () => driftThen(-1, 1, 1e9),
]);
/** Everything (corners, releases, seeded twisty): pinned with gripLead 0, gripDodge 0 and H20/H21 off. */
export const LEGACY_SCENARIOS: Scenario[] = [
  ...STRAIGHT_SCENARIOS,
  ['grip medium inward 2 s -> 0', () => track(C.medium!), 5, () => gripThen(1, 2)],
  ['grip hard inward 2 s -> 0', () => track(C.hard!), 5, () => gripThen(1, 2)],
  ['grip sharp left inward 2 s -> 0', () => track(-C.sharp!), 5, () => gripThen(-1, 2)],
  ['drift hard left 0.87 3 s -> release', () => track(-C.hard!), 5, () => driftThen(-1, 0.87, 3)],
  ['drift medium right floor 3 s -> release', () => track(C.medium!), 5, () => driftThen(1, 0, 3)],
  ['drift sharp left full 3 s -> release', () => track(-C.sharp!), 5, () => driftThen(-1, 1, 3)],
  [
    'drift hard into a straight, release on the straight',
    () => track(-C.hard!, 0, 180),
    6,
    () => driftThen(-1, 0.87, 4),
  ],
  ['seeded steer and drift, test-twisty', twistyTrack, 30, () => randomScript(11, true)],
  ['seeded steer, GRIP only, test-twisty', twistyTrack, 30, () => randomScript(23, false)],
];

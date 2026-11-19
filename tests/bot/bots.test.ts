// T16 driver bots. Written from the task spec before the implementation; do not edit to pass.
// Bots see only the car and the track ahead and answer with an InputFrame (R4).
import { describe, expect, it } from 'vitest';
import { botParams, BOT_NAMES } from '../../src/data/bots';
import { baseCar } from '../../src/data/cars';
import { curveClasses, loadTestTwisty } from '../../src/data/tracks';
import { botInput, createBot, holdSpeedLimit } from '../../src/bot/driver';
import { SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { buildTrack } from '../../src/sim/track';
import type { InputFrame, Track } from '../../src/sim/types';

const twisty = (): Track => buildTrack(loadTestTwisty().def);

interface Trace {
  steer: number[];
  brake: boolean[];
  drift: boolean[];
  curve: number[]; // curve of the segment under the car when the input was chosen
  x: number[];
  speed: number[];
  ticks: number;
  offroadTicks: number;
  finished: boolean;
}

/** Drives `laps` laps with the named bot; records every frame. maxTicks guards against a stuck bot. */
function drive(name: string, seed: number, laps: number, track: Track, maxTicks: number): Trace {
  const race = createRace(seed, 1);
  const car = race.cars[0]!;
  const bot = createBot(seed);
  const bp = botParams[name as keyof typeof botParams];
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const inputs = [frame];
  const params = [baseCar];
  const goal = laps * track.segments.length;
  const t: Trace = {
    steer: [],
    brake: [],
    drift: [],
    curve: [],
    x: [],
    speed: [],
    ticks: 0,
    offroadTicks: 0,
    finished: false,
  };
  while (car.z < goal && race.tick < maxTicks) {
    botInput(bot, bp, car, track, baseCar, frame);
    t.steer.push(frame.steer);
    t.brake.push(frame.brake);
    t.drift.push(frame.drift);
    t.curve.push(track.segments[Math.floor(car.z) % track.segments.length]!.curve);
    step(race, inputs, track, params);
    t.x.push(car.x);
    t.speed.push(car.speed);
    if (car.x > 1 || car.x < -1) t.offroadTicks++;
  }
  t.ticks = race.tick;
  t.finished = car.z >= goal;
  return t;
}

// Cap derived from the track: 3 laps at vmax take 3 * len / SEG_PER_UNIT seconds (60 seg/s); x3 margin; 120 ticks/s.
const MAX_TICKS_3_LAPS = Math.ceil(3 * (twisty().segments.length / SEG_PER_UNIT) * 3 * 120);
const AVERAGE_MAX_OFFROAD_FRACTION = 0.05; // stated bound (stage 1 starting corridor)

describe('T16 bot set', () => {
  it('has novice, average and expert', () => {
    expect([...BOT_NAMES].sort()).toEqual(['average', 'expert', 'novice']);
    for (const n of BOT_NAMES) expect(botParams[n]).toBeDefined();
  });
});

describe('T16 hold speed limit from R11/R13', () => {
  const p = baseCar;
  const k = p.centrifugal * p.kCurve;
  it('full steer, no width allowance: sp* = steerRate / (0.25*steerRate + centrifugal*kCurve*|c|)', () => {
    const want = p.steerRate / (0.25 * p.steerRate + k * curveClasses.hard);
    expect(holdSpeedLimit(curveClasses.hard, 1, 0, p)).toBeCloseTo(want, 9);
    expect(holdSpeedLimit(-curveClasses.hard, 1, 0, p)).toBeCloseTo(want, 9);
  });
  it('at the limit, steady R11 lateral speed equals the R13 push', () => {
    for (const c of [curveClasses.easy, curveClasses.medium, curveClasses.hard]) {
      for (const s of [0.6, 0.85, 1]) {
        const sp = holdSpeedLimit(c, s, 0, p);
        if (sp >= 1) continue;
        const vx = s * p.steerRate * sp * (1 - 0.25 * sp);
        const push = c * sp * sp * k;
        expect(vx).toBeCloseTo(push, 9);
      }
    }
  });
  it('is monotonic: steeper curve -> lower limit; more steer or more allowance -> higher', () => {
    const e = holdSpeedLimit(curveClasses.easy, 0.9, 0, p);
    const m = holdSpeedLimit(curveClasses.medium, 0.9, 0, p);
    const h = holdSpeedLimit(curveClasses.hard, 0.9, 0, p);
    expect(e).toBeGreaterThan(m);
    expect(m).toBeGreaterThan(h);
    expect(holdSpeedLimit(curveClasses.hard, 1, 0, p)).toBeGreaterThan(h);
    expect(holdSpeedLimit(curveClasses.hard, 0.9, 0.5, p)).toBeGreaterThan(h);
  });
  it('a straight imposes no limit (>= 1)', () => {
    expect(holdSpeedLimit(0, 1, 0, p)).toBeGreaterThanOrEqual(1);
  });
});

describe('T16 bots output valid InputFrames (R4)', () => {
  const track = twisty();
  for (const name of BOT_NAMES) {
    it(`${name}: steer finite in [-1, 1], brake and drift boolean`, () => {
      const t = drive(name, 7, 1, track, MAX_TICKS_3_LAPS);
      expect(t.steer.length).toBeGreaterThan(1000);
      for (let i = 0; i < t.steer.length; i++) {
        const s = t.steer[i]!;
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(-1);
        expect(s).toBeLessThanOrEqual(1);
        expect(typeof t.brake[i]).toBe('boolean');
        expect(typeof t.drift[i]).toBe('boolean');
      }
    });
  }
  it('novice: never drifts', () => {
    const t = drive('novice', 7, 1, track, MAX_TICKS_3_LAPS);
    expect(t.drift.some((d) => d)).toBe(false);
  });
  it('average: drifts on some ticks', () => {
    const t = drive('average', 7, 1, track, MAX_TICKS_3_LAPS);
    expect(t.drift.some((d) => d)).toBe(true);
  });
  it('expert: drifts on some ticks, never brakes inside a corner with |curve| >= driftMinCurve', () => {
    const t = drive('expert', 7, 1, track, MAX_TICKS_3_LAPS);
    const minCurve = botParams.expert.driftMinCurve;
    expect(t.drift.some((d) => d)).toBe(true);
    let sharpTicks = 0;
    for (let i = 0; i < t.curve.length; i++) {
      if (Math.abs(t.curve[i]!) >= minCurve) {
        sharpTicks++;
        expect(t.brake[i]).toBe(false);
      }
    }
    expect(sharpTicks).toBeGreaterThan(0);
  });
  it('novice never brakes', () => {
    const t = drive('novice', 3, 1, track, MAX_TICKS_3_LAPS);
    expect(t.brake.some((b) => b)).toBe(false);
  });
});

describe('T16 determinism (R2)', () => {
  const track = twisty();
  for (const name of BOT_NAMES) {
    it(`${name}: same seed -> identical run`, () => {
      const a = drive(name, 42, 1, track, 6000);
      const b = drive(name, 42, 1, track, 6000);
      expect(b.steer).toEqual(a.steer);
      expect(b.brake).toEqual(a.brake);
      expect(b.x).toEqual(a.x);
      expect(b.speed).toEqual(a.speed);
    });
    it(`${name}: different seeds differ when steering noise is on`, () => {
      if (botParams[name].noiseAmp <= 0) return;
      const a = drive(name, 1, 1, track, 3000);
      const b = drive(name, 2, 1, track, 3000);
      expect(b.steer).not.toEqual(a.steer);
    });
  }
});

describe('T16 average bot on the twisty loop', () => {
  it(`completes 3 laps, off asphalt <= ${AVERAGE_MAX_OFFROAD_FRACTION * 100}% of the time`, () => {
    const t = drive('average', 1, 3, twisty(), MAX_TICKS_3_LAPS);
    expect(t.finished).toBe(true);
    expect(t.offroadTicks / t.ticks).toBeLessThanOrEqual(AVERAGE_MAX_OFFROAD_FRACTION);
  });
});

describe('T16 skill ordering', () => {
  it('3-lap time: novice >= 10% slower than average; expert at most 1% slower than average', () => {
    const track = twisty();
    const n = drive('novice', 1, 3, track, MAX_TICKS_3_LAPS);
    const a = drive('average', 1, 3, track, MAX_TICKS_3_LAPS);
    const e = drive('expert', 1, 3, track, MAX_TICKS_3_LAPS);
    expect(n.finished && a.finished && e.finished).toBe(true);
    expect(n.ticks).toBeGreaterThanOrEqual(1.1 * a.ticks);
    expect(e.ticks).toBeLessThanOrEqual(1.01 * a.ticks);
  });
});

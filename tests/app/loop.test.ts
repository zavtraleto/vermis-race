import { describe, expect, it } from 'vitest';
import { MAX_STEPS_PER_FRAME, copyRaceState, createLoop } from '../../src/app/loop';
import type { InputSource, Loop } from '../../src/app/loop';
import { baseCarA as baseCar } from '../sim/baseCarA';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { InputFrame, RaceState } from '../../src/sim/types';

const track = makeStraightTrack(1000);
const FRAME60 = 1 / 60;
const FRAME120 = 1 / 120;

const gasSource: InputSource = (_t, out) => {
  for (const f of out) {
    f.steer = 0;
    f.brake = false;
    f.drift = false;
  }
};

function mk(cars = 1, readInput: InputSource = gasSource, maxStepsPerFrame?: number): Loop {
  const params = Array.from({ length: cars }, () => baseCar);
  return createLoop(createRace(1, cars), {
    track,
    params,
    readInput,
    ...(maxStepsPerFrame === undefined ? {} : { maxStepsPerFrame }),
  });
}

/** Reference: direct stepping with the same inputs source. */
function direct(cars: number, n: number, readInput: InputSource): RaceState {
  const s = createRace(1, cars);
  const params = Array.from({ length: cars }, () => baseCar);
  const inputs: InputFrame[] = Array.from({ length: cars }, () => ({
    steer: 0,
    brake: false,
    drift: false,
  }));
  for (let i = 0; i < n; i++) {
    readInput(s.tick, inputs);
    step(s, inputs, track, params);
  }
  return s;
}

describe('R1 step count per frame', () => {
  it('1/60 s frames -> exactly 2 ticks, for 600 frames', () => {
    const loop = mk();
    for (let i = 0; i < 600; i++) expect(loop.advance(FRAME60)).toBe(2);
    expect(loop.curr.tick).toBe(1200);
  });
  it('1/120 s frames -> exactly 1 tick, for 600 frames', () => {
    const loop = mk();
    for (let i = 0; i < 600; i++) expect(loop.advance(FRAME120)).toBe(1);
    expect(loop.curr.tick).toBe(600);
  });
  it('uneven frames 0.004 x3 -> 0, 0, 1 ticks', () => {
    // acc in ticks: 0.48, 0.96, 1.44 -> 0, 0, 1
    const loop = mk();
    expect(loop.advance(0.004)).toBe(0);
    expect(loop.advance(0.004)).toBe(0);
    expect(loop.advance(0.004)).toBe(1);
  });
  it('mixed 0.010/0.020/0.003', () => {
    // 1.2 -> 1 tick (acc .2); +2.4 = 2.6 -> 2 ticks (acc .6); +0.36 = .96 -> 0 ticks. Total 3.
    const loop = mk();
    expect(loop.advance(0.01)).toBe(1);
    expect(loop.advance(0.02)).toBe(2);
    expect(loop.advance(0.003)).toBe(0);
    expect(loop.curr.tick).toBe(3);
    expect(Math.abs(loop.alpha - 0.96)).toBeLessThan(1e-9);
  });
  it('long pause 1.0 s -> MAX_STEPS_PER_FRAME ticks, alpha 0, accumulator dropped', () => {
    const loop = mk();
    expect(loop.advance(1.0)).toBe(MAX_STEPS_PER_FRAME);
    expect(loop.alpha).toBe(0);
    expect(loop.advance(FRAME120)).toBe(1);
    expect(loop.curr.tick).toBe(MAX_STEPS_PER_FRAME + 1);
  });
  it('maxStepsPerFrame option caps at 3', () => {
    const loop = mk(1, gasSource, 3);
    expect(loop.advance(0.1)).toBe(3);
    expect(loop.curr.tick).toBe(3);
    expect(loop.alpha).toBe(0);
  });
  it('negative / NaN / Infinity frame -> 0 ticks, state untouched', () => {
    const loop = mk();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(loop.advance(bad)).toBe(0);
      expect(loop.curr.tick).toBe(0);
      expect(loop.alpha).toBe(0);
    }
  });
});

describe('R1 alpha', () => {
  it('is 0 before the first frame', () => {
    expect(mk().alpha).toBe(0);
  });
  it('0.004 x3 -> 0.48, 0.96, 0.44', () => {
    const loop = mk();
    loop.advance(0.004);
    expect(Math.abs(loop.alpha - 0.48)).toBeLessThan(1e-9);
    loop.advance(0.004);
    expect(Math.abs(loop.alpha - 0.96)).toBeLessThan(1e-9);
    loop.advance(0.004);
    expect(Math.abs(loop.alpha - 0.44)).toBeLessThan(1e-9);
  });
  it('is ~0 after 1/60 s frames', () => {
    const loop = mk();
    for (let i = 0; i < 300; i++) {
      loop.advance(FRAME60);
      expect(loop.alpha).toBeLessThan(1e-6);
    }
  });
  it('always in [0, 1) for pseudo-random frame lengths', () => {
    const loop = mk();
    let r = 12345;
    for (let i = 0; i < 2000; i++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      loop.advance((r % 1000) / 50000); // 0..0.02 s
      expect(loop.alpha).toBeGreaterThanOrEqual(0);
      expect(loop.alpha).toBeLessThan(1);
    }
  });
});

describe('R1 prev lags curr by exactly one tick', () => {
  it('prev.tick === curr.tick - 1 and prev equals reference state', () => {
    const loop = mk();
    loop.advance(FRAME60);
    loop.advance(0.0123);
    expect(loop.curr.tick).toBeGreaterThanOrEqual(1);
    expect(loop.prev.tick).toBe(loop.curr.tick - 1);
    expect(loop.prev).toEqual(direct(1, loop.curr.tick - 1, gasSource));
    expect(loop.curr).toEqual(direct(1, loop.curr.tick, gasSource));
  });
  it('frame without ticks leaves prev and curr unchanged', () => {
    const loop = mk();
    loop.advance(FRAME60);
    const p = JSON.stringify(loop.prev);
    const c = JSON.stringify(loop.curr);
    expect(loop.advance(0.001)).toBe(0);
    expect(JSON.stringify(loop.prev)).toBe(p);
    expect(JSON.stringify(loop.curr)).toBe(c);
  });
  it('prev and curr are stable references', () => {
    const loop = mk();
    const p = loop.prev;
    const c = loop.curr;
    for (let i = 0; i < 20; i++) loop.advance(FRAME60);
    loop.stepTicks(5);
    expect(loop.prev).toBe(p);
    expect(loop.curr).toBe(c);
  });
  it('before any tick prev and curr equal initial; initial is never mutated', () => {
    const initial = createRace(7, 2);
    const snapshot = JSON.stringify(initial);
    const loop = createLoop(initial, { track, params: [baseCar, baseCar], readInput: gasSource });
    expect(loop.prev).toEqual(initial);
    expect(loop.curr).toEqual(initial);
    loop.advance(0.5);
    loop.stepTicks(10);
    expect(JSON.stringify(initial)).toBe(snapshot);
    expect(loop.curr).not.toBe(initial);
  });
});

describe('R1 input reading', () => {
  it('readInput is called once per tick with consecutive tick numbers', () => {
    const seen: number[] = [];
    const loop = mk(1, (t, out) => {
      seen.push(t);
      gasSource(t, out);
    });
    for (let i = 0; i < 10; i++) loop.advance(FRAME60);
    loop.stepTicks(3);
    expect(seen).toEqual(Array.from({ length: 23 }, (_, i) => i));
  });
  it('readInput receives one InputFrame per car', () => {
    let len = -1;
    const loop = mk(3, (t, out) => {
      len = out.length;
      gasSource(t, out);
    });
    loop.advance(FRAME120);
    expect(len).toBe(3);
  });
  it('input reaches step: brake on ticks 50..99 matches direct run', () => {
    const src: InputSource = (t, out) => {
      out[0]!.steer = 0;
      out[0]!.drift = false;
      out[0]!.brake = t >= 50 && t < 100;
    };
    const loop = mk(1, src);
    for (let i = 0; i < 75; i++) loop.advance(FRAME60); // 150 ticks
    expect(loop.curr).toEqual(direct(1, 150, src));
    const noBrake = direct(1, 150, gasSource);
    expect(loop.curr.cars[0]!.speed).toBeLessThan(noBrake.cars[0]!.speed);
  });
});

describe('R1/R2 determinism', () => {
  const src: InputSource = (t, out) => {
    out[0]!.steer = Math.sin(t / 17);
    out[0]!.drift = t % 90 > 60;
    out[0]!.brake = t % 200 > 180;
    out[1]!.steer = -Math.sin(t / 23);
    out[1]!.drift = false;
    out[1]!.brake = false;
  };
  const frames = [0.016, 0.017, 0.004, 0.033, 0.0083, 0.02, 0.001, 0.25, 0.0167];
  it('two loops with the same frame sequence are identical', () => {
    const a = mk(2, src);
    const b = mk(2, src);
    for (let i = 0; i < 300; i++) {
      const f = frames[i % frames.length]!;
      expect(a.advance(f)).toBe(b.advance(f));
    }
    expect(a.curr).toEqual(b.curr);
    expect(a.prev).toEqual(b.prev);
    expect(a.alpha).toBe(b.alpha);
  });
  it('matches direct stepping for the same tick count', () => {
    const loop = mk(2, src);
    for (let i = 0; i < 300; i++) loop.advance(frames[i % frames.length]!);
    expect(loop.curr).toEqual(direct(2, loop.curr.tick, src));
  });
});

describe('golden example (brief section 5) through the loop', () => {
  it('60 frames of 1/60 s -> 120 ticks', () => {
    const loop = mk();
    for (let i = 0; i < 60; i++) loop.advance(FRAME60);
    const c = loop.curr.cars[0]!;
    // speed = 0.22 * 120 / 120 = 0.22; z = 0.22 * (120*121/2) / 120^2 * 60 = 6.655
    expect(loop.curr.tick).toBe(120);
    expect(Math.abs(c.speed - 0.22)).toBeLessThan(1e-9);
    expect(Math.abs(c.z - 6.655)).toBeLessThan(1e-6);
    expect(Math.abs(c.x)).toBe(0);
    expect(Math.abs(c.vx)).toBe(0);
    expect(Math.abs(c.heading)).toBe(0);
  });
});

describe('stepTicks', () => {
  it('runs exactly n ticks, ignores the cap, keeps alpha', () => {
    const loop = mk(1, gasSource, 3);
    loop.advance(0.004); // alpha 0.48
    loop.stepTicks(50);
    expect(loop.curr.tick).toBe(50);
    expect(loop.prev.tick).toBe(49);
    expect(Math.abs(loop.alpha - 0.48)).toBeLessThan(1e-9);
    // accumulator untouched: 0.48 + 0.52 -> exactly one more tick
    expect(loop.advance(0.52 / 120)).toBe(1);
  });
  it('stepTicks(0) does nothing', () => {
    const loop = mk();
    loop.stepTicks(0);
    expect(loop.curr.tick).toBe(0);
  });
});

describe('copyRaceState', () => {
  it('copies tick, rng and all car fields; src not mutated', () => {
    const src = createRace(42, 2);
    const params = [baseCar, baseCar];
    const inputs: InputFrame[] = [
      { steer: 0.7, brake: false, drift: true },
      { steer: -0.4, brake: false, drift: false },
    ];
    for (let i = 0; i < 400; i++) {
      inputs[0]!.drift = i % 150 > 40;
      step(src, inputs, track, params);
    }
    const before = JSON.stringify(src);
    const dst = createRace(999, 2);
    copyRaceState(src, dst);
    expect(JSON.stringify(dst)).toBe(JSON.stringify(src));
    expect(JSON.stringify(src)).toBe(before);
    expect(dst.cars).not.toBe(src.cars);
    expect(dst.cars[0]).not.toBe(src.cars[0]);
  });
});

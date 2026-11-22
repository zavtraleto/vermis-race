import { describe, expect, it } from 'vitest';
import { loadTestTwisty } from '../../src/data/tracks';
import { buildTrack } from '../../src/sim/track';
import type { Car, InputFrame, RaceState } from '../../src/sim/types';
import { P, frame, race1, stepN } from './r200_helpers';

// R2/R3 with the R200 driving state and an input that changes every tick.
const track = buildTrack(loadTestTwisty().def);

function inputAt(t: number): InputFrame {
  // steer = sin(t/37); gas swings 0..1; brake pulses 20 ticks every 150
  return frame(Math.sin(t / 37), 0.5 + 0.5 * Math.cos(t / 53), t % 150 < 20 ? 1 : 0);
}

const FIELDS: (keyof Car)[] = [
  'z',
  'x',
  'speed',
  'travel',
  'heading',
  'steer',
  'travelRate',
  'slipRate',
  'counter',
  'driftTimer',
  'edge',
  'refAngle',
  'wallTicks',
  'prevGas',
  'prevBrake',
];

function run(n: number, s: RaceState = race1({ speed: 0.6 })): RaceState {
  stepN(s, n, inputAt, track, P);
  return s;
}

describe('R2 determinism with changing input', () => {
  it('R2: two runs with the same varying input are identical field by field', () => {
    const a = run(900);
    const b = run(900);
    const ca = a.cars[0]!;
    const cb = b.cars[0]!;
    for (const f of FIELDS) expect(Object.is(ca[f], cb[f]), f).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('R2: the varying input actually moves the R200 state (the test is not vacuous)', () => {
    const c = run(900).cars[0]!;
    expect(c.x).not.toBe(0);
    expect(c.heading).not.toBe(0);
    expect(c.travel).not.toBe(0);
    expect(c.heading - c.travel).not.toBe(0);
  });
});

describe('R3 serialization round-trip with the R200 state', () => {
  it('R3: JSON clone at tick 450 continues identically for 450 more ticks', () => {
    const a = run(450);
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    run(450, a);
    run(450, b);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

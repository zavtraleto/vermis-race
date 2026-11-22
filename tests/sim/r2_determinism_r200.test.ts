import { describe, expect, it } from 'vitest';
import curves from '../../src/data/tracks/curves.json';
import type { Car, InputFrame, RaceState, Track } from '../../src/sim/types';
import { step } from '../../src/sim/race';
import { P, frame, race1 } from './r200_helpers';

// R2/R3 with the R200 driving state and an input that changes every tick.
// Gentle winding road (curve = easy*sin(i/40)): the car stays on the asphalt, so R18/R211 never act.
const track: Track = { segments: [] };
for (let i = 0; i < 4000; i++) track.segments.push({ curve: curves.easy * Math.sin(i / 40) });

/**
 * steer = 0.5*sin(t/37) plus a pull back to the centre (keeps the car on the asphalt, away from the
 * R211 wall, next slice); gas swings 0..1; brake pulses 20 ticks every 150.
 */
function inputAt(t: number, c: Car): InputFrame {
  const steer = Math.max(-1, Math.min(1, 0.5 * Math.sin(t / 37) - 3 * c.x - 6 * c.travel));
  return frame(steer, 0.5 + 0.5 * Math.cos(t / 53), t % 150 < 20 ? 1 : 0);
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

function run(n: number, s: RaceState = race1({ speed: 0.6 }), each?: (c: Car) => void): RaceState {
  const inputs = [frame(0)];
  const params = [P];
  for (let i = 0; i < n; i++) {
    inputs[0] = inputAt(s.tick, s.cars[0]!);
    step(s, inputs, track, params);
    if (each) each(s.cars[0]!);
  }
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
    let maxX = 0;
    const c = run(900, undefined, (k) => {
      maxX = Math.max(maxX, Math.abs(k.x));
    }).cars[0]!;
    expect(maxX).toBeLessThanOrEqual(1); // stays on the asphalt: no R18/R211 wall in this test
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

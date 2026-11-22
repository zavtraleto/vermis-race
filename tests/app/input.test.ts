import { describe, expect, it } from 'vitest';
import { copyInputFrame, createReadInput } from '../../src/app/input';
import type { PlayerInput } from '../../src/input/player';
import type { InputFrame } from '../../src/sim/types';

const fakePlayer = (): PlayerInput => {
  const last: InputFrame = { steer: 0, gas: 1, brake: 0, driftTap: false };
  return {
    last,
    read(out: InputFrame): void {
      out.steer = 0.7;
      out.gas = 0;
      out.brake = 1;
      out.driftTap = false;
      last.steer = 0.7;
      last.gas = 0;
      last.brake = 1;
      last.driftTap = false;
    },
  };
};

describe('createReadInput', () => {
  it('car 0 gets the player frame; the rest get the released input (R201) even if they held garbage', () => {
    const readInput = createReadInput(fakePlayer());
    const out: InputFrame[] = [
      { steer: -1, gas: 1, brake: 0, driftTap: false },
      { steer: 0.9, gas: 0, brake: 1, driftTap: false },
      { steer: -0.4, gas: 0, brake: 1, driftTap: false },
      { steer: 0.1, gas: 1, brake: 0, driftTap: false },
    ];
    readInput(0, out);
    expect(out[0]).toEqual({ steer: 0.7, gas: 0, brake: 1, driftTap: false });
    for (let i = 1; i < out.length; i++) {
      expect(out[i], `car ${i}`).toEqual({ steer: 0, gas: 1, brake: 0, driftTap: false });
    }
  });

  it('works for a single car and keeps array length and frame identity', () => {
    const readInput = createReadInput(fakePlayer());
    const out: InputFrame[] = [{ steer: 0, gas: 1, brake: 0, driftTap: false }];
    const f0 = out[0];
    readInput(5, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(f0);
    expect(out[0]).toEqual({ steer: 0.7, gas: 0, brake: 1, driftTap: false });
  });

  it('is repeatable across ticks', () => {
    const readInput = createReadInput(fakePlayer());
    const out: InputFrame[] = [
      { steer: 0, gas: 1, brake: 0, driftTap: false },
      { steer: 0, gas: 1, brake: 0, driftTap: false },
    ];
    readInput(0, out);
    out[1]!.steer = 0.5;
    readInput(1, out);
    expect(out[1]).toEqual({ steer: 0, gas: 1, brake: 0, driftTap: false });
  });
});

describe('copyInputFrame', () => {
  it('returns an equal but distinct object', () => {
    const src: InputFrame = { steer: -0.25, gas: 0, brake: 1, driftTap: false };
    const c = copyInputFrame(src);
    expect(c).toEqual(src);
    expect(c).not.toBe(src);
    src.steer = 1;
    expect(c.steer).toBe(-0.25);
  });
});

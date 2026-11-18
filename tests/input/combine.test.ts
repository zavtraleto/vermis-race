import { describe, expect, it } from 'vitest';
import { combineInputs } from '../../src/input/combine';
import type { InputFrame } from '../../src/sim/types';

const f = (steer: number, brake = false, drift = false): InputFrame => ({ steer, brake, drift });
const out0 = (): InputFrame => f(9, true, true); // garbage that must be overwritten
const bools = [false, true];

describe('combineInputs', () => {
  it.each([
    [0.3, 0.8, 0.8],
    [0.8, 0.3, 0.8],
    [0.3, -0.8, -0.8],
    [-0.8, 0.3, -0.8],
    [-0.3, -0.8, -0.8],
    [0, 0.2, 0.2],
    [0.2, 0, 0.2],
    [0, 0, 0],
  ])('steer(%f, %f) = %f (larger magnitude)', (a, b, expected) => {
    const out = out0();
    combineInputs(f(a), f(b), out);
    expect(out.steer).toBe(expected);
  });

  it('tie in magnitude -> a.steer', () => {
    const out = out0();
    combineInputs(f(0.5), f(-0.5), out);
    expect(out.steer).toBe(0.5);
    combineInputs(f(-0.5), f(0.5), out);
    expect(out.steer).toBe(-0.5);
  });

  it('brake and drift are OR', () => {
    for (const ab of bools)
      for (const bb of bools)
        for (const ad of bools)
          for (const bd of bools) {
            const out = out0();
            combineInputs(f(0, ab, ad), f(0, bb, bd), out);
            expect(out.brake).toBe(ab || bb);
            expect(out.drift).toBe(ad || bd);
          }
  });

  it('out may alias a', () => {
    const a = f(0.3, false, true);
    const b = f(-0.8, true, false);
    combineInputs(a, b, a);
    expect(a).toEqual({ steer: -0.8, brake: true, drift: true });
    expect(b).toEqual({ steer: -0.8, brake: true, drift: false });
  });

  it('out may alias b', () => {
    const a = f(0.9, true, false);
    const b = f(-0.2, false, true);
    combineInputs(a, b, b);
    expect(b).toEqual({ steer: 0.9, brake: true, drift: true });
    expect(a).toEqual({ steer: 0.9, brake: true, drift: false });
  });

  it('does not mutate inputs when out is separate', () => {
    const a = f(0.3, true, false);
    const b = f(-0.8, false, true);
    combineInputs(a, b, out0());
    expect(a).toEqual({ steer: 0.3, brake: true, drift: false });
    expect(b).toEqual({ steer: -0.8, brake: false, drift: true });
  });

  it('is commutative when magnitudes differ', () => {
    const o1 = out0();
    const o2 = out0();
    combineInputs(f(0.3, true), f(-0.8, false, true), o1);
    combineInputs(f(-0.8, false, true), f(0.3, true), o2);
    expect(o1).toEqual(o2);
  });
});

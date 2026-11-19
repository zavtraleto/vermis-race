import { describe, expect, it } from 'vitest';
import { createAutoDrift } from '../../src/input/autoDrift';

// Literal config (H3 variant C): enter at |steer| >= 0.85, release below 0.1 on the latched side.
const cfg = { autoDriftSteer: 0.85, autoDriftRelease: 0.1 };
const mk = () => createAutoDrift(cfg);

describe('H3 variant C auto drift: entering', () => {
  it('idle below the threshold stays false on both sides', () => {
    const a = mk();
    for (const s of [0, 0.3, 0.84, -0.3, -0.84, 0.8499, -0.8499]) expect(a.update(s)).toBe(false);
  });

  it.each([0.85, 0.9, 1, -0.85, -0.9, -1])('steer %f at or past the threshold latches', (s) => {
    expect(mk().update(s)).toBe(true);
  });
});

describe('H3 variant C auto drift: latched', () => {
  it.each([1, -1])('side %i: stays true while steer*side >= release', (side) => {
    const a = mk();
    expect(a.update(0.9 * side)).toBe(true);
    for (const s of [0.5, 0.2, 0.1, 0.85, 1]) expect(a.update(s * side)).toBe(true);
  });

  it.each([1, -1])('side %i: returning to centre ends the drift and it stays off', (side) => {
    const a = mk();
    a.update(0.9 * side);
    expect(a.update(0.05 * side)).toBe(false);
    expect(a.update(0)).toBe(false);
    expect(a.update(0.5 * side)).toBe(false); // unlatched, below the enter threshold
  });

  it.each([1, -1])('side %i: release boundary (0.1 holds, just below ends)', (side) => {
    const a = mk();
    a.update(0.9 * side);
    expect(a.update(0.1 * side)).toBe(true);
    expect(a.update(0.0999 * side)).toBe(false);
  });

  it.each([1, -1])('side %i: crossing to the other side ends the drift', (side) => {
    const a = mk();
    a.update(0.9 * side);
    expect(a.update(-0.3 * side)).toBe(false);
  });

  it.each([1, -1])('side %i: opposite full steer gives false first, a later update latches the other way', (side) => {
    const a = mk();
    a.update(0.9 * side);
    expect(a.update(-1 * side)).toBe(false); // unlatch happens first
    expect(a.update(-1 * side)).toBe(true); // idle -> latches the new side
    expect(a.update(-0.5 * side)).toBe(true);
    expect(a.update(0.5 * side)).toBe(false); // old side is now the wrong side
  });

  it('is deterministic: same input sequence gives identical outputs on two instances', () => {
    const seq = [0, 0.9, 0.5, 0.05, -0.9, -0.2, 0.2, 0.9, -1, -1, 0];
    const a = mk();
    const b = mk();
    expect(seq.map((s) => a.update(s))).toEqual(seq.map((s) => b.update(s)));
  });

  it('always returns a boolean and keeps no history', () => {
    const a = mk();
    for (let i = 0; i < 5000; i++) expect(typeof a.update(Math.sin(i))).toBe('boolean');
    a.update(0); // centre unlatches for sure
    expect(a.update(0.5)).toBe(false);
    expect(a.update(0.9)).toBe(true);
  });
});

describe('H3 variant C auto drift: reset', () => {
  it.each([1, -1])('side %i: reset unlatches', (side) => {
    const a = mk();
    a.update(0.9 * side);
    a.reset();
    expect(a.update(0.5 * side)).toBe(false); // would stay true if still latched
  });

  it('reset on an idle instance is harmless', () => {
    const a = mk();
    a.reset();
    expect(a.update(0.9)).toBe(true);
  });
});

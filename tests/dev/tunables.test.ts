import { describe, expect, it } from 'vitest';
import { createTunables, type TunableSpec } from '../../src/dev/tunables';

// Written from the T4 dev-panel spec, before the implementation.
// Registry of tunables over live config objects: set clamps and writes in place,
// diff = values that differ from defaults, serialize/apply round-trip, reset.

const spec: TunableSpec = {
  numbers: {
    'car.accel': { min: 0.05, max: 1, step: 0.01, label: 'Accel' },
    'car.grip': { min: 1, max: 40, step: 0.5 },
    'input.touch.deadZone': { min: 0, max: 0.3, step: 0.01 },
  },
  flags: {
    'hyp.H1': ['A', 'B'],
  },
};

function makeRoots() {
  return {
    car: { accel: 0.22, grip: 12, untouched: 7 },
    input: { touch: { deadZone: 0.05 } },
    hyp: { H1: 'A', H2: 'A' },
  };
}

describe('tunables: registry entries', () => {
  it('lists every number with path, section, label, range, default and current value', () => {
    const t = createTunables(makeRoots(), spec);
    expect(t.numbers.map((e) => e.path)).toEqual(['car.accel', 'car.grip', 'input.touch.deadZone']);
    const accel = t.numbers[0]!;
    expect(accel).toMatchObject({
      path: 'car.accel',
      section: 'car',
      label: 'Accel',
      min: 0.05,
      max: 1,
      step: 0.01,
      default: 0.22,
      value: 0.22,
    });
    const dz = t.numbers[2]!;
    expect(dz.section).toBe('input.touch');
    // Label falls back to the last path segment.
    expect(dz.label).toBe('deadZone');
  });

  it('lists flags with options, default and current value', () => {
    const t = createTunables(makeRoots(), spec);
    expect(t.flags).toHaveLength(1);
    expect(t.flags[0]).toMatchObject({
      path: 'hyp.H1',
      section: 'hyp',
      label: 'H1',
      options: ['A', 'B'],
      default: 'A',
      value: 'A',
    });
  });

  it('entry value follows the live value after set', () => {
    const t = createTunables(makeRoots(), spec);
    t.set('car.grip', 20);
    expect(t.numbers[1]!.value).toBe(20);
    t.set('hyp.H1', 'B');
    expect(t.flags[0]!.value).toBe('B');
  });
});

describe('tunables: get / set', () => {
  it('get returns the current value; unknown path -> undefined', () => {
    const t = createTunables(makeRoots(), spec);
    expect(t.get('car.accel')).toBe(0.22);
    expect(t.get('input.touch.deadZone')).toBe(0.05);
    expect(t.get('hyp.H1')).toBe('A');
    expect(t.get('car.untouched')).toBeUndefined();
    expect(t.get('nope.x')).toBeUndefined();
  });

  it('set writes into the live config object in place', () => {
    const roots = makeRoots();
    const car = roots.car;
    const touch = roots.input.touch;
    const t = createTunables(roots, spec);
    t.set('car.accel', 0.44);
    t.set('input.touch.deadZone', 0.1);
    expect(roots.car).toBe(car);
    expect(car.accel).toBe(0.44);
    expect(touch.deadZone).toBe(0.1);
    expect(car.untouched).toBe(7);
    expect(t.get('car.accel')).toBe(0.44);
  });

  it('set clamps to [min, max] and returns the written value', () => {
    const roots = makeRoots();
    const t = createTunables(roots, spec);
    expect(t.set('car.accel', 5)).toBe(1);
    expect(roots.car.accel).toBe(1);
    expect(t.set('car.accel', -3)).toBe(0.05);
    expect(roots.car.accel).toBe(0.05);
  });

  it('set of a flag writes the option in place', () => {
    const roots = makeRoots();
    const t = createTunables(roots, spec);
    expect(t.set('hyp.H1', 'B')).toBe('B');
    expect(roots.hyp.H1).toBe('B');
  });

  it('set rejects unknown paths, non-finite numbers, wrong types and unknown options', () => {
    const roots = makeRoots();
    const t = createTunables(roots, spec);
    expect(() => t.set('car.untouched', 1)).toThrow();
    expect(() => t.set('nope', 1)).toThrow();
    expect(() => t.set('car.accel', Number.NaN)).toThrow();
    expect(() => t.set('car.accel', Infinity)).toThrow();
    expect(() => t.set('car.accel', 'B')).toThrow();
    expect(() => t.set('hyp.H1', 'Z')).toThrow();
    expect(() => t.set('hyp.H1', 1)).toThrow();
    expect(roots.car.accel).toBe(0.22);
    expect(roots.hyp.H1).toBe('A');
  });

  it('notifies change listeners with the path', () => {
    const t = createTunables(makeRoots(), spec);
    const seen: (string | null)[] = [];
    const off = t.onChange((p) => seen.push(p));
    t.set('car.grip', 15);
    t.set('hyp.H1', 'B');
    off();
    t.set('car.grip', 16);
    expect(seen).toEqual(['car.grip', 'hyp.H1']);
  });
});

describe('tunables: diff / serialize / apply / reset', () => {
  it('diff is empty at start and holds only values that differ from defaults', () => {
    const t = createTunables(makeRoots(), spec);
    expect(t.diff()).toEqual({});
    t.set('car.grip', 20);
    t.set('hyp.H1', 'B');
    expect(t.diff()).toEqual({ 'car.grip': 20, 'hyp.H1': 'B' });
    t.set('car.grip', 12);
    expect(t.diff()).toEqual({ 'hyp.H1': 'B' });
  });

  it('serialize -> apply round-trips the diff onto a fresh registry', () => {
    const a = createTunables(makeRoots(), spec);
    a.set('car.accel', 0.5);
    a.set('input.touch.deadZone', 0.2);
    a.set('hyp.H1', 'B');
    const json = a.serialize();
    expect(JSON.parse(json)).toEqual(a.diff());

    const roots = makeRoots();
    const b = createTunables(roots, spec);
    expect(b.apply(json)).toEqual([]);
    expect(b.diff()).toEqual(a.diff());
    expect(roots.car.accel).toBe(0.5);
    expect(roots.input.touch.deadZone).toBe(0.2);
    expect(roots.hyp.H1).toBe('B');
    expect(b.serialize()).toBe(json);
  });

  it('apply starts from defaults: values absent from the diff are reset', () => {
    const roots = makeRoots();
    const t = createTunables(roots, spec);
    t.set('car.grip', 30);
    t.apply('{"car.accel":0.3}');
    expect(roots.car.grip).toBe(12);
    expect(t.diff()).toEqual({ 'car.accel': 0.3 });
  });

  it('apply clamps numbers and returns the keys it rejected', () => {
    const roots = makeRoots();
    const t = createTunables(roots, spec);
    const rejected = t.apply(
      JSON.stringify({
        'car.accel': 9,
        'car.untouched': 1,
        'car.grip': 'x',
        'hyp.H1': 'Z',
        zzz: 1,
      }),
    );
    expect(roots.car.accel).toBe(1);
    expect(roots.car.untouched).toBe(7);
    expect(roots.car.grip).toBe(12);
    expect(roots.hyp.H1).toBe('A');
    expect([...rejected].sort()).toEqual(['car.grip', 'car.untouched', 'hyp.H1', 'zzz']);
  });

  it('apply of malformed JSON or a non-object throws and leaves values unchanged', () => {
    const roots = makeRoots();
    const t = createTunables(roots, spec);
    t.set('car.grip', 20);
    expect(() => t.apply('{not json')).toThrow();
    expect(() => t.apply('[1,2]')).toThrow();
    expect(() => t.apply('3')).toThrow();
    expect(() => t.apply('null')).toThrow();
    expect(roots.car.grip).toBe(20);
  });

  it('apply notifies listeners', () => {
    const t = createTunables(makeRoots(), spec);
    let calls = 0;
    t.onChange(() => calls++);
    t.apply('{"car.accel":0.3}');
    expect(calls).toBeGreaterThan(0);
  });

  it('reset restores every default in place and empties the diff', () => {
    const roots = makeRoots();
    const car = roots.car;
    const t = createTunables(roots, spec);
    t.set('car.accel', 0.9);
    t.set('input.touch.deadZone', 0);
    t.set('hyp.H1', 'B');
    let calls = 0;
    t.onChange(() => calls++);
    t.reset();
    expect(roots.car).toBe(car);
    expect(car.accel).toBe(0.22);
    expect(roots.input.touch.deadZone).toBe(0.05);
    expect(roots.hyp.H1).toBe('A');
    expect(t.diff()).toEqual({});
    expect(calls).toBeGreaterThan(0);
  });
});

describe('tunables: construction validates the spec against the configs', () => {
  it('throws on a path that does not resolve to a number', () => {
    expect(() =>
      createTunables(makeRoots(), {
        numbers: { 'car.missing': { min: 0, max: 1, step: 0.1 } },
        flags: {},
      }),
    ).toThrow();
    expect(() =>
      createTunables(makeRoots(), {
        numbers: { 'input.touch': { min: 0, max: 1, step: 0.1 } },
        flags: {},
      }),
    ).toThrow();
    expect(() =>
      createTunables(makeRoots(), {
        numbers: { 'nope.x': { min: 0, max: 1, step: 0.1 } },
        flags: {},
      }),
    ).toThrow();
  });

  it('throws when the default is outside [min, max] or the range is degenerate', () => {
    expect(() =>
      createTunables(makeRoots(), {
        numbers: { 'car.grip': { min: 20, max: 40, step: 1 } },
        flags: {},
      }),
    ).toThrow();
    expect(() =>
      createTunables(makeRoots(), {
        numbers: { 'car.grip': { min: 40, max: 1, step: 1 } },
        flags: {},
      }),
    ).toThrow();
    expect(() =>
      createTunables(makeRoots(), {
        numbers: { 'car.grip': { min: 1, max: 40, step: 0 } },
        flags: {},
      }),
    ).toThrow();
  });

  it('throws when a flag path is not a string or its value is not among the options', () => {
    expect(() =>
      createTunables(makeRoots(), { numbers: {}, flags: { 'car.grip': ['A'] } }),
    ).toThrow();
    expect(() =>
      createTunables(makeRoots(), { numbers: {}, flags: { 'hyp.H2': ['B', 'C'] } }),
    ).toThrow();
  });
});

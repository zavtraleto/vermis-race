import { describe, expect, it } from 'vitest';
import base from '../../src/data/cars/base.json';
import camera from '../../src/data/camera.json';
import hypotheses from '../../src/data/hypotheses.json';
import input from '../../src/data/input.json';
import road from '../../src/data/road.json';
import sprites from '../../src/data/sprites.json';
import tunablesJson from '../../src/data/tunables.json';
import { parseDevParams } from '../../src/dev/params';
import { createTunables, type TunableSpec } from '../../src/dev/tunables';
import { createProjection } from '../../src/render/projection';

// Written from the T4 dev-panel spec: which numbers must be tunable, ranges live in data.
const spec: TunableSpec = tunablesJson;

const REQUIRED = [
  // car params of the driving model (R204, R15, R18) [ADR 0005]
  'car.accel',
  'car.engineBrake',
  'car.brakeDecel',
  'car.offroadMul',
  'car.xLimit',
  // control pad (R202)
  'input.pad.steerSpan',
  'input.pad.steerDead',
  'input.pad.padHalfH',
  'input.pad.liftZone',
  // camera
  'camera.fovDeg',
  'camera.height',
  'camera.horizon',
  'camera.drawDistance',
  // car sprite vertical position
  'sprites.player.baseY',
];

function realRoots() {
  // Fresh copies so the tests never mutate the shared imported data.
  return JSON.parse(JSON.stringify({ car: base, input, camera, sprites, hypotheses })) as Record<
    string,
    object
  >;
}

describe('tunables.json covers the spec', () => {
  it('has a range for every required path', () => {
    for (const p of REQUIRED) expect(Object.keys(spec.numbers)).toContain(p);
  });

  it('builds over the real configs (paths resolve, defaults inside ranges)', () => {
    const t = createTunables(realRoots(), spec);
    expect(t.numbers.length).toBeGreaterThanOrEqual(REQUIRED.length);
    expect(t.diff()).toEqual({});
  });

  it('every hypothesis flag is a select whose options include its current value', () => {
    for (const [key, value] of Object.entries(hypotheses)) {
      const options = spec.flags[`hypotheses.${key}`];
      expect(options, key).toBeDefined();
      expect(options).toContain(value);
    }
  });

  it('2x the default accel is inside the accel range', () => {
    const r = spec.numbers['car.accel']!;
    expect(2 * base.accel).toBeLessThanOrEqual(r.max);
  });

  it('every corner of the camera ranges keeps line 0 in front of the camera', () => {
    const fov = spec.numbers['camera.fovDeg']!;
    const height = spec.numbers['camera.height']!;
    const horizon = spec.numbers['camera.horizon']!;
    const dd = spec.numbers['camera.drawDistance']!;
    for (const f of [fov.min, fov.max])
      for (const h of [height.min, height.max])
        for (const hz of [horizon.min, horizon.max])
          for (const d of [dd.min, dd.max]) {
            const cfg = { ...camera, fovDeg: f, height: h, horizon: hz, drawDistance: d };
            expect(() => createProjection(cfg, road)).not.toThrow();
          }
  });
});

describe('dev url params', () => {
  it('?dev=1 opens the panel, anything else does not', () => {
    expect(parseDevParams('?dev=1').open).toBe(true);
    expect(parseDevParams('').open).toBe(false);
    expect(parseDevParams('?dev=0').open).toBe(false);
    expect(parseDevParams('?seed=2&dev=1&hud=1').open).toBe(true);
  });

  it('?tune= is url-decoded JSON text, absent -> null', () => {
    const diff = { 'car.accel': 0.44, 'hypotheses.H1_driftBoost': 'B' };
    const q = `?dev=1&tune=${encodeURIComponent(JSON.stringify(diff))}`;
    const tune = parseDevParams(q).tune;
    expect(tune).not.toBeNull();
    expect(JSON.parse(tune!)).toEqual(diff);
    expect(parseDevParams('?dev=1').tune).toBeNull();
  });
});

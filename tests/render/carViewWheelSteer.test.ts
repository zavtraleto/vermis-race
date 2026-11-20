import { describe, expect, it } from 'vitest';
import type { BufferAttribute } from 'three';
import { cameraConfig, car3dConfig, paletteConfig, spritesConfig } from '../../src/data/render';
import nsx from '../../src/data/models/nsx.json';
import { CarView } from '../../src/render/carModel';

// R25b: the front wheels turn about the vertical axis through their pivots by the steering angle
// (> 0 = wheels to the right), independently of the body. The wheels share the position buffer of
// the player mesh, laid out as [front-left wheel][front-right wheel][body][shadow quad].
// Game car space: Y up, front = -Z, +X = car's right. Metres.

interface ModelLike {
  parts: { wheelFL: { positions: number[] }; wheelFR: { positions: number[] } };
  pivots: { wheelFL: [number, number, number]; wheelFR: [number, number, number] };
}
const M = nsx as unknown as ModelLike;
const FL_FLOATS = M.parts.wheelFL.positions.length;
const FR_FLOATS = M.parts.wheelFR.positions.length;
const WHEEL_FLOATS = FL_FLOATS + FR_FLOATS;

interface Wheel {
  name: 'wheelFL' | 'wheelFR';
  start: number; // first float in the position array
  end: number; // one past the last float
  pivot: [number, number, number];
}
const WHEELS: Wheel[] = [
  { name: 'wheelFL', start: 0, end: FL_FLOATS, pivot: M.pivots.wheelFL },
  { name: 'wheelFR', start: FL_FLOATS, end: WHEEL_FLOATS, pivot: M.pivots.wheelFR },
];

function makeView(): CarView {
  // As src/app/main.ts: new CarView(car3dConfig, spritesConfig.player, view, paletteConfig).
  return new CarView(car3dConfig, spritesConfig.player, cameraConfig, paletteConfig);
}

/** Pose the car straight with the front wheels at `steerDeg` (the real per-frame path). */
function steer(v: CarView, steerDeg: number): void {
  v.update(0, 0, 0, 0, 0, 0, 0, 0, steerDeg);
}

function posAttr(v: CarView): BufferAttribute {
  return v.mesh.geometry.getAttribute('position') as BufferAttribute;
}

function snapshot(v: CarView): Float32Array {
  return Float32Array.from(posAttr(v).array as Float32Array);
}

function at(a: ArrayLike<number>, i: number): number {
  const x = a[i];
  if (x === undefined) throw new Error(`index ${i} out of range`);
  return x;
}

/** Float index of the wheel vertex with the smallest (front) or largest (rear) z. */
function extremeZ(a: ArrayLike<number>, w: Wheel, front: boolean): number {
  let best = w.start;
  for (let i = w.start; i < w.end; i += 3) {
    const z = at(a, i + 2);
    if (front ? z < at(a, best + 2) : z > at(a, best + 2)) best = i;
  }
  return best;
}

describe('R25b front-wheel steering in CarView', () => {
  it('R25b sign: steer > 0 swings the front of each wheel to +x and its rear to -x; < 0 opposite', () => {
    const v = makeView();
    const a0 = snapshot(v);
    for (const w of WHEELS) {
      const front = extremeZ(a0, w, true);
      const rear = extremeZ(a0, w, false);
      // Rotation by -deg about +Y: x' = px + x cos + z sin(-deg). Front point has z < pivot z, so
      // for deg > 0 the term z * sin(-deg) > 0 -> x grows; the rear point (z > pivot z) -> x shrinks.
      steer(v, 20);
      let a = posAttr(v).array;
      expect(at(a, front)).toBeGreaterThan(at(a0, front) + 1e-3);
      expect(at(a, rear)).toBeLessThan(at(a0, rear) - 1e-3);
      steer(v, -20);
      a = posAttr(v).array;
      expect(at(a, front)).toBeLessThan(at(a0, front) - 1e-3);
      expect(at(a, rear)).toBeGreaterThan(at(a0, rear) + 1e-3);
      steer(v, 0);
    }
  });

  it('R25b pivot: every wheel vertex keeps its y and its distance to the vertical pivot axis', () => {
    const v = makeView();
    const a0 = snapshot(v);
    // Angle 0: bounding-box centre in x/z on the pivot within 2 mm.
    for (const w of WHEELS) {
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity;
      for (let i = w.start; i < w.end; i += 3) {
        minX = Math.min(minX, at(a0, i));
        maxX = Math.max(maxX, at(a0, i));
        minZ = Math.min(minZ, at(a0, i + 2));
        maxZ = Math.max(maxZ, at(a0, i + 2));
      }
      expect(Math.abs((minX + maxX) / 2 - w.pivot[0])).toBeLessThanOrEqual(0.002);
      expect(Math.abs((minZ + maxZ) / 2 - w.pivot[2])).toBeLessThanOrEqual(0.002);
    }
    const centroidDist = (a: ArrayLike<number>, w: Wheel): number => {
      let sx = 0,
        sz = 0,
        n = 0;
      for (let i = w.start; i < w.end; i += 3) {
        sx += at(a, i);
        sz += at(a, i + 2);
        n++;
      }
      return Math.hypot(sx / n - w.pivot[0], sz / n - w.pivot[2]);
    };
    for (const deg of [-35, -20, -7.5, 3, 12, 20, 35]) {
      steer(v, deg);
      const a = posAttr(v).array;
      for (const w of WHEELS) {
        for (let i = w.start; i < w.end; i += 3) {
          const r0 = Math.hypot(at(a0, i) - w.pivot[0], at(a0, i + 2) - w.pivot[2]);
          const r = Math.hypot(at(a, i) - w.pivot[0], at(a, i + 2) - w.pivot[2]);
          expect(Math.abs(r - r0)).toBeLessThanOrEqual(1e-4);
          expect(Math.abs(at(a, i + 1) - at(a0, i + 1))).toBeLessThanOrEqual(1e-4);
        }
        // Centre of rotation fixed: the vertex centroid stays at the same distance from the pivot.
        expect(Math.abs(centroidDist(a, w) - centroidDist(a0, w))).toBeLessThanOrEqual(1e-4);
      }
    }
  });

  it('R25b no drift: 200 cycles of +20, -20, 0 degrees return the wheels to angle 0 within 1e-5', () => {
    const v = makeView();
    const a0 = snapshot(v);
    for (let k = 0; k < 200; k++) {
      steer(v, 20);
      steer(v, -20);
      steer(v, 0);
    }
    const a = posAttr(v).array;
    let worst = 0;
    for (let i = 0; i < WHEEL_FLOATS; i++) worst = Math.max(worst, Math.abs(at(a, i) - at(a0, i)));
    expect(worst).toBeLessThanOrEqual(1e-5);
  });

  it('R25b body untouched: no float outside the two front-wheel ranges changes for any angle', () => {
    const v = makeView();
    const a0 = snapshot(v);
    expect(a0.length).toBeGreaterThan(WHEEL_FLOATS);
    for (const deg of [-35, -10, 0.5, 20, 35, 0]) {
      steer(v, deg);
      const a = posAttr(v).array;
      let changed = 0;
      for (let i = WHEEL_FLOATS; i < a0.length; i++) if (!Object.is(at(a, i), at(a0, i))) changed++;
      expect(changed).toBe(0);
    }
  });

  it('R25b upload bookkeeping: a change bumps version with one range over the wheels; same angle does not', () => {
    const v = makeView();
    const attr = posAttr(v);
    attr.clearUpdateRanges(); // as the renderer does after an upload
    const v0 = attr.version;
    steer(v, 15);
    expect(attr.version).toBeGreaterThan(v0);
    // updateRanges are in array elements (floats) in three 0.187.
    expect(attr.updateRanges.length).toBe(1);
    expect(attr.updateRanges[0]).toEqual({ start: 0, count: WHEEL_FLOATS });
    attr.clearUpdateRanges();
    const v1 = attr.version;
    steer(v, 15);
    expect(attr.version).toBe(v1);
    expect(attr.updateRanges.length).toBe(0);
  });

  it('R25b no growth while hidden: 100 angle changes without an upload keep updateRanges.length <= 1', () => {
    // Bump blink sets scene.visible = false, so the renderer neither uploads nor clears the ranges.
    const v = makeView();
    const attr = posAttr(v);
    attr.clearUpdateRanges();
    for (let k = 0; k < 100; k++) steer(v, (k % 2 === 0 ? 1 : -1) * (5 + (k % 7)));
    expect(attr.updateRanges.length).toBeLessThanOrEqual(1);
  });
});

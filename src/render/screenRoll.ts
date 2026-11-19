import { Vector4 } from 'three';
import type { Car } from '../sim/types';
import { approach } from './driftVisual';

/** R27 drift camera roll (render only; numbers in src/data/sprites.json "driftCamera"). */
export interface ScreenRollConfig {
  rollDeg: number; // picture roll at sim drift angle 1, degrees; > 0 = counter-clockwise in a right drift
  rollTau: number; // s, smoothing time constant in and out
  overscanPx: number; // ground drawn past the screen edges so a rolled picture shows no empty corners
}

const DEG = Math.PI / 180;

/**
 * GLSL helper shared by the NDC shaders of the game layer (road, sprites, traffic): rotates an
 * NDC point about the screen centre in square pixels. uRoll = (cos, sin, width / height, 0).
 */
export const ROLL_GLSL = /* glsl */ `
uniform vec4 uRoll;
vec2 rollNdc(vec2 p) {
  vec2 q = vec2(p.x * uRoll.z, p.y);
  q = vec2(q.x * uRoll.x - q.y * uRoll.y, q.x * uRoll.y + q.y * uRoll.x);
  return vec2(q.x / uRoll.z, q.y);
}
`;

export interface RollUniform {
  value: Vector4;
}

/**
 * R27: the whole game picture rolls by an angle proportional to the sim drift angle, smoothed in
 * and out. One uniform object is shared by every game-layer material; the 3D car camera reads
 * `deg`. The UI (DOM) is not touched. Reads sim state, never writes it.
 */
export class ScreenRoll {
  /** Degrees, > 0 = picture counter-clockwise. */
  deg = 0;
  readonly uniform: RollUniform;

  constructor(
    private readonly cfg: ScreenRollConfig,
    aspect: number,
  ) {
    this.uniform = { value: new Vector4(1, 0, aspect, 0) };
  }

  /** `angle` = sim drift angle interpolated between the prev and curr states (0 in GRIP). */
  update(dt: number, car: Car, angle: number): void {
    const drifting = car.state === 'DRIFT' && car.dir !== 0;
    this.deg = approach(this.deg, drifting ? angle * this.cfg.rollDeg : 0, dt, this.cfg.rollTau);
    const r = this.deg * DEG;
    const u = this.uniform.value;
    u.x = Math.cos(r);
    u.y = Math.sin(r);
  }
}

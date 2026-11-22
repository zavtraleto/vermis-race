import { Vector4 } from 'three';

/** Overscan of the game layer (numbers in src/data/sprites.json "driftCamera"). */
export interface ScreenRollConfig {
  overscanPx: number; // ground drawn past the screen edges
}

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
 * Picture roll uniform shared by every game-layer material. The R27 drift roll was removed with
 * ADR 0005 (R213: the camera follows without tilts), so the roll stays 0. The UI is not touched.
 */
export class ScreenRoll {
  /** Degrees of the whole picture roll (always 0, R213). */
  readonly total = 0;
  readonly uniform: RollUniform;

  constructor(aspect: number) {
    this.uniform = { value: new Vector4(1, 0, aspect, 0) };
  }
}

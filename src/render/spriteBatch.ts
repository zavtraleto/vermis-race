import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
} from 'three';
import { ROLL_GLSL, type RollUniform } from './screenRoll';

// Corner (0..1, 0..1) of the unit quad; the sprite is anchored at the centre of its base.
// iUv (u0, v0, du, dv) is carried for the future atlas; with no texture the fill is flat.
const VERTEX = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute vec3 iTint;
attribute vec4 iUv;
varying vec3 vTint;
varying vec2 vUv;
${ROLL_GLSL}
void main() {
  vTint = iTint;
  vUv = iUv.xy + position.xy * iUv.zw;
  vec2 p = vec2(iPos.x + (position.x - 0.5) * iSize.x, iPos.y + position.y * iSize.y);
  gl_Position = vec4(rollNdc(p), iPos.z, 1.0); // R27 roll last
}
`;
const FRAGMENT = /* glsl */ `
varying vec3 vTint;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(vTint, 1.0);
}
`;

/**
 * All billboards of layers 2-4 in one instanced draw call: a static unit quad plus
 * per-instance position/size (NDC), depth and tint. Fixed capacity; push() between
 * begin() and end() once per frame, no allocations. Depth test/write order sprites
 * against the road and each other, so no sorting is needed.
 */
export class SpriteBatch {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly capacity: number;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly tint: Float32Array;
  private readonly uv: Float32Array;
  private readonly posAttr: InstancedBufferAttribute;
  private readonly sizeAttr: InstancedBufferAttribute;
  private readonly tintAttr: InstancedBufferAttribute;
  private readonly sx: number;
  private readonly sy: number;
  private n = 0;
  private overflow = 0;

  constructor(capacity: number, screenWidth: number, screenHeight: number, roll: RollUniform) {
    this.capacity = capacity;
    this.sx = 2 / screenWidth;
    this.sy = 2 / screenHeight;
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity * 2);
    this.tint = new Float32Array(capacity * 3);
    this.uv = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) {
      this.uv[i * 4 + 2] = 1;
      this.uv[i * 4 + 3] = 1;
    }

    const geo = new InstancedBufferGeometry();
    geo.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3),
    );
    geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    this.posAttr = new InstancedBufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    this.sizeAttr = new InstancedBufferAttribute(this.size, 2).setUsage(DynamicDrawUsage);
    this.tintAttr = new InstancedBufferAttribute(this.tint, 3).setUsage(DynamicDrawUsage);
    geo.setAttribute('iPos', this.posAttr);
    geo.setAttribute('iSize', this.sizeAttr);
    geo.setAttribute('iTint', this.tintAttr);
    geo.setAttribute('iUv', new InstancedBufferAttribute(this.uv, 4));
    geo.instanceCount = 0;

    const mat = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uRoll: roll },
      depthTest: true,
      depthWrite: true,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  /** Instances written by the last frame. */
  get count(): number {
    return this.n;
  }

  /** Instances dropped in the last frame because the batch was full. */
  get dropped(): number {
    return this.overflow;
  }

  begin(): void {
    this.n = 0;
    this.overflow = 0;
  }

  /**
   * One flat rectangle. x = centre of the base, y = base (screen px, y down), w/h in px,
   * depth in NDC, colour = 3 floats of `rgb` starting at `at` (raw sRGB 0..1).
   */
  push(
    x: number,
    y: number,
    w: number,
    h: number,
    depth: number,
    rgb: Float32Array,
    at: number,
  ): void {
    const i = this.n;
    if (i >= this.capacity) {
      this.overflow += 1;
      return;
    }
    const p = i * 3;
    this.pos[p] = x * this.sx - 1;
    this.pos[p + 1] = 1 - y * this.sy;
    this.pos[p + 2] = depth;
    this.size[i * 2] = w * this.sx;
    this.size[i * 2 + 1] = h * this.sy;
    this.tint[p] = rgb[at]!;
    this.tint[p + 1] = rgb[at + 1]!;
    this.tint[p + 2] = rgb[at + 2]!;
    this.n = i + 1;
  }

  end(): void {
    const n = this.n;
    this.mesh.geometry.instanceCount = n;
    upload(this.posAttr, n * 3);
    upload(this.sizeAttr, n * 2);
    upload(this.tintAttr, n * 3);
  }
}

function upload(a: InstancedBufferAttribute, used: number): void {
  if (used === 0) return;
  a.clearUpdateRanges();
  a.addUpdateRange(0, used);
  a.needsUpdate = true;
}

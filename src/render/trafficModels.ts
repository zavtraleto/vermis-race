import {
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector4,
} from 'three';
import type { Palette } from '../data/render';
import type { Car } from '../sim/types';
import { Builder, type Car3dConfig, type DuoShade } from './carModel';
import { placeOnRoad, type Placement } from './placeOnRoad';
import {
  focalPx,
  nearDistance,
  type CameraConfig,
  type Projection,
  type RoadConfig,
} from './projection';
import { writeHex } from './roadMesh';
import { ROLL_GLSL, type RollUniform } from './screenRoll';
import type { TrafficDrawConfig } from './worldSprites';

const VARIANTS = 3;
const BODY = 'body';
const DEG = Math.PI / 180;

// Per vertex: position / aPos1 / aPos2 = the three bodies, aShade = their face shades, aColor =
// fixed colour (raw sRGB), aBody = 1 where the per-car colour applies.
// Per instance: iA = (camera-relative x, height of the camera above the car's ground, depth,
// world units per model unit), iB = (cos yaw, sin yaw, depth base, depth gain), iC = (colour,
// body variant), iD = (crest clip line in NDC y, depth of the car's rear).
// The vertex is projected with the same pinhole as the road (focal uProj.x, centre uProj.y,
// horizon uProj.z), so a model on a straight flat road matches the road exactly.
const VERTEX = /* glsl */ `
#ifdef PRINT_DUO
uniform vec4 uDuo; // shadow rgb, amount
#endif
attribute vec3 aPos1;
attribute vec3 aPos2;
attribute vec3 aShade;
attribute vec3 aColor;
attribute float aBody;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec2 iD;
uniform vec4 uProj;
uniform vec2 uScreen;
varying vec3 vColor;
varying float vY;
varying float vClip;
${ROLL_GLSL}
void main() {
  float v = iC.w;
  vec3 p = v < 0.5 ? position : (v < 1.5 ? aPos1 : aPos2);
  float sh = v < 0.5 ? aShade.x : (v < 1.5 ? aShade.y : aShade.z);
  vColor = (aBody > 0.5 ? iC.rgb : aColor) * sh;
#ifdef PRINT_DUO
  // Spike ?print: body toward one shadow colour by the face shade, other parts flat.
  vColor = aBody > 0.5 ? mix(iC.rgb, uDuo.rgb, clamp((1.0 - sh) * uDuo.w, 0.0, 1.0)) : aColor;
#endif
  float k = iA.w;
  float lx = p.x * iB.x - p.z * iB.y;
  float lz = p.x * iB.y + p.z * iB.x;
  float z = max(iA.z - lz * k, 1.0);
  float sx = uProj.y + (iA.x + lx * k) * uProj.x / z;
  float sy = uProj.z + (iA.y - p.y * k) * uProj.x / z;
  vec2 ndc = vec2(sx * uScreen.x - 1.0, 1.0 - sy * uScreen.y);
  vY = ndc.y;
  vClip = iD.x;
  gl_Position = vec4(rollNdc(ndc), iB.z + iB.w * (1.0 - iD.y / z), 1.0);
}
`;
const FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vY;
varying float vClip;
void main() {
  if (vY < vClip) discard; // R30: below the crest line
  gl_FragColor = vec4(vColor, 1.0);
}
`;

/** Box list of one body through the player-car Builder: same shading rules, no wheels/lamps. */
function buildBody(
  cfg: Car3dConfig,
  boxes: Car3dConfig['traffic']['bodies'][number]['boxes'],
): Builder {
  const b = new Builder(cfg);
  b.shadow(cfg.traffic.shadow);
  for (const box of boxes) b.box(box);
  return b;
}

/**
 * R45 traffic as low-poly 3D bodies: three variants x palette.traffic colours, all cars in one
 * instanced draw call of the road pass. Each car is placed by the road projection (prev/curr
 * interpolation, respawn snap), yawed after the road curve, hidden behind a crest (R30) and
 * depth-ordered against the road and the roadside sprites by a narrow depth band starting at its
 * rear line; the player car is drawn after this pass, over it. No allocations per frame.
 */
export class TrafficModels {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly capacity: number;
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly c: Float32Array;
  private readonly d: Float32Array;
  private readonly attrs: InstancedBufferAttribute[];
  private readonly colours: Float32Array;
  private readonly colourCount: number;
  private readonly halfLength: number; // model units, centre to the farthest point along z
  private readonly placement: Placement = { x: 0, y: 0, w: 0, h: 0, depth: 0 };
  private readonly proj: Vector4;
  private readonly duoRgb = new Float32Array(3);
  private n = 0;

  constructor(
    private readonly cfg: Car3dConfig,
    private readonly draw: TrafficDrawConfig,
    private readonly camera: CameraConfig,
    private readonly road: RoadConfig,
    palette: Palette,
    roll: RollUniform,
    private readonly overscan: { overscanPx: number },
    duo?: DuoShade,
  ) {
    const bodies = cfg.traffic.bodies;
    if (bodies.length !== VARIANTS) throw new Error(`car3d.traffic: need ${VARIANTS} bodies`);
    const built = bodies.map((body) => buildBody(cfg, body.boxes));
    const ref = built[0]!;
    const verts = ref.keys.length;
    for (let v = 1; v < VARIANTS; v++) {
      const o = built[v]!;
      if (o.keys.length !== verts || o.keys.some((k, i) => k !== ref.keys[i]))
        throw new Error(`car3d.traffic: body '${bodies[v]!.name}' differs in boxes or colours`);
    }
    const shade = new Float32Array(verts * 3);
    const colour = new Float32Array(verts * 3);
    const isBody = new Float32Array(verts);
    let halfLength = 0;
    for (let i = 0; i < verts; i++) {
      for (let v = 0; v < VARIANTS; v++) {
        shade[i * 3 + v] = built[v]!.shade[i]!;
        halfLength = Math.max(halfLength, Math.abs(built[v]!.pos[i * 3 + 2]!));
      }
      const key = ref.keys[i]!;
      if (key === BODY) isBody[i] = 1;
      else {
        const hex = palette[key as keyof Palette];
        if (typeof hex !== 'string')
          throw new Error(`car3d.traffic: unknown palette colour '${key}'`);
        writeHex(colour, i * 3, hex);
      }
    }
    this.halfLength = halfLength;
    this.colourCount = palette.traffic.length;
    this.colours = new Float32Array(this.colourCount * 3);
    for (let i = 0; i < this.colourCount; i++) writeHex(this.colours, i * 3, palette.traffic[i]!);

    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(built[0]!.pos), 3));
    geo.setAttribute('aPos1', new BufferAttribute(new Float32Array(built[1]!.pos), 3));
    geo.setAttribute('aPos2', new BufferAttribute(new Float32Array(built[2]!.pos), 3));
    geo.setAttribute('aShade', new BufferAttribute(shade, 3));
    geo.setAttribute('aColor', new BufferAttribute(colour, 3));
    geo.setAttribute('aBody', new BufferAttribute(isBody, 1));
    const cap = Math.max(1, Math.floor(draw.capacity));
    this.capacity = cap;
    this.a = new Float32Array(cap * 4);
    this.b = new Float32Array(cap * 4);
    this.c = new Float32Array(cap * 4);
    this.d = new Float32Array(cap * 2);
    this.attrs = [
      new InstancedBufferAttribute(this.a, 4).setUsage(DynamicDrawUsage),
      new InstancedBufferAttribute(this.b, 4).setUsage(DynamicDrawUsage),
      new InstancedBufferAttribute(this.c, 4).setUsage(DynamicDrawUsage),
      new InstancedBufferAttribute(this.d, 2).setUsage(DynamicDrawUsage),
    ];
    geo.setAttribute('iA', this.attrs[0]!);
    geo.setAttribute('iB', this.attrs[1]!);
    geo.setAttribute('iC', this.attrs[2]!);
    geo.setAttribute('iD', this.attrs[3]!);
    geo.instanceCount = 0;
    this.proj = new Vector4();
    const mat = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uRoll: roll,
        uProj: { value: this.proj },
        uScreen: { value: new Vector2(2 / camera.screenWidth, 2 / camera.screenHeight) },
      },
      side: DoubleSide,
      depthTest: true,
      depthWrite: true,
    });
    if (duo) {
      writeHex(this.duoRgb, 0, duo.shadow);
      const rgb = this.duoRgb;
      mat.defines = { PRINT_DUO: '' };
      mat.uniforms.uDuo = { value: new Vector4(rgb[0], rgb[1], rgb[2], duo.amount) };
    }
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Cars drawn by the last update(). */
  get count(): number {
    return this.n;
  }

  /**
   * Places every 'traffic' car of `curr` (z/x interpolated from `prev`) at z + zOffset (zOffset =
   * segments from the camera to the player car's line, as for the old sprites). `carW` = car width
   * in world units.
   */
  update(
    proj: Projection,
    prev: readonly Car[],
    curr: readonly Car[],
    alpha: number,
    zOffset: number,
    carW: number,
  ): void {
    const dc = this.draw;
    const cam = this.camera;
    const road = this.road;
    const p = this.placement;
    const f = focalPx(cam);
    const d0 = nearDistance(cam, f);
    const cx = cam.screenWidth / 2;
    const hy = cam.horizon * cam.screenHeight;
    this.proj.set(f, cx, hy, 0);
    const k = carW / this.cfg.traffic.width;
    const half = this.halfLength * k;
    const step = 2 / (proj.count - 1);
    const over = this.overscan.overscanPx;
    let n = 0;
    for (let i = 0; i < curr.length && n < this.capacity; i++) {
      const bc = curr[i]!;
      if (bc.kind !== 'traffic') continue;
      const ac = prev[i]!;
      const jump = bc.z - ac.z;
      // R71 respawn moves a car far ahead in one tick: draw it where it is now.
      const snap = jump > dc.snapSegments || jump < -dc.snapSegments;
      const z = (snap ? bc.z : ac.z + jump * alpha) + zOffset;
      const x = snap ? bc.x : ac.x + (bc.x - ac.x) * alpha;
      let r = (z - proj.base) % proj.length;
      if (r < 0) r += proj.length;
      if (r > dc.drawDistance || !placeOnRoad(p, proj, z, x, carW, carW)) continue;
      const s = p.w / carW; // px per world unit at the car centre
      const zc = f / s;
      const zr = zc - half;
      if (zr <= 0) continue; // rear behind the camera: the car is under the player's line anyway
      if (p.x + p.w * 1.5 < -over || p.x - p.w * 1.5 > cam.screenWidth + over) continue;
      // Road heading at the car's line, from the world centre-line offset between two lines.
      const li = Math.min(Math.floor(r), proj.count - 2);
      const xi = (proj.x[li]! - cx) / proj.scale[li]!;
      const xj = (proj.x[li + 1]! - cx) / proj.scale[li + 1]!;
      let yaw = dc.yawGain * Math.atan2(xj - xi, road.segmentLength);
      const yawMax = dc.yawMaxDeg * DEG;
      if (yaw > yawMax) yaw = yawMax;
      else if (yaw < -yawMax) yaw = -yawMax;
      // Depth band: from 0.5 step in front of the sprite depth of the rear line up to that depth,
      // so the car sits in front of the road under it and orders like a sprite on its rear line.
      let nr = (zr - d0) / road.segmentLength + proj.frac;
      if (nr < 0) nr = 0;
      const ni = Math.floor(nr);
      const rearDepth = -1 + step * (ni + 0.05 + 0.2 * (nr - ni));
      // R30: behind a crest only the part above the nearest crest line is drawn.
      let clip = -10;
      if (proj.clipped[ni] === 1) {
        let crestY = Infinity;
        for (let q = 0; q < ni; q++) if (proj.y[q]! < crestY) crestY = proj.y[q]!;
        clip = 1 - (crestY * 2) / cam.screenHeight;
      }
      const o = n * 4;
      this.a[o] = (p.x - cx) / s;
      this.a[o + 1] = (p.y - hy) / s;
      this.a[o + 2] = zc;
      this.a[o + 3] = k;
      this.b[o] = Math.cos(yaw);
      this.b[o + 1] = Math.sin(yaw);
      this.b[o + 2] = rearDepth - 0.5 * step;
      this.b[o + 3] = (0.5 * step) / (1 - zr / (zc + half));
      const col = (i % this.colourCount) * 3;
      this.c[o] = this.colours[col]!;
      this.c[o + 1] = this.colours[col + 1]!;
      this.c[o + 2] = this.colours[col + 2]!;
      this.c[o + 3] = i % VARIANTS;
      this.d[n * 2] = clip;
      this.d[n * 2 + 1] = zr;
      n++;
    }
    this.n = n;
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (let j = 0; j < 4; j++) {
      const at = this.attrs[j]!;
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * at.itemSize);
      at.needsUpdate = true;
    }
  }
}

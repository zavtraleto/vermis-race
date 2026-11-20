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
import { DT } from '../sim/constants';
import type { Car, Track } from '../sim/types';
import type { CarWeightConfig } from './carWeight';
import { Builder, type Car3dConfig } from './carModel';
import { CrashTumble, type CrashTumbleConfig } from './crashTumble';
import { approach } from './driftVisual';
import { placeOnRoad, type Placement } from './placeOnRoad';
import {
  focalPx,
  nearDistance,
  type CameraConfig,
  type Projection,
  type RoadConfig,
} from './projection';
import { writeHex } from './roadMesh';
import { slopePitchDeg } from './roadSlope';
import { ROLL_GLSL, type RollUniform } from './screenRoll';
import type { TailLights } from './tailLights';
import type { BumpFeedbackConfig, TrafficDrawConfig } from './worldSprites';

/** R67 rival cars on screen (sprites.json "rivals"). */
export interface RivalDrawConfig {
  capacity: number; // most rivals drawn per frame (instance buffer size)
  widthLanes: number; // car width on the road, lanes
  labelLift: number; // name label base above the road, car-model units
  labelPx: number; // name label font size, game px (src/ui/nameLabels.ts)
}

const BODY = 'player'; // the player model's body colour key: per-rival colour here
const DEG = Math.PI / 180;

// Same pinhole as trafficModels.ts. Per instance: iA = (camera-relative x, camera height above the
// car's ground, depth, world units per model unit), iB = (cos yaw, sin yaw, depth base, depth
// gain), iC = (body colour, unused), iD = (crest clip line in NDC y, depth of the car's rear),
// iE = (R49 tumble roll in rad, hop in model units, roll pivot height, R30b slope pitch in rad,
// nose up > 0).
const VERTEX = /* glsl */ `
attribute vec3 aShade;
attribute vec3 aColor;
attribute float aBody;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec2 iD;
attribute vec4 iE;
uniform vec4 uProj;
uniform vec2 uScreen;
varying vec3 vColor;
varying float vY;
varying float vClip;
${ROLL_GLSL}
void main() {
  vColor = (aBody > 0.5 ? iC.rgb : aColor) * aShade.x;
  vec3 p = position;
  float cr = cos(iE.x);
  float sr = sin(iE.x);
  float py = p.y - iE.z;
  p = vec3(p.x * cr - py * sr, p.x * sr + py * cr + iE.z + iE.y, p.z);
  // R30b: pitch along the road slope in the car's own frame (nose = -z), pivot at the ground point
  // under the car centre, before the yaw.
  float cp = cos(iE.w);
  float sp = sin(iE.w);
  p = vec3(p.x, p.y * cp - p.z * sp, p.z * cp + p.y * sp);
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

/** The player car (car3d.json boxes, wheels, lamps, shadow) with the body colour kept apart. */
function buildPlayerBody(cfg: Car3dConfig): Builder {
  const b = new Builder(cfg);
  b.shadow();
  const w = cfg.wheels;
  for (const side of [-1, 1]) {
    b.wheel(side * w.x, w.frontZ, w.frontWidth);
    b.wheel(side * w.x, cfg.rearAxleZ, w.rearWidth);
  }
  for (const box of cfg.boxes) b.box(box);
  for (const x of cfg.lights.x) b.lamp(x);
  return b;
}

/**
 * R67 rivals drawn with the player's car model, one colour per name (palette.rivals by nameId),
 * one instanced draw call in the road pass. Placement, crest clipping (R30) and depth band as for
 * traffic (trafficModels.ts); body yaw on top of the road heading by the player's rules (R89 in
 * model B: vis*slipDeg + vel*velDeg smoothed by yawTau; model A: the R24 angle), R49 tumble and
 * hop while crashTicks > 0, R45 blink while bumpTicks > 0. After update(), labelCount / labelCar /
 * labelX / labelY give the screen point above each drawn rival within `nameDistance` segments
 * ahead (for the name labels). No allocations per frame.
 */
export class RivalModels {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly capacity: number;
  /** Labels of the last update(): car index and the screen point (game px) of the label base. */
  labelCount = 0;
  readonly labelCar: Int32Array;
  readonly labelX: Float32Array;
  readonly labelY: Float32Array;
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly c: Float32Array;
  private readonly d: Float32Array;
  private readonly e: Float32Array;
  private readonly attrs: InstancedBufferAttribute[];
  private readonly colours: Float32Array;
  private readonly colourCount: number;
  private readonly halfLength: number;
  private readonly placement: Placement = { x: 0, y: 0, w: 0, h: 0, depth: 0 };
  private readonly proj: Vector4;
  private readonly tumble: CrashTumble;
  /** Smoothed R89 body yaw per car index, degrees; NaN = not started. */
  private readonly yawDeg: Float32Array;
  private n = 0;

  constructor(
    private readonly cfg: Car3dConfig,
    private readonly draw: RivalDrawConfig,
    private readonly traffic: TrafficDrawConfig,
    private readonly weight: CarWeightConfig,
    private readonly bump: BumpFeedbackConfig,
    private readonly crash: CrashTumbleConfig,
    private readonly camera: CameraConfig,
    private readonly road: RoadConfig,
    palette: Palette,
    roll: RollUniform,
    private readonly overscan: { overscanPx: number },
    carCount: number,
  ) {
    const built = buildPlayerBody(cfg);
    const verts = built.keys.length;
    const shade = new Float32Array(verts * 3);
    const colour = new Float32Array(verts * 3);
    const isBody = new Float32Array(verts);
    let halfLength = 0;
    for (let i = 0; i < verts; i++) {
      shade[i * 3] = built.shade[i]!;
      halfLength = Math.max(halfLength, Math.abs(built.pos[i * 3 + 2]!));
      const key = built.keys[i]!;
      if (key === BODY) isBody[i] = 1;
      else {
        const hex = palette[key as keyof Palette];
        if (typeof hex !== 'string') throw new Error(`car3d: unknown palette colour '${key}'`);
        writeHex(colour, i * 3, hex);
      }
    }
    this.halfLength = halfLength;
    this.colourCount = palette.rivals.length;
    this.colours = new Float32Array(this.colourCount * 3);
    for (let i = 0; i < this.colourCount; i++) writeHex(this.colours, i * 3, palette.rivals[i]!);
    this.tumble = new CrashTumble(crash);
    this.yawDeg = new Float32Array(carCount).fill(NaN);

    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(built.pos), 3));
    geo.setAttribute('aShade', new BufferAttribute(shade, 3));
    geo.setAttribute('aColor', new BufferAttribute(colour, 3));
    geo.setAttribute('aBody', new BufferAttribute(isBody, 1));
    const cap = Math.max(1, Math.floor(draw.capacity));
    this.capacity = cap;
    this.a = new Float32Array(cap * 4);
    this.b = new Float32Array(cap * 4);
    this.c = new Float32Array(cap * 4);
    this.d = new Float32Array(cap * 2);
    this.e = new Float32Array(cap * 4);
    this.labelCar = new Int32Array(cap);
    this.labelX = new Float32Array(cap);
    this.labelY = new Float32Array(cap);
    this.attrs = [
      new InstancedBufferAttribute(this.a, 4).setUsage(DynamicDrawUsage),
      new InstancedBufferAttribute(this.b, 4).setUsage(DynamicDrawUsage),
      new InstancedBufferAttribute(this.c, 4).setUsage(DynamicDrawUsage),
      new InstancedBufferAttribute(this.d, 2).setUsage(DynamicDrawUsage),
      new InstancedBufferAttribute(this.e, 4).setUsage(DynamicDrawUsage),
    ];
    geo.setAttribute('iA', this.attrs[0]!);
    geo.setAttribute('iB', this.attrs[1]!);
    geo.setAttribute('iC', this.attrs[2]!);
    geo.setAttribute('iD', this.attrs[3]!);
    geo.setAttribute('iE', this.attrs[4]!);
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
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Rivals drawn by the last update(). */
  get count(): number {
    return this.n;
  }

  /**
   * Places every 'rival' car of `curr` (interpolated from `prev`) at z + zOffset, as traffic.
   * dt = frame seconds for the yaw smoothing; model = H14 driving model (0 A, 1 B); crashTicks =
   * crashTime in ticks; driftYawMaxDeg = R24 yaw at full angle (model A); nameDistance =
   * rivalNameDistance in segments ahead of the player (labels). R45b: the tail lights of every
   * drawn rival go to `lights`.
   */
  update(
    proj: Projection,
    prev: readonly Car[],
    curr: readonly Car[],
    alpha: number,
    dt: number,
    zOffset: number,
    model: number,
    crashTicks: number,
    driftYawMaxDeg: number,
    nameDistance: number,
    lights: TailLights,
    track: Track,
  ): void {
    const cam = this.camera;
    const slope = this.cfg.slope;
    const road = this.road;
    const tc = this.traffic;
    const w = this.weight;
    const p = this.placement;
    const f = focalPx(cam);
    const d0 = nearDistance(cam, f);
    const cx = cam.screenWidth / 2;
    const hy = cam.horizon * cam.screenHeight;
    this.proj.set(f, cx, hy, 0);
    const carW = (this.draw.widthLanes * 2 * road.halfWidth) / road.lanes;
    const k = carW / this.cfg.width;
    const half = this.halfLength * k;
    const step = 2 / (proj.count - 1);
    const over = this.overscan.overscanPx;
    const player = curr[0]!;
    const playerPrev = prev[0]!;
    const zPlayer = playerPrev.z + (player.z - playerPrev.z) * alpha;
    const blinkHz = this.bump.blinkHz;
    let n = 0;
    let labels = 0;
    for (let i = 0; i < curr.length && n < this.capacity; i++) {
      const bc = curr[i]!;
      if (bc.kind !== 'rival') continue;
      const ac = prev[i]!;
      const jump = bc.z - ac.z;
      // R63b: a pool respawn moves the car in one tick: no tween, restart the yaw smoothing.
      const snap = jump > tc.snapSegments || jump < -tc.snapSegments || ac.nameId !== bc.nameId;
      const zs = snap ? bc.z : ac.z + jump * alpha;
      const x = snap ? bc.x : ac.x + (bc.x - ac.x) * alpha;
      const t = snap ? 1 : alpha;
      // R89 (model B) body yaw, smoothed like CarWeight; model A: the R24 drift yaw.
      let target: number;
      if (model === 1) {
        const vel = (snap ? bc.vel : ac.vel + (bc.vel - ac.vel) * t) || 0;
        const vis =
          (snap ? bc.yaw : ac.yaw + (bc.yaw - ac.yaw) * t) -
          vel +
          (snap ? bc.carry : ac.carry + (bc.carry - ac.carry) * t);
        target = vis * w.slipDeg + vel * w.velDeg;
      } else target = (ac.angle + (bc.angle - ac.angle) * t) * driftYawMaxDeg;
      const prevYaw = this.yawDeg[i]!;
      const yawDeg = snap || prevYaw !== prevYaw ? target : approach(prevYaw, target, dt, w.yawTau);
      this.yawDeg[i] = yawDeg;
      // R45 blink: same on/off rule as the player.
      if (bc.bumpTicks > 0 && Math.floor(bc.bumpTicks * DT * blinkHz * 2) % 2 !== 0) continue;

      const z = zs + zOffset;
      let r = (z - proj.base) % proj.length;
      if (r < 0) r += proj.length;
      if (r > tc.drawDistance || !placeOnRoad(p, proj, z, x, carW, carW)) continue;
      const s = p.w / carW;
      const zc = f / s;
      const zr = zc - half;
      if (zr <= 0) continue;
      if (p.x + p.w * 1.5 < -over || p.x - p.w * 1.5 > cam.screenWidth + over) continue;
      const li = Math.min(Math.floor(r), proj.count - 2);
      const xi = (proj.x[li]! - cx) / proj.scale[li]!;
      const xj = (proj.x[li + 1]! - cx) / proj.scale[li + 1]!;
      let roadYaw = tc.yawGain * Math.atan2(xj - xi, road.segmentLength);
      const yawMax = tc.yawMaxDeg * DEG;
      if (roadYaw > yawMax) roadYaw = yawMax;
      else if (roadYaw < -yawMax) roadYaw = -yawMax;
      // R49 tumble from crashTicks (interpolated), side of the lamp from crashX0.
      const tb = this.tumble;
      tb.update(
        snap ? bc.crashTicks : ac.crashTicks,
        bc.crashTicks,
        crashTicks,
        bc.crashX0 < 0 ? -1 : 1,
        t,
      );
      const yaw = roadYaw + (yawDeg + tb.yawDeg) * DEG;
      let nr = (zr - d0) / road.segmentLength + proj.frac;
      if (nr < 0) nr = 0;
      const ni = Math.floor(nr);
      const rearDepth = -1 + step * (ni + 0.05 + 0.2 * (nr - ni));
      let clip = -10;
      const hidden = proj.clipped[ni] === 1;
      if (hidden) {
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
      const id = bc.nameId < 0 ? 0 : bc.nameId;
      const col = (id % this.colourCount) * 3;
      this.c[o] = this.colours[col]!;
      this.c[o + 1] = this.colours[col + 1]!;
      this.c[o + 2] = this.colours[col + 2]!;
      this.c[o + 3] = 0;
      this.d[n * 2] = clip;
      this.d[n * 2 + 1] = zr;
      this.e[o] = -tb.rollDeg * DEG;
      this.e[o + 1] = tb.hop;
      this.e[o + 2] = this.crash.pivotY;
      // R30b: pitch along the road under the car, at the z it is drawn at.
      const pitch = slopePitchDeg(track, z, slope.slopeHalfSpan, slope.slopePitchGain) * DEG;
      this.e[o + 3] = pitch;
      lights.addCar(
        this.a[o]!,
        this.a[o + 1]!,
        zc,
        k,
        this.b[o]!,
        this.b[o + 1]!,
        this.halfLength,
        this.b[o + 2]! - 0.05 * step,
        clip,
        this.e[o]!,
        // R30b: the lights follow the vertical displacement of the rear under the pitch.
        tb.hop - this.halfLength * Math.sin(pitch),
        this.crash.pivotY,
      );
      n++;
      // Name label: rivals ahead within nameDistance, not behind a crest.
      const ahead = zs - zPlayer;
      if (!hidden && ahead > 0 && ahead <= nameDistance) {
        this.labelCar[labels] = i;
        this.labelX[labels] = p.x;
        this.labelY[labels] = p.y - (this.draw.labelLift + tb.hop) * k * s;
        labels++;
      }
    }
    this.n = n;
    this.labelCount = labels;
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (let j = 0; j < this.attrs.length; j++) {
      const at = this.attrs[j]!;
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * at.itemSize);
      at.needsUpdate = true;
    }
  }
}

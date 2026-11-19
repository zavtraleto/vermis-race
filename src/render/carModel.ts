import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Vector3,
} from 'three';
import type { Palette } from '../data/render';
import type { CameraConfig } from './projection';
import type { SpritesConfig } from './worldSprites';

type PaletteKey = keyof Palette;

/**
 * Deformed box in car space (x right, y up, z toward the rear = toward the camera):
 * bottom rectangle at y0 spans zf..zr with half-width wb; top rectangle spans tzf..tzr with
 * half-width wt, its front edge at height yf and its rear edge at yr.
 */
export interface CarBox {
  color: string;
  x: number;
  wb: number;
  wt: number;
  y0: number;
  zf: number;
  zr: number;
  tzf: number;
  tzr: number;
  yf: number;
  yr: number;
}

/** R25 low-poly player car (render only; numbers in src/data/car3d.json). */
export interface Car3dConfig {
  fovDeg: number; // vertical FOV of the car camera
  near: number;
  far: number;
  width: number; // car width in model units, fitted to sprites.player.width of the screen
  rearAxleZ: number; // rear axle, model units behind the car centre; anchored at sprites.player.baseY
  yawPivotZ: number; // vertical yaw axis, model units behind the car centre
  driftRollDeg: number; // roll outward of the drift at yawMaxDeg
  shade: { top: number; front: number; side: number; rear: number; bottom: number };
  boxes: CarBox[];
  wheels: {
    color: string;
    radius: number;
    segments: number;
    x: number; // wheel centre, model units from the centre line
    frontZ: number;
    frontWidth: number;
    rearWidth: number;
  };
  lights: { color: string; radius: number; segments: number; y: number; z: number; x: number[] };
  shadow: { color: string; halfWidth: number; front: number; rear: number; y: number };
  traffic: TrafficModelConfig;
}

/**
 * R45 traffic bodies: exactly three variants with the same box list (same count and colour key
 * per box, so they share one topology and one draw call). Colour key "body" = per-car colour
 * from palette.traffic; other keys are palette colours.
 */
export interface TrafficModelConfig {
  width: number; // model width, fitted to sprites.traffic.widthLanes on the road
  shadow: Car3dConfig['shadow'];
  bodies: { name: string; boxes: CarBox[] }[];
}

const DEG = Math.PI / 180;

function paletteHex(palette: Palette, key: string): string {
  const hex = palette[key as PaletteKey];
  if (typeof hex !== 'string') throw new Error(`car3d: unknown palette colour '${key}'`);
  return hex;
}

/**
 * Collects triangles with a colour key and a face shade per vertex; build time only.
 * The player car bakes key x shade into linear colours (buildCarGeometry); traffic keeps them
 * apart so the body colour can come per instance (trafficModels.ts).
 */
export class Builder {
  readonly pos: number[] = [];
  readonly shade: number[] = [];
  readonly keys: string[] = []; // one per vertex

  constructor(private readonly cfg: Pick<Car3dConfig, 'shade' | 'wheels' | 'lights' | 'shadow'>) {}

  /**
   * Triangle a-b-c wound outward (away from `inside`), coloured palette[key] x shade by face
   * orientation (top lightest, front, side, rear, underside darkest); `lit` false keeps the colour.
   */
  tri(a: number[], b: number[], c: number[], inside: number[], key: string, lit = true): void {
    const ux = b[0]! - a[0]!,
      uy = b[1]! - a[1]!,
      uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!,
      vy = c[1]! - a[1]!,
      vz = c[2]! - a[2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) return;
    const ox = (a[0]! + b[0]! + c[0]!) / 3 - inside[0]!;
    const oy = (a[1]! + b[1]! + c[1]!) / 3 - inside[1]!;
    const oz = (a[2]! + b[2]! + c[2]!) / 3 - inside[2]!;
    const flip = nx * ox + ny * oy + nz * oz < 0;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const s = this.cfg.shade;
    const ax = Math.abs(nx),
      ay = Math.abs(ny),
      az = Math.abs(nz);
    const shade = !lit
      ? 1
      : ay >= ax && ay >= az
        ? ny > 0
          ? s.top
          : s.bottom
        : az >= ax
          ? nz > 0
            ? s.rear
            : s.front
          : s.side;
    const verts = flip ? [a, c, b] : [a, b, c];
    for (const p of verts) {
      this.pos.push(p[0]!, p[1]!, p[2]!);
      this.shade.push(shade);
      this.keys.push(key);
    }
  }

  quad(a: number[], b: number[], c: number[], d: number[], inside: number[], key: string): void {
    this.tri(a, b, c, inside, key);
    this.tri(a, c, d, inside, key);
  }

  box(b: CarBox): void {
    const x = b.x;
    const p = [
      [x - b.wb, b.y0, b.zf],
      [x + b.wb, b.y0, b.zf],
      [x + b.wb, b.y0, b.zr],
      [x - b.wb, b.y0, b.zr],
      [x - b.wt, b.yf, b.tzf],
      [x + b.wt, b.yf, b.tzf],
      [x + b.wt, b.yr, b.tzr],
      [x - b.wt, b.yr, b.tzr],
    ];
    const c = [0, 0, 0];
    for (const v of p) for (let k = 0; k < 3; k++) c[k]! += v[k]! / 8;
    const q = (i: number, j: number, k: number, l: number): void =>
      this.quad(p[i]!, p[j]!, p[k]!, p[l]!, c, b.color);
    q(0, 1, 2, 3); // bottom
    q(4, 5, 6, 7); // top
    q(0, 1, 5, 4); // front
    q(3, 2, 6, 7); // rear
    q(0, 3, 7, 4); // left
    q(1, 2, 6, 5); // right
  }

  /** Low-segment cylinder along x: tread quads + two fan caps. */
  wheel(cx: number, cz: number, width: number): void {
    const w = this.cfg.wheels;
    const r = w.radius;
    const n = w.segments;
    const c = [cx, r, cz];
    const ring = (side: number): number[][] => {
      const out: number[][] = [];
      for (let i = 0; i < n; i++) {
        const a = ((i + 0.5) / n) * Math.PI * 2;
        out.push([cx + side * width * 0.5, r + Math.cos(a) * r, cz + Math.sin(a) * r]);
      }
      return out;
    };
    const L = ring(-1);
    const R = ring(1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.quad(L[i]!, L[j]!, R[j]!, R[i]!, c, w.color);
    }
    for (let i = 1; i < n - 1; i++) {
      this.tri(L[0]!, L[i]!, L[i + 1]!, c, w.color);
      this.tri(R[0]!, R[i]!, R[i + 1]!, c, w.color);
    }
  }

  /** Flat round lamp facing the rear (+z), unlit. */
  lamp(cx: number): void {
    const l = this.cfg.lights;
    const ring: number[][] = [];
    for (let i = 0; i < l.segments; i++) {
      const a = ((i + 0.5) / l.segments) * Math.PI * 2;
      ring.push([cx + Math.cos(a) * l.radius, l.y + Math.sin(a) * l.radius, l.z]);
    }
    const inside = [cx, l.y, l.z - 1];
    for (let i = 1; i < l.segments - 1; i++)
      this.tri(ring[0]!, ring[i]!, ring[i + 1]!, inside, l.color, false);
  }

  shadow(s: Car3dConfig['shadow'] = this.cfg.shadow): void {
    const a = [-s.halfWidth, s.y, s.front];
    const b = [s.halfWidth, s.y, s.front];
    const c = [s.halfWidth, s.y, s.rear];
    const d = [-s.halfWidth, s.y, s.rear];
    const below = [0, s.y - 1, 0];
    this.tri(a, b, c, below, s.color, false);
    this.tri(a, c, d, below, s.color, false);
  }
}

/**
 * Spike ?print: two-tone shading. The body (key "player") goes from its colour toward `shadow`
 * by (1 - face shade) x amount, so every body colour lies on one palette segment; other keys stay
 * flat. Raw sRGB (the print mode turns colour management off).
 */
export interface DuoShade {
  shadow: string;
  amount: number;
}

/** R25: one merged, non-indexed geometry with per-vertex colours (lighting baked in). */
export function buildCarGeometry(
  cfg: Car3dConfig,
  palette: Palette,
  duo?: DuoShade,
): BufferGeometry {
  const b = new Builder(cfg);
  b.shadow();
  const w = cfg.wheels;
  for (const side of [-1, 1]) {
    b.wheel(side * w.x, w.frontZ, w.frontWidth);
    b.wheel(side * w.x, cfg.rearAxleZ, w.rearWidth);
  }
  for (const box of cfg.boxes) b.box(box);
  for (const x of cfg.lights.x) b.lamp(x);
  const col = new Float32Array(b.pos.length);
  const color = new Color();
  const sh = duo ? parseInt(duo.shadow.slice(1), 16) : 0;
  for (let i = 0; i < b.keys.length; i++) {
    const v = parseInt(paletteHex(palette, b.keys[i]!).slice(1), 16);
    const shade = b.shade[i]!;
    if (duo) {
      const t = b.keys[i] === 'player' ? Math.min(1, Math.max(0, (1 - shade) * duo.amount)) : 0;
      for (let c = 0; c < 3; c++) {
        const shift = 16 - c * 8;
        const from = ((v >> shift) & 0xff) / 255;
        col[i * 3 + c] = from + (((sh >> shift) & 0xff) / 255 - from) * t;
      }
      continue;
    }
    // Palette is sRGB; shade in sRGB, then convert to the linear working space the material expects.
    color.setRGB(
      (((v >> 16) & 0xff) / 255) * shade,
      (((v >> 8) & 0xff) / 255) * shade,
      ((v & 0xff) / 255) * shade,
      SRGBColorSpace,
    );
    col[i * 3] = color.r;
    col[i * 3 + 1] = color.g;
    col[i * 3 + 2] = color.b;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3));
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Pose of the car camera (pure). The camera has its own vertical FOV; it is pitched so the car's
 * ground plane vanishes on the road's horizon line, and placed so the rear-axle ground centre lands
 * at (screen centre, baseY) with the car `width` spanning `widthFrac` of the screen.
 */
export interface CarCameraPose {
  pitch: number; // rad, positive = looking down
  height: number; // camera above the anchor, model units
  back: number; // camera behind the anchor, model units
  depth: number; // anchor depth along the view axis, model units
  focalPx: number;
}

export function carCameraPose(
  out: CarCameraPose,
  camera: CameraConfig,
  player: Pick<SpritesConfig['player'], 'baseY' | 'width'>,
  car: Pick<Car3dConfig, 'fovDeg' | 'width'>,
): CarCameraPose {
  const h = camera.screenHeight;
  const f = h / 2 / Math.tan((car.fovDeg * DEG) / 2);
  const pitch = Math.atan((h / 2 - camera.horizon * h) / f);
  // Angle of the anchor ray below the horizontal.
  const down = pitch + Math.atan((player.baseY * h - h / 2) / f);
  const depth = (car.width * f) / (player.width * camera.screenWidth);
  const r = depth / Math.cos(down - pitch);
  out.pitch = pitch;
  out.height = r * Math.sin(down);
  out.back = r * Math.cos(down);
  out.depth = depth;
  out.focalPx = f;
  return out;
}

/**
 * R25 player car: its own scene and perspective camera, drawn after the road pass over a cleared
 * depth buffer. update() poses the car (yaw/roll in degrees, screen shift in px) and projects the
 * rear wheel contact points for the smoke. No allocations after construction.
 */
export class CarView {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  /** Screen px of the left / right rear wheel ground contact, from the last update(). */
  rearLX = 0;
  rearLY = 0;
  rearRX = 0;
  rearRY = 0;
  private readonly pose: CarCameraPose = { pitch: 0, height: 0, back: 0, depth: 0, focalPx: 0 };
  private readonly v = new Vector3();

  constructor(
    private readonly cfg: Car3dConfig,
    private readonly player: SpritesConfig['player'],
    private readonly view: CameraConfig,
    palette: Palette,
    duo?: DuoShade,
  ) {
    this.camera = new PerspectiveCamera(
      cfg.fovDeg,
      view.screenWidth / view.screenHeight,
      cfg.near,
      cfg.far,
    );
    this.mesh = new Mesh(
      buildCarGeometry(cfg, palette, duo),
      new MeshBasicMaterial({ vertexColors: true }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.rotation.order = 'YXZ';
    this.scene.add(this.mesh);
  }

  /**
   * yawDeg > 0 turns the nose right; rollDeg > 0 tilts the roof right; dxPx shifts on screen;
   * pitchDeg > 0 = nose down (R26). screenRollDeg (R27) rolls the camera about its view axis so
   * the car turns with the rest of the picture (> 0 = picture counter-clockwise); the rear wheel
   * points stay in unrolled screen space, like every other sprite before the shader roll.
   */
  update(yawDeg: number, rollDeg: number, dxPx: number, pitchDeg = 0, screenRollDeg = 0): void {
    const cfg = this.cfg;
    const view = this.view;
    const pose = carCameraPose(this.pose, view, this.player, cfg);
    const cam = this.camera;
    // Camera config, baseY and width are read live (dev tuning panel).
    const aspect = view.screenWidth / view.screenHeight;
    if (
      cam.fov !== cfg.fovDeg ||
      cam.aspect !== aspect ||
      cam.near !== cfg.near ||
      cam.far !== cfg.far
    ) {
      cam.fov = cfg.fovDeg;
      cam.aspect = aspect;
      cam.near = cfg.near;
      cam.far = cfg.far;
      cam.updateProjectionMatrix();
    }
    cam.position.set(0, pose.height, pose.back);
    cam.rotation.set(-pose.pitch, 0, 0);
    cam.updateMatrixWorld();
    const m = this.mesh;
    // Anchor (rear-axle ground centre) at the origin when straight; the yaw turns the car about a
    // vertical axis at car-space z = yawPivotZ, so the nose swings into the corner, the rear out.
    const b = -yawDeg * DEG;
    const pz = cfg.yawPivotZ;
    m.position.set(
      (dxPx * pose.depth) / pose.focalPx - pz * Math.sin(b),
      0,
      -cfg.rearAxleZ + pz - pz * Math.cos(b),
    );
    // Order YXZ (set in the constructor): yaw about the world vertical, pitch and roll in the body.
    m.rotation.set(-pitchDeg * DEG, b, -rollDeg * DEG);
    m.updateMatrixWorld();
    const v = this.v;
    v.set(-cfg.wheels.x, 0, cfg.rearAxleZ).applyMatrix4(m.matrixWorld).project(cam);
    this.rearLX = ((v.x + 1) / 2) * view.screenWidth;
    this.rearLY = ((1 - v.y) / 2) * view.screenHeight;
    v.set(cfg.wheels.x, 0, cfg.rearAxleZ).applyMatrix4(m.matrixWorld).project(cam);
    this.rearRX = ((v.x + 1) / 2) * view.screenWidth;
    this.rearRY = ((1 - v.y) / 2) * view.screenHeight;
    if (screenRollDeg !== 0) {
      // Rolling the camera by -a about its view axis turns the image by +a about the centre.
      cam.rotation.set(-pose.pitch, 0, -screenRollDeg * DEG);
      cam.updateMatrixWorld();
    }
  }
}

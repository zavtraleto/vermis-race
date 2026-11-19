import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  Fog,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Vector3,
  type WebGLRenderer,
} from 'three';
import type { Palette } from '../data/render';
import { Builder, buildCarGeometry, type Car3dConfig } from '../render/carModel';
import type { CarWeight } from '../render/carWeight';
import { approach, type DriftVisual } from '../render/driftVisual';
import type { RoadMeshConfig } from '../render/roadMesh';
import {
  ROADSIDE_BILLBOARD,
  ROADSIDE_BUILDING,
  ROADSIDE_LAMP,
  type Roadside,
} from '../render/roadside';
import type { ScreenRoll } from '../render/screenRoll';
import type { BumpFeedback } from '../render/bumpFeedback';
import type { SpritesConfig } from '../render/worldSprites';
import type { Car, Track } from '../sim/types';
import { linearHex, RoadRibbon, RoadWindow, type RoadPoint, type Render3dConfig } from './road3d';

const DEG = Math.PI / 180;
const VARIANTS = 3;

export interface Render3dDeps {
  cfg: Render3dConfig;
  track: Track;
  road: RoadMeshConfig;
  palette: Palette;
  car3d: Car3dConfig;
  sprites: SpritesConfig;
  screenWidth: number;
  screenHeight: number;
  drift: DriftVisual;
  weight: CarWeight;
  roll: ScreenRoll;
  bump: BumpFeedback;
  roadside: Roadside;
  roadsideIndex: Int32Array;
}

export interface Render3dInfo {
  calls: number;
  triangles: number;
  traffic: number;
  boxes: number;
}

/**
 * Traffic body variant as a plain coloured geometry: vertex colour = palette x shade for fixed
 * parts, shade only (grey) for the body; aBody marks the body vertices so the per-instance
 * colour tints only them (patched into MeshBasicMaterial below).
 */
function trafficGeometry(cfg: Car3dConfig, palette: Palette, v: number): BufferGeometry {
  const b = new Builder(cfg);
  b.shadow(cfg.traffic.shadow);
  for (const box of cfg.traffic.bodies[v]!.boxes) b.box(box);
  const n = b.keys.length;
  const col = new Float32Array(n * 3);
  const body = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const key = b.keys[i]!;
    const shade = b.shade[i]!;
    if (key === 'body') {
      body[i] = 1;
      linearHex(col, i * 3, '#ffffff', shade);
    } else {
      const hex = palette[key as keyof Palette];
      if (typeof hex !== 'string') throw new Error(`render3d: unknown palette colour '${key}'`);
      linearHex(col, i * 3, hex, shade);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3));
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setAttribute('aBody', new BufferAttribute(body, 1));
  return geo;
}

function trafficMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float aBody;\n#include <common>')
      .replace(
        'vColor.rgb *= instanceColor.rgb;',
        'vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aBody);',
      );
  };
  return m;
}

/** Unit box (base at y = 0, centred in x/z) with the car face shades baked per face. */
function shadedBox(shade: Car3dConfig['shade']): BoxGeometry {
  const g = new BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  // BoxGeometry face order: +x, -x, +y, -y, +z (toward the camera = rear), -z; 4 vertices each.
  const faces = [shade.side, shade.side, shade.top, shade.bottom, shade.rear, shade.front];
  const col = new Float32Array(24 * 3);
  for (let f = 0; f < 6; f++)
    for (let v = 0; v < 4; v++) linearHex(col, (f * 4 + v) * 3, '#ffffff', faces[f]!);
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

/**
 * Spike E1 (?render=3d): the same game drawn as one real 3D scene with one PerspectiveCamera.
 * Road ribbon from a sliding window of the track, player car and traffic standing on it with
 * their contact shadows, roadside objects as instanced boxes, smoke as camera-facing quads,
 * distance fog. Reads sim and the shared visual state (drift, weight, roll, bump), never writes
 * them. No allocations per frame.
 */
export class Render3d {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private readonly win: RoadWindow;
  private readonly ribbon: RoadRibbon;
  private readonly ground: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly fog: Fog;
  private readonly carRoot = new Group();
  private readonly carPivot = new Group();
  private readonly carMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly traffic: InstancedMesh[] = [];
  private readonly trafficColours: Color[] = [];
  private readonly boxes: InstancedMesh;
  private readonly boxColours: Color[] = [];
  private readonly smoke: InstancedMesh;
  private readonly pt: RoadPoint = { x: 0, y: 0, z: 0, heading: 0, slope: 0 };
  private readonly m4 = new Matrix4();
  private readonly q = new Quaternion();
  private readonly e = new Euler(0, 0, 0, 'YXZ');
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly wl = new Vector3();
  private readonly wr = new Vector3();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private lagYaw = 0;
  private lastCamZ = Number.NaN;
  private boxCount = 0;
  private trafficCount = 0;
  private calls = 0;
  private triangles = 0;
  private readonly view = new Float64Array([NaN, NaN, NaN, NaN]);
  private playerHeading = 0;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly d: Render3dDeps,
  ) {
    const { cfg, palette, car3d } = d;
    this.camera = new PerspectiveCamera(60, d.screenWidth / d.screenHeight, 1, 1000);
    this.camera.rotation.order = 'YXZ';
    this.fog = new Fog(palette.sky, 1, 2);
    this.scene.fog = this.fog;

    this.win = new RoadWindow(cfg.capacity + cfg.behind);
    this.ribbon = new RoadRibbon(cfg.capacity + cfg.behind, d.road, palette);
    this.scene.add(this.ribbon.mesh);

    const groundGeo = new PlaneGeometry(1, 1);
    groundGeo.rotateX(-Math.PI / 2);
    this.ground = new Mesh(groundGeo, new MeshBasicMaterial({ color: palette.verge[1]! }));
    this.ground.frustumCulled = false;
    this.scene.add(this.ground);

    // Player car: root on the road (heading, slope, scale), pivot for the R24/R26 pose.
    this.carMesh = new Mesh(
      buildCarGeometry(car3d, palette),
      new MeshBasicMaterial({ vertexColors: true }),
    );
    this.carMesh.frustumCulled = false;
    this.carMesh.position.set(0, 0, -car3d.yawPivotZ);
    this.carPivot.rotation.order = 'YXZ';
    this.carPivot.position.set(0, 0, car3d.yawPivotZ - car3d.rearAxleZ);
    this.carPivot.add(this.carMesh);
    this.carRoot.rotation.order = 'YXZ';
    this.carRoot.add(this.carPivot);
    this.scene.add(this.carRoot);

    const cap = Math.max(1, Math.floor(d.sprites.traffic.capacity));
    for (let v = 0; v < VARIANTS; v++) {
      const im = new InstancedMesh(trafficGeometry(car3d, palette, v), trafficMaterial(), cap);
      im.frustumCulled = false;
      im.count = 0;
      im.setColorAt(0, new Color(1, 1, 1));
      this.traffic.push(im);
      this.scene.add(im);
    }
    for (const hex of palette.traffic) this.trafficColours.push(new Color(hex));

    this.boxes = new InstancedMesh(
      shadedBox(car3d.shade),
      new MeshBasicMaterial({ vertexColors: true }),
      cfg.roadsideCapacity,
    );
    this.boxes.frustumCulled = false;
    this.boxes.count = 0;
    this.boxes.setColorAt(0, new Color(1, 1, 1));
    this.scene.add(this.boxes);
    // Box colour slots, same order as the pseudo-3D WorldSprites table.
    const fixed = [
      palette.post,
      palette.smoke,
      palette.lampPole,
      palette.lampHead,
      palette.billboardLeg,
      palette.billboardFrame,
      palette.billboardStripe,
      palette.buildingWindow,
      palette.postCap,
      ...palette.billboard,
      ...palette.building,
    ];
    for (const hex of fixed) this.boxColours.push(new Color(hex));

    this.smoke = new InstancedMesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ color: palette.smoke }),
      cfg.smokeCapacity,
    );
    this.smoke.frustumCulled = false;
    this.smoke.count = 0;
    this.scene.add(this.smoke);
  }

  /** Builds the frame from the two last sim states; dt drives the camera lag. */
  update(prev: readonly Car[], curr: readonly Car[], alpha: number, dt: number): void {
    const d = this.d;
    const cfg = d.cfg;
    const cc = cfg.camera;
    const segLen = d.road.segmentLength;
    const hw = d.road.halfWidth;
    const p = prev[0]!;
    const c = curr[0]!;
    const z = p.z + (c.z - p.z) * alpha;
    const x = p.x + (c.x - p.x) * alpha;
    const camZ = z - cc.distance / segLen;
    const ahead = Math.min(Math.floor(cfg.drawDistance), cfg.capacity);
    const base = Math.floor(camZ) - cfg.behind;
    this.win.build(d.track, base, ahead + cfg.behind, cfg.k3dCurve, segLen);
    this.ribbon.update(this.win, cfg.vergeWidth, cfg.liftRoad, cfg.liftMark);

    // Heading lag: the camera turns after the road (offset relative to the tangent, so the
    // per-frame re-basing of the window does not touch it).
    const pt = this.pt;
    this.win.sample(pt, z, 0);
    const carRoadY = pt.y;
    const camLat = (x + d.drift.cameraX + d.bump.shake) * hw;
    this.win.sample(pt, camZ, camLat);
    // Hills: pitch toward the car's road height so the car keeps its screen line (R33 strip).
    const slopePitch = cc.slopeFollow * Math.atan((carRoadY - pt.y) / cc.distance);
    if (Number.isFinite(this.lastCamZ) && Math.abs(camZ - this.lastCamZ) < 5) {
      const dz = camZ - this.lastCamZ;
      const segAt = Math.floor(camZ) - base;
      this.lagYaw -= this.win.curve[segAt]! * cfg.k3dCurve * dz;
    }
    this.lastCamZ = camZ;
    this.lagYaw = approach(this.lagYaw, 0, dt, cc.lagTau);
    if (cc.lagTau <= 0) this.lagYaw = 0;

    const cam = this.camera;
    const vfov = (2 * Math.atan(Math.tan((cc.fovDeg * DEG) / 2) / cam.aspect)) / DEG;
    const far = cfg.drawDistance * segLen * 1.25;
    const vk = this.view;
    if (vk[0] !== vfov || vk[1] !== cc.near || vk[2] !== far || vk[3] !== cc.horizon) {
      vk[0] = vfov;
      vk[1] = cc.near;
      vk[2] = far;
      vk[3] = cc.horizon;
      cam.fov = vfov;
      cam.near = cc.near;
      cam.far = far;
      const W = d.screenWidth;
      const H = d.screenHeight;
      cam.setViewOffset(W, H, 0, (0.5 - cc.horizon) * H, W, H);
      cam.updateProjectionMatrix();
    }
    cam.position.set(pt.x, pt.y + cc.height, pt.z);
    // R27: camera roll = picture roll (sign as in CarView).
    cam.rotation.set(
      -cc.pitchDeg * DEG + slopePitch,
      -(pt.heading + this.lagYaw),
      -d.roll.deg * DEG,
    );
    cam.updateMatrixWorld();
    const roadLen = cfg.drawDistance * segLen;
    this.fog.near = cfg.fog.near * roadLen;
    this.fog.far = cfg.fog.far * roadLen;

    // Ground plane under the whole view, below the lowest line of the window.
    let minY = Infinity;
    for (let i = 0; i <= this.win.count; i++) if (this.win.py[i]! < minY) minY = this.win.py[i]!;
    this.ground.position.set(pt.x, minY - cfg.groundDrop, pt.z);
    this.ground.scale.set(far * 2.2, 1, far * 2.2);

    this.placePlayer(z, x);
    this.placeTraffic(prev, curr, alpha);
    this.placeRoadside();
    this.placeSmoke();
  }

  render(): void {
    const r = this.renderer;
    r.info.reset();
    r.clear();
    r.render(this.scene, this.camera);
    this.calls = r.info.render.calls;
    this.triangles = r.info.render.triangles;
  }

  info(): Render3dInfo {
    return {
      calls: this.calls,
      triangles: this.triangles,
      traffic: this.trafficCount,
      boxes: this.boxCount,
    };
  }

  private placePlayer(z: number, x: number): void {
    const d = this.d;
    const pt = this.pt;
    const k = d.cfg.playerWidth / d.car3d.width;
    this.win.sample(pt, z, x * d.road.halfWidth);
    const root = this.carRoot;
    root.position.set(pt.x, pt.y, pt.z);
    root.rotation.set(Math.atan(pt.slope), -pt.heading, 0);
    root.scale.setScalar(k);
    this.playerHeading = pt.heading;
    // R24/R26 pose: yaw (drift angle or lateral motion), weight roll and pitch, as in CarView.
    const w = d.weight;
    this.carPivot.rotation.set(-w.pitch * DEG, -w.yaw * DEG, -w.roll * DEG);
    this.carMesh.visible = d.bump.visible; // R45 blink
    root.updateMatrixWorld(true);
  }

  private placeTraffic(prev: readonly Car[], curr: readonly Car[], alpha: number): void {
    const d = this.d;
    const dc = d.sprites.traffic;
    const road = d.road;
    const pt = this.pt;
    const carW = (dc.widthLanes * 2 * road.halfWidth) / road.lanes;
    const k = carW / d.car3d.traffic.width;
    const len = d.track.segments.length;
    for (let v = 0; v < VARIANTS; v++) this.traffic[v]!.count = 0;
    let n = 0;
    for (let i = 0; i < curr.length; i++) {
      const bc = curr[i]!;
      if (bc.kind !== 'traffic') continue;
      const ac = prev[i]!;
      const jump = bc.z - ac.z;
      // R71 respawn: no tween across the jump.
      const snap = jump > dc.snapSegments || jump < -dc.snapSegments;
      const z = snap ? bc.z : ac.z + jump * alpha;
      const x = snap ? bc.x : ac.x + (bc.x - ac.x) * alpha;
      let rel = (z - this.win.base) % len;
      if (rel < 0) rel += len;
      if (rel > dc.drawDistance || !this.win.sample(pt, this.win.base + rel, x * road.halfWidth))
        continue;
      const mesh = this.traffic[i % VARIANTS]!;
      if (mesh.count >= mesh.instanceMatrix.count) continue;
      this.e.set(Math.atan(pt.slope), -pt.heading, 0);
      this.q.setFromEuler(this.e);
      this.v.set(pt.x, pt.y, pt.z);
      this.s.setScalar(k);
      this.m4.compose(this.v, this.q, this.s);
      mesh.setMatrixAt(mesh.count, this.m4);
      mesh.setColorAt(mesh.count, this.trafficColours[i % this.trafficColours.length]!);
      mesh.count += 1;
      n++;
    }
    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.traffic[v]!;
      mesh.visible = mesh.count > 0;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
      mesh.instanceMatrix.needsUpdate = true;
      const ic = mesh.instanceColor!;
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, mesh.count * 3);
      ic.needsUpdate = true;
    }
    this.trafficCount = n;
  }

  /**
   * One box standing on line n: lateral / along offsets of its base centre (world units, along
   * > 0 = ahead), base height `up`, size w (across the road) x h x dd (along the road).
   */
  private box(
    n: number,
    lateral: number,
    along: number,
    up: number,
    w: number,
    h: number,
    dd: number,
    colour: number,
  ): void {
    if (this.boxCount >= this.boxes.instanceMatrix.count) return;
    const win = this.win;
    const hd = win.heading[n]!;
    const ch = Math.cos(hd);
    const sh = Math.sin(hd);
    // right = (cos, 0, sin), forward = (sin, 0, -cos)
    this.v.set(
      win.px[n]! + lateral * ch + along * sh,
      win.py[n]! + up,
      win.pz[n]! + lateral * sh - along * ch,
    );
    this.e.set(0, -hd, 0);
    this.q.setFromEuler(this.e);
    this.s.set(w, h, dd);
    this.m4.compose(this.v, this.q, this.s);
    this.boxes.setMatrixAt(this.boxCount, this.m4);
    this.boxes.setColorAt(this.boxCount, this.boxColours[colour]!);
    this.boxCount += 1;
  }

  /** R32 posts, lamps, billboards and buildings of the window, each kind within its distance. */
  private placeRoadside(): void {
    const d = this.d;
    const rs = d.roadside;
    const first = d.roadsideIndex;
    const rc = d.sprites.roadside;
    const hw = d.road.halfWidth;
    const posts = rc.posts;
    const postEvery = Math.max(1, Math.floor(posts.every));
    const lampEvery = Math.max(1, Math.floor(rc.lamps.every));
    const panels = d.palette.billboard.length;
    const buildingAt = 9 + panels;
    const buildings = d.palette.building.length;
    const win = this.win;
    const start = d.cfg.behind; // line of the camera's segment
    this.boxCount = 0;
    for (let n = 0; n < win.count; n++) {
      const seg = win.seg[n]!;
      const ahead = n - start;
      if (seg % postEvery === 0 && seg % lampEvery !== 0) {
        for (let side = -1; side <= 1; side += 2) {
          const ph = posts.height * (1 - posts.capHeight);
          this.box(n, side * posts.offset * hw, 0, 0, posts.width, ph, posts.width, 0);
          const cap = posts.height * posts.capHeight;
          this.box(n, side * posts.offset * hw, 0, ph, posts.width, cap, posts.width, 8);
        }
      }
      if (seg + 1 >= first.length) continue;
      for (let o = first[seg]!; o < first[seg + 1]!; o++) {
        const kind = rs.kind[o]!;
        const lat = rs.x[o]! * hw;
        if (kind === ROADSIDE_LAMP) {
          const c = rc.lamps;
          if (ahead > c.drawDistance) continue;
          const toRoad = lat > 0 ? -1 : 1;
          this.box(n, lat, 0, 0, c.poleWidth, c.height, c.poleWidth, 2);
          const armUp = c.height - c.armThickness;
          const armLat = lat + (toRoad * c.armLength) / 2;
          this.box(n, armLat, 0, armUp, c.armLength, c.armThickness, c.poleWidth, 2);
          const headLat = lat + toRoad * (c.armLength - c.headWidth / 2);
          const headUp = armUp - c.headHeight;
          this.box(n, headLat, 0, headUp, c.headWidth, c.headHeight, c.headWidth, 3);
        } else if (kind === ROADSIDE_BILLBOARD) {
          const c = rc.billboards;
          if (ahead > c.drawDistance) continue;
          const legDx = c.width * (0.5 - c.legInset);
          const f = c.frame * c.height;
          const t = c.legWidth; // panel thickness
          this.box(n, lat - legDx, 0, 0, c.legWidth, c.legHeight, c.legWidth, 4);
          this.box(n, lat + legDx, 0, 0, c.legWidth, c.legHeight, c.legWidth, 4);
          this.box(n, lat, 0, c.legHeight, c.width, c.height, t, 5);
          const panel = 9 + (rs.variant[o]! % panels);
          this.box(n, lat, 0, c.legHeight + f, c.width - 2 * f, c.height - 2 * f, t * 1.2, panel);
          const sy = c.legHeight + c.stripeY * c.height;
          this.box(n, lat, 0, sy, c.width - 2 * f, c.stripeHeight * c.height, t * 1.4, 6);
        } else if (kind === ROADSIDE_BUILDING) {
          const c = rc.buildings;
          if (ahead > c.drawDistance) continue;
          const variant = rs.variant[o]!;
          const shape = c.shapes[variant % c.shapes.length]!;
          const body = buildingAt + (variant % buildings);
          // Square footprint; the base centre sits half a depth behind the line, so the face
          // toward the camera stands on the line like the pseudo-3D sprite.
          const depth = shape.width;
          this.box(n, lat, depth / 2, 0, shape.width, shape.height, depth, body);
          if (ahead > d.cfg.windowSegments || shape.cols < 1 || shape.rows < 1) continue;
          const m = c.windowMargin;
          const gap = c.windowGap;
          const areaW = shape.width * (1 - 2 * m);
          const areaH = shape.height * (1 - 2 * m);
          const pitchX = areaW / shape.cols;
          const pitchY = areaH / shape.rows;
          const left = lat - areaW / 2;
          const base = shape.height * m;
          const t = 4;
          for (let i = 0; i < shape.cols; i++) {
            const cx = left + (i + 0.5) * pitchX;
            const h = areaH - pitchY * gap;
            this.box(n, cx, -t / 2, base + (pitchY * gap) / 2, pitchX * (1 - gap), h, t, 7);
          }
          for (let r = 1; r < shape.rows; r++) {
            const bandH = pitchY * gap;
            const y = base + r * pitchY - bandH / 2;
            this.box(n, lat, -t, y, areaW, bandH, t, body);
          }
        }
      }
    }
    const b = this.boxes;
    b.count = this.boxCount;
    b.instanceMatrix.clearUpdateRanges();
    b.instanceMatrix.addUpdateRange(0, this.boxCount * 16);
    b.instanceMatrix.needsUpdate = true;
    const ic = b.instanceColor!;
    ic.clearUpdateRanges();
    ic.addUpdateRange(0, this.boxCount * 3);
    ic.needsUpdate = true;
  }

  /**
   * R24 smoke: puffs from the rear wheels, moving back along the car, rising, drifting outward and
   * growing, then shrinking (same numbers as the pseudo-3D drawSmoke, car width / height in world
   * units instead of screen px). Camera-facing quads.
   */
  private placeSmoke(): void {
    const d = this.d;
    const dc = d.sprites.drift;
    const car = d.car3d;
    const pool = d.drift.smoke;
    const sm = this.smoke;
    const carW = d.cfg.playerWidth;
    const pl = d.sprites.player;
    const carH = (carW * pl.height * d.screenHeight) / (pl.width * d.screenWidth);
    const mw = this.carMesh.matrixWorld;
    this.wl.set(-car.wheels.x, 0, car.rearAxleZ).applyMatrix4(mw);
    this.wr.set(car.wheels.x, 0, car.rearAxleZ).applyMatrix4(mw);
    const hd = this.playerHeading; // road axes at the player
    this.fwd.set(Math.sin(hd), 0, -Math.cos(hd));
    this.right.set(Math.cos(hd), 0, Math.sin(hd));
    const q = this.camera.quaternion;
    let n = 0;
    for (let i = 0; i < pool.count && n < sm.instanceMatrix.count; i++) {
      const a = pool.age01(i);
      const kx = pool.x(i) / dc.smokeWheelX;
      const fade = a > dc.smokeShrink ? (1 - a) / (1 - dc.smokeShrink) : 1;
      const size = dc.smokeSize * carW * (1 + dc.smokeGrow * a) * fade;
      const t = (kx + 1) / 2;
      const back = (pool.y(i) + dc.smokeBack * a) * carH;
      const rise = dc.smokeRise * a * carH;
      const out = -d.drift.smokeDir * dc.smokeSpread * a * carW;
      this.v.set(
        this.wl.x + (this.wr.x - this.wl.x) * t - this.fwd.x * back + this.right.x * out,
        this.wl.y + (this.wr.y - this.wl.y) * t + rise + size / 2,
        this.wl.z + (this.wr.z - this.wl.z) * t - this.fwd.z * back + this.right.z * out,
      );
      this.s.set(size, size, 1);
      this.m4.compose(this.v, q, this.s);
      sm.setMatrixAt(n, this.m4);
      n++;
    }
    sm.count = n;
    sm.visible = n > 0;
    sm.instanceMatrix.clearUpdateRanges();
    sm.instanceMatrix.addUpdateRange(0, n * 16);
    sm.instanceMatrix.needsUpdate = true;
  }
}

import type { Palette } from '../data/render';
import type { CarView } from './carModel';
import type { HudLayout, SpeedometerConfig } from '../ui/speedometer';
import type { CarWeightConfig } from './carWeight';
import type { CrashTumbleConfig } from './crashTumble';
import type { RivalDrawConfig } from './rivalModels';
import type { TailLightsConfig } from './tailLights';
import type { DriftVisual, DriftVisualConfig } from './driftVisual';
import { placeOnRoad, type Placement } from './placeOnRoad';
import { forwardDist, markRect, type TyreMarks, type TyreMarksConfig } from './tyreMarks';
import type { CameraConfig, Projection } from './projection';
import { writeHex } from './roadMesh';
import {
  ROADSIDE_BILLBOARD,
  ROADSIDE_BUILDING,
  ROADSIDE_LAMP,
  type Roadside,
  type RoadsideConfig,
} from './roadside';
import type { ScreenRollConfig } from './screenRoll';
import type { SpriteBatch } from './spriteBatch';

/** R32 placement (RoadsideConfig) plus drawing sizes. World units unless noted. */
export interface RoadsideDrawConfig extends RoadsideConfig {
  // Small shoulder posts, drawn straight from the projected lines (not in the placement); skipped
  // on lamp segments so a post never stands next to a lamp pole.
  posts: {
    every: number; // a post on each shoulder every N segments
    offset: number; // road half-widths from the centre, nearer the road than the lamps
    width: number;
    height: number;
    capHeight: number; // fraction of the post height drawn in the cap colour
  };
  lamps: RoadsideConfig['lamps'] & {
    drawDistance: number; // lines from the camera
    height: number;
    poleWidth: number;
    armLength: number; // arm reaches from the pole top toward the road
    armThickness: number;
    headWidth: number; // lamp head hanging under the arm tip
    headHeight: number;
  };
  billboards: RoadsideConfig['billboards'] & {
    drawDistance: number;
    width: number;
    height: number; // panel height
    legHeight: number; // panel bottom above the ground
    legWidth: number;
    legInset: number; // leg centre from the panel side, fraction of the panel width
    frame: number; // frame thickness, fraction of the panel height
    stripeY: number; // stripe bottom above the panel bottom, fraction of the panel height
    stripeHeight: number; // fraction of the panel height
    depthStep: number; // depth offset in segment steps: just behind a lamp on the same line
  };
  buildings: RoadsideConfig['buildings'] & {
    drawDistance: number;
    windowMinPx: number; // windows only when the building is at least this tall on screen
    windowMargin: number; // window area inset, fraction of the body width / height
    windowGap: number; // dark part of each window pitch
    depthStep: number; // depth offset in segment steps: behind lamps and billboards on the same line
    shapes: { width: number; height: number; cols: number; rows: number }[];
  };
}

export interface SpritesConfig {
  capacity: number;
  player: {
    baseY: number; // R25 rear-axle ground point of the 3D car, fraction of screen height from the top
    width: number; // car width on screen, fraction of screen width (fits the 3D car; smoke x unit)
    height: number; // smoke y unit, fraction of screen height
  };
  roadside: RoadsideDrawConfig;
  drift: DriftVisualConfig;
  smokeOver: SmokeOverConfig;
  tyreMarks: TyreMarksConfig;
  traffic: TrafficDrawConfig;
  bump: BumpFeedbackConfig;
  crash: CrashTumbleConfig;
  weight: CarWeightConfig;
  rivals: RivalDrawConfig;
  driftCamera: ScreenRollConfig;
  speedometer: SpeedometerConfig;
  leaderboard: HudLayout; // R67 leaderboard size and corner offset
  tailLights: TailLightsConfig;
}

/** R24b smoke drawn over the player car (alpha-blended overlay pass after the car). */
export interface SmokeOverConfig {
  opacity: number; // alpha of a puff from its birth until fadeFrom
  fadeFrom: number; // age01 where the alpha starts falling to 0 at the end of life
}

/** R45 traffic cars (3D bodies in trafficModels.ts; the bodies themselves live in car3d.json). */
export interface TrafficDrawConfig {
  capacity: number; // most cars drawn per frame (instance buffer size)
  drawDistance: number; // lines from the camera
  widthLanes: number; // car width, lanes
  snapSegments: number; // an interpolation jump longer than this is a respawn (R71): no tween
  yawGain: number; // car yaw = yawGain x road heading at its line
  yawMaxDeg: number;
}
/** R45 player feedback after a contact (render state only). */
export interface BumpFeedbackConfig {
  blinkHz: number; // on/off cycles per second while bumpTicks > 0
  shakeAmp: number; // camera shake, road half-widths
  shakeTime: number; // s, linear decay to 0
  shakeHz: number;
}

/** Extra placeholder props used only by the stress scenario. */
export interface StressFill {
  instances: number; // total instances to reach
  offset: number; // road half-widths
  width: number;
  height: number;
}

// Colour slots in the rgb table, 3 floats each.
const POST = 0;
const SMOKE = 3;
const LAMP_POLE = 6;
const LAMP_HEAD = 9;
const BB_LEG = 12;
const BB_FRAME = 15;
const BB_STRIPE = 18;
const WINDOW = 21;
const POST_CAP = 24;
const TYRE_MARK = 27;
const ASPHALT = 30;
const FADED = 33; // scratch slot: tyre mark colour faded toward the asphalt, rewritten per push
const BB_PANEL = 36; // palette.billboard[], then palette.building[]

/** Placeholder sprites of layers 2-4: roadside objects, drift smoke, stress filler. */
export class WorldSprites {
  private readonly rgb: Float32Array;
  private readonly placement: Placement = { x: 0, y: 0, w: 0, h: 0, depth: 0 };
  private readonly screenW: number;
  private readonly screenH: number;
  private readonly panels: number;
  private readonly buildingAt: number;
  private readonly buildings: number;
  // Current crest clip line for rect(), set per projected line (R30).
  private clipY = Infinity;

  constructor(
    private readonly cfg: SpritesConfig,
    camera: CameraConfig,
    palette: Palette,
  ) {
    this.panels = palette.billboard.length;
    this.buildings = palette.building.length;
    this.buildingAt = BB_PANEL + this.panels * 3;
    this.rgb = new Float32Array(this.buildingAt + this.buildings * 3);
    writeHex(this.rgb, POST, palette.post);
    writeHex(this.rgb, POST_CAP, palette.postCap);
    writeHex(this.rgb, SMOKE, palette.smoke);
    writeHex(this.rgb, TYRE_MARK, palette.tyreMark);
    writeHex(this.rgb, ASPHALT, palette.asphalt[0]!);
    writeHex(this.rgb, LAMP_POLE, palette.lampPole);
    writeHex(this.rgb, LAMP_HEAD, palette.lampHead);
    writeHex(this.rgb, BB_LEG, palette.billboardLeg);
    writeHex(this.rgb, BB_FRAME, palette.billboardFrame);
    writeHex(this.rgb, BB_STRIPE, palette.billboardStripe);
    writeHex(this.rgb, WINDOW, palette.buildingWindow);
    for (let i = 0; i < this.panels; i++)
      writeHex(this.rgb, BB_PANEL + i * 3, palette.billboard[i]!);
    for (let i = 0; i < this.buildings; i++)
      writeHex(this.rgb, this.buildingAt + i * 3, palette.building[i]!);
    this.screenW = camera.screenWidth;
    this.screenH = camera.screenHeight;
  }

  /**
   * R24 / R24b smoke puffs from the rear wheels of the 3D car (R25: contact points projected by
   * CarView, pool x = ±smokeWheelX maps onto the left / right wheel): born small at the tyre contact
   * point, they move down the screen (back), rise, drift outward of the drift and grow; the alpha
   * holds smokeOver.opacity, then falls to 0 from smokeOver.fadeFrom (size shrinks from smokeShrink).
   * R24b: `batch` is the overlay batch drawn after the car, so the puffs cover the car's lower rear.
   */
  drawSmoke(batch: SpriteBatch, drift: DriftVisual, car: CarView): void {
    const d = this.cfg.drift;
    const o = this.cfg.smokeOver;
    const pool = drift.smoke;
    const carW = this.cfg.player.width * this.screenW;
    const carH = this.cfg.player.height * this.screenH;
    const midX = (car.rearLX + car.rearRX) * 0.5;
    const midY = (car.rearLY + car.rearRY) * 0.5;
    const halfX = (car.rearRX - car.rearLX) * 0.5;
    const halfY = (car.rearRY - car.rearLY) * 0.5;
    const shrink = d.smokeShrink;
    const fadeFrom = o.fadeFrom;
    for (let i = 0; i < pool.count; i++) {
      const a = pool.age01(i);
      const k = pool.x(i) / d.smokeWheelX;
      const fade = a > shrink ? (1 - a) / (1 - shrink) : 1;
      const alpha = o.opacity * (a > fadeFrom ? (1 - a) / (1 - fadeFrom) : 1);
      const size = d.smokeSize * carW * (1 + d.smokeGrow * a) * fade;
      const x = midX + k * halfX - drift.smokeDir * d.smokeSpread * a * carW;
      const y =
        midY + k * halfY + (pool.y(i) + (d.smokeBack - d.smokeRise) * a) * carH + size * 0.5;
      batch.push(x, y, size, size, -1, this.rgb, SMOKE, alpha);
    }
  }

  /**
   * R24c tyre marks: each stored sample joined to the next older one of the same mark by a dark
   * strip on the road (markRect: same projection as roadside objects, so the marks follow curves
   * and hills and recede with the road); the newest piece runs to the live wheel points while a
   * mark is being laid. Colour fades into the asphalt from fadeFrom x length behind the wheels;
   * nothing is drawn past length.
   */
  drawTyreMarks(batch: SpriteBatch, proj: Projection, marks: TyreMarks): void {
    const c = this.cfg.tyreMarks;
    const ring = marks.ring;
    if (c.marks !== 'on' || ring.count === 0) return;
    const len = proj.length;
    const l = marks.left;
    const r = marks.right;
    const refZ = (l.z + r.z) * 0.5;
    let i = ring.at(0);
    let dI = forwardDist((ring.zL[i]! + ring.zR[i]!) * 0.5, refZ, len);
    if (marks.open) {
      this.piece(batch, proj, l.z, l.x, ring.zL[i]!, ring.xL[i]!, 0, dI);
      this.piece(batch, proj, r.z, r.x, ring.zR[i]!, ring.xR[i]!, 0, dI);
    }
    for (let k = 0; k + 1 < ring.count; k++) {
      i = ring.at(k);
      if (dI > c.length) break;
      const j = ring.at(k + 1);
      const dJ = forwardDist((ring.zL[j]! + ring.zR[j]!) * 0.5, refZ, len);
      if (ring.link[i] === 1) {
        this.piece(batch, proj, ring.zL[i]!, ring.xL[i]!, ring.zL[j]!, ring.xL[j]!, dI, dJ);
        this.piece(batch, proj, ring.zR[i]!, ring.xR[i]!, ring.zR[j]!, ring.xR[j]!, dI, dJ);
      }
      dI = dJ;
    }
  }

  // One mark piece between road points 0 and 1 (d = segments behind the wheels at each end), cut
  // into sub-pieces about stepPx tall (at most maxSub) so the mark follows the projection.
  private piece(
    batch: SpriteBatch,
    proj: Projection,
    z0: number,
    x0: number,
    z1: number,
    x1: number,
    d0: number,
    d1: number,
  ): void {
    const c = this.cfg.tyreMarks;
    const len = proj.length;
    let dz = forwardDist(z0, z1, len);
    if (dz > len * 0.5) dz -= len;
    const p = this.placement;
    const maxSub = Math.max(1, Math.floor(c.maxSub));
    let m = markRect(p, proj, z0, x0, z1, x1, c.width) ? Math.ceil(p.h / c.stepPx) : maxSub;
    if (m < 1) m = 1;
    if (m > maxSub) m = maxSub;
    for (let s = 0; s < m; s++) {
      const u0 = s / m;
      const u1 = (s + 1) / m;
      if (
        !markRect(
          p,
          proj,
          z0 + dz * u0,
          x0 + (x1 - x0) * u0,
          z0 + dz * u1,
          x0 + (x1 - x0) * u1,
          c.width,
        )
      )
        continue;
      const d = d0 + (d1 - d0) * (u0 + u1) * 0.5;
      this.mark(batch, (d / c.length - c.fadeFrom) / (1 - c.fadeFrom));
    }
  }

  // Pushes this.placement as a tyre mark piece, faded f (0..1, clamped) toward the asphalt colour.
  private mark(batch: SpriteBatch, f: number): void {
    const t = f < 0 ? 0 : f > 1 ? 1 : f;
    const rgb = this.rgb;
    for (let ch = 0; ch < 3; ch++)
      rgb[FADED + ch] = rgb[TYRE_MARK + ch]! + (rgb[ASPHALT + ch]! - rgb[TYRE_MARK + ch]!) * t;
    const p = this.placement;
    batch.push(p.x, p.y, p.w < 1 ? 1 : p.w, p.h < 1 ? 1 : p.h, p.depth, rgb, FADED);
  }

  /**
   * R32 lamps, billboards, buildings and shoulder posts standing on the projected lines, each kind within its
   * own draw distance. `first` is the per-segment index of `rs` (indexBySegment).
   * R30: an object on a line behind a crest keeps only its part above the crest.
   */
  drawRoadside(batch: SpriteBatch, proj: Projection, rs: Roadside, first: Int32Array): void {
    const step = 2 / (proj.count - 1);
    const posts = this.cfg.roadside.posts;
    const postEvery = Math.max(1, Math.floor(posts.every));
    const lampEvery = Math.max(1, Math.floor(this.cfg.roadside.lamps.every));
    let crestY = Infinity;
    for (let n = 0; n < proj.count - 1; n++) {
      const seg = proj.segment[n]!;
      this.clipY = proj.clipped[n] === 1 ? crestY : Infinity;
      if (proj.y[n]! < crestY) crestY = proj.y[n]!;
      if (seg % postEvery === 0 && seg % lampEvery !== 0) {
        this.post(batch, proj, seg, -posts.offset);
        this.post(batch, proj, seg, posts.offset);
      }
      if (seg + 1 >= first.length) continue;
      for (let k = first[seg]!; k < first[seg + 1]!; k++) {
        const kind = rs.kind[k]!;
        if (kind === ROADSIDE_LAMP) this.lamp(batch, proj, n, seg, rs.x[k]!);
        else if (kind === ROADSIDE_BILLBOARD)
          this.billboard(batch, proj, n, seg, rs.x[k]!, rs.variant[k]!, step);
        else if (kind === ROADSIDE_BUILDING)
          this.building(batch, proj, n, seg, rs.x[k]!, rs.variant[k]!, step);
      }
    }
  }

  /** Stress scenario: plain blocks on every segment edge until the batch holds `fill.instances`. */
  drawStress(batch: SpriteBatch, proj: Projection, fill: StressFill): void {
    for (let n = 0; n < proj.count - 1 && batch.count < fill.instances; n++) {
      const side = n % 2 === 0 ? -1 : 1;
      // R30: blocks standing on a line behind a crest are not drawn.
      if (proj.clipped[n] === 1) continue;
      if (
        placeOnRoad(
          this.placement,
          proj,
          proj.segment[n]!,
          side * fill.offset,
          fill.width,
          fill.height,
        )
      ) {
        const p = this.placement;
        batch.push(p.x, p.y, p.w, p.h, p.depth, this.rgb, POST);
      }
    }
  }

  // Short post with a light cap.
  private post(batch: SpriteBatch, proj: Projection, seg: number, x: number): void {
    const c = this.cfg.roadside.posts;
    const p = this.placement;
    if (!placeOnRoad(p, proj, seg, x, c.width, c.height)) return;
    const capH = p.h * c.capHeight;
    this.rect(batch, p.x, p.y, p.w, p.h - capH, p.depth, POST);
    this.rect(batch, p.x, p.y - (p.h - capH), p.w, capH, p.depth, POST_CAP);
  }

  // Tall pole, an arm at the top reaching over the road, a lamp head under the arm tip.
  private lamp(batch: SpriteBatch, proj: Projection, n: number, seg: number, x: number): void {
    const c = this.cfg.roadside.lamps;
    const p = this.placement;
    if (n > c.drawDistance || !placeOnRoad(p, proj, seg, x, 1, 1)) return;
    const s = p.h;
    const toRoad = x > 0 ? -1 : 1;
    const reach = c.armLength * s;
    if (!this.visible(Math.min(p.x, p.x + toRoad * reach), Math.max(p.x, p.x + toRoad * reach)))
      return;
    const top = p.y - c.height * s;
    const armT = c.armThickness * s;
    this.rect(batch, p.x, p.y, c.poleWidth * s, c.height * s, p.depth, LAMP_POLE);
    this.rect(batch, p.x + toRoad * reach * 0.5, top + armT, reach, armT, p.depth, LAMP_POLE);
    const headX = p.x + toRoad * (reach - c.headWidth * s * 0.5);
    const headH = c.headHeight * s;
    this.rect(batch, headX, top + armT + headH, c.headWidth * s, headH, p.depth, LAMP_HEAD);
  }

  // Panel on two legs: frame, inner panel in one of the colour variants, a light stripe.
  private billboard(
    batch: SpriteBatch,
    proj: Projection,
    n: number,
    seg: number,
    x: number,
    variant: number,
    step: number,
  ): void {
    const c = this.cfg.roadside.billboards;
    const p = this.placement;
    if (n > c.drawDistance || !placeOnRoad(p, proj, seg, x, 1, 1)) return;
    const s = p.h;
    const w = c.width * s;
    if (!this.visible(p.x - w * 0.5, p.x + w * 0.5)) return;
    const depth = p.depth + step * c.depthStep; // just behind a lamp on the same line
    const h = c.height * s;
    const legH = c.legHeight * s;
    const legDx = w * (0.5 - c.legInset);
    const bottom = p.y - legH;
    const f = c.frame * h;
    this.rect(batch, p.x - legDx, p.y, c.legWidth * s, legH, depth, BB_LEG);
    this.rect(batch, p.x + legDx, p.y, c.legWidth * s, legH, depth, BB_LEG);
    this.rect(batch, p.x, bottom, w, h, depth, BB_FRAME);
    const panel = BB_PANEL + (variant % this.panels) * 3;
    this.rect(batch, p.x, bottom - f, w - 2 * f, h - 2 * f, depth, panel);
    const stripe = c.stripeHeight * h;
    this.rect(batch, p.x, bottom - c.stripeY * h, w - 2 * f, stripe, depth, BB_STRIPE);
  }

  // Block silhouette; nearby ones get a window grid: lit columns crossed by body-coloured bands.
  private building(
    batch: SpriteBatch,
    proj: Projection,
    n: number,
    seg: number,
    x: number,
    variant: number,
    step: number,
  ): void {
    const c = this.cfg.roadside.buildings;
    const p = this.placement;
    if (n > c.drawDistance || !placeOnRoad(p, proj, seg, x, 1, 1)) return;
    const shape = c.shapes[variant % c.shapes.length]!;
    const s = p.h;
    const w = shape.width * s;
    const h = shape.height * s;
    if (!this.visible(p.x - w * 0.5, p.x + w * 0.5)) return;
    const depth = p.depth + step * c.depthStep; // behind lamps and billboards on the same line
    const body = this.buildingAt + (variant % this.buildings) * 3;
    this.rect(batch, p.x, p.y, w, h, depth, body);
    if (h < c.windowMinPx || shape.cols < 1 || shape.rows < 1) return;
    const m = c.windowMargin;
    const gap = c.windowGap;
    const areaW = w * (1 - 2 * m);
    const areaH = h * (1 - 2 * m);
    const base = p.y - h * m;
    const pitchX = areaW / shape.cols;
    const pitchY = areaH / shape.rows;
    const left = p.x - areaW * 0.5;
    for (let i = 0; i < shape.cols; i++) {
      this.rect(
        batch,
        left + (i + 0.5) * pitchX,
        base - pitchY * gap * 0.5,
        pitchX * (1 - gap),
        areaH - pitchY * gap,
        depth,
        WINDOW,
      );
    }
    for (let r = 1; r < shape.rows; r++) {
      const bandH = pitchY * gap;
      this.rect(batch, p.x, base - r * pitchY + bandH * 0.5, areaW, bandH, depth, body);
    }
  }

  // R27: objects just past the side edges can roll into the corners of the picture.
  private visible(left: number, right: number): boolean {
    const over = this.cfg.driftCamera.overscanPx;
    return right >= -over && left <= this.screenW + over;
  }

  // Flat rectangle (base centre x, base y, px) at least 1 px in each direction, with its part
  // below clipY (behind the crest, R30) cut off; dropped if nothing is left. Same depth: later
  // pushes draw over earlier ones (depth test passes on equal depth).
  private rect(
    batch: SpriteBatch,
    x: number,
    y: number,
    w: number,
    h: number,
    depth: number,
    colour: number,
  ): void {
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    const clipY = this.clipY;
    if (y > clipY) {
      h -= y - clipY;
      y = clipY;
    }
    if (h > 0) batch.push(x, y, w, h, depth, this.rgb, colour);
  }
}

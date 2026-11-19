import type { Palette } from '../data/render';
import type { CarView } from './carModel';
import type { DriftVisual, DriftVisualConfig } from './driftVisual';
import { placeOnRoad, type Placement } from './placeOnRoad';
import type { CameraConfig, Projection } from './projection';
import { writeHex } from './roadMesh';
import type { SpriteBatch } from './spriteBatch';

export interface SpritesConfig {
  capacity: number;
  player: {
    baseY: number; // R25 rear-axle ground point of the 3D car, fraction of screen height from the top
    width: number; // car width on screen, fraction of screen width (fits the 3D car; smoke x unit)
    height: number; // smoke y unit, fraction of screen height
  };
  posts: {
    enabled: boolean;
    every: number; // a post on each shoulder every N segments
    offset: number; // road half-widths from the centre
    width: number; // world units
    height: number; // world units
    capHeight: number; // fraction of the post height drawn in the cap colour
  };
  drift: DriftVisualConfig;
}

/** Extra placeholder props used only by the stress scenario. */
export interface StressFill {
  instances: number; // total instances to reach
  offset: number; // road half-widths
  width: number;
  height: number;
}

const POST = 0;
const POST_CAP = 3;
const SMOKE = 6;
/** Placeholder sprites of layers 3-4: shoulder posts, drift smoke, stress filler. */
export class WorldSprites {
  private readonly rgb = new Float32Array(9);
  private readonly placement: Placement = { x: 0, y: 0, w: 0, h: 0, depth: 0 };
  private readonly screenW: number;
  private readonly screenH: number;

  constructor(
    private readonly cfg: SpritesConfig,
    camera: CameraConfig,
    palette: Palette,
  ) {
    writeHex(this.rgb, POST, palette.post);
    writeHex(this.rgb, POST_CAP, palette.postCap);
    writeHex(this.rgb, SMOKE, palette.smoke);
    this.screenW = camera.screenWidth;
    this.screenH = camera.screenHeight;
  }

  /**
   * R24 smoke puffs from the rear wheels of the 3D car (R25: contact points projected by CarView,
   * pool x = ±smokeWheelX maps onto the left / right wheel): they move down the screen (back),
   * rise, drift outward of the drift, grow, then shrink to 0 at the end of life. Drawn in the road
   * pass, in front of the road; the car pass draws over them.
   */
  drawSmoke(batch: SpriteBatch, drift: DriftVisual, car: CarView, drawDistance: number): void {
    const d = this.cfg.drift;
    const pool = drift.smoke;
    const carW = this.cfg.player.width * this.screenW;
    const carH = this.cfg.player.height * this.screenH;
    const midX = (car.rearLX + car.rearRX) * 0.5;
    const midY = (car.rearLY + car.rearRY) * 0.5;
    const halfX = (car.rearRX - car.rearLX) * 0.5;
    const halfY = (car.rearRY - car.rearLY) * 0.5;
    const depth = -1 + (2 / drawDistance) * 0.03;
    const shrink = d.smokeShrink;
    for (let i = 0; i < pool.count; i++) {
      const a = pool.age01(i);
      const k = pool.x(i) / d.smokeWheelX;
      const fade = a > shrink ? (1 - a) / (1 - shrink) : 1;
      const size = d.smokeSize * carW * (1 + d.smokeGrow * a) * fade;
      const x = midX + k * halfX - drift.smokeDir * d.smokeSpread * a * carW;
      const y =
        midY + k * halfY + (pool.y(i) + (d.smokeBack - d.smokeRise) * a) * carH + size * 0.5;
      batch.push(x, y, size, size, depth, this.rgb, SMOKE);
    }
  }

  /** Layer-3 posts on both shoulders on every `every`-th segment edge within the draw distance. */
  drawPosts(batch: SpriteBatch, proj: Projection): void {
    const posts = this.cfg.posts;
    if (!posts.enabled) return;
    // R30: crest line = top of the nearer road (lowest screen y of lines 0..n-1).
    let crestY = Infinity;
    for (let n = 0; n < proj.count - 1; n++) {
      const seg = proj.segment[n]!;
      const clipY = proj.clipped[n] === 1 ? crestY : Infinity;
      if (proj.y[n]! < crestY) crestY = proj.y[n]!;
      if (seg % posts.every !== 0) continue;
      this.post(batch, proj, seg, -posts.offset, posts.width, posts.height, posts.capHeight, clipY);
      this.post(batch, proj, seg, posts.offset, posts.width, posts.height, posts.capHeight, clipY);
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

  private post(
    batch: SpriteBatch,
    proj: Projection,
    z: number,
    offset: number,
    w: number,
    h: number,
    cap: number,
    clipY: number,
  ): void {
    const p = this.placement;
    if (!placeOnRoad(p, proj, z, offset, w, h)) return;
    const capH = p.h * cap;
    this.clippedRect(batch, p.x, p.y, p.w, p.h - capH, p.depth, POST, clipY);
    this.clippedRect(batch, p.x, p.y - (p.h - capH), p.w, capH, p.depth, POST_CAP, clipY);
  }

  // R30: flat rectangle with its part below clipY (behind the crest) cut off; dropped if nothing is left.
  private clippedRect(
    batch: SpriteBatch,
    x: number,
    y: number,
    w: number,
    h: number,
    depth: number,
    colour: number,
    clipY: number,
  ): void {
    if (y > clipY) {
      h -= y - clipY;
      y = clipY;
    }
    if (h > 0) batch.push(x, y, w, h, depth, this.rgb, colour);
  }
}

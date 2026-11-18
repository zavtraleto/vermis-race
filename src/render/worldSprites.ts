import type { Palette } from '../data/render';
import { placeOnRoad, type Placement } from './placeOnRoad';
import type { CameraConfig, Projection } from './projection';
import { writeHex } from './roadMesh';
import type { SpriteBatch } from './spriteBatch';

/** One rectangle of the player silhouette, in car units (x from centre / width, y up from base / height). */
export interface CarPart {
  color: string; // Palette key
  x: number;
  y: number;
  w: number;
  h: number;
  shift: number; // x offset per steer frame (car widths), multiplied by -1 / 0 / +1
}

export interface SpritesConfig {
  capacity: number;
  player: {
    baseY: number; // fraction of screen height, from the top
    width: number; // fraction of screen width
    height: number; // fraction of screen height
    steerThreshold: number; // |steer| above this picks the left/right frame
    parts: CarPart[];
  };
  posts: {
    enabled: boolean;
    every: number; // a post on each shoulder every N segments
    offset: number; // road half-widths from the centre
    width: number; // world units
    height: number; // world units
    capHeight: number; // fraction of the post height drawn in the cap colour
  };
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

/** Placeholder sprites of layers 3-4: player car, shoulder posts, stress filler. */
export class WorldSprites {
  private readonly rgb: Float32Array;
  private readonly partColor: Int32Array;
  private readonly placement: Placement = { x: 0, y: 0, w: 0, h: 0, depth: 0 };
  private readonly carX: number;
  private readonly carY: number;
  private readonly carW: number;
  private readonly carH: number;
  private readonly carDepth: number;

  constructor(
    private readonly cfg: SpritesConfig,
    camera: CameraConfig,
    palette: Palette,
  ) {
    const parts = cfg.player.parts;
    this.rgb = new Float32Array(6 + parts.length * 3);
    writeHex(this.rgb, POST, palette.post);
    writeHex(this.rgb, POST_CAP, palette.postCap);
    this.partColor = new Int32Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i]!.color as keyof Palette;
      const hex = palette[key];
      if (typeof hex !== 'string') throw new Error(`sprites: unknown palette colour '${key}'`);
      this.partColor[i] = 6 + i * 3;
      writeHex(this.rgb, 6 + i * 3, hex);
    }
    this.carX = camera.screenWidth / 2;
    this.carY = cfg.player.baseY * camera.screenHeight;
    this.carW = cfg.player.width * camera.screenWidth;
    this.carH = cfg.player.height * camera.screenHeight;
    // Nearer than anything on the road (strip 0 sprites start at +0.05 step): never covered.
    this.carDepth = -1 + (2 / camera.drawDistance) * 0.01;
  }

  /** Player car at a fixed screen spot; frame chosen from steer of the same frame, no smoothing. */
  drawPlayer(batch: SpriteBatch, steer: number): void {
    const th = this.cfg.player.steerThreshold;
    const frame = steer > th ? 1 : steer < -th ? -1 : 0;
    const parts = this.cfg.player.parts;
    // Later parts overdraw earlier ones: equal depth + LessEqual depth test, instances drawn in order.
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      batch.push(
        this.carX + (p.x + p.shift * frame) * this.carW,
        this.carY - p.y * this.carH,
        p.w * this.carW,
        p.h * this.carH,
        this.carDepth,
        this.rgb,
        this.partColor[i]!,
      );
    }
  }

  /** Layer-3 posts on both shoulders on every `every`-th segment edge within the draw distance. */
  drawPosts(batch: SpriteBatch, proj: Projection): void {
    const posts = this.cfg.posts;
    if (!posts.enabled) return;
    for (let n = 0; n < proj.count - 1; n++) {
      const seg = proj.segment[n]!;
      if (seg % posts.every !== 0) continue;
      this.post(batch, proj, seg, -posts.offset, posts.width, posts.height, posts.capHeight);
      this.post(batch, proj, seg, posts.offset, posts.width, posts.height, posts.capHeight);
    }
  }

  /** Stress scenario: plain blocks on every segment edge until the batch holds `fill.instances`. */
  drawStress(batch: SpriteBatch, proj: Projection, fill: StressFill): void {
    for (let n = 0; n < proj.count - 1 && batch.count < fill.instances; n++) {
      const side = n % 2 === 0 ? -1 : 1;
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
  ): void {
    const p = this.placement;
    if (!placeOnRoad(p, proj, z, offset, w, h)) return;
    const capH = p.h * cap;
    batch.push(p.x, p.y, p.w, p.h - capH, p.depth, this.rgb, POST);
    batch.push(p.x, p.y - (p.h - capH), p.w, capH, p.depth, this.rgb, POST_CAP);
  }
}

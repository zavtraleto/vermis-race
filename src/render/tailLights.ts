import { writeHex } from './roadMesh';
import type { SpriteBatch } from './spriteBatch';

/** R45b tail lights of traffic and rival cars (sprites.json "tailLights"). */
export interface TailLightsConfig {
  enabled: string; // "on" | "off" (dev panel switch)
  color: string; // unlit, full brightness
  size: number; // light side, car-model units
  spread: number; // half distance between the two lights, car-model units
  height: number; // light centre above the car's ground, car-model units
  minPx: number; // smallest light side on screen, game px
}

/**
 * R45b: two unlit square lights at the rear of every drawn traffic and rival car, pushed into the
 * sprite batch (no extra draw call). The car passes (trafficModels.ts, rivalModels.ts) add the
 * lights of each car they draw, with the same pinhole, yaw and tumble as the model, a depth just
 * in front of the car's rear; a light below the car's crest clip line is skipped (R30), and a
 * light is never smaller than minPx on screen. No allocations per frame.
 */
export class TailLights {
  private readonly rgb = new Float32Array(3);
  private batch: SpriteBatch | null = null;
  private f = 0;
  private cx = 0;
  private hy = 0;
  private ndcY = 0;
  private on = false;

  constructor(
    private readonly cfg: TailLightsConfig,
    screen: { screenHeight: number },
  ) {
    writeHex(this.rgb, 0, cfg.color);
    this.ndcY = 2 / screen.screenHeight;
  }

  /** Starts a frame: f = focal px, (cx, hy) = projection centre and horizon line, game px. */
  begin(batch: SpriteBatch, f: number, cx: number, hy: number): void {
    this.batch = batch;
    this.f = f;
    this.cx = cx;
    this.hy = hy;
    this.on = this.cfg.enabled === 'on';
  }

  /**
   * Adds the two lights of one drawn car, with the car-pass instance numbers: (ax, ay, zc, k) =
   * camera-relative x, camera height above the car's ground, centre depth, world units per model
   * unit; (cy, sy) = cos/sin yaw; rearZ = model z of the rear (+z = toward the camera); depth =
   * NDC depth of the lights; clip = crest clip line (NDC y); roll / hop / pivot = R49 tumble.
   */
  addCar(
    ax: number,
    ay: number,
    zc: number,
    k: number,
    cy: number,
    sy: number,
    rearZ: number,
    depth: number,
    clip: number,
    roll: number,
    hop: number,
    pivot: number,
  ): void {
    const batch = this.batch;
    if (!this.on || batch === null) return;
    const c = this.cfg;
    const f = this.f;
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    for (let side = -1; side <= 1; side += 2) {
      const mx = side * c.spread;
      const my = c.height - pivot;
      const px = mx * cr - my * sr;
      const py = mx * sr + my * cr + pivot + hop;
      const lx = px * cy - rearZ * sy;
      const lz = px * sy + rearZ * cy;
      let z = zc - lz * k;
      if (z < 1) z = 1;
      const x = this.cx + ((ax + lx * k) * f) / z;
      const y = this.hy + ((ay - py * k) * f) / z;
      if (1 - y * this.ndcY < clip) continue; // R30: behind the crest with the car
      let size = (c.size * k * f) / z;
      if (size < c.minPx) size = c.minPx;
      batch.push(x, y + size / 2, size, size, depth, this.rgb, 0);
    }
  }
}

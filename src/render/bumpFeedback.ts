import { DT } from '../sim/constants';
import type { CameraConfig, RoadConfig } from './projection';
import { focalPx, nearDistance } from './projection';
import type { BumpFeedbackConfig } from './worldSprites';

/**
 * Segments from the camera to the line where the player car is drawn (sprites.player.baseY on a
 * flat road). Traffic is drawn at its z plus this offset so the on-screen gap matches the sim gap.
 */
export function playerLineOffset(camera: CameraConfig, road: RoadConfig, baseY: number): number {
  const f = focalPx(camera);
  const horizonY = camera.horizon * camera.screenHeight;
  const scale = (baseY * camera.screenHeight - horizonY) / camera.height;
  return (f / scale - nearDistance(camera, f)) / road.segmentLength;
}

/** R45 player feedback: blink while bumpTicks > 0, short decaying camera shake on the contact tick. */
export class BumpFeedback {
  /** Player model visible this frame. */
  visible = true;
  /** Camera x offset, road half-widths. */
  shake = 0;
  private lastTicks = 0;
  private left = 0;
  private t = 0;

  constructor(private readonly cfg: BumpFeedbackConfig) {}

  /** dt = frame seconds; bumpTicks of the player in the newest sim state. */
  update(dt: number, bumpTicks: number): void {
    const c = this.cfg;
    // R43: bumpTicks only grows on a contact (it is 0 before one), so a rise is the contact tick.
    if (bumpTicks > this.lastTicks) {
      this.left = c.shakeTime;
      this.t = 0;
    }
    this.lastTicks = bumpTicks;
    if (this.left > 0) {
      this.t += dt;
      this.left -= dt;
      if (this.left < 0) this.left = 0;
      this.shake =
        c.shakeAmp * (this.left / c.shakeTime) * Math.sin(2 * Math.PI * c.shakeHz * this.t);
    } else this.shake = 0;
    // Remaining invulnerability in seconds, toggled 2 * blinkHz times per second.
    this.visible = bumpTicks === 0 || Math.floor(bumpTicks * DT * c.blinkHz * 2) % 2 === 0;
  }
}

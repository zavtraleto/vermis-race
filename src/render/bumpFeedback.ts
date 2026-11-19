import { DT } from '../sim/constants';
import type { CameraConfig, RoadConfig } from './projection';
import { focalPx, nearDistance } from './projection';
import type { BumpFeedbackConfig } from './worldSprites';

/** Camera shake numbers (bump or crash). */
export interface ShakeConfig {
  shakeAmp: number; // road half-widths
  shakeTime: number; // s, linear decay to 0
  shakeHz: number;
}

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
  private lastCrash = 0;
  private left = 0;
  private t = 0;
  // Shake being played: the bump one (R45) or the stronger crash one (R49).
  private shakeCfg: ShakeConfig;

  constructor(
    private readonly cfg: BumpFeedbackConfig,
    private readonly crash: ShakeConfig = cfg,
  ) {
    this.shakeCfg = cfg;
  }

  /** dt = frame seconds; bumpTicks / crashTicks of the player in the newest sim state. */
  update(dt: number, bumpTicks: number, crashTicks = 0): void {
    // R49: crashTicks only grows on the hit tick, so a rise is the hit: the crash shake.
    // R48: the crash ends by setting bumpTicks; that rise is the return to the road, no shake.
    if (crashTicks > this.lastCrash) {
      this.shakeCfg = this.crash;
      this.left = this.crash.shakeTime;
      this.t = 0;
    } else if (bumpTicks > this.lastTicks && this.lastCrash === 0) {
      // R43: bumpTicks only grows on a contact (it is 0 before one), so a rise is the contact tick.
      this.shakeCfg = this.cfg;
      this.left = this.cfg.shakeTime;
      this.t = 0;
    }
    this.lastTicks = bumpTicks;
    this.lastCrash = crashTicks;
    const c = this.cfg;
    const s = this.shakeCfg;
    if (this.left > 0) {
      this.t += dt;
      this.left -= dt;
      if (this.left < 0) this.left = 0;
      this.shake =
        s.shakeAmp * (this.left / s.shakeTime) * Math.sin(2 * Math.PI * s.shakeHz * this.t);
    } else this.shake = 0;
    // Remaining invulnerability in seconds, toggled 2 * blinkHz times per second.
    this.visible = bumpTicks === 0 || Math.floor(bumpTicks * DT * c.blinkHz * 2) % 2 === 0;
  }
}

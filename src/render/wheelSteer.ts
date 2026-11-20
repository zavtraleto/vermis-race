import { approach } from './driftVisual';

/** R25b front-wheel steering (render only; numbers in src/data/car3d.json "player"). */
export interface WheelSteerConfig {
  steerMaxDeg: number; // wheel angle at |steer| = 1
  steerTau: number; // s, time constant of the approach to the target angle; <= 0 snaps
}

/**
 * R25b: front-wheel angle in degrees (> 0 = wheels to the right), chasing steer * steerMaxDeg with
 * the |steer| clamped to 1. No allocations.
 */
export class WheelSteer {
  deg = 0;

  update(steer: number, dt: number, cfg: WheelSteerConfig): void {
    const s = steer > 1 ? 1 : steer < -1 ? -1 : steer;
    this.deg = approach(this.deg, s * cfg.steerMaxDeg, dt, cfg.steerTau);
  }

  reset(): void {
    this.deg = 0;
  }
}

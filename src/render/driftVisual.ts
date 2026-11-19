import type { Car } from '../sim/types';
import type { CameraConfig, RoadConfig } from './projection';

/** R24 drift look (render only; numbers in src/data/sprites.json "drift"). */
export interface DriftVisualConfig {
  yawMaxDeg: number; // R24 car yaw at sim drift angle 1, degrees about the vertical axis
  yawTau: number; // s, light smoothing time constant of the yaw
  cameraOffset: number; // road half-widths the camera moves toward the inside of the drift
  cameraTau: number; // s, smoothing time constant of the camera offset
  smoke: string; // "on" | "off"
  smokeCapacity: number; // particles, fixed
  smokeRate: number; // wheel pairs emitted per second in DRIFT
  smokeLife: number; // s
  smokeSize: number; // car widths at birth
  smokeGrow: number; // extra size at end of life, x birth size
  smokeShrink: number; // age01 where the puff starts shrinking to 0
  smokeBack: number; // car heights moved down the screen (toward the camera) over the life
  smokeRise: number; // car heights risen over the life
  smokeSpread: number; // car widths drifted outward of the drift over the life
  smokeWheelX: number; // rear wheel x, car widths from the centre
  smokeJitter: number; // car widths, random offset at birth
}

/** Exponential approach of `current` to `target` with time constant tau; tau <= 0 snaps. */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/**
 * Old R24 yaw target from steer (before the sim drift angle): 0 in GRIP; in DRIFT
 * dir * lerp(yawMin, yawMax, (steer*dir+1)/2). No longer used by DriftVisual (R24 now takes the
 * sim angle); kept only because tests/render/driftVisual.test.ts still covers it.
 */
export function driftYawTarget(
  state: Car['state'],
  dir: number,
  steer: number,
  cfg: { yawMin: number; yawMax: number },
): number {
  if (state !== 'DRIFT' || dir === 0) return 0;
  const t = (steer * dir + 1) / 2;
  return dir * (cfg.yawMin + (cfg.yawMax - cfg.yawMin) * t);
}

/** Road half-width on screen (px) at screen y, from the projection formulas. */
export function roadHalfWidthPxAt(y: number, camera: CameraConfig, road: RoadConfig): number {
  return ((y - camera.horizon * camera.screenHeight) / camera.height) * road.halfWidth;
}

/** Fixed-capacity particle pool, no allocations after construction. Overflow evicts the oldest. */
export class SmokePool {
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private n = 0;

  constructor(readonly capacity: number) {
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
  }

  get count(): number {
    return this.n;
  }

  x(i: number): number {
    return this.px[i]!;
  }

  y(i: number): number {
    return this.py[i]!;
  }

  age01(i: number): number {
    return this.age[i]! / this.life[i]!;
  }

  emit(x: number, y: number, life: number): void {
    let i = this.n;
    if (i >= this.capacity) {
      i = 0;
      for (let k = 1; k < this.n; k++) if (this.age[k]! > this.age[i]!) i = k;
    } else this.n = i + 1;
    this.px[i] = x;
    this.py[i] = y;
    this.age[i] = 0;
    this.life[i] = life;
  }

  /** Ages every particle by dt and removes the dead ones (order of the living kept). */
  update(dt: number): void {
    let w = 0;
    for (let r = 0; r < this.n; r++) {
      const a = this.age[r]! + dt;
      if (a >= this.life[r]!) continue;
      this.px[w] = this.px[r]!;
      this.py[w] = this.py[r]!;
      this.age[w] = a;
      this.life[w] = this.life[r]!;
      w++;
    }
    this.n = w;
  }

  clear(): void {
    this.n = 0;
  }
}

/**
 * Smoothed drift look of the player car: yaw, camera x offset and smoke. Driven by update(dt)
 * with the frame time (live) or a fixed dt (screenshot path). Reads sim state, never writes it.
 * Jitter comes from a local LCG, so the same call sequence gives the same picture.
 */
export class DriftVisual {
  /** Degrees; > 0 = nose to the right. */
  yaw = 0;
  cameraX = 0;
  /** dir of the last drift that emitted smoke: the puffs drift outward of it. */
  smokeDir = 0;
  readonly smoke: SmokePool;
  private emitAcc = 0;
  private rng = 1;

  constructor(private readonly cfg: DriftVisualConfig) {
    this.smoke = new SmokePool(cfg.smokeCapacity);
  }

  /** `angle` = sim drift angle interpolated between the prev and curr states (0 in GRIP). */
  update(dt: number, car: Car, angle: number): void {
    const cfg = this.cfg;
    const drifting = car.state === 'DRIFT' && car.dir !== 0;
    // R24: yaw comes from the sim angle (yawMaxDeg read live for the dev panel); render only smooths.
    this.yaw = approach(this.yaw, drifting ? angle * cfg.yawMaxDeg : 0, dt, cfg.yawTau);
    this.cameraX = approach(
      this.cameraX,
      drifting ? car.dir * cfg.cameraOffset : 0,
      dt,
      cfg.cameraTau,
    );
    const pool = this.smoke;
    if (cfg.smoke !== 'on') {
      pool.clear();
      this.emitAcc = 0;
      return;
    }
    pool.update(dt);
    if (!drifting) {
      this.emitAcc = 0;
      return;
    }
    this.smokeDir = car.dir;
    this.emitAcc += cfg.smokeRate * dt;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      pool.emit(-cfg.smokeWheelX + this.jitter(), this.jitter(), cfg.smokeLife);
      pool.emit(cfg.smokeWheelX + this.jitter(), this.jitter(), cfg.smokeLife);
    }
  }

  /** Uniform in [-smokeJitter, smokeJitter). */
  private jitter(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return (this.rng / 4294967296 - 0.5) * 2 * this.cfg.smokeJitter;
  }
}

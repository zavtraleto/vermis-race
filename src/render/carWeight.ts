import { DT, SEG_PER_UNIT } from '../sim/constants';
import type { Car } from '../sim/types';
import { approach } from './driftVisual';

/** R26 weight of the player model (render only; numbers in src/data/sprites.json "weight"). */
export interface CarWeightConfig {
  yawGain: number; // GRIP yaw = yawGain x heading of the motion relative to the road (lateral / forward)
  yawMaxDeg: number; // GRIP yaw clamp
  yawTau: number; // s, smoothing of the final yaw
  minSpeed: number; // vmax fraction: forward speed floor of the heading (no blow-up at a standstill)
  blendTau: number; // s, GRIP <-> DRIFT yaw blend
  rollGain: number; // degrees per half-width/s^2 of lateral acceleration, outward
  rollMaxDeg: number;
  rollTau: number; // s, derivative filter and smoothing of the roll
  pitchGain: number; // degrees per vmax/s of speed change; speed loss = nose down
  pitchMaxDeg: number;
  pitchTau: number; // s, derivative filter and smoothing of the pitch
  slipDeg: number; // R89 model B: degrees on screen per unit of visible slip (yaw - vel + carry)
  velDeg: number; // R89 model B: degrees on screen per unit of vel
}

const RAD = 180 / Math.PI;

function clamp(v: number, max: number): number {
  return v > max ? max : v < -max ? -max : v;
}

/** Derivative of a signal through an exponential filter: (value - smoothed) / tau. */
function filteredRate(value: number, smoothed: number, tau: number): number {
  return tau > 0 ? (value - smoothed) / tau : 0;
}

/**
 * R26 pose of the player model. Outside DRIFT the yaw follows the car's actual lateral motion
 * relative to the road (dx/dt between the prev and curr sim states, so the R13 slide is in it)
 * over its forward speed; in DRIFT the R24 yaw (sim angle x yawMaxDeg) takes over through a
 * continuous blend. Roll leans outward from the lateral acceleration (plus the R25 outward drift
 * roll); pitch dips the nose on speed loss (brake, drift, bump) and squats on acceleration.
 * Reads sim state, never writes it; no allocations.
 */
export class CarWeight {
  /** Degrees; > 0 = nose right. */
  yaw = 0;
  /** Degrees; > 0 = roof right. */
  roll = 0;
  /** Degrees; > 0 = nose down. */
  pitch = 0;
  private blend = 0;
  private vSmooth = 0;
  private sSmooth = 0;
  private started = false;

  constructor(private readonly cfg: CarWeightConfig) {}

  /**
   * dt = frame (or tick) seconds; prev/curr = the two last sim states of the player; speed = the
   * interpolated speed; driftYaw = the smoothed R24 yaw in degrees (0 in GRIP); yawMaxDeg /
   * driftRollDeg = R24 / R25 numbers; halfWidth / segmentLength = world units of the road.
   * bodyYaw = R89 model B: vis*slipDeg + vel*velDeg in degrees (interpolated), replacing the R24/R26
   * yaw path in both states; null in model A.
   */
  update(
    dt: number,
    prev: Car,
    curr: Car,
    speed: number,
    driftYaw: number,
    yawMaxDeg: number,
    driftRollDeg: number,
    halfWidth: number,
    segmentLength: number,
    bodyYaw: number | null = null,
  ): void {
    const c = this.cfg;
    const vLat = (curr.x - prev.x) / DT; // half-widths per second, relative to the road
    if (!this.started) {
      this.started = true;
      this.vSmooth = vLat;
      this.sSmooth = speed;
    }
    const forward = Math.max(speed, c.minSpeed) * SEG_PER_UNIT * segmentLength;
    const gripYaw = clamp(c.yawGain * Math.atan2(vLat * halfWidth, forward) * RAD, c.yawMaxDeg);
    const drifting = curr.state === 'DRIFT' && curr.dir !== 0;
    this.blend = approach(this.blend, drifting ? 1 : 0, dt, c.blendTau);
    const yawTarget =
      bodyYaw !== null ? bodyYaw : this.blend * driftYaw + (1 - this.blend) * gripYaw;
    this.yaw = approach(this.yaw, yawTarget, dt, c.yawTau);

    this.vSmooth = approach(this.vSmooth, vLat, dt, c.rollTau);
    const latAccel = filteredRate(vLat, this.vSmooth, c.rollTau);
    const driftRoll = yawMaxDeg !== 0 ? (driftYaw / yawMaxDeg) * driftRollDeg : 0;
    const rollTarget = clamp(-c.rollGain * latAccel, c.rollMaxDeg) - driftRoll;
    this.roll = approach(this.roll, rollTarget, dt, c.rollTau);

    this.sSmooth = approach(this.sSmooth, speed, dt, c.pitchTau);
    const accel = filteredRate(speed, this.sSmooth, c.pitchTau);
    this.pitch = approach(this.pitch, clamp(-c.pitchGain * accel, c.pitchMaxDeg), dt, c.pitchTau);
  }
}

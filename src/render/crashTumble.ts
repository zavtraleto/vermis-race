/** R49 crash look of the player (render only; numbers in src/data/sprites.json "crash"). */
export interface CrashTumbleConfig {
  rollTurns: number; // whole barrel rolls over the crash (ends upright)
  yawTurns: number; // whole spins about the vertical over the crash
  hopHeight: number; // highest hop above the road, car-model units
  hops: number; // hops over the crash, each lower than the last
  pivotY: number; // roll axis height above the road, car-model units
  shakeAmp: number; // camera shake at the hit, road half-widths (stronger than bump.shakeAmp)
  shakeTime: number; // s, linear decay to 0
  shakeHz: number;
}

/**
 * Pose offsets while crashTicks > 0, interpolated between the previous and the current sim
 * state. Rotations ease out and end on whole turns, so the car lands upright where the sim puts
 * it back on the road. No allocations.
 */
export class CrashTumble {
  rollDeg = 0;
  yawDeg = 0;
  hop = 0;

  constructor(private readonly cfg: CrashTumbleConfig) {}

  /** totalTicks = crashTime in ticks; side = sign(crashX0) (+1 lamp on the right). */
  update(
    prevTicks: number,
    currTicks: number,
    totalTicks: number,
    side: number,
    alpha: number,
  ): void {
    if ((prevTicks <= 0 && currTicks <= 0) || totalTicks <= 0) {
      this.rollDeg = 0;
      this.yawDeg = 0;
      this.hop = 0;
      return;
    }
    // R48: crashTicks only grows on the hit tick, where the previous state had no crash.
    const fc = currTicks / totalTicks;
    const fp = prevTicks > 0 ? prevTicks / totalTicks : 1;
    let u = 1 - (fp + (fc - fp) * alpha); // 0 at the hit, 1 back on the road
    if (u < 0) u = 0;
    if (u > 1) u = 1;
    const c = this.cfg;
    const k = 1 - (1 - u) * (1 - u);
    // Roll toward the road (away from the lamp): roof over to the road side.
    this.rollDeg = -side * 360 * c.rollTurns * k;
    this.yawDeg = -side * 360 * c.yawTurns * k;
    this.hop = c.hopHeight * Math.abs(Math.sin(Math.PI * c.hops * u)) * (1 - u);
  }
}

import { DT, STEER_HIST } from '../sim/constants';
import { flickMul } from '../sim/race';
import type { Car, CarParams, Segment } from '../sim/types';

/** R81b (отладка): "the largest |d| of the last second" when no entry was counted. */
const MISS_WINDOW_S = 1;
const VARIANTS = ['A', 'B', 'C', 'D'];

/** H16 flag -> CarParams.driftEntry (R81b, R81c): A 0, B 1, C 2, D 3; anything else falls back to A. */
export function driftEntryOf(flag: string): number {
  const i = VARIANTS.indexOf(flag);
  return i < 0 ? 0 : i;
}

/** H17/H18 flag -> CarParams.gripScrub / driftTurbo (R86b, R86c): B 1, anything else (A) 0. */
export function onOffOf(flag: string): number {
  return flag === 'B' ? 1 : 0;
}

/**
 * R81b debug readout of the last model B drift entry, built outside the sim from the car state
 * after each tick (raw steer, drift hold, steer history). A/B: magnitude = the largest flick |d| of
 * the tick, threshold = flickDelta*m; C: magnitude = |steer|, threshold = deflectEnter.
 * observe() allocates nothing; text() builds a string and is meant for a throttled overlay.
 */
export class DriftEntryProbe {
  private readonly recent = new Float64Array(Math.round(MISS_WINDOW_S / DT));
  private head = 0;
  private prevState = 'GRIP';
  private prevZ = 0;
  private tick = 0;
  private entryTick = -1;
  private tryTick = -1;
  private variant = 0;
  private side = 0;
  private mag = 0;
  private thr = 0;
  private lastThr = 0;
  private tryVariant = 0;

  /** Call once per sim tick with the player car after that tick and the params it ran with. */
  observe(car: Car, p: CarParams, segments: readonly Segment[]): void {
    this.tick++;
    const n = segments.length;
    let seg = Math.floor(this.prevZ) % n;
    if (seg < 0) seg += n;
    let mag = 0;
    let thr = p.deflectEnter;
    if (p.driftEntry === 3) {
      // R81c: zone stick, no threshold on steer; magnitude = |steer| on entry.
      mag = car.steer < 0 ? -car.steer : car.steer;
      thr = 0;
    } else if (p.driftEntry === 2) {
      mag = car.steer < 0 ? -car.steer : car.steer;
    } else if (car.driftHeld && car.steerHistCount >= 2) {
      // The tick's steer is the last recorded one; compare with the flickWindow before it (R81).
      const hist = car.steerHist;
      let last = car.steerHistHead - 1;
      if (last < 0) last += STEER_HIST;
      let kMax = Math.round(p.flickWindow / DT);
      if (kMax > car.steerHistCount - 1) kMax = car.steerHistCount - 1;
      let best = 0;
      for (let k = 1; k <= kMax; k++) {
        let j = last - k;
        if (j < 0) j += STEER_HIST;
        const d = hist[last]! - hist[j]!;
        if ((d < 0 ? -d : d) > (best < 0 ? -best : best)) best = d;
      }
      mag = best < 0 ? -best : best;
      const m = p.driftEntry === 1 && best !== 0 ? flickMul(segments, seg, best, p) : 1;
      thr = p.flickDelta * m;
    } else {
      thr = p.flickDelta;
    }
    const heldGrip = car.driftHeld && this.prevState === 'GRIP';
    this.recent[this.head] = heldGrip ? mag : 0;
    this.head = this.head + 1 >= this.recent.length ? 0 : this.head + 1;
    if (heldGrip) {
      this.tryTick = this.tick;
      this.lastThr = thr;
      this.tryVariant = p.driftEntry;
    }
    if (this.prevState === 'GRIP' && car.state === 'DRIFT') {
      this.entryTick = this.tick;
      this.variant = p.driftEntry;
      this.side = car.dir;
      this.mag = mag;
      this.thr = thr;
    }
    this.prevState = car.state;
    this.prevZ = car.z;
  }

  /** Overlay text: the last entry, or "не засчитан" with the largest magnitude of the last second. */
  text(): string {
    if (this.tryTick < 0) return 'дрифт: —';
    // R81c: the zone entry has no threshold to miss; only the side of the last entry is shown.
    if (this.tryVariant === 3) {
      if (this.entryTick < 0) return 'дрифт D (зона): —';
      return `дрифт D (зона) ${this.side > 0 ? 'вправо' : 'влево'}
|руль| ${this.mag.toFixed(2)}`;
    }
    if (this.entryTick >= this.tryTick) {
      const side = this.side > 0 ? 'вправо' : 'влево';
      return `дрифт ${VARIANTS[this.variant] ?? '?'} ${side}\n${this.variant === 2 ? '|руль|' : '|d|'} ${this.mag.toFixed(2)} ≥ ${this.thr.toFixed(2)}`;
    }
    let max = 0;
    for (let i = 0; i < this.recent.length; i++) if (this.recent[i]! > max) max = this.recent[i]!;
    return `дрифт ${VARIANTS[this.tryVariant] ?? '?'} не засчитан\nmax${this.tryVariant === 2 ? '|руль|' : '|d|'} ${max.toFixed(2)} < ${this.lastThr.toFixed(2)}`;
  }
}

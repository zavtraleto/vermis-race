import type { TouchStickConfig } from './types';

export type FlickDriftConfig = Pick<TouchStickConfig, 'flickDelta' | 'flickWindowMs'>;

/**
 * H3 variant E: flick drift. Between down and up the adapter reports the stick steer with sample();
 * down() records nothing, the first sample is the baseline. A sample that differs by at least
 * flickDelta from any sample of the same touch taken no more than flickWindowMs earlier makes the
 * flick active; it stays active until up. Samples outside down..up are ignored. Time in ms.
 */
export interface FlickDrift {
  down(tMs: number): void;
  sample(steer: number, tMs: number): void;
  up(tMs: number): void;
  readonly active: boolean;
}

// Ring buffer size, structural: pointer events plus a 120 Hz poll stay well below it per window.
// On overflow the oldest samples of the window are dropped.
const RING = 64;

export function createFlickDrift(cfg: FlickDriftConfig): FlickDrift {
  const steers = new Float64Array(RING);
  const times = new Float64Array(RING);
  let count = 0;
  let head = 0; // index of the next write
  let touching = false;
  let active = false;
  return {
    get active(): boolean {
      return active;
    },
    down(): void {
      touching = true;
      active = false;
      count = 0;
      head = 0;
    },
    sample(steer: number, tMs: number): void {
      if (!touching || active) return;
      // H3 E: compare with every sample of this touch inside the window, newest first.
      for (let k = 1; k <= count; k++) {
        const j = (head - k + RING) % RING;
        if (tMs - times[j]! > cfg.flickWindowMs) break;
        const d = steer - steers[j]!;
        if (d >= cfg.flickDelta || d <= -cfg.flickDelta) {
          active = true;
          return;
        }
      }
      steers[head] = steer;
      times[head] = tMs;
      head = (head + 1) % RING;
      if (count < RING) count++;
    },
    up(): void {
      touching = false;
      active = false;
      count = 0;
      head = 0;
    },
  };
}

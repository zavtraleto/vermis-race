export interface FrameSummary {
  p50: number; // ms
  p99: number; // ms
  max: number; // ms
  samples: number; // samples in the window
}

/** Ring buffer of the last `capacity` frame durations (ms). No allocations after construction. */
export class FrameStats {
  private readonly ring: Float64Array;
  private readonly scratch: Float64Array;
  private count = 0;
  private head = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`FrameStats capacity must be a positive integer, got ${capacity}`);
    }
    this.ring = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  /** Number of samples currently in the window: min(pushed, capacity). */
  get samples(): number {
    return this.count;
  }

  push(ms: number): void {
    this.ring[this.head] = ms;
    this.head = (this.head + 1) % this.ring.length;
    if (this.count < this.ring.length) this.count++;
  }

  /** Writes p50/p99/max/samples of the current window into `out` and returns `out`. */
  summarize(out: FrameSummary): FrameSummary {
    const n = this.count;
    out.samples = n;
    if (n === 0) {
      out.p50 = 0;
      out.p99 = 0;
      out.max = 0;
      return out;
    }
    const cap = this.ring.length;
    const sc = this.scratch;
    for (let k = 0; k < cap; k++) sc[k] = k < n ? this.ring[k]! : Infinity;
    sc.sort();
    out.p50 = sc[rank(50, n)]!;
    out.p99 = sc[rank(99, n)]!;
    out.max = sc[n - 1]!;
    return out;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }
}

/** Nearest-rank index for percentile q of n sorted samples. */
function rank(q: number, n: number): number {
  const idx = Math.ceil((q * n) / 100 - 1e-9) - 1;
  return idx < 0 ? 0 : idx > n - 1 ? n - 1 : idx;
}

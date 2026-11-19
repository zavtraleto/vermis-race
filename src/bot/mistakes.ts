/** R63c config (src/data/rivals.json, see mistakeConfig in src/data/rivals.ts). */
export interface MistakeConfig {
  mistakePeriod: [number, number, number]; // mean seconds between mistakes: novice, average, expert
  mistakeTimeMin: number; // seconds
  mistakeTimeMax: number;
  mistakeSteerMin: number; // steer offset magnitude
  mistakeSteerMax: number;
  mistakeBandMul: number; // interval multiplier when band > bandBoost/2
  bandBoost: number;
}

/** R63c flat JSON state of one bot's mistake generator. */
export interface MistakeState {
  rng: number; // seeded generator state
  wait: number; // seconds until the next mistake starts (< 0 before the first draw)
  left: number; // seconds left of the active mistake, 0 = none
  offset: number; // signed steer offset of the active mistake
}

// Float slack when the active mistake's time runs out (dt sums are not exact).
const END_EPS = 1e-9;

export function createMistakes(seed: number): MistakeState {
  return { rng: seed | 0, wait: -1, left: 0, offset: 0 };
}

/** mulberry32, same algorithm as src/sim/rng.ts, on the generator's own state. */
function nextUnit(m: MistakeState): number {
  let t = (m.rng + 0x6d2b79f5) | 0;
  m.rng = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Exponential interval with the skill's mean; x mistakeBandMul while band > bandBoost/2. */
function drawInterval(m: MistakeState, skill: number, band: number, cfg: MistakeConfig): number {
  let mean = cfg.mistakePeriod[skill < 0 ? 0 : skill > 2 ? 2 : skill]!;
  if (band > cfg.bandBoost / 2) mean *= cfg.mistakeBandMul;
  return -mean * Math.log(1 - nextUnit(m));
}

/**
 * R63c returns the steer offset to add this tick (0 when no mistake is active). Intervals are
 * counted start-to-start; a start that falls inside an active mistake (or on the tick it ends)
 * waits until the next free tick.
 */
export function stepMistake(
  m: MistakeState,
  skill: number,
  band: number,
  cfg: MistakeConfig,
  dt: number,
): number {
  if (m.wait < 0) m.wait = drawInterval(m, skill, band, cfg);
  m.wait -= dt;
  if (m.left > 0) {
    m.left -= dt;
    if (m.left > END_EPS) return m.offset;
    m.left = 0;
    m.offset = 0;
    return 0;
  }
  if (m.wait > 0) return 0;
  const tMin = cfg.mistakeTimeMin;
  const sMin = cfg.mistakeSteerMin;
  m.left = tMin + (cfg.mistakeTimeMax - tMin) * nextUnit(m);
  const side = nextUnit(m) < 0.5 ? -1 : 1;
  m.offset = side * (sMin + (cfg.mistakeSteerMax - sMin) * nextUnit(m));
  m.wait += drawInterval(m, skill, band, cfg);
  if (m.wait < 0) m.wait = 0; // never re-arm the 'not drawn yet' marker
  return m.offset;
}

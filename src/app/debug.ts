import type { InputFrame, RaceState } from '../sim/types';
import type { FrameSummary } from '../ui/frameStats';

export interface GameParams {
  seed: number;
  scenario: string;
  frames: number | null;
  ticks: number | null;
  hud: boolean;
}

export interface RendererStats {
  calls: number;
  triangles: number;
  instances: number; // SpriteBatch instances drawn
}

/** Live tuning registry (src/dev): paths like 'car.accel', 'camera.fovDeg'. */
export interface TunablesDebug {
  get(path: string): number | string | undefined;
  /** Clamps to the range in src/data/tunables.json; throws on an unknown path. */
  set(path: string, value: number | string): number | string;
  /** Only values that differ from src/data defaults. */
  diff(): Record<string, number | string>;
}

export interface GameDebug {
  frames: number;
  done: boolean;
  errors: string[];
  params: GameParams;
  rendererInfo: () => RendererStats;
  frameStats: () => FrameSummary; // ms over the recent live frames
  readonly tick: number;
  state: () => RaceState;
  stepTicks: (n: number) => void;
  /** Copy of the player's last InputFrame (what the sim received), independent of the driving model. */
  input: () => InputFrame;
  tunables: TunablesDebug;
}

declare global {
  interface Window {
    __game: GameDebug;
  }
}

/** Finite non-negative number, floored; anything else (or absent) -> null. */
function parseCount(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function parseParams(search: string): GameParams {
  const q = new URLSearchParams(search);
  const seed = Number(q.get('seed') ?? '1');
  return {
    seed: Number.isFinite(seed) ? seed : 1,
    scenario: q.get('scenario') ?? 'empty',
    frames: parseCount(q.get('frames')),
    ticks: parseCount(q.get('ticks')),
    hud: q.get('hud') === '1',
  };
}

export function installErrorCollectors(errors: string[]): void {
  window.addEventListener('error', (e) => {
    errors.push(`error: ${e.message}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    errors.push(`unhandledrejection: ${String(e.reason)}`);
  });
}

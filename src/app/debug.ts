import type { InputFrame, RaceState } from '../sim/types';
import type { FrameSummary } from '../ui/frameStats';

export interface GameParams {
  seed: number;
  scenario: string;
  frames: number | null;
  ticks: number | null;
  hud: boolean;
  map: boolean; // ribbonMap off unless ?map=1
  track: string; // R31b ?track=: drift-run (default) or test-twisty
  traffic: boolean; // R70 traffic on the default track; ?traffic=0 turns it off
  ui: boolean; // R28 UI layer (speedometer); ?ui=0 hides it
  model: 0 | 1 | null; // H14 driving model: ?model=a -> 0, ?model=b -> 1, absent or other -> null (data)
  render: string; // spike E1: '3d' = true 3D renderer (src/render3d), anything else = pseudo-3D
}

export interface RendererStats {
  calls: number;
  triangles: number;
  instances: number; // SpriteBatch instances drawn
  dropped: number; // SpriteBatch instances dropped in the last frame (capacity overflow)
  traffic: number; // R45 traffic models drawn in the last frame
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
    map: q.get('map') === '1',
    track: q.get('track') ?? 'drift-run',
    traffic: q.get('traffic') !== '0',
    ui: q.get('ui') !== '0',
    model: q.get('model') === 'a' ? 0 : q.get('model') === 'b' ? 1 : null,
    render: q.get('render') ?? 'pseudo',
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

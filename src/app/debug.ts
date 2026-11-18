import type { RaceState } from '../sim/types';

export interface GameParams {
  seed: number;
  scenario: string;
  frames: number | null;
  ticks: number | null;
}

export interface RendererStats {
  calls: number;
  triangles: number;
}

export interface GameDebug {
  frames: number;
  done: boolean;
  errors: string[];
  params: GameParams;
  rendererInfo: () => RendererStats;
  readonly tick: number;
  state: () => RaceState;
  stepTicks: (n: number) => void;
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

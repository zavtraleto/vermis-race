export interface GameParams {
  seed: number;
  scenario: string;
  frames: number | null;
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
}

declare global {
  interface Window {
    __game: GameDebug;
  }
}

export function parseParams(search: string): GameParams {
  const q = new URLSearchParams(search);
  const seed = Number(q.get('seed') ?? '1');
  const framesRaw = q.get('frames');
  const frames = framesRaw === null ? null : Number(framesRaw);
  return {
    seed: Number.isFinite(seed) ? seed : 1,
    scenario: q.get('scenario') ?? 'empty',
    frames: frames !== null && Number.isFinite(frames) && frames >= 0 ? Math.floor(frames) : null,
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

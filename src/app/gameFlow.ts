// R95 start screen and pause: pure phase model (no DOM).

export type GamePhase = 'menu' | 'run' | 'pause';

export interface GameFlow {
  readonly phase: GamePhase;
  /** True only in 'run'. */
  readonly simRunning: boolean;
  start(): void;
  pause(): void;
  resume(): void;
  /** Returns true when the race must be restarted; goes to 'run'. */
  restart(): boolean;
}

export function createGameFlow(opts: { menu: boolean }): GameFlow {
  let phase: GamePhase = opts.menu ? 'menu' : 'run';
  return {
    get phase(): GamePhase {
      return phase;
    },
    get simRunning(): boolean {
      return phase === 'run';
    },
    start(): void {
      if (phase === 'menu') phase = 'run';
    },
    pause(): void {
      if (phase === 'run') phase = 'pause';
    },
    resume(): void {
      if (phase === 'pause') phase = 'run';
    },
    restart(): boolean {
      if (phase === 'menu') return false;
      phase = 'run';
      return true;
    },
  };
}

/** R95 "Автоматика": false with menu=0 or any `scenario` parameter. */
export function menuEnabled(search: string): boolean {
  const q = new URLSearchParams(search);
  return q.get('menu') !== '0' && !q.has('scenario');
}

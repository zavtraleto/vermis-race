// R95 start screen and pause: pure phase model (no DOM). Stub — implementation pending.

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
  void opts;
  throw new Error('not implemented');
}

/** R95 "Автоматика": false with menu=0 or any `scenario` parameter. */
export function menuEnabled(search: string): boolean {
  void search;
  throw new Error('not implemented');
}

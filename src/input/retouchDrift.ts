import type { TouchStickConfig } from './types';

export type RetouchDriftConfig = Pick<TouchStickConfig, 'retouchWindowMs' | 'retouchSwipePx'>;

/**
 * H3 variant D: re-touch drift. A touch-down no later than retouchWindowMs after the last up is
 * armed; an armed touch whose x moves at least retouchSwipePx away from its touch-down point (either
 * side) becomes active and stays active until up. Up clears active and armed. The very first touch
 * is never armed. x in CSS px of the game area (as pointerDom passes it), time in ms.
 */
export interface RetouchDrift {
  down(x: number, tMs: number): void;
  move(x: number, tMs: number): void;
  up(tMs: number): void;
  readonly active: boolean;
}

export function createRetouchDrift(cfg: RetouchDriftConfig): RetouchDrift {
  let touching = false;
  let armed = false;
  let active = false;
  let hasUp = false;
  let lastUp = 0;
  let downX = 0;
  return {
    get active(): boolean {
      return active;
    },
    down(x: number, tMs: number): void {
      touching = true;
      active = false;
      armed = hasUp && tMs - lastUp <= cfg.retouchWindowMs;
      downX = x;
    },
    move(x: number): void {
      if (!touching || !armed || active) return;
      if (Math.abs(x - downX) >= cfg.retouchSwipePx) active = true;
    },
    up(tMs: number): void {
      touching = false;
      armed = false;
      active = false;
      hasUp = true;
      lastUp = tMs;
    },
  };
}

import type { TouchStickConfig } from './types';

export type FlickDriftConfig = Pick<TouchStickConfig, 'flickDelta' | 'flickWindowMs'>;

/** H3 variant E: flick drift. Type-only stub, the logic is not implemented yet. */
export interface FlickDrift {
  down(tMs: number): void;
  sample(steer: number, tMs: number): void;
  up(tMs: number): void;
  readonly active: boolean;
}

export function createFlickDrift(cfg: FlickDriftConfig): FlickDrift {
  void cfg;
  throw new Error('not implemented');
}

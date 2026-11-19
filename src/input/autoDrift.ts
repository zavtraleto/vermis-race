import type { TouchStickConfig } from './types';

export type AutoDriftConfig = Pick<TouchStickConfig, 'autoDriftSteer' | 'autoDriftRelease'>;

/**
 * H3 variant C: touch drift without a gesture. Idle: |steer| >= autoDriftSteer latches the side
 * sign(steer) and returns true. Latched: true while steer * side >= autoDriftRelease; otherwise
 * the latch drops and that update returns false (a later update may latch again).
 */
export interface AutoDrift {
  update(steer: number): boolean;
  reset(): void;
}

export function createAutoDrift(cfg: AutoDriftConfig): AutoDrift {
  let side = 0;
  return {
    update(steer: number): boolean {
      if (side !== 0) {
        if (steer * side >= cfg.autoDriftRelease) return true;
        side = 0;
        return false;
      }
      if (Math.abs(steer) >= cfg.autoDriftSteer) {
        side = steer < 0 ? -1 : 1;
        return true;
      }
      return false;
    },
    reset(): void {
      side = 0;
    },
  };
}

import type { InputFrame } from '../sim/types';
import { combineInputs } from './combine';
import type { KeyboardInput } from './keyboard';
import type { TouchStick } from './touchStick';

export interface PlayerInput {
  /**
   * Reads keyboard and touch at now() and writes their combination (combineInputs) into `out`;
   * also copies it into `last`. No allocations.
   */
  read(out: InputFrame): void;
  /** The last frame produced by read() (all zero before the first read). Mutated in place. */
  readonly last: InputFrame;
}

export function createPlayerInput(
  keyboard: KeyboardInput,
  touch: TouchStick,
  now: () => number,
): PlayerInput {
  const kbFrame: InputFrame = { steer: 0, brake: false, drift: false };
  const touchFrame: InputFrame = { steer: 0, brake: false, drift: false };
  const last: InputFrame = { steer: 0, brake: false, drift: false };
  return {
    last,
    read(out: InputFrame): void {
      const t = now();
      keyboard.read(t, kbFrame);
      touch.read(t, touchFrame);
      combineInputs(kbFrame, touchFrame, out);
      last.steer = out.steer;
      last.brake = out.brake;
      last.drift = out.drift;
    },
  };
}

import type { InputFrame } from '../sim/types';
import { combineInputs } from './combine';
import type { KeyboardInput } from './keyboard';
import type { Pad } from './pad';

export interface PlayerInput {
  /**
   * Reads keyboard and pad at now() and writes their combination (combineInputs) into `out`;
   * also copies it into `last`. No allocations.
   */
  read(out: InputFrame): void;
  /** The last frame produced by read() (released input before the first read). Mutated in place. */
  readonly last: InputFrame;
}

export function createPlayerInput(
  keyboard: KeyboardInput,
  pad: Pad,
  now: () => number,
): PlayerInput {
  const kbFrame: InputFrame = { steer: 0, gas: 1, brake: 0, driftTap: false };
  const padFrame: InputFrame = { steer: 0, gas: 1, brake: 0, driftTap: false };
  const last: InputFrame = { steer: 0, gas: 1, brake: 0, driftTap: false };
  return {
    last,
    read(out: InputFrame): void {
      const t = now();
      keyboard.read(t, kbFrame);
      pad.read(t, padFrame);
      combineInputs(kbFrame, padFrame, out);
      last.steer = out.steer;
      last.gas = out.gas;
      last.brake = out.brake;
      last.driftTap = out.driftTap;
    },
  };
}

import type { PlayerInput } from '../input/player';
import type { InputFrame } from '../sim/types';
import type { InputSource } from './loop';

/**
 * Loop input source: car 0 (the player) gets player.read(); every other car gets the released
 * input { steer: 0, gas: 1, brake: 0, driftTap: false } (R201). No allocations.
 */
export function createReadInput(player: PlayerInput): InputSource {
  return (_tick: number, out: InputFrame[]): void => {
    if (out.length > 0) player.read(out[0]!);
    for (let i = 1; i < out.length; i++) {
      const f = out[i]!;
      f.steer = 0;
      f.gas = 1;
      f.brake = 0;
      f.driftTap = false;
    }
  };
}

/** Fresh copy of an InputFrame (for window.__game.input()). */
export function copyInputFrame(f: InputFrame): InputFrame {
  return { steer: f.steer, gas: f.gas, brake: f.brake, driftTap: f.driftTap };
}

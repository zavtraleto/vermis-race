import type { PlayerInput } from '../input/player';
import type { InputFrame } from '../sim/types';
import type { InputSource } from './loop';

/**
 * Loop input source: car 0 (the player) gets player.read(); every other car gets
 * { steer: 0, brake: false, drift: false } until AI exists. No allocations.
 */
export function createReadInput(player: PlayerInput): InputSource {
  return (_tick: number, out: InputFrame[]): void => {
    if (out.length > 0) player.read(out[0]!);
    for (let i = 1; i < out.length; i++) {
      const f = out[i]!;
      f.steer = 0;
      f.brake = false;
      f.drift = false;
    }
  };
}

/** Fresh copy of an InputFrame (for window.__game.input()). */
export function copyInputFrame(f: InputFrame): InputFrame {
  return { steer: f.steer, brake: f.brake, drift: f.drift };
}

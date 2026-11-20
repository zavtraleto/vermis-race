import type { InputFrame } from '../sim/types';
import type { AutoDrift } from './autoDrift';
import { combineInputs } from './combine';
import type { FlickDrift } from './flickDrift';
import type { RetouchDrift } from './retouchDrift';
import type { KeyboardInput } from './keyboard';
import { resolveDriftEntry, type DriftEntry } from './scheme';
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

/** H3 touch drift entry, read live from `hypotheses` (dev panel can switch it at runtime). */
export interface DriftEntryOptions {
  hypotheses: { H3_driftEntry: string };
  autoDrift: AutoDrift;
  /** H3 D: fed by the pointer adapter with the active touch's events. */
  retouch?: RetouchDrift;
  /** H3 E: flick detector fed by the pointer adapter / the poll. */
  flick?: FlickDrift;
  /** H14, read live: in model B (model 1) touch drift = the pointer is held, H3 does not apply (R81). */
  car?: { readonly model: number; readonly driftEntry?: number };
  warn: (message: string) => void;
}

export function createPlayerInput(
  keyboard: KeyboardInput,
  touch: TouchStick,
  now: () => number,
  drift?: DriftEntryOptions,
): PlayerInput {
  const kbFrame: InputFrame = { steer: 0, brake: false, drift: false };
  const touchFrame: InputFrame = { steer: 0, brake: false, drift: false };
  const last: InputFrame = { steer: 0, brake: false, drift: false };
  // Resolved only when the flag changes, so a bad value warns once per change.
  let flag: string | null = null;
  let entry: DriftEntry = 'A';
  return {
    last,
    read(out: InputFrame): void {
      const t = now();
      keyboard.read(t, kbFrame);
      touch.read(t, touchFrame);
      if (drift !== undefined) {
        const f = drift.hypotheses.H3_driftEntry;
        if (f !== flag) {
          flag = f;
          entry = resolveDriftEntry(f, drift.warn);
          drift.autoDrift.reset();
        }
        // R81c (model B, driftEntry 3): touch drift = the zone stick's latch, as the stick reports it.
        if (drift.car?.model === 1 && drift.car.driftEntry === 3) {
          // keep touchFrame.drift
        }
        // R81 (model B): drift input = finger on the screen or mouse button held; the sim finds the flick.
        // R81e/R81f (variants 4 and 5): the same finger-down drift on the zone stick.
        else if (drift.car?.model === 1) touchFrame.drift = touch.activeId !== null;
        // H3 C: the pull-down gesture is ignored, touch drift follows the stick deflection.
        else if (entry === 'C') touchFrame.drift = drift.autoDrift.update(touchFrame.steer);
        // H3 D: the pull-down gesture is ignored, touch drift = re-touch + sideways swipe.
        else if (entry === 'D') touchFrame.drift = drift.retouch?.active ?? false;
        // H3 E: the pull-down gesture is ignored, touch drift = a flick latched until release.
        else if (entry === 'E') touchFrame.drift = drift.flick?.active ?? false;
      }
      combineInputs(kbFrame, touchFrame, out);
      last.steer = out.steer;
      last.brake = out.brake;
      last.drift = out.drift;
    },
  };
}

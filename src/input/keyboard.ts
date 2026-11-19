import type { InputFrame } from '../sim/types';
import type { KeyboardConfig } from './types';

/**
 * Pure keyboard model (no DOM). Time is explicit, in ms, monotonic.
 * Codes are KeyboardEvent.code values (layout independent):
 * steer left: KeyA, ArrowLeft; steer right: KeyD, ArrowRight; brake: KeyS, ArrowDown;
 * drift: ShiftLeft, ShiftRight, Space.
 */
export interface KeyboardInput {
  /** Returns true if the code is one of ours (the DOM adapter then calls preventDefault). Repeats are harmless. */
  keyDown(code: string, tMs: number): boolean;
  /** Returns true if the code is one of ours. */
  keyUp(code: string, tMs: number): boolean;
  /** Releases every held key (window blur / tab hidden). */
  releaseAll(tMs: number): void;
  /**
   * Fills `out` for time tMs. Steer moves toward target (right - left, so both = 0) at
   * 1/steerRampMs per ms; brake and drift are plain held flags. No allocations.
   */
  read(tMs: number, out: InputFrame): void;
}

// One bit per code so two keys for the same action are held independently.
const LEFT_A = 1;
const LEFT_ARROW = 2;
const RIGHT_D = 4;
const RIGHT_ARROW = 8;
const BRAKE_S = 16;
const BRAKE_ARROW = 32;
const DRIFT_SHIFT_L = 64;
const DRIFT_SHIFT_R = 128;
const DRIFT_SPACE = 256;
const LEFT = LEFT_A | LEFT_ARROW;
const RIGHT = RIGHT_D | RIGHT_ARROW;
const BRAKE = BRAKE_S | BRAKE_ARROW;
const DRIFT = DRIFT_SHIFT_L | DRIFT_SHIFT_R | DRIFT_SPACE;

function codeBit(code: string): number {
  switch (code) {
    case 'KeyA':
      return LEFT_A;
    case 'ArrowLeft':
      return LEFT_ARROW;
    case 'KeyD':
      return RIGHT_D;
    case 'ArrowRight':
      return RIGHT_ARROW;
    case 'KeyS':
      return BRAKE_S;
    case 'ArrowDown':
      return BRAKE_ARROW;
    case 'ShiftLeft':
      return DRIFT_SHIFT_L;
    case 'ShiftRight':
      return DRIFT_SHIFT_R;
    case 'Space':
      return DRIFT_SPACE;
    default:
      return 0;
  }
}

/**
 * `car.model` is read live. Model 1 (B, R81 keyboard entry): a drift key pressed while a steer key
 * is held makes the next read return steer 0 and the read after it the full steer of the held keys;
 * a steer key pressed while drift is held sets the full steer at once. Model 0 / no car: ramp only.
 */
export function createKeyboardInput(
  cfg: KeyboardConfig,
  car?: { readonly model: number },
): KeyboardInput {
  let held = 0;
  let steer = 0;
  let lastT: number | null = null;
  // R81 keyboard entry: the next read returns steer 0; then the read after it snaps to the target.
  let zeroNext = false;
  let snapNext = false;

  function target(): number {
    return ((held & RIGHT) !== 0 ? 1 : 0) - ((held & LEFT) !== 0 ? 1 : 0);
  }

  /** Integrates steer toward the current target up to tMs; non-monotonic time -> dt 0. */
  function advance(tMs: number): void {
    if (lastT === null || tMs <= lastT) {
      if (lastT === null) lastT = tMs;
      return;
    }
    const dt = tMs - lastT;
    lastT = tMs;
    const tgt = target();
    // cfg read live (dev tuning panel); same arithmetic as dt * (1 / ramp).
    const step = dt * (1 / cfg.steerRampMs);
    if (steer < tgt) steer = Math.min(tgt, steer + step);
    else if (steer > tgt) steer = Math.max(tgt, steer - step);
  }

  return {
    keyDown(code: string, tMs: number): boolean {
      advance(tMs);
      const bit = codeBit(code);
      const wasDrift = (held & DRIFT) !== 0;
      held |= bit;
      if (car?.model === 1) {
        // A new drift press (not auto-repeat, not a second drift key) with a steer key held.
        if ((bit & DRIFT) !== 0 && !wasDrift && (held & (LEFT | RIGHT)) !== 0) zeroNext = true;
        // A steer key pressed while drift is held: full steer at once.
        if ((bit & (LEFT | RIGHT)) !== 0 && wasDrift) steer = target();
      }
      return bit !== 0;
    },
    keyUp(code: string, tMs: number): boolean {
      advance(tMs);
      const bit = codeBit(code);
      held &= ~bit;
      // Drift fully released: no pending zero or jump remains.
      if ((held & DRIFT) === 0) zeroNext = snapNext = false;
      return bit !== 0;
    },
    releaseAll(tMs: number): void {
      advance(tMs);
      held = 0;
      zeroNext = snapNext = false;
    },
    read(tMs: number, out: InputFrame): void {
      advance(tMs);
      if (snapNext) {
        snapNext = false;
        steer = target();
      }
      out.steer = steer;
      if (zeroNext) {
        zeroNext = false;
        snapNext = true;
        out.steer = 0;
      }
      out.brake = (held & BRAKE) !== 0;
      out.drift = (held & DRIFT) !== 0;
    },
  };
}

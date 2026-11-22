import type { InputFrame } from '../sim/types';

/**
 * Pure keyboard model (no DOM), R202. Codes are KeyboardEvent.code values (layout independent):
 * ArrowLeft / ArrowRight = steer target -1 / +1 (both = 0), ArrowDown = brake 1 and gas 0, no key =
 * gas 1; Space = driftTap on the first read after it is pressed (one tick).
 */
export interface KeyboardInput {
  /** Returns true if the code is one of ours (the DOM adapter then calls preventDefault). Repeats are harmless. */
  keyDown(code: string, tMs: number): boolean;
  /** Returns true if the code is one of ours. */
  keyUp(code: string, tMs: number): boolean;
  /** Releases every held key (window blur / tab hidden). */
  releaseAll(tMs: number): void;
  /** Fills `out` for time tMs. No allocations. */
  read(tMs: number, out: InputFrame): void;
}

const LEFT = 1;
const RIGHT = 2;
const BRAKE = 4;
const TAP = 8;

function codeBit(code: string): number {
  switch (code) {
    case 'ArrowLeft':
      return LEFT;
    case 'ArrowRight':
      return RIGHT;
    case 'ArrowDown':
      return BRAKE;
    case 'Space':
      return TAP;
    default:
      return 0;
  }
}

export function createKeyboardInput(): KeyboardInput {
  let held = 0;
  let tapPending = false;
  return {
    keyDown(code: string): boolean {
      const bit = codeBit(code);
      if (bit === TAP && (held & TAP) === 0) tapPending = true; // not on auto-repeat
      held |= bit;
      return bit !== 0;
    },
    keyUp(code: string): boolean {
      const bit = codeBit(code);
      held &= ~bit;
      return bit !== 0;
    },
    releaseAll(): void {
      held = 0;
      tapPending = false;
    },
    read(_tMs: number, out: InputFrame): void {
      out.steer = ((held & RIGHT) !== 0 ? 1 : 0) - ((held & LEFT) !== 0 ? 1 : 0);
      const braking = (held & BRAKE) !== 0;
      out.gas = braking ? 0 : 1;
      out.brake = braking ? 1 : 0;
      out.driftTap = tapPending;
      tapPending = false;
    },
  };
}

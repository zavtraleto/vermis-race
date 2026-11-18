import type { InputFrame } from '../sim/types';

/**
 * out.steer = the steer with the larger magnitude (tie -> a.steer); brake and drift = a OR b.
 * `out` may be the same object as `a` or `b`. No allocations.
 */
export function combineInputs(a: InputFrame, b: InputFrame, out: InputFrame): void {
  const as = a.steer;
  const bs = b.steer;
  const brake = a.brake || b.brake;
  const drift = a.drift || b.drift;
  out.steer = Math.abs(bs) > Math.abs(as) ? bs : as;
  out.brake = brake;
  out.drift = drift;
}

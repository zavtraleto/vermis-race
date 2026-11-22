import type { InputFrame } from '../sim/types';

/**
 * out.steer = the steer with the larger magnitude (tie -> a.steer); brake and drift = a OR b.
 * R151: out.throttle the same way as the steer (absent = 0), written only when a or b has one.
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
  if (a.throttle !== undefined || b.throttle !== undefined) {
    const at = a.throttle ?? 0;
    const bt = b.throttle ?? 0;
    out.throttle = Math.abs(bt) > Math.abs(at) ? bt : at;
  }
}

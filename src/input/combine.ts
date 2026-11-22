import type { InputFrame } from '../sim/types';

/**
 * out.steer = the steer with the larger magnitude (tie -> a.steer); gas = the smaller gas, brake =
 * the larger brake, driftTap = a OR b. `out` may be the same object as `a` or `b`. No allocations.
 */
export function combineInputs(a: InputFrame, b: InputFrame, out: InputFrame): void {
  const as = a.steer;
  const bs = b.steer;
  const gas = a.gas < b.gas ? a.gas : b.gas;
  const brake = a.brake > b.brake ? a.brake : b.brake;
  const tap = a.driftTap || b.driftTap;
  out.steer = Math.abs(bs) > Math.abs(as) ? bs : as;
  out.gas = gas;
  out.brake = brake;
  out.driftTap = tap;
}

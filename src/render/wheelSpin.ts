const TWO_PI = 2 * Math.PI;

/**
 * R25c: wheel spin angle about the axle. Angular speed = speedMps / radiusM; returns the new angle
 * wrapped into [0, 2π). radiusM <= 0 leaves the angle unchanged. Pure, no allocations.
 */
export function stepWheelSpin(
  angleRad: number,
  speedMps: number,
  radiusM: number,
  dt: number,
): number {
  if (!(radiusM > 0) || speedMps === 0 || dt === 0) return angleRad;
  let a = (angleRad + (speedMps / radiusM) * dt) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a >= TWO_PI ? 0 : a;
}

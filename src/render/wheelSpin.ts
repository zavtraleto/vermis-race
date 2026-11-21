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
  void angleRad;
  void speedMps;
  void radiusM;
  void dt;
  throw new Error('not implemented');
}

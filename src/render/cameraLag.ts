/**
 * R27b: the render-side lateral camera position camPosX (half-widths) chases the car x:
 * camPosX += (x - camPosX)*(1 - exp(-dt/tau)), then |x - camPosX| <= max. tau 0 = the camera on x.
 * Returns the new camPosX; pure, no allocations.
 */
export function stepCamLag(camPosX: number, x: number, dt: number, tau: number, max: number): number {
  let c = tau > 0 ? camPosX + (x - camPosX) * (1 - Math.exp(-dt / tau)) : x;
  if (x - c > max) c = x - max;
  else if (c - x > max) c = x + max;
  return c;
}

/**
 * R27d: the R27b lag written through the offset o = x - camPosX. Target oT = clamp(vx*tau, +-max);
 * o += (oT - o)*(1 - exp(-dt/T)), T = tau while the target is farther from zero on the same side
 * (|oT| >= |o|, oT*o >= 0), else returnTau (0 = at once). Returns the new o (camPosX = x - o); pure.
 */
export function stepCamOffset(
  o: number,
  vx: number,
  dt: number,
  tau: number,
  returnTau: number,
  max: number,
): number {
  let oT = vx * tau;
  if (oT > max) oT = max;
  else if (oT < -max) oT = -max;
  const away = (oT < 0 ? -oT : oT) >= (o < 0 ? -o : o) && oT * o >= 0;
  const t = away ? tau : returnTau;
  return t > 0 ? o + (oT - o) * (1 - Math.exp(-dt / t)) : oT;
}

/** R27b: the camPosX shared by the pseudo-3D frame and ?render=3d (a render field, not sim state). */
export interface CamLag {
  posX: number;
}

/** R27b numbers in src/data/camera.json. */
export interface CamLagConfig {
  camLagTau: number; // s, lag of camPosX behind the car x (0 = the camera on x)
  camLagMax: number; // half-widths, max |x - camPosX|
  camReturnTau: number; // s, R27d return of the offset x - camPosX toward its target (0 = at once)
}

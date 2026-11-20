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

/** R27b: the camPosX shared by the pseudo-3D frame and ?render=3d (a render field, not sim state). */
export interface CamLag {
  posX: number;
}

/** R27b numbers in src/data/camera.json. */
export interface CamLagConfig {
  camLagTau: number; // s, lag of camPosX behind the car x (0 = the camera on x)
  camLagMax: number; // half-widths, max |x - camPosX|
}

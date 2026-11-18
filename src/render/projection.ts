import type { Track } from '../sim/types';

export interface CameraConfig {
  fovDeg: number; // horizontal FOV, degrees
  height: number; // camera height above road, world units
  drawDistance: number; // segments drawn
  horizon: number; // horizon line as a fraction of screen height from the top
  screenWidth: number; // px
  screenHeight: number; // px
}

export interface RoadConfig {
  segmentLength: number; // world units
  halfWidth: number; // road half-width, world units
  rumbleLength: number; // segments per colour stripe
  lanes: number;
  rumbleWidth: number; // fraction of halfWidth
  laneMarkerWidth: number; // fraction of halfWidth
}

export interface Projection {
  count: number; // lines written by the last project() call
  base: number; // wrapped track segment of line 0 (the segment the camera is in)
  frac: number; // camera position inside the base segment, 0..1
  length: number; // track length in segments at the last project() call
  x: Float32Array; // screen x of road centre, px
  y: Float32Array; // screen y, px, origin top-left, y down
  w: Float32Array; // road half-width on screen, px
  scale: Float32Array; // px per world unit
  segment: Int32Array; // wrapped track segment index of this line
}

function focalPx(camera: CameraConfig): number {
  return camera.screenWidth / 2 / Math.tan((camera.fovDeg * Math.PI) / 360);
}

// Distance from the camera to the line at the bottom of the screen.
function nearDistance(camera: CameraConfig, f: number): number {
  return (f * camera.height) / (camera.screenHeight - camera.horizon * camera.screenHeight);
}

export function createProjection(camera: CameraConfig, road: RoadConfig): Projection {
  const d0 = nearDistance(camera, focalPx(camera));
  // Relative epsilon absorbs tan() rounding (tan(pi/4) = 0.9999999999999999).
  if (!(d0 - road.segmentLength > 1e-9 * d0)) {
    throw new Error(
      `projection: d0 (${d0}) must exceed segmentLength (${road.segmentLength}), otherwise line 0 falls behind the camera`,
    );
  }
  const n = camera.drawDistance + 1;
  return {
    count: 0,
    base: 0,
    frac: 0,
    length: 1,
    x: new Float32Array(n),
    y: new Float32Array(n),
    w: new Float32Array(n),
    scale: new Float32Array(n),
    segment: new Int32Array(n),
  };
}

export function project(
  out: Projection,
  track: Track,
  z: number,
  x: number,
  camera: CameraConfig,
  road: RoadConfig,
): void {
  const segs = track.segments;
  const len = segs.length;
  const halfW = camera.screenWidth / 2;
  const horizonY = camera.horizon * camera.screenHeight;
  const f = focalPx(camera);
  const d0 = nearDistance(camera, f);
  const zFloor = Math.floor(z);
  const frac = z - zFloor;
  const base = ((zFloor % len) + len) % len;
  const count = camera.drawDistance + 1;
  const camX = x * road.halfWidth;

  // Curve accumulation starts mid-segment so edges stay continuous across boundaries.
  const c0 = segs[base]!.curve;
  let off = c0 * frac;
  let dx = -c0 * frac;
  for (let n = 0; n < count; n++) {
    const seg = (base + n) % len;
    const scale = f / (d0 + (n - frac) * road.segmentLength);
    out.segment[n] = seg;
    out.scale[n] = scale;
    out.y[n] = horizonY + scale * camera.height;
    out.w[n] = scale * road.halfWidth;
    out.x[n] = halfW + scale * (off - camX);
    off += dx;
    dx += segs[seg]!.curve;
  }
  out.count = count;
  out.base = base;
  out.frac = frac;
  out.length = len;
}

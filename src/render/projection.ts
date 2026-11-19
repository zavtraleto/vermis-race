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
  curve: Float32Array; // curve of that track segment
  // R30: 1 = line hidden behind a crest (its screen y is not above every nearer line).
  clipped: Uint8Array;
}

// R30 road height at the START of segment seg, segment lengths (= y of the previous segment;
// the loop starts at 0). Tracks without y are flat.
function startHeight(track: Track, seg: number): number {
  return seg === 0 ? 0 : (track.segments[seg - 1]!.y ?? 0);
}

function focalPx(camera: CameraConfig): number {
  return camera.screenWidth / 2 / Math.tan((camera.fovDeg * Math.PI) / 360);
}

// Distance from the camera to the line at the bottom of the screen.
function nearDistance(camera: CameraConfig, f: number): number {
  return (f * camera.height) / (camera.screenHeight - camera.horizon * camera.screenHeight);
}

// Low camera: line 0 can come nearer than the bottom of the screen, even behind the camera.
// Relative epsilon absorbs tan() rounding (tan(pi/4) = 0.9999999999999999).
function isLowCamera(d0: number, road: RoadConfig): boolean {
  return !(d0 - road.segmentLength > 1e-9 * d0);
}

export function createProjection(camera: CameraConfig, road: RoadConfig): Projection {
  void road;
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
    curve: new Float32Array(n),
    clipped: new Uint8Array(n),
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
  // R30: world height = y * segmentLength (y is in segment lengths, as in javascript-racer).
  // The camera rides camera.height above the road under it, linear inside the base segment.
  const hBase = startHeight(track, base);
  const camRoad = (hBase + frac * ((segs[base]!.y ?? 0) - hBase)) * road.segmentLength;
  const camY = camera.height + camRoad;

  // Curve accumulation starts mid-segment so edges stay continuous across boundaries.
  const c0 = segs[base]!.curve;
  let off = c0 * frac;
  let dx = -c0 * frac;
  for (let n = 0; n < count; n++) {
    const seg = (base + n) % len;
    const scale = f / (d0 + (n - frac) * road.segmentLength);
    out.segment[n] = seg;
    out.curve[n] = segs[seg]!.curve;
    out.scale[n] = scale;
    out.y[n] = horizonY + scale * (camY - startHeight(track, seg) * road.segmentLength);
    out.w[n] = scale * road.halfWidth;
    out.x[n] = halfW + scale * (off - camX);
    off += dx;
    dx += segs[seg]!.curve;
  }
  if (frac > 0 && isLowCamera(d0, road)) {
    // Clamp line 0 onto the near plane (depth d0, the bottom of the screen). Depth is linear
    // in n, so depth d0 lies frac of the way from line 0 to line 1; the world offset is
    // interpolated there (line 0: c0*frac, line 1: 0) and then projected.
    // R30: the road height there is the one under the camera, so y stays camera.height below.
    const s = f / d0;
    const offNear = c0 * frac * (1 - frac);
    out.scale[0] = s;
    out.y[0] = horizonY + s * camera.height;
    out.w[0] = s * road.halfWidth;
    out.x[0] = halfW + s * (offNear - camX);
  }
  // R30 crest clipping, front to back: a line is hidden unless it is above every nearer line.
  let minY = out.y[0]!;
  out.clipped[0] = 0;
  for (let n = 1; n < count; n++) {
    const yn = out.y[n]!;
    if (yn >= minY) out.clipped[n] = 1;
    else {
      out.clipped[n] = 0;
      minY = yn;
    }
  }
  out.count = count;
  out.base = base;
  out.frac = frac;
  out.length = len;
}

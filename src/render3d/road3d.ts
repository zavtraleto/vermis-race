import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
} from 'three';
import type { Palette } from '../data/render';
import type { RoadMeshConfig } from '../render/roadMesh';
import type { Track } from '../sim/types';

/** Spike E1: numbers of the true-3D renderer (src/data/render3d.json). World units unless noted. */
export interface Render3dConfig {
  k3dCurve: number; // rad of real heading change per unit of sim curve per segment
  drawDistance: number; // segments built ahead of the camera (live, <= capacity)
  capacity: number; // buffer size in segments
  behind: number; // segments built behind the camera
  vergeWidth: number; // verge reaches this many road half-widths from the centre line
  groundDrop: number; // flat ground plane sits this far below the lowest line of the window
  liftRoad: number; // asphalt / kerb height above the verge
  liftMark: number; // markings height above the verge
  playerWidth: number; // player car width
  camera: {
    height: number;
    distance: number; // behind the player's rear axle, along the road
    fovDeg: number; // horizontal
    pitchDeg: number; // > 0 = looking down
    horizon: number; // principal point as a fraction of screen height (pseudo-3D horizon line)
    lagTau: number; // s, heading lag behind the road direction
    slopeFollow: number; // 0..1, pitch toward the car's road height on hills
    near: number;
  };
  fog: { near: number; far: number }; // fractions of drawDistance * segmentLength
  roadsideCapacity: number;
  windowSegments: number; // building windows only this many segments ahead
  smokeCapacity: number;
}

const SCRATCH = new Color();

/** Writes palette hex (sRGB) times shade as a linear colour (build time only). */
export function linearHex(out: Float32Array, at: number, hex: string, shade = 1): void {
  const v = parseInt(hex.slice(1), 16);
  SCRATCH.setRGB(
    (((v >> 16) & 0xff) / 255) * shade,
    (((v >> 8) & 0xff) / 255) * shade,
    ((v & 0xff) / 255) * shade,
    SRGBColorSpace,
  );
  out[at] = SCRATCH.r;
  out[at + 1] = SCRATCH.g;
  out[at + 2] = SCRATCH.b;
}

/** A point on the road: world position, heading (rad, 0 = -z, > 0 = turning right), slope. */
export interface RoadPoint {
  x: number;
  y: number;
  z: number;
  heading: number;
  slope: number;
}

/**
 * Sliding window of the track as real geometry, in a frame local to its first line (origin,
 * heading 0). Line n is the start of segment base + n. Heading grows by curve * k3dCurve per
 * segment, height comes from Segment.y. Rebuilt every frame; the endless loop is never built whole.
 */
export class RoadWindow {
  base = 0; // unwrapped segment index of line 0
  count = 0; // segments in the window (lines = count + 1)
  readonly px: Float64Array;
  readonly pz: Float64Array;
  readonly py: Float64Array;
  readonly heading: Float64Array;
  readonly seg: Int32Array; // wrapped track segment of line n
  readonly curve: Float32Array;
  private segLen = 1;
  private k = 0;

  constructor(readonly capacity: number) {
    const n = capacity + 1;
    this.px = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.py = new Float64Array(n);
    this.heading = new Float64Array(n);
    this.seg = new Int32Array(n);
    this.curve = new Float32Array(n);
  }

  build(track: Track, base: number, count: number, k: number, segLen: number): void {
    const segs = track.segments;
    const len = segs.length;
    const n = Math.min(count, this.capacity);
    this.base = base;
    this.count = n;
    this.segLen = segLen;
    this.k = k;
    let x = 0;
    let z = 0;
    let h = 0;
    for (let i = 0; i <= n; i++) {
      const s = (((base + i) % len) + len) % len;
      const c = segs[s]!.curve;
      this.seg[i] = s;
      this.curve[i] = c;
      this.px[i] = x;
      this.pz[i] = z;
      this.heading[i] = h;
      // R30: height at the start of segment s = y of the previous segment (the loop starts at 0).
      this.py[i] = (s === 0 ? 0 : (segs[s - 1]!.y ?? 0)) * segLen;
      const mid = h + c * k * 0.5;
      x += segLen * Math.sin(mid);
      z -= segLen * Math.cos(mid);
      h += c * k;
    }
  }

  /** Point at unwrapped segment position zU, `lateral` world units to the right. False outside. */
  sample(out: RoadPoint, zU: number, lateral: number): boolean {
    const rel = zU - this.base;
    let i = Math.floor(rel);
    if (i < 0 || i > this.count) return false;
    if (i === this.count) i = this.count - 1;
    const t = rel - i;
    const ck = this.curve[i]! * this.k;
    const h = this.heading[i]! + t * ck;
    const mid = this.heading[i]! + t * ck * 0.5;
    const L = this.segLen * t;
    out.heading = h;
    out.x = this.px[i]! + L * Math.sin(mid) + lateral * Math.cos(h);
    out.z = this.pz[i]! - L * Math.cos(mid) + lateral * Math.sin(h);
    const y0 = this.py[i]!;
    const y1 = this.py[i + 1]!;
    out.y = y0 + t * (y1 - y0);
    out.slope = (y1 - y0) / this.segLen;
    return true;
  }
}

// Colour slots in the rgb table, 3 floats each (linear).
const ASPHALT_LIGHT = 0;
const ASPHALT_DARK = 3;
const RUMBLE_LIGHT = 6;
const RUMBLE_DARK = 9;
const VERGE_LIGHT = 12;
const VERGE_DARK = 15;
const LANE = 18;
const CENTRE = 21;
const SHOULDER = 24;

/**
 * Road ribbon of the window: same bands and markings as the pseudo-3D RoadMesh (verge, kerbs
 * red/white in corners, asphalt, edge lines, dashed lanes, double centre line), but as real world
 * quads lying on the road surface; the markings are lifted a little above the asphalt.
 * One dynamic BufferGeometry, one draw call, fog from the scene.
 */
export class RoadRibbon {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;
  private readonly rgb = new Float32Array(27);
  private readonly cosH: Float64Array;
  private readonly sinH: Float64Array;
  private quads = 0;

  constructor(
    capacity: number,
    private readonly road: RoadMeshConfig,
    palette: Palette,
  ) {
    // 2 verges, 2 kerbs, asphalt, 2 edge lines, lane lines (the centre one doubled)
    const maxQuads = capacity * (2 + 2 + 1 + 2 + road.lanes);
    linearHex(this.rgb, ASPHALT_LIGHT, palette.asphalt[0]!);
    linearHex(this.rgb, ASPHALT_DARK, palette.asphalt[1]!);
    linearHex(this.rgb, RUMBLE_LIGHT, palette.rumble[0]!);
    linearHex(this.rgb, RUMBLE_DARK, palette.rumble[1]!);
    linearHex(this.rgb, VERGE_LIGHT, palette.verge[0]!);
    linearHex(this.rgb, VERGE_DARK, palette.verge[1]!);
    linearHex(this.rgb, LANE, palette.lane);
    linearHex(this.rgb, CENTRE, palette.centreLine);
    linearHex(this.rgb, SHOULDER, palette.shoulder);
    this.cosH = new Float64Array(capacity + 1);
    this.sinH = new Float64Array(capacity + 1);
    this.pos = new Float32Array(maxQuads * 12);
    this.col = new Float32Array(maxQuads * 12);
    const idx = new Uint32Array(maxQuads * 6);
    for (let q = 0, v = 0, i = 0; q < maxQuads; q++, v += 4, i += 6) {
      idx[i] = v;
      idx[i + 1] = v + 1;
      idx[i + 2] = v + 2;
      idx[i + 3] = v;
      idx[i + 4] = v + 2;
      idx[i + 5] = v + 3;
    }
    const geo = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    this.colAttr = new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setIndex(new BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.mesh = new Mesh(geo, new MeshBasicMaterial({ vertexColors: true }));
    this.mesh.frustumCulled = false;
  }

  update(w: RoadWindow, vergeWidth: number, liftRoad: number, liftMark: number): void {
    const road = this.road;
    for (let i = 0; i <= w.count; i++) {
      this.cosH[i] = Math.cos(w.heading[i]!);
      this.sinH[i] = Math.sin(w.heading[i]!);
    }
    const dashPeriod = road.laneDash.on + road.laneDash.off;
    const centreLane = road.lanes % 2 === 0 ? road.lanes / 2 : -1;
    const rw = road.rumbleWidth;
    const ei = 1 - road.edgeLineInset - road.edgeLineWidth;
    const eo = 1 - road.edgeLineInset;
    const h = road.laneMarkerWidth / 2;
    const g = road.centreGap / 2;
    this.quads = 0;
    for (let n = 0; n < w.count; n++) {
      const seg = w.seg[n]!;
      const light = Math.floor(seg / road.rumbleLength) % 2 === 0;
      // Verge only outside the kerbs: no coplanar overlap with the asphalt (z-fighting far away).
      const verge = light ? VERGE_LIGHT : VERGE_DARK;
      this.quad(w, n, -vergeWidth, -1 - rw, 0, verge);
      this.quad(w, n, 1 + rw, vergeWidth, 0, verge);
      const corner = Math.abs(w.curve[n]!) >= road.kerbMinCurve;
      const kerb = corner ? (light ? RUMBLE_LIGHT : RUMBLE_DARK) : SHOULDER;
      this.quad(w, n, -1 - rw, -1, liftRoad, kerb);
      this.quad(w, n, 1, 1 + rw, liftRoad, kerb);
      this.quad(w, n, -1, 1, liftRoad, light ? ASPHALT_LIGHT : ASPHALT_DARK);
      this.quad(w, n, -eo, -ei, liftMark, LANE);
      this.quad(w, n, ei, eo, liftMark, LANE);
      const dash = seg % dashPeriod < road.laneDash.on;
      for (let lane = 1; lane < road.lanes; lane++) {
        const c = -1 + (2 * lane) / road.lanes;
        if (lane === centreLane) {
          this.quad(w, n, c - g - 2 * h, c - g, liftMark, CENTRE);
          this.quad(w, n, c + g, c + g + 2 * h, liftMark, CENTRE);
        } else if (dash) this.quad(w, n, c - h, c + h, liftMark, LANE);
      }
    }
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, this.quads * 6);
    const used = this.quads * 12;
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(0, used);
    this.posAttr.needsUpdate = true;
    this.colAttr.clearUpdateRanges();
    this.colAttr.addUpdateRange(0, used);
    this.colAttr.needsUpdate = true;
  }

  // Quad between lines n and n + 1, laterally from l to r road half-widths, `lift` above the line.
  private quad(w: RoadWindow, n: number, l: number, r: number, lift: number, colour: number): void {
    const p = this.pos;
    const c = this.col;
    const rgb = this.rgb;
    const hw = this.road.halfWidth;
    let i = this.quads * 12;
    for (let v = 0; v < 4; v++) {
      // v: 0 near-left, 1 near-right, 2 far-right, 3 far-left
      const m = v < 2 ? n : n + 1;
      const off = (v === 0 || v === 3 ? l : r) * hw;
      p[i] = w.px[m]! + off * this.cosH[m]!;
      p[i + 1] = w.py[m]! + lift;
      p[i + 2] = w.pz[m]! + off * this.sinH[m]!;
      c[i] = rgb[colour]!;
      c[i + 1] = rgb[colour + 1]!;
      c[i + 2] = rgb[colour + 2]!;
      i += 3;
    }
    this.quads += 1;
  }
}

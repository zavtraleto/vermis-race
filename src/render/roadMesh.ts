import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Mesh, ShaderMaterial } from 'three';
import type { Palette } from '../data/render';
import type { CameraConfig, Projection, RoadConfig } from './projection';

// Positions arrive already in NDC; the camera passed to render() is ignored.
const VERTEX = /* glsl */ `
attribute vec3 aColor;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(position, 1.0);
}
`;
const FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

// Colour slots in the rgb table, 3 floats each. Values stay raw sRGB (no Color conversion).
const ASPHALT_LIGHT = 0;
const ASPHALT_DARK = 3;
const RUMBLE_LIGHT = 6;
const RUMBLE_DARK = 9;
const VERGE_LIGHT = 12;
const VERGE_DARK = 15;
const LANE = 18;

export function writeHex(out: Float32Array, at: number, hex: string): void {
  const v = parseInt(hex.slice(1), 16);
  out[at] = ((v >> 16) & 0xff) / 255;
  out[at + 1] = ((v >> 8) & 0xff) / 255;
  out[at + 2] = (v & 0xff) / 255;
}

/**
 * Grey road: one dynamic BufferGeometry, one draw call.
 * Per strip n (between projected lines n and n+1): full-width verge, rumble bands
 * outside the asphalt edge (±w .. ±w(1+rumbleWidth)), asphalt ±w, lane markers on light stripes.
 * Verge overlaps everything and sits at the strip's depth; asphalt/rumble are one micro-step
 * nearer, markers two, so depth testing layers them without per-pixel sorting.
 */
export class RoadMesh {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;
  private readonly rgb = new Float32Array(21);
  private readonly screenW: number;
  private readonly invW: number;
  private readonly invH: number;
  private readonly strips: number;
  private quads = 0;

  constructor(
    // horizon is read live in update() (dev tuning panel); drawDistance sizes the buffers here.
    private readonly camera: CameraConfig,
    private readonly road: RoadConfig,
    palette: Palette,
  ) {
    const quadsPerSegment = 1 + 2 + 1 + (road.lanes - 1);
    const maxQuads = camera.drawDistance * quadsPerSegment;
    this.strips = camera.drawDistance;
    this.screenW = camera.screenWidth;
    this.invW = 1 / camera.screenWidth;
    this.invH = 1 / camera.screenHeight;

    writeHex(this.rgb, ASPHALT_LIGHT, palette.asphalt[0]!);
    writeHex(this.rgb, ASPHALT_DARK, palette.asphalt[1]!);
    writeHex(this.rgb, RUMBLE_LIGHT, palette.rumble[0]!);
    writeHex(this.rgb, RUMBLE_DARK, palette.rumble[1]!);
    writeHex(this.rgb, VERGE_LIGHT, palette.verge[0]!);
    writeHex(this.rgb, VERGE_DARK, palette.verge[1]!);
    writeHex(this.rgb, LANE, palette.lane);

    this.pos = new Float32Array(maxQuads * 4 * 3);
    this.col = new Float32Array(maxQuads * 4 * 3);
    const idx = new Uint16Array(maxQuads * 6);
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
    geo.setAttribute('aColor', this.colAttr);
    geo.setIndex(new BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    const mat = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: true,
      depthWrite: true,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  update(proj: Projection): void {
    const road = this.road;
    const horizonY = this.camera.horizon * this.camera.screenHeight;
    const step = 2 / this.strips;
    const last = Math.min(proj.count - 1, this.strips);
    this.quads = 0;
    for (let n = 0; n < last; n++) {
      const y0 = proj.y[n]!;
      const y1 = proj.y[n + 1]!;
      // Skip strips at/above the horizon or with no height (y grows downwards).
      if (y0 <= horizonY || y1 >= y0) continue;
      const x0 = proj.x[n]!;
      const x1 = proj.x[n + 1]!;
      const w0 = proj.w[n]!;
      const w1 = proj.w[n + 1]!;
      const light = Math.floor(proj.segment[n]! / road.rumbleLength) % 2 === 0;
      const z = -1 + step * (n + 0.5);
      const zRoad = z - step * 0.1;
      const zMark = z - step * 0.2;

      this.quad(0, this.screenW, y0, 0, this.screenW, y1, z, light ? VERGE_LIGHT : VERGE_DARK);

      const r0 = w0 * road.rumbleWidth;
      const r1 = w1 * road.rumbleWidth;
      const rumble = light ? RUMBLE_LIGHT : RUMBLE_DARK;
      this.quad(x0 - w0 - r0, x0 - w0, y0, x1 - w1 - r1, x1 - w1, y1, zRoad, rumble);
      this.quad(x0 + w0, x0 + w0 + r0, y0, x1 + w1, x1 + w1 + r1, y1, zRoad, rumble);
      this.quad(x0 - w0, x0 + w0, y0, x1 - w1, x1 + w1, y1, zRoad, light ? ASPHALT_LIGHT : ASPHALT_DARK);

      if (light) {
        const h0 = (w0 * road.laneMarkerWidth) / 2;
        const h1 = (w1 * road.laneMarkerWidth) / 2;
        for (let lane = 1; lane < road.lanes; lane++) {
          const c0 = x0 - w0 + (2 * w0 * lane) / road.lanes;
          const c1 = x1 - w1 + (2 * w1 * lane) / road.lanes;
          this.quad(c0 - h0, c0 + h0, y0, c1 - h1, c1 + h1, y1, zMark, LANE);
        }
      }
    }

    const geo = this.mesh.geometry;
    geo.setDrawRange(0, this.quads * 6);
    const used = this.quads * 4 * 3;
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(0, used);
    this.posAttr.needsUpdate = true;
    this.colAttr.clearUpdateRanges();
    this.colAttr.addUpdateRange(0, used);
    this.colAttr.needsUpdate = true;
  }

  // Quad from screen px: bottom edge (l0..r0 at y0), top edge (l1..r1 at y1).
  private quad(
    l0: number,
    r0: number,
    y0: number,
    l1: number,
    r1: number,
    y1: number,
    z: number,
    colour: number,
  ): void {
    const p = this.pos;
    const c = this.col;
    const rgb = this.rgb;
    let i = this.quads * 12;
    const ny0 = 1 - y0 * this.invH * 2;
    const ny1 = 1 - y1 * this.invH * 2;
    const sx = this.invW * 2;
    p[i] = l0 * sx - 1;
    p[i + 1] = ny0;
    p[i + 2] = z;
    p[i + 3] = r0 * sx - 1;
    p[i + 4] = ny0;
    p[i + 5] = z;
    p[i + 6] = r1 * sx - 1;
    p[i + 7] = ny1;
    p[i + 8] = z;
    p[i + 9] = l1 * sx - 1;
    p[i + 10] = ny1;
    p[i + 11] = z;
    for (let v = 0; v < 4; v++, i += 3) {
      c[i] = rgb[colour]!;
      c[i + 1] = rgb[colour + 1]!;
      c[i + 2] = rgb[colour + 2]!;
    }
    this.quads += 1;
  }
}

import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Mesh, ShaderMaterial } from 'three';
import type { Palette } from '../data/render';
import type { Track } from '../sim/types';
import type { CameraConfig } from './projection';
import {
  createRibbonLayout,
  createRibbonMap,
  layoutRibbon,
  updateRibbonMap,
  type RibbonLayout,
  type RibbonMap,
  type RibbonMapConfig,
  type RibbonThresholds,
  type RibbonZone,
} from './ribbonMap';
import { writeHex } from './roadMesh';

export interface RibbonMapRenderConfig extends RibbonMapConfig {
  enabled: boolean; // off = mesh hidden, no draw call (playtest with/without, also ?map=0)
  zone: {
    height: number; // fraction of screen height, from the top, full width
    padding: number; // px
    xStretch: number;
  };
  ribbonWidth: number; // px
  marker: {
    width: number; // px
    height: number; // px
    span: number; // px per road half-width of the car's x
  };
}

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

// Colour slots, 3 floats each: backing, classes 0..3 (straight, easy, medium, hard), marker.
const BACKING = 0;
const CLASS0 = 3;
const MARKER = 15;

/**
 * Ribbon map in the top zone: one dynamic BufferGeometry, one draw call, drawn last
 * without depth test. Quads: backing strip, one capped quad per polyline interval, car marker.
 */
export class RibbonMapMesh {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly map: RibbonMap;
  readonly layout: RibbonLayout;
  private readonly zone: RibbonZone;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;
  private readonly rgb = new Float32Array(18);
  private readonly sx: number;
  private readonly sy: number;
  private quads = 0;

  constructor(
    private readonly cfg: RibbonMapRenderConfig,
    camera: CameraConfig,
    palette: Palette,
    private readonly thresholds: RibbonThresholds,
  ) {
    this.map = createRibbonMap(cfg);
    this.layout = createRibbonLayout(cfg);
    this.zone = {
      width: camera.screenWidth,
      height: Math.round(cfg.zone.height * camera.screenHeight),
      padding: cfg.zone.padding,
      xStretch: cfg.zone.xStretch,
    };
    this.sx = 2 / camera.screenWidth;
    this.sy = 2 / camera.screenHeight;
    writeHex(this.rgb, BACKING, palette.mapBacking);
    writeHex(this.rgb, CLASS0, palette.mapStraight);
    writeHex(this.rgb, CLASS0 + 3, palette.mapEasy);
    writeHex(this.rgb, CLASS0 + 6, palette.mapMedium);
    writeHex(this.rgb, CLASS0 + 9, palette.mapHard);
    writeHex(this.rgb, MARKER, palette.mapMarker);

    const maxQuads = cfg.points + 2;
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
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    // Over the road and sprites: drawn after them (three sorts opaque objects by renderOrder first).
    this.mesh.renderOrder = 10;
    this.mesh.visible = cfg.enabled;
  }

  get enabled(): boolean {
    return this.mesh.visible;
  }

  set enabled(on: boolean) {
    this.mesh.visible = on;
  }

  /** Zone height in px (top of the screen). */
  get zoneHeight(): number {
    return this.zone.height;
  }

  update(track: Track, z: number, speed: number, carX: number): void {
    if (!this.mesh.visible) return;
    const map = this.map;
    const l = this.layout;
    updateRibbonMap(map, track, z, speed, carX, this.cfg, this.thresholds);
    layoutRibbon(l, map, this.zone);
    this.quads = 0;

    const zh = this.zone.height;
    this.rect(0, 0, this.zone.width, zh, BACKING);

    const hw = this.cfg.ribbonWidth / 2;
    for (let i = 0; i + 1 < l.count; i++) {
      const x0 = l.px[i]!;
      const y0 = l.py[i]!;
      const x1 = l.px[i + 1]!;
      const y1 = l.py[i + 1]!;
      let dx = x1 - x0;
      let dy = y1 - y0;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        dx = 0;
        dy = -1;
      } else {
        dx /= d;
        dy /= d;
      }
      // Square caps (extend by hw both ways) close the joints between intervals.
      const ax = x0 - dx * hw;
      const ay = y0 - dy * hw;
      const bx = x1 + dx * hw;
      const by = y1 + dy * hw;
      const nx = -dy * hw;
      const ny = dx * hw;
      const c = Math.max(this.map.cls[i]!, this.map.cls[i + 1]!);
      this.quad(
        ax - nx,
        ay - ny,
        ax + nx,
        ay + ny,
        bx + nx,
        by + ny,
        bx - nx,
        by - ny,
        CLASS0 + c * 3,
      );
    }

    // Car marker at the bottom of the ribbon, shifted by the car's x on the road.
    const m = this.cfg.marker;
    const mx = l.px[0]! + map.carX * m.span;
    const my = l.py[0]!;
    this.rect(mx - m.width / 2, my - m.height / 2, mx + m.width / 2, my + m.height / 2, MARKER);

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

  private rect(l: number, t: number, r: number, b: number, colour: number): void {
    this.quad(l, b, r, b, r, t, l, t, colour);
  }

  // Four corners in screen px (y down), in winding order.
  private quad(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    colour: number,
  ): void {
    const p = this.pos;
    const c = this.col;
    const rgb = this.rgb;
    let i = this.quads * 12;
    const sx = this.sx;
    const sy = this.sy;
    p[i] = x0 * sx - 1;
    p[i + 1] = 1 - y0 * sy;
    p[i + 2] = 0;
    p[i + 3] = x1 * sx - 1;
    p[i + 4] = 1 - y1 * sy;
    p[i + 5] = 0;
    p[i + 6] = x2 * sx - 1;
    p[i + 7] = 1 - y2 * sy;
    p[i + 8] = 0;
    p[i + 9] = x3 * sx - 1;
    p[i + 10] = 1 - y3 * sy;
    p[i + 11] = 0;
    for (let v = 0; v < 4; v++, i += 3) {
      c[i] = rgb[colour]!;
      c[i + 1] = rgb[colour + 1]!;
      c[i + 2] = rgb[colour + 2]!;
    }
    this.quads += 1;
  }
}

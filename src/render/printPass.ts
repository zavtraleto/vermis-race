// Spike: "printed comic / risograph" look behind ?print=1 (docs/research/print-spike.md).
import {
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { writeHex } from './roadMesh';

/** Numbers in src/data/print.json; palette entries are sRGB hex, roles are palette indices. */
export interface PrintConfig {
  scale: number; // canvas backing store = source size x scale (integer)
  palette: string[]; // exactly 16 colours
  paper: number;
  key: number;
  screen: number; // 0 = AM halftone, 1 = stipple, 2 = Bayer 4x4 at source-pixel scale
  cell: number; // AM cell, device px
  angle: number; // AM grid angle, deg
  stippleDot: number; // stipple grain, device px
  misregX: number; // colour plate offset against the key plate, device px
  misregY: number;
  contour: number; // key line where neighbouring source pixels differ by more (0..1 per channel)
  lineWidth: number; // key line width, device px
  hatch: number; // hatch spacing of the darkest tones, device px; 0 = off
  hatchLum: number; // source luma below this gets hatched
  dropout: number; // ink dropout probability inside the picture
  dropoutDot: number; // dropout grain, device px
  dropoutPatch: number; // wavelength of the blotchy dropout density, device px
  dropoutEdge: number; // extra dropout probability at the picture edge
  dropoutEdgeRange: number; // device px from the edge over which the extra fades out
  margin: number; // paper margin, device px
  marginRough: number; // edge displacement amplitude, device px
  marginNoise: number; // edge displacement wavelength, device px
  sky: {
    top: number; // palette index at the top
    horizon: number; // palette index at the horizon
    y0: number; // screen fraction from the top where the ramp starts
    y1: number; // screen fraction where it ends
    bands: number; // tone steps of the ramp
    sun: number; // palette index
    sunX: number; // screen fraction
    sunY: number; // screen fraction from the top
    sunR: number; // fraction of the screen width; 0 = no sun
  };
}

export const PALETTE_SIZE = 16;

const VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform vec2 uOut;
uniform float uScale;
uniform vec3 uPal[${PALETTE_SIZE}];
uniform vec3 uPaper;
uniform vec3 uKey;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSun;
uniform float uScreen;
uniform float uCell;
uniform vec2 uRot;
uniform float uStippleDot;
uniform vec2 uMisreg;
uniform float uContour;
uniform float uLineWidth;
uniform float uHatch;
uniform float uHatchLum;
uniform float uDropout;
uniform float uDropoutDot;
uniform float uDropoutPatch;
uniform float uDropoutEdge;
uniform float uDropoutEdgeRange;
uniform float uMargin;
uniform float uMarginRough;
uniform float uMarginNoise;
uniform vec3 uSkyRamp; // y0, y1 (screen fractions from the top), bands
uniform vec3 uSunDisc; // x, y (fractions, y from the top), radius (fraction of width)

// Hash without sine (Dave Hoskins), stable in screen space.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}

float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}

// Screen threshold in [0, 1): ink the second colour where the tone is above it.
float threshold(vec2 dev) {
  if (uScreen < 0.5) {
    vec2 p = vec2(uRot.x * dev.x - uRot.y * dev.y, uRot.y * dev.x + uRot.x * dev.y) / uCell;
    vec2 f = fract(p) - 0.5;
    return length(f) * 1.41421356;
  }
  if (uScreen < 1.5) return hash12(floor(dev / uStippleDot));
  return bayer4(floor(dev / uScale)) + 0.5 / 16.0;
}

vec4 src(vec2 dev) {
  vec2 px = clamp(floor(dev / uScale), vec2(0.0), uSrcSize - 1.0);
  return texture2D(uSrc, (px + 0.5) / uSrcSize);
}

float diff(vec4 a, vec4 b) {
  vec4 d = abs(a - b);
  return max(max(d.r, d.g), max(d.b, d.a));
}

void main() {
  vec2 dev = floor(gl_FragCoord.xy);
  // Paper margin with a rough, noise-displaced picture edge.
  float edge = min(min(dev.x, uOut.x - 1.0 - dev.x), min(dev.y, uOut.y - 1.0 - dev.y));
  float rough = (valueNoise(dev / max(uMarginNoise, 1.0)) - 0.5) * 2.0 * uMarginRough;
  float d = edge - uMargin + rough;
  if (d < 0.0) {
    gl_FragColor = vec4(uPaper, 1.0);
    return;
  }
  vec3 ink;
  // Key plate: contour of the low-res source, plus hatching of the darkest tones.
  vec4 k = src(dev);
  float edgeDiff = max(diff(k, src(dev + vec2(uLineWidth, 0.0))), diff(k, src(dev + vec2(0.0, uLineWidth))));
  float luma = dot(k.rgb, vec3(0.299, 0.587, 0.114));
  bool hatched = uHatch > 0.0 && k.a > 0.5 && luma < uHatchLum && mod(dev.x + dev.y, uHatch) < 1.0;
  if (edgeDiff > uContour || hatched) {
    ink = uKey;
  } else {
    vec2 cd = dev + uMisreg;
    vec4 c = src(cd);
    if (c.a < 0.5) {
      // Sky: banded vertical tone ramp in halftone, flat sun disc near the horizon.
      float yTop = 1.0 - (cd.y + 0.5) / uOut.y;
      vec2 sunD = vec2((cd.x + 0.5) / uOut.x - uSunDisc.x, (yTop - uSunDisc.y) * uOut.y / uOut.x);
      if (length(sunD) < uSunDisc.z) {
        ink = uSun;
      } else {
        float t = clamp((yTop - uSkyRamp.x) / max(uSkyRamp.y - uSkyRamp.x, 1e-4), 0.0, 1.0);
        float b = max(uSkyRamp.z, 1.0);
        t = (floor(t * b) + 0.5) / b;
        ink = t > threshold(cd) ? uSkyHorizon : uSkyTop;
      }
    } else {
      // Colour plate: two nearest palette colours, one of them by the screen threshold.
      vec3 p1 = uPal[0];
      vec3 p2 = uPal[1];
      float d1 = 1e9;
      float d2 = 1e9;
      for (int i = 0; i < ${PALETTE_SIZE}; i++) {
        vec3 e = c.rgb - uPal[i];
        float dd = dot(e, e);
        if (dd < d1) {
          d2 = d1;
          p2 = p1;
          d1 = dd;
          p1 = uPal[i];
        } else if (dd < d2) {
          d2 = dd;
          p2 = uPal[i];
        }
      }
      vec3 seg = p2 - p1;
      float t = clamp(dot(c.rgb - p1, seg) / max(dot(seg, seg), 1e-6), 0.0, 1.0);
      ink = t > threshold(cd) ? p2 : p1;
    }
  }
  // Ink dropout: paper shows through, denser near the picture edge.
  // Blotchy density: starved patches (x0..2 of the mean) instead of even TV noise.
  float blot = 2.0 * valueNoise(dev / max(uDropoutPatch, 1.0) + 41.0);
  float drop = uDropout * blot * blot + uDropoutEdge * (1.0 - clamp(d / max(uDropoutEdgeRange, 1.0), 0.0, 1.0));
  if (hash12(floor(dev / max(uDropoutDot, 1.0)) + 17.0) < drop) ink = uPaper;
  gl_FragColor = vec4(ink, 1.0);
}
`;

function setPaletteColour(out: Vector3, pal: Float32Array, index: number): void {
  const i = Math.min(PALETTE_SIZE - 1, Math.max(0, Math.round(index))) * 3;
  out.set(pal[i]!, pal[i + 1]!, pal[i + 2]!);
}

/**
 * Renders the game passes into a low-res target (sky = alpha 0) and prints it onto the canvas at
 * an integer scale with one fullscreen quad. Colours are raw sRGB bytes end to end (the caller
 * turns ColorManagement off so the built-in car material writes sRGB too). No allocations per frame.
 */
export class PrintPass {
  readonly target: WebGLRenderTarget;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: ShaderMaterial;
  private readonly pal = new Float32Array(PALETTE_SIZE * 3);
  private scale = 0;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly cfg: PrintConfig,
    private readonly width: number,
    private readonly height: number,
  ) {
    if (cfg.palette.length !== PALETTE_SIZE)
      throw new Error(`print: palette must have ${PALETTE_SIZE} colours`);
    for (let i = 0; i < PALETTE_SIZE; i++) writeHex(this.pal, i * 3, cfg.palette[i]!);
    this.target = new WebGLRenderTarget(width, height, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
    });
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSrc: { value: this.target.texture },
        uSrcSize: { value: new Vector2(width, height) },
        uOut: { value: new Vector2() },
        uScale: { value: 1 },
        uPal: { value: this.pal },
        uPaper: { value: new Vector3() },
        uKey: { value: new Vector3() },
        uSkyTop: { value: new Vector3() },
        uSkyHorizon: { value: new Vector3() },
        uSun: { value: new Vector3() },
        uScreen: { value: 0 },
        uCell: { value: 1 },
        uRot: { value: new Vector2() },
        uStippleDot: { value: 1 },
        uMisreg: { value: new Vector2() },
        uContour: { value: 0 },
        uLineWidth: { value: 1 },
        uHatch: { value: 0 },
        uHatchLum: { value: 0 },
        uDropout: { value: 0 },
        uDropoutDot: { value: 1 },
        uDropoutPatch: { value: 1 },
        uDropoutEdge: { value: 0 },
        uDropoutEdgeRange: { value: 1 },
        uMargin: { value: 0 },
        uMarginRough: { value: 0 },
        uMarginNoise: { value: 1 },
        uSkyRamp: { value: new Vector3() },
        uSunDisc: { value: new Vector3() },
      },
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Resizes the canvas backing store when the tuned scale changes (CSS size untouched). */
  private fitCanvas(): void {
    const s = Math.max(1, Math.round(this.cfg.scale));
    if (s === this.scale) return;
    this.scale = s;
    this.renderer.setSize(this.width * s, this.height * s, false);
  }

  /** Start of the game passes: they draw into the low-res target. */
  begin(): void {
    this.fitCanvas();
    this.renderer.setRenderTarget(this.target);
  }

  /** Prints the target onto the canvas. */
  end(): void {
    const r = this.renderer;
    const cfg = this.cfg;
    const u = this.material.uniforms;
    r.setRenderTarget(null);
    (u.uOut!.value as Vector2).set(this.width * this.scale, this.height * this.scale);
    u.uScale!.value = this.scale;
    setPaletteColour(u.uPaper!.value as Vector3, this.pal, cfg.paper);
    setPaletteColour(u.uKey!.value as Vector3, this.pal, cfg.key);
    setPaletteColour(u.uSkyTop!.value as Vector3, this.pal, cfg.sky.top);
    setPaletteColour(u.uSkyHorizon!.value as Vector3, this.pal, cfg.sky.horizon);
    setPaletteColour(u.uSun!.value as Vector3, this.pal, cfg.sky.sun);
    u.uScreen!.value = cfg.screen;
    u.uCell!.value = cfg.cell;
    const a = (cfg.angle * Math.PI) / 180;
    (u.uRot!.value as Vector2).set(Math.cos(a), Math.sin(a));
    u.uStippleDot!.value = cfg.stippleDot;
    // Sampling at dev + offset shifts the plate by -offset; gl_FragCoord y grows upward, so
    // positive misregX / misregY move the colour plate right / down on screen.
    (u.uMisreg!.value as Vector2).set(-cfg.misregX, cfg.misregY);
    u.uContour!.value = cfg.contour;
    u.uLineWidth!.value = cfg.lineWidth;
    u.uHatch!.value = cfg.hatch;
    u.uHatchLum!.value = cfg.hatchLum;
    u.uDropout!.value = cfg.dropout;
    u.uDropoutDot!.value = cfg.dropoutDot;
    u.uDropoutPatch!.value = cfg.dropoutPatch;
    u.uDropoutEdge!.value = cfg.dropoutEdge;
    u.uDropoutEdgeRange!.value = cfg.dropoutEdgeRange;
    u.uMargin!.value = cfg.margin;
    u.uMarginRough!.value = cfg.marginRough;
    u.uMarginNoise!.value = cfg.marginNoise;
    (u.uSkyRamp!.value as Vector3).set(cfg.sky.y0, cfg.sky.y1, cfg.sky.bands);
    (u.uSunDisc!.value as Vector3).set(cfg.sky.sunX, cfg.sky.sunY, cfg.sky.sunR);
    r.render(this.scene, this.camera);
  }
}

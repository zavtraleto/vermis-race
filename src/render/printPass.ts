// Spike: "printed comic / risograph" look behind ?print=<preset> (docs/research/print-spike.md).
import {
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { CameraConfig } from './projection';
import { writeHex } from './roadMesh';
import type { RollUniform } from './screenRoll';

/** Shared print numbers (src/data/print.json "params"); roles are palette indices. */
export interface PrintParams {
  scale: number; // canvas backing store = source size x scale (integer)
  paper: number;
  key: number;
  screen: number; // 0 = AM halftone, 1 = stipple, 2 = Bayer 4x4 at source-pixel scale
  cell: number; // AM cell, device px
  angle: number; // AM grid angle, deg
  stippleDot: number; // stipple grain, device px
  misregX: number; // colour plate offset against the key plate, device px (> 0 = right)
  misregY: number; // (> 0 = down)
  contour: number; // key line where neighbouring source pixels differ by more (0..1 per channel)
  keyWeight: number; // key line weight, source px (1 or 2)
  hatch: number; // hatch spacing of the darkest tones, device px; 0 = off
  hatchLum: number; // source luma below this gets hatched
  dryInk: number; // mean share of dark solids flecked with the neighbouring palette colour
  dryLum: number; // only solids darker than this luma get dry ink
  dryDot: number; // dry-ink grain, device px
  dryPatch: number; // wavelength of the dry-ink unevenness, device px
  hazeHeight: number; // half-height of the haze band around the horizon, screen fraction
  hazeStrength: number; // tone of horizon-colour dots at the horizon line (0..1)
  dropout: number; // paper dropout everywhere inside the picture
  dropoutDot: number; // dropout grain, device px (clumps of two offset cells)
  dropoutBlot: number; // dropout inside a blotch
  dropoutCover: number; // noise level above which a blotch starts (higher = fewer blotches)
  dropoutPatch: number; // blotch noise wavelength, device px
  dropoutEdge: number; // dropout at the rough picture edge
  dropoutEdgeRange: number; // device px from the edge over which it fades out
  margin: number; // paper margin, device px
  marginRough: number; // edge displacement amplitude, device px
  marginNoise: number; // edge displacement wavelength, device px
}

/** Sky of one preset; the ramp ends at the camera horizon. */
export interface PrintSky {
  top: number; // palette index at the top
  horizon: number; // palette index at the horizon (also the haze dots)
  y0: number; // screen fraction from the top where the ramp starts
  bands: number; // tone steps of the ramp
  sun: number; // palette index
  sunX: number; // screen fraction
  sunY: number; // screen fraction from the top
  sunR: number; // fraction of the screen width; 0 = no sun
}

export interface PrintConfig extends PrintParams {
  palette: string[]; // exactly 16 colours
  sky: PrintSky;
}

export const PALETTE_SIZE = 16;
/** Two-tone segments (body colour -> its shadow) quantised along themselves, not nearest-two. */
export const MAX_PAIRS = 8;

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
uniform vec3 uPairA[${MAX_PAIRS}];
uniform vec3 uPairB[${MAX_PAIRS}];
uniform float uPairN;
uniform vec3 uPaper;
uniform vec3 uKey;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSun;
uniform vec4 uRoll; // R27 picture roll: cos, sin (the shared game-layer uniform)
uniform float uHorizon; // camera horizon, fraction from the top
uniform float uScreen;
uniform float uCell;
uniform vec2 uRot;
uniform float uStippleDot;
uniform vec2 uMisreg;
uniform float uContour;
uniform float uKeyWeight;
uniform float uHatch;
uniform float uHatchLum;
uniform vec4 uDry; // amount, luma, grain, patch
uniform vec2 uHaze; // height, strength
uniform vec4 uDrop; // base, grain, blot, cover
uniform vec3 uDrop2; // patch, edge, edge range
uniform vec3 uMargin; // width, rough, noise
uniform vec2 uSkyRamp; // y0, bands
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

// Clumped grain: union of two half-offset cell grids, so specks are irregular 1-2 cell blobs.
float grain(vec2 dev, float s, float seed) {
  s = max(s, 1.0);
  return min(hash12(floor(dev / s) + seed), hash12(floor((dev + 0.5 * s) / s) + seed + 19.0));
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
    // Area-linear dot: tone t covers ~t of the cell (round dot up to r = 0.5, then the corners).
    float r = length(fract(p) - 0.5);
    return r < 0.5 ? 3.14159265 * r * r : 0.785398 + (r - 0.5) * 1.0367;
  }
  if (uScreen < 1.5) return hash12(floor(dev / uStippleDot));
  return bayer4(floor(dev / uScale)) + 0.5 / 16.0;
}

vec4 srcPx(vec2 px) {
  px = clamp(px, vec2(0.0), uSrcSize - 1.0);
  return texture2D(uSrc, (px + 0.5) / uSrcSize);
}

float diff(vec4 a, vec4 b) {
  vec4 d = abs(a - b);
  return max(max(d.r, d.g), max(d.b, d.a));
}

// Device px -> unrolled screen fractions (x from the left, y from the top), undoing the R27 roll.
vec2 unrolled(vec2 dev) {
  vec2 c = dev + 0.5 - 0.5 * uOut;
  vec2 u = vec2(uRoll.x * c.x + uRoll.y * c.y, -uRoll.y * c.x + uRoll.x * c.y);
  return vec2(0.5 + u.x / uOut.x, 0.5 - u.y / uOut.y);
}

void main() {
  vec2 dev = floor(gl_FragCoord.xy);
  // Paper margin with a rough, noise-displaced picture edge.
  float edge = min(min(dev.x, uOut.x - 1.0 - dev.x), min(dev.y, uOut.y - 1.0 - dev.y));
  float rough = (valueNoise(dev / max(uMargin.z, 1.0)) - 0.5) * 2.0 * uMargin.y;
  float d = edge - uMargin.x + rough;
  if (d < 0.0) {
    gl_FragColor = vec4(uPaper, 1.0);
    return;
  }
  vec3 ink;
  // Key plate: contour of the low-res source (any colour step, always at drawn/sky borders),
  // keyWeight 1 = one source px on one side of the step, 2 = both sides.
  vec2 kp = floor(dev / uScale);
  vec4 k = srcPx(kp);
  float e = max(diff(k, srcPx(kp + vec2(1.0, 0.0))), diff(k, srcPx(kp + vec2(0.0, 1.0))));
  if (uKeyWeight > 1.5)
    e = max(e, max(diff(k, srcPx(kp - vec2(1.0, 0.0))), diff(k, srcPx(kp - vec2(0.0, 1.0)))));
  float luma = dot(k.rgb, vec3(0.299, 0.587, 0.114));
  bool hatched = uHatch > 0.0 && k.a > 0.5 && luma < uHatchLum && mod(dev.x + dev.y, uHatch) < 1.0;
  if (e > uContour || hatched) {
    ink = uKey;
  } else {
    vec2 cd = dev + uMisreg;
    vec4 c = srcPx(floor(cd / uScale));
    vec2 un = unrolled(cd);
    if (c.a < 0.5) {
      // Sky: banded vertical tone ramp in halftone, flat sun disc near the horizon.
      vec2 sunD = vec2(un.x - uSunDisc.x, (un.y - uSunDisc.y) * uOut.y / uOut.x);
      if (length(sunD) < uSunDisc.z) {
        ink = uSun;
      } else {
        float t = clamp((un.y - uSkyRamp.x) / max(uHorizon - uSkyRamp.x, 1e-4), 0.0, 1.0);
        float b = max(uSkyRamp.y, 1.0);
        t = (floor(t * b) + 0.5) / b;
        ink = t > threshold(cd) ? uSkyHorizon : uSkyTop;
      }
    } else {
      // Colour plate. Two-tone bodies lie inside a body -> shadow segment: quantise along it.
      vec3 p1 = uPal[0];
      vec3 p2 = uPal[1];
      float t = 0.0;
      bool pair = false;
      for (int i = 0; i < ${MAX_PAIRS}; i++) {
        if (float(i) >= uPairN) break;
        vec3 a = uPairA[i];
        vec3 seg = uPairB[i] - a;
        float tt = clamp(dot(c.rgb - a, seg) / max(dot(seg, seg), 1e-6), 0.0, 1.0);
        vec3 off = c.rgb - a - seg * tt;
        if (tt > 0.004 && tt < 0.996 && dot(off, off) < 6e-5) {
          p1 = a;
          p2 = uPairB[i];
          t = tt;
          pair = true;
          break;
        }
      }
      if (!pair) {
        // Two nearest palette colours, one of them by the screen threshold.
        float d1 = 1e9;
        float d2 = 1e9;
        for (int i = 0; i < ${PALETTE_SIZE}; i++) {
          vec3 q = c.rgb - uPal[i];
          float dd = dot(q, q);
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
        t = clamp(dot(c.rgb - p1, seg) / max(dot(seg, seg), 1e-6), 0.0, 1.0);
      }
      ink = t > threshold(cd) ? p2 : p1;
      // Dry ink: dark solids flecked with the neighbouring palette colour, unevenly.
      float cl = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      if (!pair && t < 0.02 && cl < uDry.y) {
        float amount = uDry.x * 2.0 * valueNoise(cd / max(uDry.w, 1.0) + 7.0);
        if (grain(cd, uDry.z, 3.0) < amount) ink = p2;
      }
      // Backlight haze: horizon-colour dots growing toward the horizon line.
      float h = uHaze.y * clamp(1.0 - abs(un.y - uHorizon) / max(uHaze.x, 1e-4), 0.0, 1.0);
      if (h > threshold(cd)) ink = uSkyHorizon;
    }
  }
  // Paper dropout: at the rough edge, in a few large soft blotches, and (base) everywhere.
  float blot = smoothstep(uDrop.w, uDrop.w + 0.1, valueNoise(dev / max(uDrop2.x, 1.0) + 205.0));
  float drop = uDrop.x + uDrop.z * blot + uDrop2.y * (1.0 - clamp(d / max(uDrop2.z, 1.0), 0.0, 1.0));
  if (grain(dev, uDrop.y, 17.0) < drop) ink = uPaper;
  gl_FragColor = vec4(ink, 1.0);
}
`;

function paletteIndex(palette: string[], hex: string): number {
  const i = palette.findIndex((p) => p.toLowerCase() === hex.toLowerCase());
  if (i < 0) throw new Error(`print: colour ${hex} is not in the print palette`);
  return i;
}

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

  /** `pairs`: [body, shadow] hex colours of the two-tone bodies (must be palette colours). */
  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly cfg: PrintConfig,
    private readonly width: number,
    private readonly height: number,
    roll: RollUniform,
    private readonly view: CameraConfig,
    pairs: [string, string][],
  ) {
    if (cfg.palette.length !== PALETTE_SIZE)
      throw new Error(`print: palette must have ${PALETTE_SIZE} colours`);
    if (pairs.length > MAX_PAIRS) throw new Error(`print: at most ${MAX_PAIRS} two-tone pairs`);
    for (let i = 0; i < PALETTE_SIZE; i++) writeHex(this.pal, i * 3, cfg.palette[i]!);
    const pairA = new Float32Array(MAX_PAIRS * 3);
    const pairB = new Float32Array(MAX_PAIRS * 3);
    pairs.forEach(([a, b], i) => {
      writeHex(pairA, i * 3, cfg.palette[paletteIndex(cfg.palette, a)]!);
      writeHex(pairB, i * 3, cfg.palette[paletteIndex(cfg.palette, b)]!);
    });
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
        uPairA: { value: pairA },
        uPairB: { value: pairB },
        uPairN: { value: pairs.length },
        uPaper: { value: new Vector3() },
        uKey: { value: new Vector3() },
        uSkyTop: { value: new Vector3() },
        uSkyHorizon: { value: new Vector3() },
        uSun: { value: new Vector3() },
        uRoll: roll,
        uHorizon: { value: 0 },
        uScreen: { value: 0 },
        uCell: { value: 1 },
        uRot: { value: new Vector2() },
        uStippleDot: { value: 1 },
        uMisreg: { value: new Vector2() },
        uContour: { value: 0 },
        uKeyWeight: { value: 1 },
        uHatch: { value: 0 },
        uHatchLum: { value: 0 },
        uDry: { value: new Vector4() },
        uHaze: { value: new Vector2() },
        uDrop: { value: new Vector4() },
        uDrop2: { value: new Vector3() },
        uMargin: { value: new Vector3() },
        uSkyRamp: { value: new Vector2() },
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
    const sky = cfg.sky;
    const u = this.material.uniforms;
    r.setRenderTarget(null);
    (u.uOut!.value as Vector2).set(this.width * this.scale, this.height * this.scale);
    u.uScale!.value = this.scale;
    setPaletteColour(u.uPaper!.value as Vector3, this.pal, cfg.paper);
    setPaletteColour(u.uKey!.value as Vector3, this.pal, cfg.key);
    setPaletteColour(u.uSkyTop!.value as Vector3, this.pal, sky.top);
    setPaletteColour(u.uSkyHorizon!.value as Vector3, this.pal, sky.horizon);
    setPaletteColour(u.uSun!.value as Vector3, this.pal, sky.sun);
    u.uHorizon!.value = this.view.horizon;
    u.uScreen!.value = cfg.screen;
    u.uCell!.value = cfg.cell;
    const a = (cfg.angle * Math.PI) / 180;
    (u.uRot!.value as Vector2).set(Math.cos(a), Math.sin(a));
    u.uStippleDot!.value = cfg.stippleDot;
    // Sampling at dev + offset shifts the plate by -offset; gl_FragCoord y grows upward, so
    // positive misregX / misregY move the colour plate right / down on screen.
    (u.uMisreg!.value as Vector2).set(-cfg.misregX, cfg.misregY);
    u.uContour!.value = cfg.contour;
    u.uKeyWeight!.value = cfg.keyWeight;
    u.uHatch!.value = cfg.hatch;
    u.uHatchLum!.value = cfg.hatchLum;
    (u.uDry!.value as Vector4).set(cfg.dryInk, cfg.dryLum, cfg.dryDot, cfg.dryPatch);
    (u.uHaze!.value as Vector2).set(cfg.hazeHeight, cfg.hazeStrength);
    (u.uDrop!.value as Vector4).set(cfg.dropout, cfg.dropoutDot, cfg.dropoutBlot, cfg.dropoutCover);
    (u.uDrop2!.value as Vector3).set(cfg.dropoutPatch, cfg.dropoutEdge, cfg.dropoutEdgeRange);
    (u.uMargin!.value as Vector3).set(cfg.margin, cfg.marginRough, cfg.marginNoise);
    (u.uSkyRamp!.value as Vector2).set(sky.y0, sky.bands);
    (u.uSunDisc!.value as Vector3).set(sky.sunX, sky.sunY, sky.sunR);
    r.render(this.scene, this.camera);
  }
}

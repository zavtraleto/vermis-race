// R25: build-time converter of a Blender glTF binary (.glb) car into the game's flat model data
// (src/data/models/*.json). No runtime glTF loader: the game imports the JSON.
//
// Usage: node tools/model/glb-to-car.mjs [--in art/cars/nsx/nsx_v1.glb] [--out src/data/models/nsx.json]
//
// Game car space: Y up, front = -Z, +X = the car's right (as CarView in src/render/carModel.ts).
// glTF from Blender: Y up, Blender's -Y front exported as +Z, so game = (-gx, gy, -gz)
// (a half-turn about Y, winding preserved).
// Output: positions as integers in `unit` metres, 9 per triangle (non-indexed), one palette index
// per triangle. `body` = every mesh except the two front wheels; the front wheels are stored
// relative to their pivot (node origin = wheel centre). The rear wheels stay in `body`; their
// triangle ranges there and their pivots are recorded for the R25c spin.
// Deterministic: no timestamps, fixed key order.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const UNIT = 0.001; // metres per integer step
const FRONT_LEFT = 'wheel_FL';
const FRONT_RIGHT = 'wheel_FR';
const REAR_LEFT = 'wheel_RL';
const REAR_RIGHT = 'wheel_RR';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const inPath = resolve(arg('--in', 'art/cars/nsx/nsx_v1.glb'));
const outPath = resolve(arg('--out', 'src/data/models/nsx.json'));

// --- GLB container: 12-byte header, JSON chunk, BIN chunk ---
const file = readFileSync(inPath);
if (file.readUInt32LE(0) !== 0x46546c67) throw new Error(`${inPath}: not a glTF binary`);
let json = null;
let bin = null;
for (let off = 12; off < file.length;) {
  const len = file.readUInt32LE(off);
  const type = file.readUInt32LE(off + 4);
  const data = file.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
  else if (type === 0x004e4942) bin = data;
  off += 8 + len;
}
if (!json || !bin) throw new Error(`${inPath}: missing JSON or BIN chunk`);

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const READERS = {
  5121: [1, (b, o) => b.readUInt8(o)],
  5123: [2, (b, o) => b.readUInt16LE(o)],
  5125: [4, (b, o) => b.readUInt32LE(o)],
  5126: [4, (b, o) => b.readFloatLE(o)],
};

/** Accessor as an array of tuples (arrays of `n` numbers). */
function readAccessor(index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  if ((view.buffer ?? 0) !== 0) throw new Error('only buffer 0 (the BIN chunk) is supported');
  const n = COMPONENTS[acc.type];
  const [size, read] = READERS[acc.componentType];
  const stride = view.byteStride ?? n * size;
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const t = [];
    for (let k = 0; k < n; k++) t.push(read(bin, base + i * stride + k * size));
    out.push(t);
  }
  return out;
}

/** Column-major 4x4 local matrix of a node (matrix or TRS). */
function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/** glTF point -> game car space. */
function toGame(m, p) {
  const gx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const gy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const gz = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  return [-gx, gy, -gz];
}

// --- Colours: emissive when non-zero, else baseColorFactor; linear -> sRGB hex ---
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}
function materialHex(index) {
  const m = json.materials?.[index];
  if (!m) return '#ffffff';
  const e = m.emissiveFactor ?? [0, 0, 0];
  const c =
    e[0] > 0 || e[1] > 0 || e[2] > 0 ? e : (m.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1]);
  return '#' + [0, 1, 2].map((k) => linearToSrgb(c[k]).toString(16).padStart(2, '0')).join('');
}

const palette = [];
function paletteIndex(hex) {
  let i = palette.indexOf(hex);
  if (i < 0) {
    i = palette.length;
    palette.push(hex);
  }
  return i;
}

// --- Walk the scene: world matrices per mesh node ---
const meshNodes = []; // { name, world }
function walk(index, parent) {
  const node = json.nodes[index];
  const world = mul(parent, nodeMatrix(node));
  if (node.mesh !== undefined) meshNodes.push({ name: node.name, node, world });
  for (const c of node.children ?? []) walk(c, world);
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
for (const n of json.scenes[json.scene ?? 0].nodes) walk(n, IDENTITY);

function byName(name) {
  const n = meshNodes.find((m) => m.name === name);
  if (!n) throw new Error(`${inPath}: no mesh node '${name}'`);
  return n;
}

/** Node origin in game space. */
function origin(n) {
  return toGame(n.world, [0, 0, 0]);
}

const q = (v) => Math.round(v / UNIT);
const metres = (v) => Math.round(v / UNIT) / Math.round(1 / UNIT);

/** Triangles of a mesh node appended to `part`, positions relative to `pivot` (game space). */
function addMesh(part, n, pivot) {
  const mesh = json.meshes[n.node.mesh];
  for (const prim of mesh.primitives) {
    if ((prim.mode ?? 4) !== 4) throw new Error(`${n.name}: only triangle lists are supported`);
    const pos = readAccessor(prim.attributes.POSITION);
    const idx =
      prim.indices !== undefined
        ? readAccessor(prim.indices).map((t) => t[0])
        : pos.map((_, i) => i);
    const color = paletteIndex(materialHex(prim.material));
    for (let t = 0; t + 2 < idx.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const g = toGame(n.world, pos[idx[t + k]]);
        part.positions.push(q(g[0] - pivot[0]), q(g[1] - pivot[1]), q(g[2] - pivot[2]));
      }
      part.colors.push(color);
    }
  }
}

const fl = byName(FRONT_LEFT);
const fr = byName(FRONT_RIGHT);
const pivotFL = origin(fl);
const pivotFR = origin(fr);
const zero = [0, 0, 0];
const body = { positions: [], colors: [] };
const rlNode = byName(REAR_LEFT);
const rrNode = byName(REAR_RIGHT);
const ranges = {}; // R25c: [first triangle, triangle count] of each rear wheel inside body
for (const n of meshNodes) {
  if (n === fl || n === fr) continue;
  const first = body.colors.length;
  addMesh(body, n, zero);
  if (n === rlNode) ranges.wheelRL = [first, body.colors.length - first];
  if (n === rrNode) ranges.wheelRR = [first, body.colors.length - first];
}
const wheelFL = { positions: [], colors: [] };
const wheelFR = { positions: [], colors: [] };
addMesh(wheelFL, fl, pivotFL);
addMesh(wheelFR, fr, pivotFR);

const rl = origin(rlNode);
const rr = origin(rrNode);

const out = {
  unit: UNIT,
  palette,
  parts: { body, wheelFL, wheelFR },
  pivots: { wheelFL: pivotFL.map(metres), wheelFR: pivotFR.map(metres) },
  rearAxleZ: metres((rl[2] + rr[2]) / 2),
  rearWheelX: metres((Math.abs(rl[0]) + Math.abs(rr[0])) / 2),
  rearWheels: {
    pivots: { wheelRL: rl.map(metres), wheelRR: rr.map(metres) },
    ranges,
  },
};

// One array per line keeps the file diffable without a line per number.
const line = (v) => JSON.stringify(v);
const partText = (p) =>
  `{\n      "positions": ${line(p.positions)},\n      "colors": ${line(p.colors)}\n    }`;
const text =
  '{\n' +
  `  "unit": ${line(out.unit)},\n` +
  `  "palette": ${line(out.palette)},\n` +
  '  "parts": {\n' +
  `    "body": ${partText(body)},\n` +
  `    "wheelFL": ${partText(wheelFL)},\n` +
  `    "wheelFR": ${partText(wheelFR)}\n` +
  '  },\n' +
  `  "pivots": { "wheelFL": ${line(out.pivots.wheelFL)}, "wheelFR": ${line(out.pivots.wheelFR)} },\n` +
  `  "rearAxleZ": ${line(out.rearAxleZ)},\n` +
  `  "rearWheelX": ${line(out.rearWheelX)},\n` +
  `  "rearWheels": ${line(out.rearWheels)}\n` +
  '}\n';
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, text);
const tri = (p) => p.colors.length;
console.log(
  `${outPath}: body ${tri(body)} tris, wheelFL ${tri(wheelFL)}, wheelFR ${tri(wheelFR)}, ` +
    `palette ${palette.length}, ${text.length} bytes`,
);

// Spike: ?print=1 frames read straight from the canvas (1080x1920 backing store) + palette check
// + live frame times. Not part of smoke or shots.
// Usage: node tools/spike/print-shots.mjs [--no-build] [--gpu]
//   --gpu: launch Chromium without the SwiftShader flags (hardware GPU if the machine allows it).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = resolve(root, 'docs', 'research', 'print-spike');
mkdirSync(out, { recursive: true });
const palette = JSON.parse(
  readFileSync(resolve(root, 'src', 'data', 'print.json'), 'utf8'),
).palette.map((h) => h.toLowerCase());
// name -> [scenario, print preset, tune diff]
const SHOTS = {
  'p1-roadside-am': ['roadside', '1', {}],
  'p1-drift-right-am': ['drift-right', '1', {}],
  'p1-traffic-am': ['traffic', '1', {}],
  'p1-curve-left-am': ['curve-left', '1', {}],
  'p1-roadside-stipple': ['roadside', '1', { 'print.screen': 1 }],
  'p1-roadside-bayer': ['roadside', '1', { 'print.screen': 2 }],
  'p2-roadside-am': ['roadside', '2', {}],
  'p2-drift-right-am': ['drift-right', '2', {}],
  'p2-traffic-am': ['traffic', '2', {}],
};

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

if (!process.argv.includes('--no-build')) {
  const r = spawnSync('npx vite build', { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const PORT = await freePort();
const server = spawn(`npx vite preview --port ${PORT} --strictPort`, {
  cwd: root,
  shell: true,
  stdio: 'ignore',
});
const stop = () => {
  if (process.platform === 'win32') spawnSync(`taskkill /pid ${server.pid} /T /F`, { shell: true });
  else server.kill();
};
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const gpu = process.argv.includes('--gpu');
const browser = await chromium.launch({
  args: gpu
    ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const report = { gpu, shots: {}, live: {} };
let failed = false;

async function open(query, waitFor) {
  const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?${query}`);
  await page.waitForFunction(waitFor, null, { timeout: 60_000 });
  return { page, errors };
}

try {
  for (const [name, [scenario, preset, diff]] of Object.entries(SHOTS)) {
    const tune = encodeURIComponent(JSON.stringify(diff));
    const { page, errors } = await open(
      `scenario=${scenario}&seed=1&print=${preset}&tune=${tune}`,
      () => window.__game?.done === true,
    );
    // Re-render the same state and read the drawing buffer in the same task (before compositing).
    const r = await page.evaluate(() => {
      const c = document.getElementById('game');
      const gl = c.getContext('webgl2');
      window.__spikeFrame();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const counts = new Map();
      for (let i = 0; i < px.length; i += 4) {
        const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      // Flip to top-down and encode PNG through a 2D canvas.
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++)
        img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      ctx.putImageData(img, 0, 0);
      const colours = [...counts.entries()].map(([k, n]) => [
        '#' + k.toString(16).padStart(6, '0'),
        n,
      ]);
      return {
        w,
        h,
        colours,
        png: cv.toDataURL('image/png').split(',')[1],
        info: window.__game.rendererInfo(),
      };
    });
    writeFileSync(resolve(out, `${name}.png`), Buffer.from(r.png, 'base64'));
    const foreign = r.colours.filter(([hex]) => !palette.includes(hex));
    const ok = r.colours.length <= 16 && foreign.length === 0 && errors.length === 0;
    if (!ok) failed = true;
    report.shots[name] = {
      size: `${r.w}x${r.h}`,
      unique: r.colours.length,
      foreign,
      info: r.info,
      errors,
    };
    console.log(
      `${name}.png ${r.w}x${r.h} unique=${r.colours.length} notInPalette=${foreign.length}` +
        ` calls=${r.info.calls} tris=${r.info.triangles} ${ok ? 'OK' : 'FAIL'}`,
      foreign.length ? JSON.stringify(foreign.slice(0, 10)) : '',
      errors.length ? errors : '',
    );
    await page.close();
  }
  // Timed frames (vsync-free): N full renders, each synced by a 1 px readPixels (as in E1).
  report.timed = {};
  for (const [name, query] of [
    ['timed-print', 'scenario=traffic&seed=1&print=1'],
    ['timed-plain', 'scenario=traffic&seed=1'],
  ]) {
    const { page, errors } = await open(query, () => window.__game?.done === true);
    const r = await page.evaluate(() => {
      const gl = document.getElementById('game').getContext('webgl2');
      const px = new Uint8Array(4);
      const N = 200;
      for (let i = 0; i < 20; i++) window.__spikeFrame();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        window.__spikeFrame();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return { msPerFrame: (performance.now() - t0) / N, info: window.__game.rendererInfo() };
    });
    report.timed[name] = { ...r, errors };
    if (errors.length) failed = true;
    console.log(name, JSON.stringify(report.timed[name]));
    await page.close();
  }
  // Live run with the HUD on the default track (traffic pool), ~8 s.
  for (const [name, query] of [
    ['live-print', 'seed=1&scenario=empty&hud=1&print=1'],
    ['live-plain', 'seed=1&scenario=empty&hud=1'],
  ]) {
    const { page, errors } = await open(query, () => window.__game?.frames >= 30);
    let maxCalls = 0;
    for (let k = 0; k < 16; k++) {
      await page.waitForTimeout(500);
      maxCalls = Math.max(
        maxCalls,
        (await page.evaluate(() => window.__game.rendererInfo())).calls,
      );
    }
    const stats = await page.evaluate(() => window.__game.frameStats());
    const info = await page.evaluate(() => window.__game.rendererInfo());
    const frames = await page.evaluate(() => window.__game.frames);
    const renderer = await page.evaluate(() => {
      const gl = document.getElementById('game').getContext('webgl2');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    report.live[name] = { stats, info, maxCalls, frames, renderer, errors };
    if (errors.length) failed = true;
    console.log(name, JSON.stringify(report.live[name]));
    await page.close();
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  stop();
}
writeFileSync(
  resolve(out, gpu ? 'report-gpu.json' : 'report.json'),
  JSON.stringify(report, null, 2),
);
process.exit(failed ? 1 : 0);

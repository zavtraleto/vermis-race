// Spike E1: pseudo-3D vs ?render=3d screenshot pairs + budget runs. Not part of smoke or shots.
// Usage: node tools/spike/render3d-shots.mjs [--no-build]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = resolve(root, 'docs', 'research', 'render-3d');
mkdirSync(out, { recursive: true });
const SCENARIOS = ['straight', 'curve-left', 'drift-right', 'drift-camera', 'traffic', 'roadside', 'hill-crest'];
// Extra 3D variants: name -> [scenario, tune diff].
const TELE = {
  'render3d.camera.height': 200,
  'render3d.camera.distance': 1000,
  'render3d.camera.fovDeg': 45,
  'render3d.camera.horizon': 0.6,
};
const VARIANTS = {
  'curve-left-k0015': ['curve-left', { 'render3d.k3dCurve': 0.0015 }],
  'curve-left-k003': ['curve-left', { 'render3d.k3dCurve': 0.003 }],
  'curve-left-k005-dd100': ['curve-left', { 'render3d.k3dCurve': 0.005, 'render3d.drawDistance': 100 }],
  'drift-right-k0015': ['drift-right', { 'render3d.k3dCurve': 0.0015 }],
  'drift-right-k003': ['drift-right', { 'render3d.k3dCurve': 0.003 }],
  'straight-tele': ['straight', TELE],
  'drift-right-tele': ['drift-right', TELE],
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
const server = spawn(`npx vite preview --port ${PORT} --strictPort`, { cwd: root, shell: true, stdio: 'ignore' });
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

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const report = { shots: {}, live: {} };
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

async function shot(name, query) {
  const { page, errors } = await open(query, () => window.__game?.done === true);
  await page.screenshot({ path: resolve(out, `${name}.png`) });
  const info = await page.evaluate(() => window.__game.rendererInfo());
  report.shots[name] = { info, errors };
  if (errors.length) failed = true;
  console.log(name, JSON.stringify(info), errors.length ? errors : '');
  await page.close();
}

try {
  for (const s of SCENARIOS) {
    await shot(`${s}-pseudo`, `scenario=${s}&seed=1&frames=60`);
    await shot(`${s}-3d`, `scenario=${s}&seed=1&frames=60&render=3d`);
  }
  for (const [name, [s, diff]] of Object.entries(VARIANTS)) {
    const tune = encodeURIComponent(JSON.stringify(diff));
    await shot(`${name}-3d`, `scenario=${s}&seed=1&frames=60&render=3d&tune=${tune}`);
  }
  // Dev panel with the render3d sliders: opens without errors, a slider moves the camera.
  {
    const { page, errors } = await open('seed=1&scenario=straight&render=3d&dev=1&frames=60', () => window.__game?.done === true);
    const r = await page.evaluate(() => {
      const t = window.__game.tunables;
      return { k: t.get('render3d.k3dCurve'), set: t.set('render3d.camera.height', 500) };
    });
    await page.screenshot({ path: resolve(out, 'dev-panel-3d.png') });
    report.devPanel = { ...r, errors };
    if (errors.length || r.k === undefined) failed = true;
    console.log('dev panel', JSON.stringify(report.devPanel));
    await page.close();
  }
  // Timed frames: N full frames (update + render + GPU sync by a 1 px readPixels) on fixed scenes.
  report.timed = {};
  for (const s of ['traffic-20', 'stress', 'drift-camera']) {
    for (const mode of ['pseudo', '3d']) {
      const q = `scenario=${s}&seed=1&ticks=1&render=${mode}`;
      const { page, errors } = await open(q, () => window.__game?.done === true);
      const r = await page.evaluate(() => {
        const gl = document.getElementById('game').getContext('webgl2');
        const px = new Uint8Array(4);
        const N = 300;
        for (let i = 0; i < 20; i++) window.__spikeFrame();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
          window.__spikeFrame();
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        }
        const ms = (performance.now() - t0) / N;
        return { ms, info: window.__game.rendererInfo() };
      });
      if (s === 'traffic-20') await page.screenshot({ path: resolve(out, `traffic-20-${mode}.png`) });
      report.timed[`${s}-${mode}`] = { ...r, errors };
      if (errors.length) failed = true;
      console.log('timed', s, mode, JSON.stringify(r), errors.length ? errors : '');
      await page.close();
    }
  }
  // Live runs: default track with the full traffic pool (worst case for cars) and the stress scenario.
  for (const [name, query] of [
    ['default-pseudo', 'seed=1&scenario=empty&hud=1'],
    ['default-3d', 'seed=1&scenario=empty&hud=1&render=3d'],
    ['stress-pseudo', 'seed=1&scenario=stress'],
    ['stress-3d', 'seed=1&scenario=stress&render=3d'],
  ]) {
    const { page, errors } = await open(query, () => window.__game?.frames >= 30);
    // Sample over ~600 frames; keep the frame with the most traffic in view.
    let worst = null;
    let maxCalls = 0;
    let maxTris = 0;
    for (let k = 0; k < 20; k++) {
      await page.waitForTimeout(500);
      const info = await page.evaluate(() => window.__game.rendererInfo());
      maxCalls = Math.max(maxCalls, info.calls);
      maxTris = Math.max(maxTris, info.triangles);
      if (worst === null || info.traffic > worst.traffic) worst = info;
    }
    const stats = await page.evaluate(() => window.__game.frameStats());
    const frames = await page.evaluate(() => window.__game.frames);
    if (name === 'default-3d') await page.screenshot({ path: resolve(out, 'live-traffic-3d.png') });
    if (name === 'default-pseudo') await page.screenshot({ path: resolve(out, 'live-traffic-pseudo.png') });
    report.live[name] = { worst, maxCalls, maxTris, stats, frames, errors };
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
writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);

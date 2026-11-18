// Usage: npm run shot -- <scenario> [--update] [--no-build]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { compare } from 'odiff-bin';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const update = args.includes('--update');
const noBuild = args.includes('--no-build');
const scenario = args.find((a) => !a.startsWith('--'));
if (!scenario) {
  console.error('usage: npm run shot -- <scenario> [--update] [--no-build]');
  process.exit(2);
}
const THRESHOLD_PCT = 0.5;
// Free port picked dynamically: a fixed port may be held by another worktree's preview server, and with
// --strictPort our own server would then die silently while the screenshot is taken from the foreign build.
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
const PORT = Number(process.env.SHOT_PORT) || (await freePort());
const shots = resolve(root, 'shots');
mkdirSync(shots, { recursive: true });
const base = resolve(shots, `${scenario}.png`);
const actual = resolve(shots, `${scenario}.actual.png`);
const diff = resolve(shots, `${scenario}.diff.png`);

if (!noBuild || !existsSync(resolve(root, 'dist'))) {
  const r = spawnSync('npx vite build', { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Unique marker inside dist/: proves the server answering on PORT serves exactly this build of ours.
const markerName = '.shot-marker';
const marker = randomUUID();
writeFileSync(resolve(root, 'dist', markerName), marker);
let serverExit = null;
const server = spawn(`npx vite preview --port ${PORT} --strictPort`, {
  cwd: root,
  shell: true,
  stdio: 'ignore',
});
server.on('exit', (code) => {
  serverExit = code;
});
const stopServer = () => {
  rmSync(resolve(root, 'dist', markerName), { force: true });
  if (process.platform === 'win32') spawnSync(`taskkill /pid ${server.pid} /T /F`, { shell: true });
  else server.kill();
};

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (serverExit !== null) throw new Error(`vite preview exited early (code ${serverExit}); port ${PORT} busy?`);
    try {
      const res = await fetch(`http://localhost:${PORT}/${markerName}`);
      if (res.ok) {
        if ((await res.text()).trim() === marker) return;
        throw new Error(`server on port ${PORT} is not our build (marker mismatch): foreign server?`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('marker mismatch')) throw e;
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('preview server did not start');
}

let exitCode = 0;
try {
  await waitForServer();
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(
    `http://localhost:${PORT}/?scenario=${encodeURIComponent(scenario)}&seed=1&frames=60`,
  );
  await page.waitForFunction(() => window.__game?.done === true, null, { timeout: 30_000 });
  const isBaseline = update || !existsSync(base);
  await page.screenshot({ path: isBaseline ? base : actual });
  await browser.close();
  if (errors.length) {
    console.error('page errors:', errors);
    exitCode = 1;
  } else if (isBaseline) {
    console.log(
      `${update ? 'baseline updated' : 'no baseline found, saved NEW baseline'}: shots/${scenario}.png`,
    );
  } else {
    const res = await compare(base, actual, diff, { threshold: 0.1, antialiasing: true });
    let pct = 0;
    if (!res.match) pct = res.reason === 'pixel-diff' ? res.diffPercentage : 100;
    console.log(`diff ${scenario}: ${pct.toFixed(4)}% (limit ${THRESHOLD_PCT}%)`);
    if (pct > THRESHOLD_PCT) {
      console.error(`FAIL: see shots/${scenario}.diff.png`);
      exitCode = 1;
    }
  }
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  stopServer();
}
process.exit(exitCode);

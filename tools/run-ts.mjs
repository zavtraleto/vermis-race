// Runs a TypeScript tool through Vite's module runner (vite is already a direct dependency;
// no tsx/ts-node/vite-node in the repo). Usage: node tools/run-ts.mjs <tool.ts> [args...].
// The tool exports main(io) and returns an exit code. All file and process I/O lives here,
// so the TS tools stay pure and need no @types/node.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runnerImport } from 'vite';

const [entry, ...argv] = process.argv.slice(2);
if (!entry) {
  console.error('usage: node tools/run-ts.mjs <tool.ts> [args...]');
  process.exit(2);
}
const io = {
  argv,
  read: (p) => readFileSync(resolve(p), 'utf8'),
  write: (p, text) => writeFileSync(resolve(p), text),
  exists: (p) => existsSync(resolve(p)),
  list: (dir) => readdirSync(resolve(dir)).sort(),
  log: (s) => console.log(s),
};
const { module } = await runnerImport(resolve(entry), { configFile: false, logLevel: 'error' });
const code = await module.main(io);
process.exit(typeof code === 'number' ? code : 0);

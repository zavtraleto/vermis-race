// Claude Code hooks for this repo. Usage: node scripts/hook.mjs <format|guard>
// Reads the hook payload (JSON) from stdin. Exit 2 + stderr = block and tell the agent why.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const input = payload.tool_input ?? {};

// The command runs in payload.cwd, which may be a git worktree of this repo with its own branch.
// Judge the branch and run checks there, not in the checkout this script happens to live in.
function findRoot() {
  const cwd = typeof payload.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : scriptRoot;
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return top ? resolve(top) : scriptRoot;
  } catch {
    return scriptRoot;
  }
}
const root = findRoot();

function run(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryRun(cmd) {
  try {
    return { ok: true, out: run(cmd) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
function block(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}
const hasDeps = existsSync(resolve(root, 'node_modules'));

if (mode === 'format') {
  // After Edit/Write of a TS file: prettier + eslint --fix on that file only.
  const file = input.file_path;
  if (!file || !/\.(ts|tsx|mts)$/.test(file) || !hasDeps) process.exit(0);
  const rel = relative(root, resolve(file));
  if (rel.startsWith('..') || rel.includes('node_modules')) process.exit(0);
  tryRun(`npx prettier --write "${rel}"`);
  const lint = tryRun(`npx eslint --fix "${rel}"`);
  if (!lint.ok) {
    block(`eslint reports problems in ${rel} after auto-fix. Fix them before going on:\n${lint.out.slice(-2000)}`);
  }
  process.exit(0);
}

if (mode === 'guard') {
  const cmd = String(input.command ?? '');
  if (!/\bgit\b/.test(cmd)) process.exit(0);

  const isCommit = /\bgit\b[^|;&]*\bcommit\b/.test(cmd);
  const isPush = /\bgit\b[^|;&]*\bpush\b/.test(cmd);
  if (!isCommit && !isPush) process.exit(0);

  // One-off override: the author asked in chat for this exact action on main.
  // The agent must never add this marker on its own initiative. Force push stays forbidden.
  const authorApproved = /\bAUTHOR_APPROVED\b/.test(cmd);

  const head = tryRun('git rev-parse --verify HEAD');
  const branch = tryRun('git branch --show-current').out.trim();

  if (isPush) {
    if (/(\s--force(?!-with-lease)\b|\s-f\b|\s\+\S+)/.test(cmd)) {
      block('Force push is forbidden in this repo. Push normally, or ask the author if history really must be rewritten.');
    }
    // Tokens after "push" that are not flags: [remote, refspec...]
    const pushArgs = cmd
      .slice(cmd.search(/\bpush\b/) + 4)
      .split(/[|;&]/)[0]
      .trim()
      .split(/\s+/)
      .filter((t) => t && !t.startsWith('-'));
    const refspecs = pushArgs.slice(1);
    const namesMain = refspecs.some((r) => r === 'main' || r.endsWith(':main'));
    const implicitMain = branch === 'main' && refspecs.length === 0;
    if ((namesMain || implicitMain) && !authorApproved) {
      block('Pushing main is forbidden: main moves only through merges done by the author. Push your feature branch instead.');
    }
  }

  if (isCommit) {
    // The very first commit of the repo is allowed on main.
    if (branch === 'main' && head.ok && !authorApproved) {
      block('Direct commits to main are forbidden. Create a branch first: git switch -c feat/<short-name>, then commit there.');
    }
    if (hasDeps && existsSync(resolve(root, 'package.json'))) {
      const check = tryRun('npm run check --silent');
      if (!check.ok) {
        block(`npm run check fails, so the commit is refused. Fix type and lint errors first:\n${check.out.slice(-3000)}`);
      }
    }
  }
  process.exit(0);
}

process.exit(0);

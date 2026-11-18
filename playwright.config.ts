import { defineConfig } from '@playwright/test';

// Port is overridable (SMOKE_PORT) so parallel worktrees can run smoke side by side. reuseExistingServer:false
// makes Playwright fail loudly if the port is taken instead of testing someone else's build.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const PORT = Number(env?.SMOKE_PORT) || 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 360, height: 640 },
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

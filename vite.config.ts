import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: true },
  preview: { host: true },
  test: { include: ['tests/sim/**/*.test.ts'] },
});

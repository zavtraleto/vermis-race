import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base: the same build works at the domain root (vite preview) and under /<repo>/ on GitHub Pages.
  base: './',
  server: { host: true },
  preview: { host: true },
  test: { include: ['tests/{sim,app,render,ui,input,dev}/**/*.test.ts'] },
});

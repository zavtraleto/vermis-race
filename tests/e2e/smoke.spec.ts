import { expect, test } from '@playwright/test';

test('prod build renders 120 frames within budget, no errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto('/?seed=1&scenario=empty');
  await page.waitForFunction(() => window.__game.frames >= 120, null, { timeout: 30_000 });

  const info = await page.evaluate(() => window.__game.rendererInfo());
  const gameErrors = await page.evaluate(() => window.__game.errors);

  expect(problems).toEqual([]);
  expect(gameErrors).toEqual([]);
  expect(info.calls).toBeLessThanOrEqual(12);
  expect(info.triangles).toBeLessThanOrEqual(20000);
});

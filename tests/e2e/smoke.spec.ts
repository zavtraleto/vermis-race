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

test('sim ticks advance across rendered frames', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto('/?seed=1&scenario=empty');
  await page.waitForFunction(() => window.__game.frames >= 30, null, { timeout: 30_000 });
  const t1 = await page.evaluate(() => window.__game.tick);
  await page.waitForFunction(() => window.__game.frames >= 90, null, { timeout: 30_000 });
  const t2 = await page.evaluate(() => window.__game.tick);
  const speed = await page.evaluate(() => window.__game.state().cars[0]!.speed);

  expect(t1).toBeGreaterThan(0);
  expect(t2).toBeGreaterThan(t1);
  expect(speed).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});

test('?ticks=120 reproduces the golden example', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto('/?seed=1&scenario=empty&ticks=120');
  await page.waitForFunction(() => window.__game.done, null, { timeout: 30_000 });
  const tick = await page.evaluate(() => window.__game.tick);
  const car = await page.evaluate(() => window.__game.state().cars[0]!);

  expect(tick).toBe(120);
  expect(Math.abs(car.speed - 0.22)).toBeLessThan(1e-9);
  expect(Math.abs(car.z - 6.655)).toBeLessThan(1e-6);
  expect(problems).toEqual([]);
});

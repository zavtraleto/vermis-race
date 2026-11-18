import { expect, test, type Page } from '@playwright/test';

function collectProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

test('normal scene: road + sprites within 4 draw calls, frame stats collected', async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.goto('/?seed=1&scenario=empty');
  await page.waitForFunction(() => window.__game.frames >= 120, null, { timeout: 30_000 });

  const info = await page.evaluate(() => window.__game.rendererInfo());
  const stats = await page.evaluate(() => window.__game.frameStats());

  expect(problems).toEqual([]);
  expect(info.calls).toBeLessThanOrEqual(4);
  expect(info.instances).toBeGreaterThan(0); // player car + posts
  expect(stats.samples).toBeGreaterThan(0);
  expect(stats.p50).toBeGreaterThan(0);
  expect(stats.p99).toBeGreaterThanOrEqual(stats.p50);
  expect(stats.max).toBeGreaterThanOrEqual(stats.p99);
  // HUD overlay only with ?hud=1.
  expect(await page.locator('#hud-frame').count()).toBe(0);
});

test('stress scenario: 400 instances, live loop, HUD shows on ?hud=1', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto('/?seed=1&scenario=stress&hud=1');
  await page.waitForFunction(() => window.__game.frames >= 60, null, { timeout: 30_000 });

  const info = await page.evaluate(() => window.__game.rendererInfo());
  const tick = await page.evaluate(() => window.__game.tick);

  expect(problems).toEqual([]);
  expect(info.instances).toBe(400);
  expect(info.calls).toBeLessThanOrEqual(4);
  expect(tick).toBeGreaterThan(0);
  await expect(page.locator('#hud-frame')).toContainText('p99');
});

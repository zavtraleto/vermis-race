import { expect, test, type Page } from '@playwright/test';

// T4 dev tuning panel. Sim driven only by stepTicks (?frames=0 stops the rAF loop).
const TICKS = 60; // 0.5 s of sim: far below vmax with the default and the doubled accel

function collect(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/?seed=1&frames=0${query}`);
  await page.waitForFunction(() => window.__game.done, null, { timeout: 30_000 });
}

async function speedAfter(page: Page, ticks: number): Promise<number> {
  await page.evaluate((n) => window.__game.stepTicks(n), ticks);
  return page.evaluate(() => window.__game.state().cars[0]!.speed);
}

test('panel is absent without ?dev=1 and present with it', async ({ page }) => {
  const problems = collect(page);
  await open(page, '');
  await expect(page.locator('#dev-panel')).toHaveCount(0);
  await open(page, '&dev=1');
  await expect(page.locator('#dev-panel')).toBeVisible();
  await expect(page.locator('#dev-panel [data-path="car.accel"]')).toHaveCount(1);
  await expect(
    page.locator('#dev-panel [data-path="hypotheses.H2_touchSteering"] select'),
  ).toHaveCount(1);
  expect(problems).toEqual([]);
});

test('2x accel via __game.tunables gives a higher speed after the same ticks; survives reload', async ({
  page,
}) => {
  const problems = collect(page);
  await open(page, '');
  const base = await speedAfter(page, TICKS);

  await open(page, '&dev=1');
  const def = (await page.evaluate(() => window.__game.tunables.get('car.accel'))) as number;
  const written = await page.evaluate((v) => window.__game.tunables.set('car.accel', v), 2 * def);
  expect(written).toBe(2 * def);
  const tuned = await speedAfter(page, TICKS);
  expect(tuned).toBeGreaterThan(base * 1.5);
  // The panel readout follows a set() from outside.
  await expect(page.locator('#dev-panel [data-path="car.accel"] button').last()).toHaveText(
    (2 * def).toFixed(2),
  );

  await page.reload();
  await page.waitForFunction(() => window.__game.done, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__game.tunables.diff())).toEqual({
    'car.accel': 2 * def,
  });
  expect(await speedAfter(page, TICKS)).toBeCloseTo(tuned, 9);

  // Reset from the panel clears the saved diff.
  await page.locator('#dev-panel button', { hasText: 'Reset' }).click();
  expect(await page.evaluate(() => window.__game.tunables.diff())).toEqual({});
  await page.reload();
  await page.waitForFunction(() => window.__game.done, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__game.tunables.diff())).toEqual({});
  expect(problems).toEqual([]);
});

test('?tune= applies a url-encoded diff', async ({ page }) => {
  const problems = collect(page);
  const diff = { 'car.grip': 20, 'camera.fovDeg': 90, 'hypotheses.H1_driftBoost': 'B' };
  await open(page, `&tune=${encodeURIComponent(JSON.stringify(diff))}`);
  expect(await page.evaluate(() => window.__game.tunables.diff())).toEqual(diff);
  expect(await page.evaluate(() => window.__game.tunables.get('car.grip'))).toBe(20);
  expect(problems).toEqual([]);
});

test('steering ignores a drag that starts on the open panel', async ({ page }) => {
  const problems = collect(page);
  await open(page, '&dev=1');
  // Whole screen is the steering zone, so only the panel guard can stop the drag.
  await page.evaluate(() => window.__game.tunables.set('input.touch.steerZoneFrac', 1));
  const steerAfterDrag = async (x: number, y: number): Promise<number> => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 4 });
    await page.evaluate(() => window.__game.stepTicks(1));
    const steer = await page.evaluate(() => window.__game.input().steer);
    await page.mouse.up();
    return steer;
  };
  // A section header of the panel (top of the screen).
  const header = await page.locator('#dev-panel summary').first().boundingBox();
  expect(header).not.toBeNull();
  expect(await steerAfterDrag(header!.x + 20, header!.y + header!.height / 2)).toBe(0);
  // Control: the same drag on the road below the panel steers.
  expect(await steerAfterDrag(100, 600)).toBeGreaterThan(0);

  // Collapsed: only the small tab remains, the rest of the screen steers again.
  await page.locator('#dev-panel button', { hasText: '▴' }).click();
  await expect(page.locator('#dev-tab')).toBeVisible();
  expect(await steerAfterDrag(header!.x + 20, header!.y + header!.height / 2)).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});

test('backquote toggles the panel', async ({ page }) => {
  await open(page, '');
  await expect(page.locator('#dev-panel')).toHaveCount(0);
  await page.keyboard.press('Backquote');
  await expect(page.locator('#dev-panel')).toBeVisible();
  await page.keyboard.press('Backquote');
  await expect(page.locator('#dev-panel')).toBeHidden();
});

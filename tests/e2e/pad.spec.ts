import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// R214 visible control pad: shown during the race, never intercepts touches, finger dot follows
// the active pointer and hides without one; not shown in the menu.

function collect(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

test('R214: pad visible in the race, does not take pointer events, dot follows the held mouse', async ({
  page,
}) => {
  const problems = collect(page);
  await page.goto('/?seed=1&scenario=empty'); // scenario skips the menu (R95)
  await page.waitForFunction(() => window.__game.frames >= 10, null, { timeout: 30_000 });

  const pad = page.getByTestId('pad');
  const dot = page.getByTestId('pad-dot');
  await expect(pad).toBeVisible();
  expect(await pad.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  // R214(b): no finger -> no dot
  await expect(dot).toBeHidden();

  // A point inside the R202 rectangle: centre + (0.3 half-width, 0.2 half-height down).
  const box = await page.locator('#game').boundingBox();
  expect(box).not.toBeNull();
  const px = box!.x + box!.width / 2 + 0.3 * (box!.width / 2);
  const py = box!.y + box!.height / 2 + 0.2 * (box!.height / 2);

  await page.mouse.move(px, py);
  await page.mouse.down();
  await expect(dot).toBeVisible();
  // The press reached the game through the pad (pointer-events none): steer > 0 right of centre.
  await page.waitForFunction(() => window.__game.input().steer > 0, null, { timeout: 5_000 });
  const d = await dot.boundingBox();
  expect(d).not.toBeNull();
  const dx = d!.x + d!.width / 2 - px;
  const dy = d!.y + d!.height / 2 - py;
  expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(6);

  await page.mouse.up();
  await expect(dot).toBeHidden();
  await expect(pad).toBeVisible();

  expect(problems).toEqual([]);
  expect(await page.evaluate(() => window.__game.errors)).toEqual([]);
});

test('R214: pad is not visible in the menu', async ({ page }) => {
  const problems = collect(page);
  await page.goto('/?seed=1'); // no scenario -> start screen (menu)
  await page.waitForFunction(() => window.__game.frames >= 10, null, { timeout: 30_000 });

  await expect(page.getByTestId('pad')).toBeHidden();
  await expect(page.getByTestId('pad-dot')).toBeHidden();

  expect(problems).toEqual([]);
});

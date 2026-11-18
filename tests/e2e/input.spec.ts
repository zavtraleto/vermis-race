import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function collect(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function ready(page: Page): Promise<void> {
  await page.goto('/?seed=1&scenario=empty');
  await page.waitForFunction(() => window.__game.frames >= 10, null, { timeout: 30_000 });
}

const touch = (
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
) =>
  page.dispatchEvent('#game', type, {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: x,
    clientY: y,
    bubbles: true,
  });

test('keyboard ArrowRight ramps steer up and back to exactly 0', async ({ page }) => {
  const problems = collect(page);
  await ready(page);

  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(() => window.__game.input().steer > 0, null, { timeout: 5_000 });
  await page.keyboard.up('ArrowRight');
  await page.waitForFunction(() => window.__game.input().steer === 0, null, { timeout: 5_000 });

  expect(problems).toEqual([]);
  expect(await page.evaluate(() => window.__game.errors)).toEqual([]);
});

test('touch drag right inside the bottom zone steers, release returns to 0', async ({ page }) => {
  const problems = collect(page);
  await ready(page);

  await touch(page, 'pointerdown', 180, 560);
  await touch(page, 'pointermove', 250, 560);
  await page.waitForFunction(() => window.__game.input().steer > 0, null, { timeout: 5_000 });
  await touch(page, 'pointerup', 250, 560);
  await page.waitForFunction(() => window.__game.input().steer === 0, null, { timeout: 5_000 });

  expect(problems).toEqual([]);
  expect(await page.evaluate(() => window.__game.errors)).toEqual([]);
});

test('touch gesture above the steering zone is ignored', async ({ page }) => {
  const problems = collect(page);
  await ready(page);

  await touch(page, 'pointerdown', 180, 200);
  await touch(page, 'pointermove', 250, 200);
  const f0 = await page.evaluate(() => window.__game.frames);
  await page.waitForFunction((n) => window.__game.frames >= n + 20, f0, { timeout: 10_000 });
  expect(await page.evaluate(() => window.__game.input().steer)).toBe(0);
  await touch(page, 'pointerup', 250, 200);

  expect(problems).toEqual([]);
  expect(await page.evaluate(() => window.__game.errors)).toEqual([]);
});

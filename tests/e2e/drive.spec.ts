import { expect, test, type Page } from '@playwright/test';

// Default twisty track, sim driven only by stepTicks (?frames=0 stops the rAF loop).
// The keyboard ramp runs on performance.now: after RAMP_WAIT_MS the held key gives steer = 1,
// and stepTicks inside one evaluate sees a constant steer, so the run is deterministic.
const SPEED_UP_TICKS = 480; // 4 s of sim: sp = 0.88
const HOLD_TICKS = 180; // 1.5 s of sim with the key held
const RAMP_WAIT_MS = 300; // > keyboard.steerRampMs

function collect(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function drive(page: Page, key: 'ArrowRight' | 'ArrowLeft' | null): Promise<number> {
  await page.goto('/?seed=1&frames=0');
  await page.waitForFunction(() => window.__game.done, null, { timeout: 30_000 });
  await page.evaluate((n) => window.__game.stepTicks(n), SPEED_UP_TICKS);
  if (key) {
    await page.keyboard.down(key);
    await page.waitForTimeout(RAMP_WAIT_MS);
  }
  await page.evaluate((n) => window.__game.stepTicks(n), HOLD_TICKS);
  if (key) {
    expect(Math.abs(await page.evaluate(() => window.__game.input().steer))).toBe(1);
    await page.keyboard.up(key);
  }
  expect(await page.evaluate(() => window.__game.tick)).toBe(SPEED_UP_TICKS + HOLD_TICKS);
  return page.evaluate(() => window.__game.state().cars[0]!.x);
}

test('holding ArrowRight / ArrowLeft at speed moves the car right / left vs no input', async ({
  page,
}) => {
  const problems = collect(page);
  const base = await drive(page, null);
  const right = await drive(page, 'ArrowRight');
  const left = await drive(page, 'ArrowLeft');

  expect(right - base).toBeGreaterThan(0.5);
  expect(left - base).toBeLessThan(-0.5);
  expect(problems).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';

// Default twisty track, measured inside its first easy section (segments < ~100, no drift-only corner yet:
// the `straight` scenario pins the input, so the keyboard could not act there).
// Sim driven only by stepTicks (?frames=0 stops the rAF loop).
// The keyboard ramp runs on performance.now: after RAMP_WAIT_MS the held key gives steer = 1,
// and stepTicks inside one evaluate sees a constant steer, so the run is deterministic.
const SPEED_UP_TICKS = 240; // 2 s of sim
const HOLD_TICKS = 150; // 1.25 s of sim with the key held
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
  const car = await page.evaluate(() => window.__game.state().cars[0]!);
  expect(car.z).toBeLessThan(100); // still inside the first easy section
  return car.x;
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

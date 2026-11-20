import { describe, expect, it } from 'vitest';
import { baseCar as base } from '../../src/data/cars';
import { inputConfig } from '../../src/data/input';
import { createAutoDrift } from '../../src/input/autoDrift';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPlayerInput } from '../../src/input/player';
import { createTouchStick } from '../../src/input/touchStick';
import { NO_H17_H18 } from '../sim/pinH17H18';
import { ENTRY_A } from '../sim/pinEntryA';
import { NO_GRIP_LEAD } from '../sim/pinGripLead';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { Car, CarParams, InputFrame } from '../../src/sim/types';

/**
 * R81 keyboard entry, end to end: real keyboard model + createPlayerInput + real sim, model B,
 * real base car data (lamps off), straight road, 0.9 vmax. Keys are delivered on exact tick
 * times, before the tick's read. ASSUMED API: the keyboard gets the same `{model}` object the
 * player gets as drift.car (createKeyboardInput(cfg, car)). 0.15 s = 9 ticks (DT = 1/60).
 * Flick needs |d| >= flickDelta 0.5: steer 0 -> +-1 gives |d| = 1.
 */
const TICK_MS = DT * 1000;
// H17/H18 off: this test is about keyboard entry
const params: CarParams = {
  ...base,
  model: 1,
  crashMinSpeed: 1e9,
  driftAutoExit: 0,
  ...NO_H17_H18,
  ...ENTRY_A, // R81 keyboard flick entry; the R81c keyboard is tested in stick_zone.test.ts
  ...NO_GRIP_LEAD, // R85b off: this test is about keyboard entry
};
type Ev = { t: number; kind: 'down' | 'up'; code: string };

function rig(car = { model: 1 }) {
  const kb = createKeyboardInput(inputConfig.keyboard, car);
  const clock = { t: 0 };
  const player = createPlayerInput(kb, createTouchStick(inputConfig.touch), () => clock.t, {
    hypotheses: { H3_driftEntry: 'A' },
    autoDrift: createAutoDrift(inputConfig.touch),
    car,
    warn: () => undefined,
  });
  const state = createRace(1, 1);
  const c: Car = state.cars[0]!;
  c.speed = 0.9 * base.vmax;
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const track = makeStraightTrack(4000);
  const queue: Ev[] = [];
  let next = 0;
  return {
    car: c,
    runTo(tMs: number, evs: Ev[], onTick?: (c: Car, t: number) => void): void {
      for (const e of evs) queue.push(e);
      queue.sort((a, b) => a.t - b.t);
      while (state.tick * TICK_MS < tMs) {
        const t = state.tick * TICK_MS;
        clock.t = t;
        while (next < queue.length && queue[next]!.t <= t) {
          const e = queue[next++]!;
          if (e.kind === 'down') kb.keyDown(e.code, e.t);
          else kb.keyUp(e.code, e.t);
        }
        player.read(frame);
        step(state, [frame], track, [params]);
        onTick?.(c, t);
      }
    },
  };
}
const dn = (t: number, code: string): Ev => ({ t, kind: 'down', code });
const up = (t: number, code: string): Ev => ({ t, kind: 'up', code });

describe('R81 keyboard entry end to end (model B)', () => {
  it.each([
    ['ArrowRight', 1],
    ['ArrowLeft', -1],
  ] as const)('(a/b) %s held 1 s, then Space: DRIFT dir %i within 0.15 s', (key, side) => {
    const r = rig();
    r.runTo(1000, [dn(0, key)]);
    expect(r.car.state).toBe('GRIP');
    r.runTo(1150, [dn(1000, 'Space')]);
    expect(r.car.state).toBe('DRIFT');
    expect(r.car.dir).toBe(side);
  });

  it.each([
    ['ArrowLeft', -1],
    ['ArrowRight', 1],
  ] as const)('(c) Space held, then a tap of %s: DRIFT dir %i', (key, side) => {
    const r = rig();
    r.runTo(500, [dn(0, 'Space')]);
    expect(r.car.state).toBe('GRIP');
    r.runTo(650, [dn(500, key), up(550, key)]);
    expect(r.car.state).toBe('DRIFT');
    expect(r.car.dir).toBe(side);
  });

  it('(d) arrows only: never DRIFT, steer ramps monotonically to 1', () => {
    const r = rig();
    const steers: number[] = [];
    r.runTo(1500, [dn(0, 'ArrowRight')], (c) => {
      expect(c.state).toBe('GRIP');
      steers.push(c.steer);
    });
    for (let i = 1; i < steers.length; i++)
      expect(steers[i]!).toBeGreaterThanOrEqual(steers[i - 1]!);
    expect(steers[steers.length - 1]!).toBeGreaterThan(0.9);
  });

  it('(e) release Space -> GRIP; press again with the arrow held -> DRIFT again, same side', () => {
    const r = rig();
    r.runTo(1000, [dn(0, 'ArrowRight')]);
    r.runTo(1300, [dn(1000, 'Space')]);
    expect(r.car.state).toBe('DRIFT');
    r.runTo(1300 + 2 * TICK_MS + 1, [up(1300, 'Space')]);
    expect(r.car.state).toBe('GRIP');
    r.runTo(1800, [dn(1500, 'Space')]);
    expect(r.car.state).toBe('DRIFT');
    expect(r.car.dir).toBe(1);
  });

  it('(f) both arrows held + Space: never DRIFT', () => {
    const r = rig();
    r.runTo(1500, [dn(0, 'ArrowLeft'), dn(0, 'ArrowRight'), dn(500, 'Space')], (c) =>
      expect(c.state).toBe('GRIP'),
    );
  });

  it('keyboard under model 0: steer already full, no zero read, so no flick inside the hold', () => {
    const r = rig({ model: 0 });
    r.runTo(1000, [dn(0, 'ArrowRight')]);
    r.runTo(1300, [dn(1000, 'Space')]);
    expect(r.car.state).toBe('GRIP');
  });
});

// R81 (model B): a flick counts only inside one hold of input.drift.
// Brief R81, sentence "Рывок считается только внутри одного удержания": on a tick where input.drift is
// not held the steer buffer is cleared, so the steer jump of release + re-touch is not a flick; the
// comparison covers only the ticks of the current hold (a sample from a non-held tick never counts).
//
// Numbers: Q (accel 0, slipDrag 0), straight track, speed 0.8 (> driftEnterSpeed*vmax = 0.45).
// flickDelta 0.5, flickWindow 0.12 s. Jump -0.8 -> 0 has |d| = 0.8 >= 0.5 (would be a flick without
// the rule); 0 -> 1 has |d| = 1 >= 0.5. A real flick 0 -> -0.8 inside the new hold has |d| = 0.8.
import { describe, expect, it } from 'vitest';
import { inputConfig } from '../../src/data/input';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPlayerInput } from '../../src/input/player';
import { createTouchStick } from '../../src/input/touchStick';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, InputFrame } from '../../src/sim/types';
import { Q, STRAIGHT, car, inp, mk, stepB, stepN } from './modelb_helpers';

const HOLD_TICKS = Math.round(0.3 / DT); // 0.3 s
const WINDOW_TICKS = Math.round(0.12 / DT);

/** GRIP at speed -> 5 ticks of steer 0 held -> steer +0.8 held: DRIFT dir +1 (flick, d = 0.8). */
function driftRight() {
  const s = mk({ speed: 0.8 });
  stepN(s, 5, inp(0, true));
  stepB(s, inp(0.8, true));
  expect(car(s).state).toBe('DRIFT');
  expect(car(s).dir).toBe(1);
  return s;
}

describe('R81 flick only inside one hold', () => {
  describe.each([1, 3, 8])('release for %i ticks with the steer held, then re-touch at steer 0', (n) => {
    it.each([-0.8, 0.8])('drift dir +1 with steer %f before release: stays GRIP for 0.3 s', (before) => {
      expect(n).toBeLessThanOrEqual(WINDOW_TICKS); // the old jump is inside flickWindow
      const s = driftRight();
      stepN(s, 4, inp(before, true)); // counter-steer (or same side) inside the drift
      stepN(s, n, inp(before, false)); // finger up: R82 exit
      expect(car(s).state).toBe('GRIP');
      for (let i = 0; i < HOLD_TICKS; i++) {
        stepB(s, inp(0, true)); // re-touch: steer 0 at once, drift held
        expect(car(s).state).toBe('GRIP');
      }
    });

    it('steer decaying toward 0 during the release (touch stick), then re-touch at 0: stays GRIP', () => {
      const s = driftRight();
      stepN(s, 4, inp(-0.8, true));
      for (let i = 0; i < n; i++) stepB(s, inp(-0.8 * (1 - (i + 1) / (n + 1)), false));
      for (let i = 0; i < HOLD_TICKS; i++) {
        stepB(s, inp(0, true));
        expect(car(s).state).toBe('GRIP');
      }
    });
  });

  it('a real flick inside the new hold (0 -> -0.8 within the window) enters DRIFT dir -1', () => {
    const s = driftRight();
    stepN(s, 4, inp(-0.8, true));
    stepN(s, 3, inp(-0.8, false));
    stepN(s, 3, inp(0, true)); // re-touch, no flick yet
    expect(car(s).state).toBe('GRIP');
    stepB(s, inp(-0.8, true)); // d = -0.8 vs the ticks of this hold
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(-1);
  });

  it('a "before" sample from ticks without drift does not count: 0 (no drift) -> 1 (drift on the same tick)', () => {
    const s = mk({ speed: 0.8 });
    stepN(s, 5, inp(0, false));
    stepB(s, inp(1, true));
    expect(car(s).state).toBe('GRIP');
    for (let i = 0; i < HOLD_TICKS; i++) {
      stepB(s, inp(1, true)); // steer stays 1: still no change inside the hold
      expect(car(s).state).toBe('GRIP');
    }
  });

  it('kept: drift held all the time, a flick 0 -> 0.8 enters DRIFT dir +1', () => {
    const s = mk({ speed: 0.8 });
    stepN(s, 5, inp(0, true));
    stepB(s, inp(0.8, true));
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });

  it('property: left/right mirror of the re-touch case, and determinism', () => {
    const run = (sign: number) => {
      const s = mk({ speed: 0.8 });
      stepN(s, 5, inp(0, true));
      stepB(s, inp(0.8 * sign, true));
      stepN(s, 4, inp(-0.8 * sign, true));
      stepN(s, 3, inp(-0.8 * sign, false));
      stepN(s, HOLD_TICKS, inp(0, true));
      return s;
    };
    const a = run(1);
    const b = run(-1);
    expect(car(a).state).toBe('GRIP');
    expect(car(b).state).toBe('GRIP');
    expect(JSON.stringify(run(1))).toBe(JSON.stringify(a));
  });
});

describe('R81 flick only inside one hold: real touch stick + player input', () => {
  const W = 390;
  const H = 693;
  const Y = 560; // steering zone
  const CX = 195;
  const TICK_MS = DT * 1000;

  it('drift right, counter-steer, finger up, re-touch 30 ms later without moving: GRIP after 0.3 s', () => {
    const stick = createTouchStick(inputConfig.touch);
    const kb = createKeyboardInput(inputConfig.keyboard);
    const state = createRace(1, 1);
    const c: Car = state.cars[0]!;
    c.speed = 0.8;
    const clock = { t: 0 };
    const player = createPlayerInput(kb, stick, () => clock.t, {
      hypotheses: { H3_driftEntry: 'E' },
      autoDrift: { reset: () => undefined, update: () => false },
      warn: () => undefined,
      car: { model: 1 },
    } as never);
    const frame: InputFrame = { steer: 0, brake: false, drift: false };
    const evs: { t: number; k: 'down' | 'move' | 'up'; x: number }[] = [
      { t: 0, k: 'down', x: CX },
      { t: 300 + 25, k: 'move', x: CX + 30 }, // sharp 60 px in 50 ms: flick to the right
      { t: 300 + 50, k: 'move', x: CX + 60 },
    ];
    // slow counter-steer to -90 px (full left), 600 ms
    for (let i = 1; i <= 36; i++) evs.push({ t: 1000 + (i * 600) / 36, k: 'move', x: CX + 60 - (150 * i) / 36 });
    const tUp = 2000;
    evs.push({ t: tUp, k: 'up', x: CX - 90 });
    evs.push({ t: tUp + 30, k: 'down', x: CX }); // re-touch, no movement afterwards
    let next = 0;
    let driftSeen = false;
    const tEnd = tUp + 30 + 300;
    while (state.tick * TICK_MS < tEnd) {
      const t = state.tick * TICK_MS;
      clock.t = t;
      while (next < evs.length && evs[next]!.t <= t) {
        const e = evs[next++]!;
        stick.setArea(W, H);
        if (e.k === 'down') stick.pointerDown(1, e.x, Y, e.t);
        else if (e.k === 'move') stick.pointerMove(1, e.x, Y, e.t);
        else stick.pointerUp(1, e.t);
      }
      player.read(frame);
      step(state, [frame], STRAIGHT, [Q]);
      if (t < tUp && c.state === 'DRIFT') driftSeen = true;
      if (t >= tUp + 30 + 2 * TICK_MS) expect(c.state).toBe('GRIP'); // after the re-touch
    }
    expect(driftSeen).toBe(true);
    expect(c.state).toBe('GRIP');
  });
});

import { describe, expect, it } from 'vitest';
import { baseCarA as baseCar } from '../sim/baseCarA';
import { inputConfig } from '../../src/data/input';
import { createAutoDrift } from '../../src/input/autoDrift';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPlayerInput } from '../../src/input/player';
import { createRetouchDrift } from '../../src/input/retouchDrift';
import { createTouchStick } from '../../src/input/touchStick';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, InputFrame } from '../../src/sim/types';
import { constTrack } from '../sim/driving_helpers';

/**
 * End to end of the H3 D touch gesture (R20 armed entry): real touch stick + retouchDrift + player
 * input with real data, feeding the real sim on a constant medium curve (curves.json medium = 4.5)
 * at 0.9 vmax. Pointer events are delivered the way src/input/pointerDom.ts does (stick first, then
 * retouch, same timestamp); the sim is stepped at DT between events. Surface 390 x 693 px (9:16).
 *
 * Data in force: retouchWindowMs 450, retouchSwipePx 14, stickRadiusFrac 0.2 (R = 78 px),
 * steerZoneFrac 0.35 (zone y >= 450), driftArmTime 0.3 s.
 * 60 px swipe: raw 60/78 = 0.769, steer = 0.769^1.4 = 0.69.
 */
const W = 390;
const H = 693;
const DOWN_Y = 560; // inside the steering zone
const CX = 195;
const track = constTrack(4.5);
const TICK_MS = DT * 1000;

type Ev = { t: number; kind: 'down' | 'move' | 'up'; x: number };

/** Linear swipe of dx px over durMs starting at t0, sampled every stepMs (last sample exact). */
function swipe(t0: number, x0: number, dx: number, durMs: number, stepMs: number): Ev[] {
  const out: Ev[] = [];
  const n = Math.round(durMs / stepMs);
  for (let i = 1; i <= n; i++) out.push({ t: t0 + i * stepMs, kind: 'move', x: x0 + (dx * i) / n });
  return out;
}

interface Rig {
  car: Car;
  /** Runs the sim until tMs, delivering events due; calls onTick after each step. */
  runTo(tMs: number, events: Ev[], onTick?: (car: Car, tMs: number) => void): void;
}

function rig(): Rig {
  const kb = createKeyboardInput(inputConfig.keyboard);
  const stick = createTouchStick(inputConfig.touch);
  const retouch = createRetouchDrift(inputConfig.touch);
  const clock = { t: 0 };
  const player = createPlayerInput(kb, stick, () => clock.t, {
    hypotheses: { H3_driftEntry: 'D' },
    autoDrift: createAutoDrift(inputConfig.touch),
    retouch,
    warn: () => undefined,
  });
  const state = createRace(1, 1);
  const car = state.cars[0]!;
  // R21c: this test describes leaving the drift by taking the finger to the centre (small-angle
  // exit), which is H12 A (driftAutoExit 1); the data default is now 0.
  const params = { ...baseCar, driftAutoExit: 1 };
  car.speed = 0.9 * baseCar.vmax;
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const queue: Ev[] = [];
  let next = 0;
  const POINTER = 1;
  const deliver = (e: Ev): void => {
    if (e.kind === 'down') {
      stick.setArea(W, H);
      if (stick.pointerDown(POINTER, e.x, DOWN_Y, e.t)) retouch.down(e.x, e.t);
    } else if (e.kind === 'move') {
      if (stick.activeId === POINTER) {
        stick.pointerMove(POINTER, e.x, DOWN_Y, e.t);
        retouch.move(e.x, e.t);
      }
    } else if (stick.activeId === POINTER) {
      stick.pointerUp(POINTER, e.t);
      retouch.up(e.t);
    }
  };
  return {
    car,
    runTo(tMs, events, onTick) {
      for (const e of events) queue.push(e);
      queue.sort((a, b) => a.t - b.t);
      while (state.tick * TICK_MS < tMs) {
        const t = state.tick * TICK_MS;
        clock.t = t;
        while (next < queue.length && queue[next]!.t <= t) deliver(queue[next++]!);
        player.read(frame);
        step(state, [frame], track, [params]);
        onTick?.(car, t);
      }
    },
  };
}

/** hold 0..500, lift, re-touch at 650 (150 ms later); returns the events up to the re-touch. */
const holdLiftRetouch = (gapMs: number): { evs: Ev[]; tRetouch: number } => {
  const tUp = 500;
  const tRetouch = tUp + gapMs;
  return {
    evs: [
      { t: 0, kind: 'down', x: CX },
      { t: tUp, kind: 'up', x: CX },
      { t: tRetouch, kind: 'down', x: CX },
    ],
    tRetouch,
  };
};

describe('H3 D end to end: re-touch + swipe -> drift (R20 armed entry)', () => {
  it.each([1, -1])(
    '(a) slow swipe 60 px over 200 ms (side %i): DRIFT toward the swipe, stays while held',
    (side) => {
      const { evs, tRetouch } = holdLiftRetouch(150);
      const r = rig();
      const sw = swipe(tRetouch, CX, side * 60, 200, 1000 / 60);
      r.runTo(tRetouch + 200, [...evs, ...sw]);
      // hold the 60 px deflection for 1.5 s more; once DRIFT is reached it must never drop.
      let entered = r.car.state === 'DRIFT';
      r.runTo(tRetouch + 200 + 1500, [], (c) => {
        if (c.state === 'DRIFT') entered = true;
        else expect(entered).toBe(false); // no drop after entry
      });
      expect(entered).toBe(true);
      expect(r.car.state).toBe('DRIFT');
      expect(r.car.dir).toBe(side);
    },
  );

  it.each([1, -1])('(b) fast swipe 60 px within 2 frames at 60 Hz (side %i): DRIFT', (side) => {
    const { evs, tRetouch } = holdLiftRetouch(150);
    const r = rig();
    const sw: Ev[] = [
      { t: tRetouch + 1000 / 60, kind: 'move', x: CX + side * 30 },
      { t: tRetouch + 2000 / 60, kind: 'move', x: CX + side * 60 },
    ];
    let entered = false;
    r.runTo(tRetouch + 1500, [...evs, ...sw], (c) => {
      if (c.state === 'DRIFT') entered = true;
      else expect(entered).toBe(false);
    });
    expect(entered).toBe(true);
    expect(r.car.state).toBe('DRIFT');
    expect(r.car.dir).toBe(side);
  });

  it('(c) re-touch after the retouch window (1000 ms) + swipe: stays GRIP, steering works', () => {
    const { evs, tRetouch } = holdLiftRetouch(1000);
    const r = rig();
    const sw = swipe(tRetouch, CX, 60, 200, 1000 / 60);
    let maxSteer = 0;
    r.runTo(tRetouch + 1500, [...evs, ...sw], (c) => {
      expect(c.state).toBe('GRIP');
      if (c.steer > maxSteer) maxSteer = c.steer;
    });
    // 60 px swipe -> stick steer 0.69; smoothed steer follows it
    expect(maxSteer).toBeGreaterThan(0.6);
    expect(r.car.steer).toBeGreaterThan(0.6);
  });

  it('(d) the very first touch + swipe: stays GRIP', () => {
    const r = rig();
    const sw = swipe(100, CX, 60, 200, 1000 / 60);
    let maxSteer = 0;
    r.runTo(1800, [{ t: 100, kind: 'down', x: CX }, ...sw], (c) => {
      expect(c.state).toBe('GRIP');
      if (c.steer > maxSteer) maxSteer = c.steer;
    });
    expect(maxSteer).toBeGreaterThan(0.6);
  });

  it('(e) in DRIFT the finger back to the centre returns to GRIP without lifting; holding does not re-enter', () => {
    const { evs, tRetouch } = holdLiftRetouch(150);
    const r = rig();
    const sw = swipe(tRetouch, CX, 60, 200, 1000 / 60);
    const tBack = tRetouch + 200 + 1000;
    const back = swipe(tBack, CX + 60, -60, 100, 1000 / 60); // finger returns to the touch-down x
    let drifted = false;
    r.runTo(tBack, [...evs, ...sw, ...back], (c) => {
      if (c.state === 'DRIFT') drifted = true;
    });
    expect(drifted).toBe(true);
    expect(r.car.state).toBe('DRIFT');
    // returns to GRIP within driftStraightTime + 0.5 s of the finger being back
    const budgetMs = (baseCar.driftStraightTime + 0.5) * 1000;
    const tGrip = { t: -1 };
    r.runTo(tBack + 100 + budgetMs, [], (c, t) => {
      if (c.state === 'GRIP' && tGrip.t < 0) tGrip.t = t;
    });
    expect(tGrip.t).toBeGreaterThan(0);
    // still holding the finger for 2 s: never re-enters
    r.runTo(tBack + 100 + budgetMs + 2000, [], (c) => {
      expect(c.state).toBe('GRIP');
    });
  });
});

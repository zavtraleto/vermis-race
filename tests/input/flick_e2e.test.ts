import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { inputConfig } from '../../src/data/input';
import { createAutoDrift } from '../../src/input/autoDrift';
import { createFlickDrift } from '../../src/input/flickDrift';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPlayerInput } from '../../src/input/player';
import { createTouchStick } from '../../src/input/touchStick';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, InputFrame } from '../../src/sim/types';
import { constTrack } from '../sim/driving_helpers';

/**
 * End to end of H3 E (flick drift) with R21c: real touch stick + flickDrift + player input with real
 * data (H3 'E'), feeding the real sim on a constant medium curve (curves.json medium = 4.5) at 0.9
 * vmax, driftAutoExit 0 (H12 B, explicit). Pointer events as the pointer adapter delivers them: the
 * stick first, then flick.sample(stick steer, t); the poll also samples the stick's steer every tick.
 * Surface 390 x 693 px: R = 0.2 * 390 = 78 px. 60 px: raw 0.769, steer 0.769^1.4 = 0.69;
 * 30 px: raw 0.385, steer 0.263. A sharp 60 px move in 50 ms changes the steer by 0.69 > flickDelta
 * 0.5 inside flickWindowMs 120. The same 60 px over 600 ms changes it by at most
 * 0.69 * (1 - 0.8^1.4) = 0.185 per 120 ms window.
 */
const W = 390;
const H = 693;
const DOWN_Y = 560; // inside the steering zone (y >= 450)
const CX = 195;
const TICK_MS = DT * 1000;
const params = { ...baseCar, driftAutoExit: 0 };

type Ev = { t: number; kind: 'down' | 'move' | 'up'; x: number };

/** Linear move of dx px over durMs from t0, sampled every stepMs (last sample exact). */
function swipe(t0: number, x0: number, dx: number, durMs: number, stepMs: number): Ev[] {
  const out: Ev[] = [];
  const n = Math.round(durMs / stepMs);
  for (let i = 1; i <= n; i++) out.push({ t: t0 + i * stepMs, kind: 'move', x: x0 + (dx * i) / n });
  return out;
}

function rig(side: 1 | -1) {
  const kb = createKeyboardInput(inputConfig.keyboard);
  const stick = createTouchStick(inputConfig.touch);
  const flick = createFlickDrift(inputConfig.touch);
  const clock = { t: 0 };
  const player = createPlayerInput(kb, stick, () => clock.t, {
    hypotheses: { H3_driftEntry: 'E' },
    autoDrift: createAutoDrift(inputConfig.touch),
    flick,
    warn: () => undefined,
  });
  const track = constTrack(side * 4.5);
  const state = createRace(1, 1);
  const car: Car = state.cars[0]!;
  car.speed = 0.9 * baseCar.vmax;
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  const tmp: InputFrame = { steer: 0, brake: false, drift: false };
  const queue: Ev[] = [];
  let next = 0;
  let touching = false;
  const POINTER = 1;
  const sampleStick = (t: number): void => {
    stick.read(t, tmp);
    flick.sample(tmp.steer, t);
  };
  const deliver = (e: Ev): void => {
    if (e.kind === 'down') {
      stick.setArea(W, H);
      if (stick.pointerDown(POINTER, e.x, DOWN_Y, e.t)) {
        touching = true;
        flick.down(e.t);
        sampleStick(e.t);
      }
    } else if (e.kind === 'move') {
      if (stick.activeId === POINTER) {
        stick.pointerMove(POINTER, e.x, DOWN_Y, e.t);
        sampleStick(e.t);
      }
    } else if (stick.activeId === POINTER) {
      stick.pointerUp(POINTER, e.t);
      flick.up(e.t);
      touching = false;
    }
  };
  return {
    car,
    flick,
    runTo(tMs: number, events: Ev[], onTick?: (c: Car, t: number) => void): void {
      for (const e of events) queue.push(e);
      queue.sort((a, b) => a.t - b.t);
      while (state.tick * TICK_MS < tMs) {
        const t = state.tick * TICK_MS;
        clock.t = t;
        while (next < queue.length && queue[next]!.t <= t) deliver(queue[next++]!);
        if (touching) sampleStick(t); // poll
        player.read(frame);
        step(state, [frame], track, [params]);
        onTick?.(car, t);
      }
    },
  };
}

const sharp = (t0: number, side: number): Ev[] => [
  { t: t0 + 25, kind: 'move', x: CX + side * 30 },
  { t: t0 + 50, kind: 'move', x: CX + side * 60 },
];

describe('H3 E end to end: flick -> drift (R21c: it stays until release)', () => {
  it.each([1, -1] as const)(
    '(a) held still 300 ms, then 60 px within 50 ms (side %i): DRIFT toward the swipe, stays DRIFT held, even with the finger back at centre for 2 s',
    (side) => {
      const r = rig(side);
      const back = swipe(300 + 50 + 1000, CX + side * 60, -side * 60, 100, 1000 / 60);
      const evs: Ev[] = [{ t: 0, kind: 'down', x: CX }, ...sharp(300, side), ...back];
      let entered = false;
      r.runTo(300 + 50 + 1000 + 100 + 2000, evs, (c) => {
        if (c.state === 'DRIFT') entered = true;
        else expect(entered).toBe(false); // never drops once entered
      });
      expect(entered).toBe(true);
      expect(r.car.state).toBe('DRIFT');
      expect(r.car.dir).toBe(side);
    },
  );

  it.each([1, -1] as const)(
    '(b) the same 60 px done smoothly over 600 ms (side %i): stays GRIP and steers',
    (side) => {
      const r = rig(side);
      const evs: Ev[] = [
        { t: 0, kind: 'down', x: CX },
        ...swipe(300, CX, side * 60, 600, 1000 / 60),
      ];
      let maxSteer = 0;
      r.runTo(300 + 600 + 1500, evs, (c) => {
        expect(c.state).toBe('GRIP');
        maxSteer = Math.max(maxSteer, Math.abs(c.steer));
      });
      expect(maxSteer).toBeGreaterThan(0.6);
      expect(r.flick.active).toBe(false);
    },
  );

  it('(c) release returns to GRIP at once (within 2 ticks)', () => {
    const r = rig(1);
    const tUp = 300 + 50 + 1000;
    r.runTo(tUp, [{ t: 0, kind: 'down', x: CX }, ...sharp(300, 1)]);
    expect(r.car.state).toBe('DRIFT');
    r.runTo(tUp + 2 * TICK_MS + 1, [{ t: tUp, kind: 'up', x: CX + 60 }]);
    expect(r.car.state).toBe('GRIP');
    expect(r.car.dir).toBe(0);
    expect(r.flick.active).toBe(false);
  });

  it.each([1, -1] as const)(
    '(d) a fresh touch that flicks immediately (side %i) also enters DRIFT',
    (side) => {
      const r = rig(side);
      let entered = false;
      r.runTo(1500, [{ t: 0, kind: 'down', x: CX }, ...sharp(0, side)], (c) => {
        if (c.state === 'DRIFT') entered = true;
      });
      expect(entered).toBe(true);
      expect(r.car.state).toBe('DRIFT');
      expect(r.car.dir).toBe(side);
    },
  );

  it('(e) small jitter (+-5 px at 60 Hz) for 3 s never enters DRIFT', () => {
    const r = rig(1);
    const evs: Ev[] = [{ t: 0, kind: 'down', x: CX }];
    for (let i = 1; i <= 180; i++)
      evs.push({ t: (i * 1000) / 60, kind: 'move', x: CX + (i % 2 === 0 ? 5 : -5) });
    r.runTo(3000, evs, (c) => expect(c.state).toBe('GRIP'));
    expect(r.flick.active).toBe(false);
  });
});

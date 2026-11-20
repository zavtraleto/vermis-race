import { describe, expect, it } from 'vitest';
import { baseCar } from '../../src/data/cars';
import { inputConfig } from '../../src/data/input';
import { createAutoDrift } from '../../src/input/autoDrift';
import { createKeyboardInput } from '../../src/input/keyboard';
import { createPlayerInput } from '../../src/input/player';
import type { TouchStick } from '../../src/input/touchStick';
import { createZoneStick } from '../../src/input/zoneStick';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { CarParams, InputFrame, Track } from '../../src/sim/types';

/**
 * R81e "Ввод" (driftEntry 4, H16 = E). input.drift in variant 4 means only "control held":
 * - touch: the finger is on the screen; the stick is the R81c zone stick without the drift border:
 *   steer = clamp(dx/stickRadius, -1, 1), centre = touch-down point, zoneReleaseMs 0; driftEdge and
 *   the latch are not used (past the zone edge the steer is simply 1).
 * - keyboard: at least one arrow held (Space and Shift do not matter any more); steer = arrows at full
 *   value at once (as in R81c), without the R81 zero-read substitution.
 * ASSUMED API (same as R81c tests): keyboard and player input get the live car `{ model, driftEntry }`.
 * The touch side is checked through createPlayerInput (what the player frame reports), not through
 * the zone stick alone: the brief does not say which of the two drops the latch.
 */
const V4 = { model: 1, driftEntry: 4 };
const W = 360;
const H = 640;
const X0 = 180;
const Y = 560; // inside the steering zone (bottom 35%)
const R = inputConfig.touch.stickRadius * W; // 0.16*360 = 57.6 px
const EDGE = R * inputConfig.touch.driftEdge; // 77.76 px

const frame = (): InputFrame => ({ steer: 0, brake: false, drift: false });

describe('R81e keyboard (driftEntry 4): drift = an arrow held, steer = arrows at full value at once', () => {
  const kbd = (car: { model: number; driftEntry: number } = { ...V4 }) =>
    createKeyboardInput(inputConfig.keyboard, car);
  const rd = (kb: ReturnType<typeof kbd>, t: number): InputFrame => {
    const f = frame();
    kb.read(t, f);
    return f;
  };
  it.each([
    ['ArrowRight', 1],
    ['ArrowLeft', -1],
  ] as const)(
    '%s held: steer %i and drift true on the first read (no steerRampMs ramp)',
    (key, sg) => {
      const kb = kbd();
      expect(rd(kb, 0).drift).toBe(false);
      kb.keyDown(key, 0);
      const f = rd(kb, 10); // a ramp would give 10/120 = 0.083
      expect(f.steer).toBe(sg);
      expect(f.drift).toBe(true);
      kb.keyUp(key, 20);
      const g = rd(kb, 30);
      expect(g.steer).toBe(0);
      expect(g.drift).toBe(false);
    },
  );
  it('both arrows: steer 0 but control held (drift true); releasing one gives the other at full value', () => {
    const kb = kbd();
    kb.keyDown('ArrowLeft', 0);
    kb.keyDown('ArrowRight', 0);
    const f = rd(kb, 10);
    expect(f.steer).toBe(0);
    expect(f.drift).toBe(true);
    kb.keyUp('ArrowLeft', 20);
    const g = rd(kb, 30);
    expect(g.steer).toBe(1);
    expect(g.drift).toBe(true);
    kb.keyUp('ArrowRight', 40);
    expect(rd(kb, 50).drift).toBe(false);
  });
  it.each(['Space', 'ShiftLeft', 'ShiftRight'])(
    '%s alone does not hold the control: drift false',
    (key) => {
      const kb = kbd();
      kb.keyDown(key, 0);
      const f = rd(kb, 10);
      expect(f.drift).toBe(false);
      expect(f.steer).toBe(0);
    },
  );
  it('arrow held, then Space pressed and released: no zero read, steer and drift unchanged', () => {
    const kb = kbd();
    kb.keyDown('ArrowRight', 0);
    rd(kb, 500);
    kb.keyDown('Space', 500);
    for (let t = 510; t <= 600; t += 10) {
      const f = rd(kb, t);
      expect(f.steer).toBe(1);
      expect(f.drift).toBe(true);
    }
    kb.keyUp('Space', 600);
    const g = rd(kb, 610);
    expect(g.steer).toBe(1);
    expect(g.drift).toBe(true);
  });
  it('Space held, arrow pressed and released: drift follows the arrow, not Space', () => {
    const kb = kbd();
    kb.keyDown('Space', 0);
    expect(rd(kb, 100).drift).toBe(false);
    kb.keyDown('ArrowLeft', 100);
    const f = rd(kb, 110);
    expect(f.steer).toBe(-1);
    expect(f.drift).toBe(true);
    kb.keyUp('ArrowLeft', 120);
    const g = rd(kb, 130);
    expect(g.steer).toBe(0);
    expect(g.drift).toBe(false);
  });
  it('determinism: same events twice give identical frames', () => {
    const run = (): InputFrame[] => {
      const kb = kbd();
      const out: InputFrame[] = [];
      kb.keyDown('ArrowLeft', 0);
      for (let t = 10; t <= 400; t += 10) {
        if (t === 150) kb.keyDown('Space', t);
        if (t === 200) kb.keyDown('ArrowRight', t);
        if (t === 300) kb.keyUp('ArrowLeft', t);
        out.push(rd(kb, t));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('R81e touch through the player input (model B, driftEntry 4): drift = finger on the screen', () => {
  const rig = () => {
    const car = { ...V4 };
    const clock = { t: 0 };
    const touch: TouchStick = createZoneStick(inputConfig.touch);
    touch.setArea(W, H);
    const player = createPlayerInput(
      createKeyboardInput(inputConfig.keyboard, car),
      touch,
      () => clock.t,
      {
        hypotheses: { H3_driftEntry: 'E' },
        autoDrift: createAutoDrift(inputConfig.touch),
        car,
        warn: () => undefined,
      },
    );
    const f = frame();
    const at = (t: number): InputFrame => {
      clock.t = t;
      player.read(f);
      return f;
    };
    return { touch, at };
  };
  for (const sg of [1, -1]) {
    it(`side ${sg}: touch-down is held at once; inside the zone held, past the old drift border steer 1 and held, back inside still held`, () => {
      const r = rig();
      r.touch.pointerDown(1, X0, Y, 0);
      let f = r.at(0);
      expect(f.drift).toBe(true);
      expect(f.steer).toBe(0);
      r.touch.pointerMove(1, X0 + sg * 0.5 * R, Y, 10);
      f = r.at(10);
      expect(f.drift).toBe(true); // variant 3 would report false here (no edge crossed)
      expect(f.steer).toBeCloseTo(sg * 0.5, 9);
      r.touch.pointerMove(1, X0 + sg * (EDGE + 30), Y, 20);
      f = r.at(20);
      expect(f.steer).toBe(sg);
      expect(f.drift).toBe(true);
      r.touch.pointerMove(1, X0 + sg * 0.1 * R, Y, 30);
      f = r.at(30);
      expect(f.steer).toBeCloseTo(sg * 0.1, 9);
      expect(f.drift).toBe(true);
    });
  }
  it('release (up or cancel): steer 0 and drift false on the first read (zoneReleaseMs 0)', () => {
    for (const how of ['up', 'cancel'] as const) {
      const r = rig();
      r.touch.pointerDown(1, X0, Y, 0);
      r.touch.pointerMove(1, X0 + 2 * R, Y, 10);
      expect(r.at(10).drift).toBe(true);
      if (how === 'up') r.touch.pointerUp(1, 20);
      else r.touch.pointerCancel(1, 20);
      const f = r.at(20);
      expect(f.steer).toBe(0);
      expect(f.drift).toBe(false);
    }
  });
  it('a new touch is held again at once (no latch to cross)', () => {
    const r = rig();
    r.touch.pointerDown(1, X0, Y, 0);
    r.touch.pointerUp(1, 10);
    expect(r.at(10).drift).toBe(false);
    r.touch.pointerDown(2, X0 + 40, Y, 20);
    expect(r.at(20).drift).toBe(true);
  });
  it('steer is linear and the centre stays at the touch point (out to 2 R and back to 0.3 R gives 0.3)', () => {
    const r = rig();
    r.touch.pointerDown(1, X0, Y, 0);
    r.touch.pointerMove(1, X0 + 2 * R, Y, 10);
    r.at(10);
    r.touch.pointerMove(1, X0 + 0.3 * R, Y, 20);
    expect(r.at(20).steer).toBeCloseTo(0.3, 9);
  });
});

describe('R81e keyboard end to end with the sim (variant 4, real base car)', () => {
  // Real base numbers with R81e start values, lamps off; constant hard corner (curve 7) at vmax:
  // needAhead = 7*1*kYaw/gripA = 1.49 >= 1, so an arrow into the corner held 12 ticks enters on the 13th.
  const AUTO = { autoSteer: 0.7, autoHold: 0.1, autoLook: 0.25, autoNeed: 1.0 };
  const params: CarParams = { ...baseCar, ...AUTO, model: 1, driftEntry: 4, crashMinSpeed: 1e9 };
  const HARD: Track = { segments: Array.from({ length: 4000 }, () => ({ curve: 7 })) };
  it('ArrowRight held: GRIP for 12 ticks, DRIFT on the 13th with dir +1; arrow released: GRIP on that tick', () => {
    const car = { ...V4 };
    const kb = createKeyboardInput(inputConfig.keyboard, car);
    const s = createRace(1, 1);
    const c = s.cars[0]!;
    c.speed = params.vmax;
    c.z = 10;
    const f = frame();
    const tick = (): void => {
      kb.read(s.tick * DT * 1000, f);
      step(s, [f], HARD, [params]);
    };
    kb.keyDown('ArrowRight', 0);
    for (let i = 0; i < 12; i++) {
      tick();
      expect(c.state).toBe('GRIP');
    }
    tick();
    expect(c.state).toBe('DRIFT');
    expect(c.dir).toBe(1);
    for (let i = 0; i < 60; i++) tick();
    expect(c.state).toBe('DRIFT');
    kb.keyUp('ArrowRight', s.tick * DT * 1000);
    tick();
    expect(c.state).toBe('GRIP');
  });
  it('Space alone with no arrow never enters', () => {
    const car = { ...V4 };
    const kb = createKeyboardInput(inputConfig.keyboard, car);
    const s = createRace(1, 1);
    s.cars[0]!.speed = params.vmax;
    const f = frame();
    kb.keyDown('Space', 0);
    for (let i = 0; i < 120; i++) {
      kb.read(s.tick * DT * 1000, f);
      step(s, [f], HARD, [params]);
      expect(s.cars[0]!.state).toBe('GRIP');
    }
  });
});

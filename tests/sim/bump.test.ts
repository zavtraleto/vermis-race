import { describe, expect, it } from 'vitest';
import { step } from '../../src/sim/race';
import { BP, BUMP_TICKS, IDLE, TRACK, dz, setup, stepOnce } from './traffic_helpers';

// Geometry: setup() gives POST-step positions, so every contact check at the end of step 1 sees
// exactly the stated z/x. Player: accel 0 (constant speed), x = 0, travel = 0, steer = 0, straight track.
// Hit box: |dz| < carLength = 1.5 and |dx| < (0.2 + 0.2)/2 = 0.2. Rear hit: z < zT - 0.75.
const P = (speed: number, x = 0) => ({ z: 10, x, speed });

describe('R40 contact condition', () => {
  it('z overlap only: no contact', () => {
    // dz = 0 (inside 1.5), dx = 0.5 (outside 0.2)
    const s = setup(P(0.8), [{ z: 10, x: 0.5, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.8, 12);
    expect(s.cars[0]!.bumpTicks).toBe(0);
    expect(Math.abs(s.cars[0]!.x)).toBe(0);
  });

  it('x overlap only: no contact', () => {
    // dx = 0.1 (inside 0.2), dz = 2.0 (outside 1.5)
    const s = setup(P(0.8), [{ z: 12, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.8, 12);
    expect(s.cars[0]!.bumpTicks).toBe(0);
  });

  it('both overlaps: contact', () => {
    // dz = 0, dx = 0.1 -> side contact
    const s = setup(P(0.8), [{ z: 10, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.bumpTicks).toBe(BUMP_TICKS);
  });

  it('contact is symmetric in x (traffic left or right of the player)', () => {
    for (const tx of [-0.1, 0.1]) {
      const s = setup(P(0.8), [{ z: 10, x: tx, speed: 0.5 }]);
      stepOnce(s);
      expect(s.cars[0]!.bumpTicks).toBe(BUMP_TICKS);
    }
  });

  it('no contact while bumpTicks > 0', () => {
    const s = setup(P(0.8), [{ z: 10, x: 0.1, speed: 0.5 }]);
    s.cars[0]!.bumpTicks = 5;
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.8, 12); // would be 0.75 with a contact
    expect(Math.abs(s.cars[0]!.x)).toBe(0);
    expect(s.cars[0]!.bumpTicks).toBe(4);
  });

  it('at most one contact per step; the lower traffic index wins', () => {
    // car 1: dz 0 (side contact, left of player), car 2: rear hit (dz = +0.9), right of the player.
    // Applying car 1 only: speed 0.8 - 0.05 = 0.75. Applying car 2 would give 0.4.
    const s = setup(P(0.8), [
      { z: 10, x: -0.1, speed: 0.5 },
      { z: 10.9, x: 0.1, speed: 0.5 },
    ]);
    stepOnce(s);
    const p = s.cars[0]!;
    expect(p.speed).toBeCloseTo(0.75, 12);
    expect(p.bumpTicks).toBe(BUMP_TICKS);
  });

  it('traffic vs traffic never interacts', () => {
    // Player far away; two traffic cars on top of each other (same lane, dz 0.2, different speeds).
    const s = setup({ z: 500, x: 0, speed: 0 }, [
      { z: 100, x: 0.25, speed: 0.5 },
      { z: 100.2, x: 0.25, speed: 0.4 },
    ]);
    stepOnce(s);
    const a = s.cars[1]!;
    const b = s.cars[2]!;
    expect(a.speed).toBe(0.5);
    expect(b.speed).toBe(0.4);
    expect(a.x).toBe(0.25);
    expect(b.x).toBe(0.25);
    expect(a.bumpTicks + b.bumpTicks + s.cars[0]!.bumpTicks).toBe(0);
  });

  it('a traffic car is not modified by a SIDE contact (only R16 moves it; a rear hit pushes it, R41)', () => {
    const s = setup(P(0.8), [{ z: 10, x: 0.1, speed: 0.5 }]);
    const t = s.cars[1]!;
    const before = { ...t };
    stepOnce(s);
    expect(s.cars[0]!.bumpTicks).toBe(BUMP_TICKS); // the contact did happen
    expect(t).toEqual({ ...before, z: before.z + dz(0.5) });
  });
});

describe('R41 speed loss', () => {
  // R41 (rewritten 2026-11-19): the loss is taken from the hitter's own speed v0, not down to the
  // traffic speed. Old tests encoded speed = max(speedT - 0.1*vmax, 0.3*vmax); updated here.
  it('rear hit: speed = min(v0, max(v0 - 0.1*vmax, 0.3*vmax))', () => {
    // dz = zT - z = 0.9 > 0.75 -> rear. min(0.8, max(0.8 - 0.1, 0.3)) = min(0.8, 0.7) = 0.7
    const s = setup(P(0.8), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.7, 12);
  });

  it('rear hit, floor case: low v0 -> 0.3*vmax', () => {
    // v0 = 0.35: min(0.35, max(0.35 - 0.1, 0.3)) = min(0.35, 0.3) = 0.3 (traffic speed is irrelevant)
    const s = setup(P(0.35), [{ z: 10.9, x: 0.1, speed: 0.2 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.3, 12);
  });

  it('rear hit, player already slower: speed unchanged', () => {
    // min(0.2, max(0.2 - 0.1, 0.3)) = min(0.2, 0.3) = 0.2
    const s = setup(P(0.2), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.2, 12);
    expect(s.cars[0]!.bumpTicks).toBe(BUMP_TICKS); // still a contact
  });

  it('side contact: speed -= 0.05*vmax', () => {
    // dz = 0 -> not rear (10 < 9.25 is false). 0.8 - 0.05 = 0.75
    const s = setup(P(0.8), [{ z: 10, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.75, 12);
  });

  it('side contact with traffic ahead of the player but within the rear threshold is a side contact', () => {
    // zT - z = 0.5 <= 0.75 -> side: 0.8 - 0.05 = 0.75 (rear rule would give 0.4)
    const s = setup(P(0.8), [{ z: 10.5, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.75, 12);
  });

  it('side contact: traffic behind the player (z > zT) is also a side contact', () => {
    // zT - z = -0.5 -> side: 0.75
    const s = setup(P(0.8), [{ z: 9.5, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.75, 12);
  });

  it('side contact floor: 0.32 - 0.05 = 0.27 -> 0.3 * vmax', () => {
    const s = setup(P(0.32), [{ z: 10, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.speed).toBeCloseTo(0.3, 12);
  });

  it('speed loss scales with vmax', () => {
    // vmax 0.5: side loss 0.05*0.5 = 0.025; 0.4 - 0.025 = 0.375 (floor 0.15)
    const s = setup(P(0.4), [{ z: 10, x: 0.1, speed: 0.2 }]);
    step(
      s,
      s.cars.map(() => IDLE),
      TRACK,
      s.cars.map(() => ({ ...BP, vmax: 0.5 })),
    );
    expect(s.cars[0]!.speed).toBeCloseTo(0.375, 12);
  });
});

describe('R43 invulnerability window', () => {
  it('bumpTicks = round(bumpInvulnTime / DT) = 96 after a contact', () => {
    const s = setup(P(0.8), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    expect(s.cars[0]!.bumpTicks).toBe(96);
  });

  it('decrements by 1 per step down to 0, then stays 0', () => {
    // After the rear hit the player is at 0.7 vs traffic max(0.5, 0.8 + 0.1) = 0.9: the gap opens by
    // 0.1/tick, so the cars separate (|dz| >= 1.5) long before tick 96 and nothing re-triggers the counter.
    const s = setup(P(0.8), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    for (let k = 1; k <= BUMP_TICKS; k++) {
      stepOnce(s);
      expect(s.cars[0]!.bumpTicks).toBe(BUMP_TICKS - k);
    }
    stepOnce(s);
    expect(s.cars[0]!.bumpTicks).toBe(0);
  });

  it('after the counter reaches 0 a new contact can happen', () => {
    const s = setup(P(0.8), [{ z: 10.9, x: 0.1, speed: 0.5 }]);
    stepOnce(s);
    for (let k = 0; k < BUMP_TICKS; k++) stepOnce(s);
    const p = s.cars[0]!;
    expect(p.bumpTicks).toBe(0);
    // Place the (rails) traffic car so that the next step ends in a side contact:
    // after the step the player is at p.z + 0.2 (speed 0.4); the car at z + 0.2 + 0.25 - 0.25.
    const t = s.cars[1]!;
    t.speed = 0.4;
    Object.assign(t, { cruise: 0.4 }); // R41b
    t.x = p.x + 0.05;
    t.z = p.z; // after the step both advanced by 0.2 -> dz = 0
    const speedBefore = p.speed;
    stepOnce(s);
    expect(p.bumpTicks).toBe(BUMP_TICKS);
    expect(p.speed).toBeCloseTo(speedBefore - 0.05, 12); // side loss, above the floor 0.3
  });
});

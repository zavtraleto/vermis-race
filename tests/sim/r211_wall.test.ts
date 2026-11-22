import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/constants';
import { P, STRAIGHT, car0, frame, race1, rad, slipOf, stepN } from './r200_helpers';

// R211 wall and border (with R18): at |x| = xLimit travel and travelRate toward the border become 0,
// then |slip| <= slipMax again (heading pulled); impact angle (|travel| before zeroing) > wallKillAngle
// (5 deg) -> slip = 0, driftTimer = 0, wallTicks = 0.5 s (60 ticks at DT 1/120), slip held 0 meanwhile.
const WALL_TICKS = Math.round(0.5 / DT); // 60
const EPS = 1e-12;

describe('R211 wall and border', () => {
  it('R211: repro: vmax, straight, steer 1 for 0.5 s then 0, gas 1 for 5 s: no spin at the wall', () => {
    const s = race1({ speed: P.vmax });
    const c = car0(s);
    let prevZ = c.z;
    let prevTravel = c.travel;
    let hitTick = -1;
    let impact = 0;
    for (let i = 0; i < 600; i++) {
      stepN(s, 1, frame(i < 60 ? 1 : 0));
      expect(Math.abs(slipOf(c)), `tick ${i}`).toBeLessThanOrEqual(rad(P.slipMax) + 1e-9);
      expect(Math.abs(c.travel), `tick ${i}`).toBeLessThan(Math.PI / 2);
      expect(c.z, `tick ${i}`).toBeGreaterThan(prevZ); // keeps moving forward, never backward
      if (hitTick < 0 && Math.abs(c.x) === P.xLimit) {
        hitTick = i;
        impact = Math.abs(prevTravel);
      }
      if (hitTick >= 0 && i < hitTick + WALL_TICKS) {
        expect(Math.abs(slipOf(c)), `tick ${i} (wall)`).toBeLessThan(EPS);
      }
      prevZ = c.z;
      prevTravel = c.travel;
    }
    expect(hitTick).toBeGreaterThanOrEqual(0); // the scenario really reaches the wall
    expect(impact).toBeGreaterThan(rad(5)); // ... with a killing angle
  });

  for (const side of [1, -1]) {
    it(`R211: hit > 5 deg kills the slip and the drift, holds slip 0 for 0.5 s (side ${side})`, () => {
      // travel 20 deg toward the border, slip 6 deg, a live drift timer, travelRate toward the border
      const s = race1({
        speed: 1,
        x: side * (P.xLimit - 0.0005),
        travel: side * rad(20),
        heading: side * rad(26),
        travelRate: side * 1,
        steer: side,
        driftTimer: 50,
      });
      stepN(s, 1, frame(side));
      const c = car0(s);
      expect(c.x).toBe(side * P.xLimit);
      expect(Math.abs(c.travel)).toBeLessThan(EPS); // toward the border -> 0
      expect(c.travelRate * side).toBeLessThanOrEqual(0); // no rate toward the border left
      expect(Math.abs(slipOf(c))).toBeLessThan(EPS);
      expect(c.driftTimer).toBe(0);
      expect(c.wallTicks).toBeGreaterThanOrEqual(WALL_TICKS - 1);
      expect(c.wallTicks).toBeLessThanOrEqual(WALL_TICKS);
      // full steer into the wall would grow slip; it is held 0 while wallTicks > 0
      for (let i = 1; i < WALL_TICKS; i++) {
        stepN(s, 1, frame(side));
        if (c.wallTicks > 0) expect(Math.abs(slipOf(c)), `tick ${i}`).toBeLessThan(EPS);
      }
      expect(c.driftTimer).toBe(0);
    });
  }

  it('R211: shallow touch (< 5 deg) zeroes travel toward the border but keeps the slip', () => {
    // travel 3 deg toward the border, slip 6 deg: impact 3 deg (+ one tick of R207 catch-up) < 5 deg
    const s = race1({
      speed: 1,
      x: P.xLimit - 0.0005,
      travel: rad(3),
      heading: rad(9),
      driftTimer: 50,
    });
    stepN(s, 1, frame(0));
    const c = car0(s);
    expect(c.x).toBe(P.xLimit);
    expect(Math.abs(c.travel)).toBeLessThan(EPS);
    expect(Math.abs(slipOf(c))).toBeGreaterThan(rad(4));
    expect(c.driftTimer).toBeGreaterThan(0);
    expect(c.wallTicks).toBe(0);
  });

  it('R211: after zeroing travel |slip| <= slipMax again (heading is pulled), shallow touch', () => {
    // travel 3 deg, heading 75 deg: slip 72 deg; travel -> 0 would make it 75 deg > 73 deg
    const s = race1({ speed: 1, x: P.xLimit - 0.0005, travel: rad(3), heading: rad(75) });
    stepN(s, 1, frame(0));
    const c = car0(s);
    expect(Math.abs(c.travel)).toBeLessThan(EPS);
    expect(Math.abs(slipOf(c))).toBeLessThanOrEqual(rad(P.slipMax) + 1e-9);
    expect(Math.abs(slipOf(c))).toBeGreaterThan(rad(60)); // not killed: shallow impact
  });

  it('R211: away from the wall nothing is touched (|x| < xLimit)', () => {
    const s = race1({ speed: 1, x: 0, travel: rad(20), heading: rad(26), driftTimer: 50 });
    stepN(s, 1, frame(1), STRAIGHT);
    const c = car0(s);
    expect(c.wallTicks).toBe(0);
    expect(Math.abs(c.travel)).toBeGreaterThan(rad(10));
  });
});

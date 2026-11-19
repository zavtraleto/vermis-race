import { describe, expect, it } from 'vitest';
import { baseCarA as baseCar } from './baseCarA';
import { createRace, placeTraffic, step } from '../../src/sim/race';
import { makeStraightTrack } from '../../src/sim/track';
import type { InputFrame, RaceState, Track } from '../../src/sim/types';
import { BP, CFG, IDLE, LANES, TRACK, dz, setup, stepOnce } from './traffic_helpers';

const laneCentres: number[] = [];
for (let l = 0; l < LANES; l++) laneCentres.push(-1 + ((l + 0.5) * 2) / LANES);
const isLaneCentre = (x: number): boolean => laneCentres.some((c) => Math.abs(c - x) < 1e-9);
const trafficOf = (s: RaceState) => s.cars.filter((c) => c.kind === 'traffic');

describe('R70 traffic cars on rails', () => {
  it('createRace(seed, n, t) appends t traffic cars after the others, bumpTicks 0', () => {
    const s = createRace(1, 2, 3);
    expect(s.cars.length).toBe(5);
    expect(s.cars.slice(2).map((c) => c.kind)).toEqual(['traffic', 'traffic', 'traffic']);
    expect(s.cars.every((c) => c.bumpTicks === 0)).toBe(true);
  });

  it('keeps speed and x for 600 ticks on a curved track; z advances by R16', () => {
    // Curved track: every segment curve 2 (hard right). Player parked far behind (accel 0, speed 0).
    const curved: Track = { segments: Array.from({ length: 1000 }, () => ({ curve: 2 })) };
    const s = createRace(1, 1, 1);
    const t = s.cars[1]!;
    t.z = 100;
    t.x = -1 + (2.5 * 2) / LANES; // lane 2 centre = -0.375
    t.speed = 0.5;
    // 600 ticks * 0.5 * 0.5 * 60/120... z += speed*DT*60 = 0.5*0.5 = 0.25 per tick -> 150.
    for (let i = 0; i < 600; i++) {
      step(s, [IDLE, IDLE], curved, [BP, BP]);
    }
    expect(t.x).toBe(-0.375);
    expect(t.speed).toBe(0.5);
    expect(Math.abs(t.z - (100 + 600 * dz(0.5)))).toBeLessThan(1e-9);
    expect(t.z).toBeCloseTo(250, 9);
  });

  it('ignores steer, brake and drift inputs of its own index; never leaves GRIP', () => {
    const curved: Track = { segments: Array.from({ length: 1000 }, () => ({ curve: 2 })) };
    const s = createRace(1, 1, 1);
    const t = s.cars[1]!;
    t.z = 100;
    t.x = 0.25;
    t.speed = 0.5;
    const wild: InputFrame[] = [
      { steer: 1, brake: true, drift: true },
      { steer: -1, brake: false, drift: true },
      { steer: 1, brake: true, drift: false },
    ];
    for (let i = 0; i < 600; i++) {
      // traffic gets the player's params object (rails): accel/brake/steer numbers must not matter
      step(s, [IDLE, wild[i % 3]!], curved, [BP, { ...baseCar }]);
    }
    expect(t.x).toBe(0.25);
    expect(t.speed).toBe(0.5);
    expect(t.state).toBe('GRIP');
    expect(t.dir).toBe(0);
    expect(Math.abs(t.angle)).toBe(0);
    expect(Math.abs(t.vx)).toBe(0);
    expect(Math.abs(t.steer)).toBe(0);
    expect(Math.abs(t.heading)).toBe(0); // only R16 runs for traffic (R17 does not)
    expect(t.bumpTicks).toBe(0);
  });

  it('without a TrafficConfig traffic never respawns and the rng is untouched', () => {
    // Player at z=500 speed 0; traffic 35 behind it (beyond any despawn distance).
    const s = setup({ z: 500, x: 0, speed: 0 }, [{ z: 465, x: 0.25, speed: 0.5 }]);
    const rng = s.rng;
    for (let i = 0; i < 400; i++) stepOnce(s); // no traffic argument
    // setup() gives z after step 1 (465), so 400 steps in total = 399 further steps: 465 + 399 * 0.25
    expect(s.cars[1]!.z).toBeCloseTo(465 + 399 * dz(0.5), 9);
    expect(s.rng).toBe(rng);
  });
});

describe('R71 initial placement (placeTraffic)', () => {
  const place = (seed: number, playerZ = 0, vmax = 1) => {
    const s = createRace(seed, 1, CFG.trafficMax);
    s.cars[0]!.z = playerZ;
    placeTraffic(s, CFG, vmax);
    return s;
  };

  it('every traffic x is a lane centre -1 + (lane + 0.5) * 2 / lanes', () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const c of trafficOf(place(seed))) expect(isLaneCentre(c.x)).toBe(true);
    }
  });

  it('speeds lie in [min, max] * playerVmax', () => {
    // vmax 0.9: [0.4*0.9, 0.7*0.9] = [0.36, 0.63]
    for (let seed = 1; seed <= 20; seed++) {
      for (const c of trafficOf(place(seed, 0, 0.9))) {
        expect(c.speed).toBeGreaterThanOrEqual(0.36 - 1e-12);
        expect(c.speed).toBeLessThanOrEqual(0.63 + 1e-12);
      }
    }
  });

  it('first traffic car is at least trafficSpawnAhead ahead of the player', () => {
    for (let seed = 1; seed <= 20; seed++) {
      expect(place(seed, 0).cars[1]!.z).toBeGreaterThanOrEqual(100);
      expect(place(seed, 50).cars[1]!.z).toBeGreaterThanOrEqual(150); // player z = 50
    }
  });

  it('consecutive z gaps (in index order) lie in [gapMin, gapMax]', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const t = trafficOf(place(seed));
      expect(t.length).toBe(5);
      for (let i = 1; i < t.length; i++) {
        const gap = t[i]!.z - t[i - 1]!.z;
        expect(gap).toBeGreaterThanOrEqual(20 - 1e-9);
        expect(gap).toBeLessThanOrEqual(50 + 1e-9);
      }
    }
  });

  it('same seed gives the same layout, different seeds differ', () => {
    expect(JSON.stringify(place(5))).toBe(JSON.stringify(place(5)));
    expect(JSON.stringify(place(5))).not.toBe(JSON.stringify(place(6)));
  });

  it('does not touch the player', () => {
    const s = place(3);
    expect(s.cars[0]!.kind).toBe('player');
    expect(s.cars[0]!.z).toBe(0);
    expect(s.cars[0]!.speed).toBe(0);
  });
});

describe('R71 respawn in step', () => {
  // Player parked at z=500, speed 0 (BP accel 0). Distances are measured after the step; every
  // scenario starts the stale car >= 34.75 behind, so it respawns on tick 1 whether the check is
  // before or after R16 (despawnBehind = 30).
  const EPS = 0.5; // slack for whether the respawn offset is measured before or after the car's own R16 (<= 0.35)

  it('a car more than trafficDespawnBehind behind reappears beyond the furthest car by a gap in range', () => {
    const s = setup({ z: 500, x: 0, speed: 0 }, [
      { z: 700, x: 0.25, speed: 0.5 },
      { z: 465, x: -0.25, speed: 0.5 }, // 35 behind: respawns
      { z: 800, x: 0.75, speed: 0.5 }, // furthest: 800 after the step
    ]);
    stepOnce(s, undefined, CFG);
    const c = s.cars[2]!;
    // furthest car 3 is at 800 (+0.25 if it already moved); candidate in [800+20, 800+50]
    expect(c.z - 800).toBeGreaterThanOrEqual(20 - EPS);
    expect(c.z - 800).toBeLessThanOrEqual(50 + EPS);
    expect(c.z - 500).toBeGreaterThanOrEqual(100);
    expect(isLaneCentre(c.x)).toBe(true);
    expect(c.speed).toBeGreaterThanOrEqual(0.4 - 1e-12);
    expect(c.speed).toBeLessThanOrEqual(0.7 + 1e-12);
  });

  it('respawn is never closer than trafficSpawnAhead to the player; several respawn in index order', () => {
    const s = setup({ z: 500, x: 0, speed: 0 }, [
      { z: 520, x: 0.25, speed: 0.5 }, // furthest, only 20 ahead: furthest + gap = 540..570 < 600
      { z: 465, x: -0.25, speed: 0.5 }, // respawns first
      { z: 460, x: 0.75, speed: 0.5 }, // respawns second
    ]);
    stepOnce(s, undefined, CFG);
    const a = s.cars[2]!;
    const b = s.cars[3]!;
    expect(a.z - 500).toBeGreaterThanOrEqual(100 - EPS);
    expect(b.z - 500).toBeGreaterThanOrEqual(100 - EPS);
    // the second respawn is placed beyond the first (it is now the furthest car) by a gap in range
    expect(b.z - a.z).toBeGreaterThanOrEqual(20 - EPS);
    expect(b.z - a.z).toBeLessThanOrEqual(50 + EPS);
    for (const c of [a, b]) {
      expect(isLaneCentre(c.x)).toBe(true);
      expect(c.speed).toBeGreaterThanOrEqual(0.4 - 1e-12);
      expect(c.speed).toBeLessThanOrEqual(0.7 + 1e-12);
    }
  });

  it('rng advances when a respawn happens', () => {
    const s = setup({ z: 500, x: 0, speed: 0 }, [{ z: 465, x: 0.25, speed: 0.5 }]);
    const rng = s.rng;
    stepOnce(s, undefined, CFG);
    expect(s.rng).not.toBe(rng);
  });

  it('rng is untouched while no respawn happens', () => {
    const s = setup({ z: 500, x: 0, speed: 0 }, [
      { z: 600, x: 0.25, speed: 0.5 },
      { z: 650, x: -0.25, speed: 0.5 },
    ]);
    const rng = s.rng;
    for (let i = 0; i < 200; i++) stepOnce(s, undefined, CFG);
    expect(s.rng).toBe(rng);
  });

  it('determinism: two identical long runs give identical JSON; a JSON round-trip continues identically', () => {
    const fast = { ...BP, accel: 0, vmax: 1 };
    const build = (): RaceState => {
      const s = createRace(42, 1, CFG.trafficMax);
      placeTraffic(s, CFG, 1);
      const p = s.cars[0]!;
      // Player starts 150+ ahead of every placed car and sits at x = 1.4, outside every lane's hit
      // band (lane centres <= 0.875, R40 half-band 0.2 -> max 1.075), so no unintended contact (R40/R41)
      // can happen. All five cars are > trafficDespawnBehind behind, so they respawn (R71) at once.
      p.z = 400;
      p.x = 1.4;
      p.speed = 0.9;
      return s;
    };
    const track: Track = makeStraightTrack(1000);
    const run = (s: RaceState, n: number): void => {
      const params = s.cars.map(() => fast);
      const inputs = s.cars.map(() => IDLE);
      for (let i = 0; i < n; i++) step(s, inputs, track, params, CFG);
    };
    const a = build();
    const b = build();
    const rng0 = a.rng;
    run(a, 1500);
    run(b, 1500);
    expect(a.rng).not.toBe(rng0); // the scenario really contains respawns
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // R3: serialization round-trip in the middle of a run
    const c = build();
    run(c, 750);
    const d: RaceState = JSON.parse(JSON.stringify(c)) as RaceState;
    run(c, 750);
    run(d, 750);
    expect(JSON.stringify(c)).toBe(JSON.stringify(d));
  });
});

describe('Regression: trafficCount 0', () => {
  it('createRace(seed, n) equals createRace(seed, n, 0) and contains only player/rival', () => {
    expect(JSON.stringify(createRace(3, 2, 0))).toBe(JSON.stringify(createRace(3, 2)));
    expect(createRace(3, 2, 0).cars.some((c) => c.kind === 'traffic')).toBe(false);
  });

  it('passing a TrafficConfig with no traffic cars changes nothing', () => {
    const a = createRace(3, 1, 0);
    const b = createRace(3, 1, 0);
    const p = { ...baseCar };
    for (let i = 0; i < 300; i++) {
      const input: InputFrame = { steer: Math.sin(i / 20), brake: false, drift: i > 100 };
      step(a, [input], TRACK, [p]);
      step(b, [input], TRACK, [p], CFG);
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

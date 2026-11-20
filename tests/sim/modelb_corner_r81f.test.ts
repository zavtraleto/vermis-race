import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/constants';
import { createRace } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState, Track } from '../../src/sim/types';
import { Lcg, V5, custom, mirror, stepV } from './corner_helpers';
import { Q, STRAIGHT, car, constTrack, inp, mk, slipOf } from './modelb_helpers';

// Spec: docs/brief.md R81f (drift in every corner, driftEntry 5, H16 = F), R83c (drift size by the
// corner), R86f (no speed loss in DRIFT), with R82 / R82b / R48 as they stand. Written from the brief.
// Rule tests use Q (model B, accel 0, slipDrag 0, gripScrub 0, driftTurbo 0, T68 rules off: gripDodge 0,
// driftMinU 0, leadRamp 0, debtTime 0; gripLead 0; lamps off) plus the T71 numbers and driftSpeedLoss 0
// (R86f): speed then stays exactly constant, so every number below is hand-computable.
//
// Q numbers: vmax 1, kYaw 2, driftEnterSpeed 0.45, driftExitSpeed 0.3, kickBase 2, slipFull 2.64,
// slipResponse 8, driftLat 0.46, driftPush 0.0287, driftLead 1.25 (base), latScale 1, DT = 1/120.
// T71: cornerCurve 0.5, cornerGap 30, cornerSpan 0.5, cornerMinU 0.1.
// R83c: h = min(1, driftPush*max(0, A*dir)/driftLat), A = curve*sp*kYaw (sp 1: A = 2*curve):
//   easy 2   -> A 4    -> h = 0.0287*4/0.46    = 0.249565
//   medium 4.5 -> A 9  -> h = 0.0287*9/0.46    = 0.561522
//   hard 7   -> A 14   -> h = 0.0287*14/0.46   = 0.873478
//   sharp 8.3 -> A 16.6 -> 0.0287*16.6/0.46   = 1.035739 -> 1
//   uc = clamp(h + 0.5*u, 0.1, 1), u = clamp(steer*dir, -1, 1).
// Entry tick from rest (yaw = vel = carry = yawRate = 0): yawRate = dir*kickBase = 2*dir (R81b C), then
//   R83 DRIFT: yawRate += (64*(slipT - 0) - 16*yawRate)*DT, slipT = dir*2.64*uc; slip = yawRate*DT.

const P5 = { ...Q, ...V5, driftSpeedLoss: 0, debtTime: 0 } as CarParams;
/** Walls and off-road loss removed (R15 would change speed and so A). */
const F5 = { ...P5, xLimit: 1e9, offroadMul: 1 } as CarParams;
const H = (p: CarParams, over: Record<string, number>): CarParams =>
  ({ ...p, ...over }) as CarParams;

const hOf = (curve: number, dir: number, sp = 1): number =>
  Math.min(1, (0.0287 * Math.max(0, curve * sp * 2 * dir)) / 0.46);
const ucOf = (curve: number, dir: number, steer: number, sp = 1): number =>
  Math.min(1, Math.max(0.1, hOf(curve, dir, sp) + 0.5 * Math.max(-1, Math.min(1, steer * dir))));
const entryYawRate = (dir: number, uc: number): number =>
  2 * dir + (64 * dir * 2.64 * uc - 16 * 2 * dir) * DT;

const st1 = (s: RaceState, f: InputFrame, p: CarParams = P5, t: Track = STRAIGHT): void =>
  stepV(s, [f], t, [p]);
const stN = (s: RaceState, n: number, f: InputFrame, p: CarParams = P5, t: Track = STRAIGHT) => {
  for (let i = 0; i < n; i++) stepV(s, [f], t, [p]);
};
const segOf = (c: Car, t: Track): number => {
  const n = t.segments.length;
  return ((Math.floor(c.z) % n) + n) % n;
};
/** State after exactly one step from a fresh GRIP car. */
function once(over: Partial<Car>, f: InputFrame, t: Track, p: CarParams = P5): Car {
  const s = mk({ speed: 1, z: 10, ...over });
  st1(s, f, p, t);
  return car(s);
}
type Tr = { tick: number; seg: number; to: string; dir: number };
/** Runs `n` ticks with a constant input, recording state changes with the start-of-tick segment. */
function trace(s: RaceState, n: number, f: (i: number) => InputFrame, t: Track, p = F5): Tr[] {
  const out: Tr[] = [];
  for (let i = 0; i < n; i++) {
    const c = car(s);
    const seg = segOf(c, t);
    const was = c.state;
    st1(s, f(i), p, t);
    if (c.state !== was) out.push({ tick: s.tick, seg, to: c.state, dir: c.dir });
  }
  return out;
}
const phys = (c: Car) => ({
  state: c.state,
  dir: c.dir,
  x: c.x,
  z: c.z,
  speed: c.speed,
  vx: c.vx,
  steer: c.steer,
  heading: c.heading,
  angle: c.angle,
  yaw: c.yaw,
  yawRate: c.yawRate,
  vel: c.vel,
  carry: c.carry,
  driftTicks: c.driftTicks,
  scrubDebt: c.scrubDebt,
});

// ------------------------------------------------------------------------------------------------
describe('R81f corner segment: |curve| >= cornerCurve, cornerSide = sign(curve), else 0', () => {
  it('curve 0.5 (= cornerCurve) enters with dir +1; 0.49 stays GRIP', () => {
    const a = once({}, inp(0, true), constTrack(0.5));
    expect(a.state).toBe('DRIFT');
    expect(a.dir).toBe(1);
    expect(once({}, inp(0, true), constTrack(0.49)).state).toBe('GRIP');
  });
  it('curve -0.5 enters with dir -1; -0.49 stays GRIP', () => {
    const a = once({}, inp(0, true), constTrack(-0.5));
    expect(a.state).toBe('DRIFT');
    expect(a.dir).toBe(-1);
    expect(once({}, inp(0, true), constTrack(-0.49)).state).toBe('GRIP');
  });
  it('cornerCurve is a parameter: cornerCurve 2 -> curve 1.99 GRIP, 2 DRIFT', () => {
    const p = H(P5, { cornerCurve: 2 });
    expect(once({}, inp(0, true), constTrack(1.99), p).state).toBe('GRIP');
    expect(once({}, inp(0, true), constTrack(2), p).state).toBe('DRIFT');
  });
  it('a straight (curve exactly 0) never enters, whatever the steer', () => {
    for (const st of [-1, -0.5, 0, 0.5, 1])
      expect(once({}, inp(st, true), STRAIGHT).state).toBe('GRIP');
  });
});

describe('R81f entry: GRIP + input.drift + corner segment + speed -> DRIFT in the same tick', () => {
  it('enters on the very first tick, no history and no time held needed', () => {
    for (const curve of [0.5, 2, 4.5, 7, 8.3, 20]) {
      const c = once({}, inp(0, true), constTrack(curve));
      expect(c.state).toBe('DRIFT');
    }
  });
  it('the side is the corner side, never the steer side (steer with, against, 0; both sides)', () => {
    for (const side of [1, -1] as const) {
      for (const st of [-1, -0.3, 0, 0.3, 1]) {
        const c = once({}, inp(st, true), constTrack(7 * side));
        expect(c.state).toBe('DRIFT');
        expect(c.dir).toBe(side);
      }
    }
  });
  it('input.drift false never enters (240 ticks of full steer into a hard corner)', () => {
    const s = mk({ speed: 1, z: 10 });
    for (let i = 0; i < 240; i++) {
      st1(s, inp(1, false), F5, constTrack(7));
      expect(car(s).state).toBe('GRIP');
    }
  });
  it('speed > driftEnterSpeed*vmax strictly (start-of-step speed): 0.45 GRIP, 0.4501 DRIFT', () => {
    expect(once({ speed: 0.45 }, inp(0, true), constTrack(7)).state).toBe('GRIP');
    expect(once({ speed: 0.4501 }, inp(0, true), constTrack(7)).state).toBe('DRIFT');
  });
  it('in a crash (crashTicks > 0) it does not enter', () => {
    const c = once({ crashTicks: 50, crashSpeed0: 1 }, inp(0, true), constTrack(7));
    expect(c.state).toBe('GRIP');
  });
  it('start-of-step z decides: z 99.75 (segment 99 straight) GRIP, the next tick (z 100.25) DRIFT', () => {
    const t = custom(4000, [[100, 200, 7]]);
    const s = mk({ speed: 1, z: 99.75 });
    st1(s, inp(0, true), P5, t);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).z).toBeCloseTo(100.25, 12); // z += speed*SEG_PER_UNIT*DT = 0.5
    st1(s, inp(0, true), P5, t);
    expect(car(s).state).toBe('DRIFT');
  });
  it('entry effects as R81b C: from rest, yawRate = dir*kickBase, then R83 with the R83c share (hand numbers)', () => {
    // [curve, steer, uc]: hard 0 -> 0.873478; hard -1 -> 0.373478; easy -1 -> 0.1 (floor);
    // sharp 0 -> 1 (cap); medium (left, -4.5) steer +1 (against) -> 0.561522 - 0.5 = 0.0615 -> 0.1
    const cases: [number, number][] = [
      [7, 0],
      [7, -1],
      [2, -1],
      [8.3, 0],
      [-4.5, 1],
      [-7, 0.4],
    ];
    for (const [curve, st] of cases) {
      const dir = Math.sign(curve);
      const uc = ucOf(curve, dir, st);
      const yr = entryYawRate(dir, uc);
      const c = once({}, inp(st, true), constTrack(curve));
      expect(c.state).toBe('DRIFT');
      expect(c.dir).toBe(dir);
      expect(c.yawRate).toBeCloseTo(yr, 9);
      expect(slipOf(c)).toBeCloseTo(yr * DT, 9);
      expect(c.angle).toBeCloseTo((yr * DT) / 2.64, 9);
      expect(c.driftTicks).toBe(1); // R86e/R87: 0 on entry, +1 at the end of the DRIFT tick
      expect(c.scrubDebt).toBe(0);
    }
    // spot values: hard steer 0: 2 + (64*2.305983 - 32)/120 = 2.963193; easy -1: 2 + (16.896 - 32)/120 = 1.874133
    expect(entryYawRate(1, ucOf(7, 1, 0))).toBeCloseTo(2.963193, 5);
    expect(entryYawRate(1, ucOf(2, 1, -1))).toBeCloseTo(1.874133, 5);
  });
  it('entry with carry: slip0 = dir*max(0, vis*dir), yaw = vel + slip0, carry = vis - slip0 (as R81b C)', () => {
    // vis = yaw - vel + carry = 0.3 - 0.1 + 0.05 = 0.25, dir +1 -> slip0 0.25, carry 0
    // dir -1 (left corner): slip0 = -max(0, -0.25) = 0, carry 0.25
    for (const [curve, slip0, carry0] of [
      [7, 0.25, 0],
      [-7, 0, 0.25],
    ] as const) {
      const c = once({ yaw: 0.3, vel: 0.1, carry: 0.05 }, inp(0, true), constTrack(curve));
      const dir = Math.sign(curve);
      expect(c.state).toBe('DRIFT');
      expect(c.carry).toBeCloseTo(carry0 * Math.exp(-8 * DT), 9); // R82b decays the new carry
      // R83 from slip0 with yawRate = 2*dir: yawRate' = 2dir + (64*(slipT - slip0) - 32dir)*DT
      const slipT = dir * 2.64 * ucOf(curve, dir, 0);
      const yr = 2 * dir + (64 * (slipT - slip0) - 32 * dir) * DT;
      expect(c.yawRate).toBeCloseTo(yr, 9);
      expect(slipOf(c)).toBeCloseTo(slip0 + yr * DT, 9);
    }
  });
  it('the steer buffer is not written; armTicks and autoTicks stay 0 in variant 5', () => {
    const s = mk({ speed: 1, z: 10 });
    const t = custom(4000, [
      [30, 60, 7],
      [150, 60, -7],
    ]);
    for (let i = 0; i < 600; i++) {
      st1(s, inp(i % 50 < 25 ? 1 : -1, i % 90 > 10), F5, t);
      expect(car(s).steerHistCount).toBe(0);
      expect(car(s).armTicks).toBe(0);
      expect(car(s).autoTicks).toBe(0);
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe('R81f hold and corner end (cornerGap segments ahead, start-of-step segment)', () => {
  // Car GRIP at z 140, speed 1 (0.5 segment per tick), finger held, steer 0. Corner +7 on [100, 150).
  const run = (t: Track, p: CarParams = F5, n = 700): Tr[] => {
    const s = mk({ speed: 1, z: 140 });
    return trace(s, n, () => inp(0, true), t, p);
  };
  it('gap of 30 straight segments (= cornerGap) inside one corner: one entry, no exit in the gap', () => {
    const tr = run(
      custom(4000, [
        [100, 50, 7],
        [180, 100, 7],
      ]),
    );
    expect(tr[0]).toMatchObject({ to: 'DRIFT', dir: 1, seg: 140 });
    expect(tr.length).toBe(2); // the only exit is the end of the second part
    expect(tr[1]).toMatchObject({ to: 'GRIP', seg: 280 });
  });
  it('gap of 31: the corner ends on the first gap segment (150), new entry on segment 181', () => {
    const tr = run(
      custom(4000, [
        [100, 50, 7],
        [181, 100, 7],
      ]),
    );
    expect(tr.map((x) => [x.to, x.seg])).toEqual([
      ['DRIFT', 140],
      ['GRIP', 150],
      ['DRIFT', 181],
      ['GRIP', 281],
    ]);
  });
  it('cornerGap is a parameter in segments: cornerGap 10 holds a 10-gap and ends an 11-gap', () => {
    const p = H(F5, { cornerGap: 10 });
    const a = run(
      custom(4000, [
        [100, 50, 7],
        [160, 50, 7],
      ]),
      p,
    );
    expect(a.length).toBe(2);
    const b = run(
      custom(4000, [
        [100, 50, 7],
        [161, 50, 7],
      ]),
      p,
    );
    expect(b.map((x) => x.seg)).toEqual([140, 150, 161, 211]);
  });
  it('only corner segments count in the gap: a same-side curve 0.4 (< cornerCurve) does not hold', () => {
    const tr = run(
      custom(4000, [
        [100, 50, 7],
        [150, 20, 0.4],
      ]),
    );
    expect(tr.map((x) => [x.to, x.seg])).toEqual([
      ['DRIFT', 140],
      ['GRIP', 150],
    ]);
  });
  it('the first corner segment ahead decides: other side first (even with a same-side one later) -> end', () => {
    const tr = run(
      custom(4000, [
        [100, 50, 7],
        [160, 5, -7],
        [165, 100, 7],
      ]),
    );
    expect(tr.slice(0, 3).map((x) => [x.to, x.seg, x.dir])).toEqual([
      ['DRIFT', 140, 1],
      ['GRIP', 150, 0],
      ['DRIFT', 160, -1],
    ]);
  });
  it('cornerSide(seg) = -dir ends the drift at once (direct S-bend: exactly one GRIP tick, then the other side)', () => {
    const s = mk({ speed: 1, z: 149 });
    const t = custom(4000, [
      [100, 50, 7],
      [150, 100, -7],
    ]);
    const tr = trace(s, 4, () => inp(0, true), t);
    // tick 1: z 149 (seg 149, +7) -> DRIFT +1; tick 2: z 149.5 seg 149 hold; tick 3: z 150 seg 150 (-7) -> GRIP;
    // tick 4: z 150.5, state GRIP at the start -> enters with dir -1.
    expect(tr.map((x) => [x.tick, x.to, x.dir])).toEqual([
      [1, 'DRIFT', 1],
      [3, 'GRIP', 0],
      [4, 'DRIFT', -1],
    ]);
  });
  it('the look-ahead wraps over the lap: track 400, +7 on [370, 400) and [10, 100): one drift across the line', () => {
    const t = custom(400, [
      [370, 30, 7],
      [10, 90, 7],
    ]);
    const s = mk({ speed: 1, z: 360 });
    const tr = trace(s, 300, () => inp(0, true), t);
    expect(tr.map((x) => [x.to, x.seg])).toEqual([
      ['DRIFT', 370],
      ['GRIP', 100],
    ]);
  });
  it('steer does not end the drift: -1, 0, +1 held in a hard corner keep DRIFT and dir', () => {
    const s = mk({ speed: 1, z: 10 });
    for (const st of [-1, 0, 1, -1]) {
      for (let i = 0; i < 60; i++) {
        st1(s, inp(st, true), F5, constTrack(7));
        expect(car(s).state).toBe('DRIFT');
        expect(car(s).dir).toBe(1);
      }
    }
  });
});

describe('R81f corner end: GRIP with the R82 effects, nothing paid', () => {
  const pre: Partial<Car> = {
    speed: 1,
    z: 10,
    state: 'DRIFT',
    dir: 1,
    driftHeld: true,
    yaw: 0.8,
    vel: 0.1,
    carry: 0.05,
    yawRate: 0.3,
  };
  // curve 0.4 under the car: not a corner segment, nothing ahead -> corner over; A = 0.4*1*2 = 0.8.
  const T04 = constTrack(0.4);
  it('the corner-end exit (finger held) equals the release exit (R82) on the same state, exactly', () => {
    const a = mk(pre);
    st1(a, inp(0.3, true), P5, T04);
    const b = mk(pre);
    st1(b, inp(0.3, false), P5, T04);
    expect(car(a).state).toBe('GRIP');
    expect(car(a).dir).toBe(0);
    expect(phys(car(a))).toEqual(phys(car(b)));
  });
  it('control: the same state on a corner segment (curve 0.5) stays DRIFT', () => {
    const a = mk(pre);
    st1(a, inp(0.3, true), P5, constTrack(0.5));
    expect(car(a).state).toBe('DRIFT');
  });
  it('corner end and release in the same tick give one exit, the same as the release alone', () => {
    const a = mk(pre);
    st1(a, inp(0, false), P5, STRAIGHT);
    const b = mk(pre);
    st1(b, inp(0, false), P5, T04);
    expect(car(a).state).toBe('GRIP');
    expect(car(b).state).toBe('GRIP');
  });
  it('nothing paid: speed is unchanged by the corner-end exit (Q: no other speed term), scrubDebt and driftTicks 0', () => {
    for (const debtTime of [0, 0.5]) {
      // debtTime 0.5 too: R86e pays only on R82 exits (release / speed), not on the end of a corner
      const s = mk({ ...pre, scrubDebt: 0.2, driftTicks: 3 } as Partial<Car>);
      st1(s, inp(0, true), H(P5, { debtTime, gripScrub: 1 }), STRAIGHT);
      expect(car(s).state).toBe('GRIP');
      expect(car(s).speed).toBe(1);
      expect(car(s).scrubDebt).toBe(0);
      expect(car(s).driftTicks).toBe(0);
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe('R81f release and re-touch (R82 unchanged, no armTicks block in variant 5)', () => {
  const HARD = constTrack(7);
  const drifting = (): RaceState => {
    const s = mk({ speed: 1, z: 10 });
    stN(s, 240, inp(0, true), F5, HARD);
    expect(car(s).state).toBe('DRIFT');
    return s;
  };
  for (const gap of [1, 6, 36, 72]) {
    it(`release ${gap} tick(s): GRIP on the first release tick, DRIFT again on the first touch tick`, () => {
      const s = drifting();
      st1(s, inp(0, false), F5, HARD);
      expect(car(s).state).toBe('GRIP');
      expect(car(s).dir).toBe(0);
      stN(s, gap - 1, inp(0, false), F5, HARD);
      expect(car(s).state).toBe('GRIP');
      st1(s, inp(-1, true), F5, HARD);
      expect(car(s).state).toBe('DRIFT');
      expect(car(s).dir).toBe(1);
      expect(car(s).armTicks).toBe(0);
    });
  }
  it('exit by speed while held: GRIP (R82, speed 0.29 < 0.3), no block; entry as soon as speed > 0.45', () => {
    const s = mk({ speed: 0.29, z: 10, state: 'DRIFT', dir: 1, driftHeld: true, yaw: 0.5 });
    st1(s, inp(0, true), F5, HARD);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).armTicks).toBe(0);
    stN(s, 30, inp(0, true), F5, HARD);
    expect(car(s).state).toBe('GRIP'); // 0.29 < driftEnterSpeed
    car(s).speed = 0.46;
    st1(s, inp(0, true), F5, HARD); // finger never released
    expect(car(s).state).toBe('DRIFT');
  });
  it('hysteresis: DRIFT at 0.3 and 0.4 stays DRIFT; GRIP at 0.4 held does not enter', () => {
    for (const v of [0.3, 0.4]) {
      const s = mk({ speed: v, z: 10, state: 'DRIFT', dir: 1, driftHeld: true, yaw: 0.5 });
      st1(s, inp(0, true), F5, HARD);
      expect(car(s).state).toBe('DRIFT');
    }
    expect(once({ speed: 0.4 }, inp(0, true), HARD, F5).state).toBe('GRIP');
  });
});

// ------------------------------------------------------------------------------------------------
describe('R81f straights never drift, for any input (straight road)', () => {
  const pats: ReadonlyArray<
    readonly [string, (i: number, r: Lcg, st: { v: number; u: number }) => number]
  > = [
    ['full lock +1', () => 1],
    ['full lock -1', () => -1],
    ['steer 0', () => 0],
    ['weave 0.2 s', (i) => (Math.floor(i / 24) % 2 ? 1 : -1)],
    ['weave 1 s', (i) => (Math.floor(i / 120) % 2 ? 1 : -1)],
    [
      'seeded random',
      (i, r, st) => {
        if (i >= st.u) {
          st.v = r.next() * 2 - 1;
          st.u = i + 6 + Math.floor(r.next() * 120);
        }
        return st.v;
      },
    ],
  ];
  for (const [name, fn] of pats) {
    it(`${name}, finger held 20 s at 0.5-1.0 vmax: 0 DRIFT ticks`, () => {
      for (const sp of [0.5, 1]) {
        for (let seed = 1; seed <= 3; seed++) {
          const s = mk({ speed: sp, z: 10 });
          const r = new Lcg(seed);
          const st = { v: 0, u: 0 };
          for (let i = 0; i < 20 / DT; i++) {
            st1(s, inp(fn(i, r, st), true), F5, STRAIGHT);
            expect(car(s).state).toBe('GRIP');
          }
        }
      }
    });
  }
});

// ------------------------------------------------------------------------------------------------
describe('R83c drift share by the corner: uc = clamp(h + cornerSpan*u, cornerMinU, 1)', () => {
  /** Steady DRIFT after 8 s on a constant curve at constant speed 1 (Q), steer `st`
   * (slip chase: critically damped at 8/s; vel chase velGripDrift 3/s: e^(-24) left). */
  const steady = (curve: number, st: number, p: CarParams = F5): Car => {
    const s = mk({ speed: 1, z: 10 });
    stN(s, 960, inp(st, true), p, constTrack(curve));
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).speed).toBe(1); // precondition: constant speed (R86f, Q)
    return car(s);
  };
  it('h at vmax per class: easy 0.25, medium 0.56, hard 0.87, sharp 1 (1.04 cut); at 0.6 vmax 0.15 / 0.34 / 0.52 / 0.62', () => {
    expect(hOf(2, 1)).toBeCloseTo(0.25, 2);
    expect(hOf(4.5, 1)).toBeCloseTo(0.56, 2);
    expect(hOf(7, 1)).toBeCloseTo(0.87, 2);
    expect((0.0287 * 16.6) / 0.46).toBeCloseTo(1.04, 2);
    expect(hOf(8.3, 1)).toBe(1);
    expect(hOf(2, 1, 0.6)).toBeCloseTo(0.15, 2);
    expect(hOf(4.5, 1, 0.6)).toBeCloseTo(0.34, 2);
    expect(hOf(7, 1, 0.6)).toBeCloseTo(0.52, 2);
    expect(hOf(8.3, 1, 0.6)).toBeCloseTo(0.62, 2);
  });
  const cases: [number, number][] = [
    [2, 0],
    [2, 1],
    [2, -1],
    [4.5, 0],
    [4.5, 0.6],
    [4.5, -0.6],
    [7, 0],
    [7, 0.3],
    [7, -1],
    [8.3, 0],
    [8.3, -1],
    [8.3, -0.2],
  ];
  for (const side of [1, -1] as const) {
    it(`steady angle*dir = uc for every class and steer (side ${side}); angle never below cornerMinU 0.1`, () => {
      for (const [cv, st] of cases) {
        const c = steady(cv * side, st * side);
        const uc = ucOf(cv, 1, st);
        expect(c.dir).toBe(side);
        expect(c.angle * side).toBeCloseTo(uc, 6);
        expect(c.angle * side).toBeGreaterThanOrEqual(0.1 - 1e-9);
      }
    });
  }
  it('hand values: easy -1 -> 0.1 (floor), medium +0.6 -> 0.861522, hard -1 -> 0.373478, sharp -0.2 -> 0.9', () => {
    expect(ucOf(2, 1, -1)).toBe(0.1);
    expect(ucOf(4.5, 1, 0.6)).toBeCloseTo(0.861522, 6);
    expect(ucOf(7, 1, -1)).toBeCloseTo(0.373478, 6);
    expect(ucOf(8.3, 1, -0.2)).toBeCloseTo(0.9, 9);
  });
  it('steer 0 holds the road: steady vel = 0 in easy, medium, hard (R84: 0.46*h - 0.0287*A = 0)', () => {
    for (const cv of [2, 4.5, 7]) expect(steady(cv, 0).vel).toBeCloseTo(0, 4);
    // sharp: h cut to 1 -> velT = 0.46 - 0.0287*16.6 = -0.016420 (slightly outward)
    expect(steady(8.3, 0).vel).toBeCloseTo(0.46 - 0.0287 * 16.6, 4);
  });
  it('steer into the corner moves the line in, against moves it out (steady vel monotone in steer, hard)', () => {
    let last = -Infinity;
    for (const st of [-1, -0.5, 0, 0.2]) {
      const v = steady(7, st).vel;
      expect(v).toBeGreaterThan(last);
      last = v;
    }
  });
  it('driftMinU is not used in variant 5: driftMinU 0.9 gives the same steady angle (easy steer -1 -> 0.1)', () => {
    const c = steady(2, -1, H(F5, { driftMinU: 0.9 }));
    expect(c.angle).toBeCloseTo(0.1, 6);
  });
  it('cornerSpan and cornerMinU are parameters: span 0.3 hard -1 -> 0.573478; minU 0.3 easy -1 -> 0.3', () => {
    expect(steady(7, -1, H(F5, { cornerSpan: 0.3 })).angle).toBeCloseTo(0.873478 - 0.3, 5);
    expect(steady(2, -1, H(F5, { cornerMinU: 0.3 })).angle).toBeCloseTo(0.3, 6);
  });
  it('in a same-side gap (curve 0, A = 0) h = 0: the share is max(cornerMinU, cornerSpan*u)', () => {
    // DRIFT dir +1 held over a 30-segment straight gap between two +7 parts; steer +1 -> uc 0.5 there.
    // Speed 0.5 (> 0.45): 0.25 segment per tick. Corner [100, 150): 200 ticks, the slip settles at
    // 2.64*min(1, 0.0287*7/0.46 + 0.5) = 2.64*0.936739 = 2.472991. Gap [150, 180): 120 ticks (1 s);
    // the critically damped chase (8/s) toward 2.64*0.5 = 1.32 leaves (1 + 8t)e^(-8t) ~ 0.003 of the step.
    const t = custom(4000, [
      [100, 50, 7],
      [180, 100, 7],
    ]);
    const s = mk({ speed: 0.5, z: 100 });
    stN(s, 200, inp(1, true), F5, t); // to z 150
    expect(car(s).state).toBe('DRIFT');
    expect(slipOf(car(s))).toBeCloseTo(2.64 * ucOf(7, 1, 1, 0.5), 2);
    stN(s, 118, inp(1, true), F5, t); // z 179.5: still in the gap
    expect(car(s).state).toBe('DRIFT');
    expect(Math.abs(slipOf(car(s)) - 1.32)).toBeLessThan(0.02);
  });
  it('R85 lead uses this uc: vx - vel*sp = dir*driftLead*(uc - angle*dir) on every DRIFT tick (leadRamp 0)', () => {
    for (const side of [1, -1] as const) {
      const s = mk({ speed: 1, z: 10 });
      for (let i = 0; i < 90; i++) {
        const st = side * (i < 30 ? 0 : i < 60 ? -1 : 0.4);
        st1(s, inp(st, true), F5, constTrack(7 * side));
        const c = car(s);
        expect(c.state).toBe('DRIFT');
        const uc = ucOf(7, 1, st * side);
        expect(c.vx - c.vel).toBeCloseTo(side * 1.25 * (uc - c.angle * side), 9);
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe('R86f no speed loss in DRIFT: cap = vcap*capMul, driftSpeedLoss 0', () => {
  const PA = { ...P5, accel: 0.22 } as CarParams; // with throttle, still slipDrag 0
  it('full slip (angle 1) at 0.9 vmax accelerates by accel*DT (old R86 cap 1 - loss would brake)', () => {
    const s = mk({ speed: 0.9, z: 10, state: 'DRIFT', dir: 1, driftHeld: true, yaw: 2.64, vel: 0 });
    st1(s, inp(1, true), PA, constTrack(8.3));
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).speed).toBeCloseTo(0.9 + 0.22 * DT, 12);
  });
  it('a steady drift at vmax keeps exactly vmax in every class and steer', () => {
    for (const cv of [0.5, 2, 4.5, 7, 8.3])
      for (const st of [-1, 0, 1]) {
        const s = mk({ speed: 1, z: 10 });
        stN(
          s,
          240,
          inp(st, true),
          { ...PA, xLimit: 1e9, offroadMul: 1 } as CarParams,
          constTrack(cv),
        );
        expect(car(s).state).toBe('DRIFT');
        expect(car(s).speed).toBe(1);
      }
  });
  it('R52 flow works in DRIFT as in GRIP: draft 1 -> cap vmax*draftCapMul 1.13, accel*draftAccelMul', () => {
    // traffic car 10 segments ahead in the cone (draftLength 80, draftWidth 0.25): 1 + 0.22*1.6*DT
    for (const drift of [false, true]) {
      const s = createRace(1, 1, 1);
      Object.assign(car(s), {
        speed: 1,
        z: 10,
        draft: 1,
        ...(drift ? { state: 'DRIFT', dir: 1, driftHeld: true, yaw: 1.32 } : {}),
      });
      const t = s.cars[1]!;
      t.z = 20;
      t.x = 0;
      t.speed = 0.5;
      stepV(s, [inp(drift ? 0.5 : 0, drift), inp(0)], constTrack(drift ? 2 : 0), [PA, PA]);
      expect(car(s).state).toBe(drift ? 'DRIFT' : 'GRIP');
      expect(car(s).speed).toBeCloseTo(1 + 0.22 * 1.6 * DT, 12);
    }
  });
  it('above the cap the speed still falls by driftBrake*DT in DRIFT (1.1 -> 1.1 - 0.3*DT)', () => {
    const s = mk({ speed: 1.1, z: 10, state: 'DRIFT', dir: 1, driftHeld: true, yaw: 1.32 });
    st1(s, inp(0.5, true), PA, constTrack(4.5));
    expect(car(s).speed).toBeCloseTo(1.1 - 0.3 * DT, 12);
  });
  it('the brake still slows a drift: 0.8 -> 0.8 - 0.6*DT', () => {
    const s = mk({ speed: 0.8, z: 10, state: 'DRIFT', dir: 1, driftHeld: true, yaw: 1.32 });
    st1(s, inp(0.5, true, true), PA, constTrack(4.5));
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).speed).toBeCloseTo(0.8 - 0.6 * DT, 12);
  });
  it('R15 off the road still costs speed in DRIFT (x 1.2): (0.8 + 0.22*DT)*0.99^(60*DT)', () => {
    const s = mk({ speed: 0.8, z: 10, x: 1.2, state: 'DRIFT', dir: 1, driftHeld: true, yaw: 1.32 });
    st1(s, inp(0.5, true), { ...PA, offroadMul: 0.99 } as CarParams, constTrack(4.5));
    expect(car(s).speed).toBeCloseTo((0.8 + 0.22 * DT) * Math.pow(0.99, 60 * DT), 12);
  });
  it('a rear hit on traffic (R41) still costs speed in DRIFT', () => {
    const hit = (withTraffic: boolean): number => {
      const s = createRace(1, 1, 1);
      Object.assign(car(s), {
        speed: 1,
        z: 10,
        state: 'DRIFT',
        dir: 1,
        driftHeld: true,
        yaw: 1.32,
      });
      const t = s.cars[1]!;
      t.z = withTraffic ? 10.6 : 900;
      t.x = 0;
      t.speed = 0.5;
      stepV(s, [inp(0.5, true), inp(0)], constTrack(4.5), [PA, PA]);
      return car(s).speed;
    };
    expect(hit(false)).toBe(1);
    expect(hit(true)).toBeLessThan(1 - 0.01);
  });
  it('R86b does not act in DRIFT (gripScrub 1, hard at vmax: need 1.49 > 0.8): speed stays 1', () => {
    const s = mk({ speed: 1, z: 10 });
    stN(s, 240, inp(0, true), H(F5, { gripScrub: 1 }), constTrack(7));
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).speed).toBe(1);
    expect(car(s).scrubDebt).toBe(0);
  });
  it('R86b still acts in GRIP in the same corner (finger up): speed falls', () => {
    const s = mk({ speed: 1, z: 10 });
    stN(s, 60, inp(1, false), H(F5, { gripScrub: 1 }), constTrack(7));
    expect(car(s).speed).toBeLessThan(0.99);
  });
  it('entering the drift does not change speed (entry tick, Q)', () => {
    expect(once({ speed: 0.77 }, inp(0, true), constTrack(7)).speed).toBe(0.77);
  });
  it('carry costs no speed after an exit: the same run with the carry zeroed on the exit tick keeps the same speed', () => {
    const PD = { ...PA, slipDrag: 0.058, xLimit: 1e9, offroadMul: 1 } as CarParams;
    const go = (zero: boolean): number[] => {
      const s = mk({ speed: 0.8, z: 10 });
      stN(s, 120, inp(0, true), PD, constTrack(7));
      st1(s, inp(0, false), PD, constTrack(7)); // release: GRIP with carry
      expect(car(s).state).toBe('GRIP');
      if (zero) car(s).carry = 0;
      const out: number[] = [];
      for (let i = 0; i < 60; i++) {
        st1(s, inp(0, false), PD, STRAIGHT);
        out.push(car(s).speed);
      }
      return out;
    };
    const a = go(false);
    const b = go(true);
    for (let i = 0; i < a.length; i++) expect(a[i]!).toBeCloseTo(b[i]!, 12);
  });
});

// ------------------------------------------------------------------------------------------------
describe('R81f crash (R48): DRIFT ends without payment, no entry while crashing, entry again after', () => {
  const LAMP = {
    lampEvery: 16,
    lampOffset: 1.4,
    lampHitW: 0.08,
    crashMinSpeed: 0.3,
    crashTime: 1.6,
    crashReturnX: 0.6,
    carHitW: 0.16,
    bumpInvulnTime: 0.8,
    offroadMul: 1,
    xLimit: 2,
    driftOffroad: 1,
  };
  it('hit in DRIFT: GRIP, dir 0, driftTicks 0, scrubDebt 0; held in the corner: GRIP for the whole crash; then DRIFT', () => {
    // lamps from tests/sim/crash.test.ts: z 15.75 -> 16.0 at speed 0.5 crosses the lamp at x 1.4
    const p = { ...P5, ...LAMP } as CarParams;
    const t = constTrack(20);
    const s = mk({
      z: 15.75,
      x: 1.4,
      speed: 0.5,
      state: 'DRIFT',
      dir: 1,
      driftHeld: true,
      yaw: 0.5,
      driftTicks: 30,
    } as Partial<Car>);
    st1(s, inp(0, true), p, t);
    expect(car(s).crashTicks).toBe(192);
    expect(car(s).state).toBe('GRIP');
    expect(car(s).dir).toBe(0);
    expect(car(s).driftTicks).toBe(0);
    expect(car(s).scrubDebt).toBe(0);
    let guard = 0;
    while (car(s).crashTicks > 0 && guard++ < 400) {
      st1(s, inp(1, true), p, t);
      expect(car(s).state).toBe('GRIP');
    }
    expect(car(s).crashTicks).toBe(0);
    expect(guard).toBeGreaterThanOrEqual(191);
    // speed 0 after the crash: autogas is off in Q (accel 0), so give it a speed to enter
    car(s).speed = 0.6;
    st1(s, inp(0, true), p, t);
    expect(car(s).state).toBe('DRIFT');
    expect(car(s).dir).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
describe('R81f properties: symmetry, determinism, JSON round-trip, per-car variant', () => {
  const parts: ReadonlyArray<readonly [number, number, number]> = [
    [200, 300, 7],
    [520, 20, 0.3],
    [560, 200, -4.5],
    [780, 15, -8.3],
    [800, 250, 2],
    [1100, 150, 8.3],
    [1250, 150, -7],
  ];
  const TR = custom(4000, parts);
  const TL = mirror(TR);
  const script = (i: number, sg: number): InputFrame =>
    inp(sg * Math.max(-1, Math.min(1, 1.4 * Math.sin(i / 37))), i % 300 > 25);
  const RP = { ...P5, accel: 0.22, slipDrag: 0.058, gripScrub: 1 } as CarParams;
  it('left/right symmetry of a whole run through mirrored corners; drift really happens on both sides', () => {
    const r = mk({ speed: 1, z: 150 });
    const l = mk({ speed: 1, z: 150 });
    const dirs = new Set<number>();
    for (let i = 0; i < 1800; i++) {
      stepV(r, [script(i, 1)], TR, [RP]);
      stepV(l, [script(i, -1)], TL, [RP]);
      const a = car(r);
      const b = car(l);
      if (a.state === 'DRIFT') dirs.add(a.dir);
      expect(b.state).toBe(a.state);
      expect(b.dir + a.dir).toBe(0);
      expect(b.x).toBeCloseTo(-a.x, 9);
      expect(b.speed).toBeCloseTo(a.speed, 12);
      expect(b.angle).toBeCloseTo(-a.angle, 9);
    }
    expect([...dirs].sort()).toEqual([-1, 1]);
  });
  it('deterministic: same inputs twice give an identical state', () => {
    const play = (): string => {
      const s = mk({ speed: 1, z: 150 });
      for (let i = 0; i < 1500; i++) stepV(s, [script(i, 1)], TR, [RP]);
      return JSON.stringify(s);
    };
    expect(play()).toBe(play());
  });
  it('JSON round-trip inside a same-side gap continues identically (the hold has no hidden state)', () => {
    const t = custom(4000, [
      [100, 50, 7],
      [175, 100, 7],
    ]);
    const a = mk({ speed: 1, z: 140 });
    for (let i = 0; i < 30; i++) stepV(a, [inp(0, true)], t, [F5]); // z 155: in the gap, DRIFT
    expect(car(a).state).toBe('DRIFT');
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    for (let i = 0; i < 200; i++) {
      stepV(a, [inp(0.3, true)], t, [F5]);
      stepV(b, [inp(0.3, true)], t, [F5]);
    }
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it('bounds: 0 <= angle*dir <= 1 and dir = 0 exactly in GRIP over the scripted run', () => {
    const s = mk({ speed: 1, z: 150 });
    for (let i = 0; i < 1800; i++) {
      stepV(s, [script(i, 1)], TR, [RP]);
      const c = car(s);
      if (c.state === 'GRIP') expect(c.dir).toBe(0);
      else {
        expect(c.angle * c.dir).toBeGreaterThanOrEqual(0);
        expect(c.angle * c.dir).toBeLessThanOrEqual(1 + 1e-9);
      }
      expect(Number.isFinite(c.x) && Number.isFinite(c.speed)).toBe(true);
    }
  });
  it('the variant is per car: on a straight with drift held, variant 3 (steer 1) drifts, variant 5 does not', () => {
    const s = createRace(3, 2);
    s.cars.forEach((c, i) => Object.assign(c, { speed: 1, z: 10 + 150 * i, x: 0 }));
    const P3 = { ...Q, driftEntry: 3 } as CarParams;
    stepV(s, [inp(1, true), inp(1, true)], STRAIGHT, [P3, P5]);
    expect(s.cars.map((c) => c.state)).toEqual(['DRIFT', 'GRIP']);
  });
});

// T77 (docs/brief.md R84c, R85e, R85f, H20, H21; written before the implementation).
// Runs: the spike's (tools/spike/release-pullback.ts, docs/research/release-pullback.md) through the
// real `step`: base car, driftTurbo 0, driftEntry 3, speed vmax at the start and free, `free` road (no
// walls, no off-road loss, no lamps). Curves: easy 2, medium 4.5, hard 7, sharp 8.3 (curves.json);
// A = curve*sp*kYaw (kYaw 2). "Outward" = from x at the release, away from the corner centre: a left
// corner (curve < 0) throws the car to +x, a right corner to -x.
import { describe, expect, it } from 'vitest';
import base from '../../src/data/cars/base.json';
import hypotheses from '../../src/data/hypotheses.json';
import tunables from '../../src/data/tunables.json';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, RaceState } from '../../src/sim/types';
import { V5 } from './corner_helpers';
import { PB } from './modelb_helpers';
import { NO_T77 } from './pinT77';
import {
  C,
  H20_OFF,
  H20_ON,
  HELD_DRIFT_SCENARIOS,
  LEGACY_SCENARIOS,
  P0,
  REL_TS,
  STRAIGHT_SCENARIOS,
  driftThen,
  free,
  gripThen,
  holdSteer,
  rail,
  randomScript,
  relSide,
  relV,
  release,
  run,
  track,
  traceHash,
  twistyTrack,
  type Sample,
} from './t77_helpers';
import { PIN_HELD, PIN_LEGACY, PIN_STRAIGHT } from './t77_pins';

const B = base as unknown as Record<string, number>;
const FP = free(P0);
/** R85f / R84c criteria car: H20 on with the start numbers, rails as given. */
const F = (r: number): CarParams => ({ ...FP, ...H20_ON, ...rail(r) });
const xAt = (S: Sample[], t: number): number => S[Math.round(t / DT) - 1]!.x;
const CORNERS = ['medium', 'hard', 'sharp'] as const;
const num = (v: unknown): number => v as number;

/** vInf of R85f: -A/yawAlign - clamp(A/velGrip, +-slipGripMax) at speed `speed`. */
function vInfOf(p: CarParams, curve: number, speed: number): number {
  const A = curve * (speed / p.vmax) * p.kYaw;
  const sG = Math.max(-p.slipGripMax, Math.min(p.slipGripMax, A / p.velGrip));
  return -A / p.yawAlign - sG;
}

// ------------------------------------------------------------------------------------------ data
describe('T77 data: R85f / R84c parameters, H20 / H21 flags, dev panel', () => {
  const H = hypotheses as Record<string, string>;
  const T = tunables as unknown as {
    numbers: Record<string, { min: number; max: number; step: number }>;
    flags: Record<string, string[]>;
    meta: Record<string, { rule?: string; group?: string; tier?: string; model?: string }>;
  };
  const key = (id: string): string | undefined =>
    Object.keys(H).find((k) => k.startsWith(id + '_'));
  it('cars/base.json: releaseHold 1 (H20 B), releaseSlide 0.25 half-widths/s^2 (R85f)', () => {
    expect(B.releaseHold).toBe(1);
    expect(B.releaseSlide).toBe(0.25);
  });
  it('cars/base.json: driftRail 0.5 (H21 B, R84c start)', () => {
    expect(B.driftRail).toBe(0.5);
  });
  for (const id of ['H20', 'H21']) {
    it(`hypotheses.json has ${id} = "B" (brief hypothesis table: start B)`, () => {
      const k = key(id);
      expect(k).toBeDefined();
      expect(H[k!]).toBe('B');
    });
    it(`dev panel: ${id} is a runtime flag A/B with its meta (every hypothesis is a runtime flag)`, () => {
      const k = 'hypotheses.' + key(id)!;
      expect(T.flags[k]).toEqual(['A', 'B']);
      expect(T.meta[k]?.rule).toBe(id);
    });
  }
  it('dev panel: a driftRail slider 0..1 (R84c "ползунок 0–1"), Drift group, model B, same tier as driftPush', () => {
    expect(T.numbers['car.driftRail']).toBeDefined();
    expect(T.numbers['car.driftRail']!.min).toBe(0);
    expect(T.numbers['car.driftRail']!.max).toBe(1);
    const m = T.meta['car.driftRail'];
    expect(m?.rule).toBe('R84c');
    expect(m?.group).toBe(T.meta['car.driftPush']!.group);
    expect(m?.tier).toBe(T.meta['car.driftPush']!.tier);
    expect(m?.tier).toBe('core'); // the author wants the rail slider at hand (P13 limit: another item moves to more)
    expect(m?.model).toBe('B');
  });
  it('the older-test helper PB pins releaseHold 0 and driftRail 0 (NO_T77)', () => {
    const pb = PB as unknown as Record<string, number>;
    expect(pb.releaseHold).toBe(NO_T77.releaseHold);
    expect(pb.driftRail).toBe(NO_T77.driftRail);
  });
});

// ------------------------------------------------------------------------------------------ pins
describe('H20 / H21 off (releaseHold 0, driftRail 0) = the old behaviour bit for bit', () => {
  // With gripLead 0 and gripDodge 0 the R85e clip has nothing to act on, so every run of the old
  // code must come back bit for bit (hash of every tick, recorded before T77 in t77_pins.ts).
  const L = { ...FP, gripLead: 0, gripDodge: 0, ...NO_T77 } as CarParams;
  for (const [name, tr, T, s] of LEGACY_SCENARIOS) {
    it(`${name}`, () => {
      expect(traceHash(L, tr(), T, s())).toBe(PIN_LEGACY[name]);
    });
  }
});

describe('R85e / R85f / R84c on a straight: bit for bit as before (brief R85f: "прямая ... бит-в-бит")', () => {
  for (const [name, tr, T, s] of STRAIGHT_SCENARIOS) {
    it(`${name}: default data, H20 B with rails 0.5, H20 A with rails 0 all equal the pre-T77 run`, () => {
      for (const p of [FP, F(0.5), F(1), { ...FP, ...H20_OFF, ...rail(0) } as CarParams])
        expect(traceHash(p, tr(), T, s())).toBe(PIN_STRAIGHT[name]);
    });
  }
});

describe('R84c driftRail 0 = bit for bit as it was (held drift in every corner class, default data)', () => {
  for (const [name, tr, T, s] of HELD_DRIFT_SCENARIOS) {
    it(name, () => {
      expect(traceHash({ ...FP, ...rail(0) } as CarParams, tr(), T, s())).toBe(PIN_HELD[name]);
    });
  }
});

// ------------------------------------------------------------------------------------------ R85e
describe('R85e GRIP lead only catches: hand-computed tick in a corner', () => {
  // Constant speed (accel 0, slipDrag 0, gripScrub 0), sp 1, H20 off, medium (curve 4.5):
  //   A = 4.5*1*2 = 9; sG = 9/22 = 0.409091; vStar(steer 0) = -9/15 - 0.409091 = -1.009091.
  // Start: vel v0, yaw = v0 + sG, yawRate = A (steady GRIP course of steer 0 before the tick).
  // R83: yawRate += (steer*15.75 - 15*yaw - yawRate)*(1 - exp(-60/120)); yaw += (yawRate - A)*DT.
  // R84: vel += (22*clamp(yaw - vel, +-0.75) - A)*DT (slip limit 0.8 not reached).
  // R85b: L = 0.9*(vStar - vel)*sp*latScale (R85c 0: |A| 9 >= dodgeFadeA 4).
  const E = { ...FP, accel: 0, slipDrag: 0, gripScrub: 0, ...H20_OFF, ...rail(0) } as CarParams;
  function tick1(curve: number, v0: number, steer: number): { vel: number; L: number } {
    const A = curve * E.kYaw;
    const sG = Math.max(-E.slipGripMax, Math.min(E.slipGripMax, A / E.velGrip));
    let yaw = v0 + sG;
    let yawRate = A;
    yawRate +=
      (steer * E.yawRateMax - E.yawAlign * yaw - yawRate) * (1 - Math.exp(-E.yawResponse * DT));
    yaw += (yawRate - A) * DT;
    const force = Math.max(-E.slipGripMax, Math.min(E.slipGripMax, yaw - v0));
    const vel = v0 + (E.velGrip * force - A) * DT;
    const vStar = (steer * E.yawRateMax - A) / E.yawAlign - sG;
    return { vel, L: E.gripLead * (vStar - vel) };
  }
  function oneTick(curve: number, v0: number, steer: number): Car {
    const s = createRace(1, 1);
    const c = s.cars[0]!;
    const A = curve * E.kYaw;
    c.speed = E.vmax;
    c.vel = v0;
    c.yaw = v0 + Math.max(-E.slipGripMax, Math.min(E.slipGripMax, A / E.velGrip));
    c.yawRate = A;
    step(s, [{ steer, brake: false, drift: false }], track(curve), [E]);
    return c;
  }
  for (const m of [1, -1] as const) {
    it(`mirror ${m}: right corner, moving inward 0.1, steer 0: the outward lead is clipped to -vel, vx = 0, x stays`, () => {
      // vel1 = 0.1 + (22*0.354545 - 9)/120 = 0.09000 (by tick1); L = 0.9*(-1.009091 - 0.09) = -0.98918
      // R85e: L*steer = 0 is not toward the finger -> L in [-vel1, 0] -> L = -vel1 -> vx = 0
      const h = tick1(m * 4.5, m * 0.1, 0);
      expect(h.vel * m).toBeCloseTo(0.09, 4);
      expect(h.L * m).toBeLessThan(-h.vel * m); // today's lead would throw the car outward
      const c = oneTick(m * 4.5, m * 0.1, 0);
      expect(c.vel).toBeCloseTo(h.vel, 12); // the lead is not fed back (R85b)
      expect(c.vx).toBeCloseTo(0, 12);
      expect(c.x).toBeCloseTo(0, 12);
    });
    it(`mirror ${m}: left corner, moving outward 0.1, steer 0: the further-outward lead is cut to 0, vx = vel`, () => {
      // curve -4.5: vStar(0) = +1.009091 > vel1 -> L > 0 with steer 0 -> clipped to 0 -> vx = vel1*sp
      const h = tick1(-m * 4.5, m * 0.1, 0);
      expect(h.L * m).toBeGreaterThan(0);
      const c = oneTick(-m * 4.5, m * 0.1, 0);
      expect(c.vx).toBeCloseTo(h.vel, 12);
      expect(c.x).toBeCloseTo(h.vel * DT, 12);
    });
    it(`mirror ${m}: right corner, full steer inward from vel -0.3: the lead toward the finger is kept as it was`, () => {
      // vStar(1) = (15.75 - 9)/15 - 0.409091 = 0.040909 > vel1 -> L > 0, steer > 0 -> unchanged
      const h = tick1(m * 4.5, -m * 0.3, m);
      expect(h.L * m).toBeGreaterThan(0);
      const c = oneTick(m * 4.5, -m * 0.3, m);
      expect(c.vx).toBeCloseTo(h.vel + h.L, 12);
    });
  }
});

describe('R85e criterion (H20 = A): no outward throw on the release tick in a corner', () => {
  const P = { ...FP, ...H20_OFF, ...rail(0) } as CarParams;
  for (const m of [1, -1] as const) {
    it(`side ${m}: medium, full steer inward 2 s -> 0: outward vx on the first tick <= 0.05 (was 0.90), in 0.1 s <= 0.03 (was 0.093)`, () => {
      const S = run(P, track(m * C.medium!), 2.5, gripThen(m, 2));
      const r = release(S, 2, -m);
      expect(r.first).toBeLessThanOrEqual(0.05);
      expect(r.out01).toBeLessThanOrEqual(0.03);
    });
    it(`side ${m}: hard, steady drift at the hold steer -> release: first-tick outward vx <= 0.05 (was 1.41), in 0.1 s <= 0.05 (was 0.142)`, () => {
      const dir = -m;
      const u = holdSteer(P, dir * C.hard!, dir);
      const S = run(P, track(dir * C.hard!), 3.5, driftThen(dir, u, 3));
      const r = release(S, 3, -dir);
      expect(r.first).toBeLessThanOrEqual(0.05);
      expect(r.out01).toBeLessThanOrEqual(0.05);
    });
  }
});

// ------------------------------------------------------------------------------------------ R85f
describe('R85f criterion: steady drift at the hold steer 3 s -> release (medium / hard / sharp)', () => {
  // brief bounds: 0.3 s <= 0.02, 0.6 s <= 0.05, 1.0 s <= 0.12, 1.5 s 0.15-0.30, 3.0 s 0.6-1.2;
  // 1 half-width in 2.5-4.0 s; outward vx increment per tick in the first 0.3 s <= 0.01.
  // Spike (b): medium 0.005 / 0.032 / 0.102 / 0.245 / 1.051, 2.9 s; hard 0.003 / 0.025 / 0.085 / 0.203
  // / 0.842, 3.3 s; sharp 0.006 / 0.029 / 0.086 / 0.195 / 0.753, 3.5 s. Today: 0.293 / 0.430 / 0.487 in 0.3 s.
  const BOUND: Record<string, [number, number]> = {
    '0.3': [-Infinity, 0.02],
    '0.6': [-Infinity, 0.05],
    '1': [-Infinity, 0.12],
    '1.5': [0.15, 0.3],
    '3': [0.6, 1.2],
  };
  const drift = (cls: string, dir: number, r: number) => {
    const p = F(r);
    const u = holdSteer(p, dir * C[cls]!, dir);
    return release(run(p, track(dir * C[cls]!), 8, driftThen(dir, u, 3)), 3, -dir);
  };
  for (const cls of CORNERS) {
    for (const dir of [-1, 1] as const) {
      it(`${cls}, dir ${dir}, driftRail 0: outward within the bounds, edge in 2.5-4.0 s, no vx jump`, () => {
        const r = drift(cls, dir, 0);
        for (const t of REL_TS) {
          expect(r.out[String(t)]).toBeGreaterThanOrEqual(BOUND[String(t)]![0]);
          expect(r.out[String(t)]).toBeLessThanOrEqual(BOUND[String(t)]![1]);
        }
        expect(r.tEdge).toBeGreaterThanOrEqual(2.5);
        expect(r.tEdge).toBeLessThanOrEqual(4.0);
        expect(r.jump).toBeLessThanOrEqual(0.01);
      });
    }
    it(`${cls}: with driftRail 0.5 the same numbers +-0.02 up to 1.5 s, +-0.04 at 3.0 s (and the same bounds)`, () => {
      // The rail acts only in DRIFT; after the release both runs are the same GRIP memory from a
      // slightly different release state, and the constant-acceleration slide widens that gap with
      // time (spike release-pullback.ts: sharp 0.036 at 3.0 s). Brief R85f: +-0.02 to 1.5 s, +-0.04 at 3.0 s.
      const a = drift(cls, -1, 0);
      const b = drift(cls, -1, 0.5);
      for (const t of REL_TS) {
        const tol = t <= 1.5 ? 0.02 : 0.04;
        expect(Math.abs(b.out[String(t)]! - a.out[String(t)]!)).toBeLessThanOrEqual(tol);
        expect(b.out[String(t)]).toBeGreaterThanOrEqual(BOUND[String(t)]![0]);
        expect(b.out[String(t)]).toBeLessThanOrEqual(BOUND[String(t)]![1]);
      }
      expect(b.jump).toBeLessThanOrEqual(0.01);
    });
  }
});

describe('R85f criterion: GRIP, full steer inward 2 s -> 0', () => {
  // medium: the drift bounds at 0.3 / 0.6 / 1.0 / 1.5 s (spike 0.004 / 0.031 / 0.101 / 0.244);
  // hard and sharp, where full steer already slides outward: 0.3 s <= 0.07, 0.6 s <= 0.15, 1.5 s <= 0.50
  // (spike 0.054 / 0.125 / 0.438 and 0.049 / 0.112 / 0.387; today 0.291 / 0.585 / 1.444, 0.250 / 0.501 / 1.226).
  const MAX: Record<string, Record<string, number>> = {
    medium: { '0.3': 0.02, '0.6': 0.05, '1': 0.12, '1.5': 0.3 },
    hard: { '0.3': 0.07, '0.6': 0.15, '1.5': 0.5 },
    sharp: { '0.3': 0.07, '0.6': 0.15, '1.5': 0.5 },
  };
  for (const cls of CORNERS) {
    for (const m of [1, -1] as const) {
      it(`${cls}, side ${m}: outward within the bounds, no outward vx jump > 0.01 per tick in 0.3 s`, () => {
        const r = release(run(F(0.5), track(m * C[cls]!), 7, gripThen(m, 2)), 2, -m);
        for (const [t, mx] of Object.entries(MAX[cls]!)) expect(r.out[t]).toBeLessThanOrEqual(mx);
        if (cls === 'medium') expect(r.out['1.5']).toBeGreaterThanOrEqual(0.15);
        expect(r.jump).toBeLessThanOrEqual(0.01);
      });
    }
  }
});

describe('R85f memory fields relSide / relV (start, slide, end)', () => {
  const P = F(0);
  /** Steps one tick and returns [relSide, relV] after it plus vel and speed before it. */
  function tickRec(s: RaceState, fr: InputFrame, tr = track(C.medium!)) {
    const c = s.cars[0]!;
    const vel0 = c.vel;
    const sp0 = c.speed;
    step(s, [fr], tr, [P]);
    return { side: num(relSide(c)), v: num(relV(c)), vel0, sp0 };
  }
  function gripRace(curve: number): RaceState {
    const s = createRace(1, 1);
    s.cars[0]!.speed = P.vmax;
    const tr = track(curve);
    for (let i = 0; i < 2 / DT; i++)
      step(s, [{ steer: Math.sign(curve), brake: false, drift: false }], tr, [P]);
    return s;
  }
  it('createRace: relSide 0 and relV 0 on every car', () => {
    for (const c of createRace(3, 4).cars) {
      expect(relSide(c)).toBe(0);
      expect(relV(c)).toBe(0);
    }
  });
  for (const m of [1, -1] as const) {
    it(`side ${m}: GRIP release in medium starts the memory: relSide = sign(vInf) = ${-m}, relV from 0 grows by releaseSlide*DT per tick`, () => {
      const s = gripRace(m * C.medium!);
      const c = s.cars[0]!;
      expect(relSide(c)).toBe(0); // full steer held: no memory
      const fr: InputFrame = { steer: 0, brake: false, drift: false };
      const first = tickRec(s, fr, track(m * C.medium!));
      const vInf = vInfOf(P, m * C.medium!, first.sp0);
      expect(Math.sign(vInf)).toBe(-m);
      expect(first.side).toBe(-m);
      // relV = vel if vel*vInf > 0, else 0; then relV += relSide*0.25*DT in the same tick
      const v0 = first.vel0 * vInf > 0 ? first.vel0 : 0;
      expect(first.v).toBeCloseTo(v0 - m * 0.25 * DT, 12);
      let v = first.v;
      for (let i = 0; i < 60; i++) {
        const r = tickRec(s, fr, track(m * C.medium!));
        expect(r.side).toBe(-m);
        expect(r.v).toBeCloseTo(v - m * 0.25 * DT, 12);
        v = r.v;
      }
    });
    it(`side ${m}: drift exit (R82) in hard starts the memory on the release tick, relSide = ${m}`, () => {
      const dir = -m; // left corner for m = 1: vInf > 0
      const s = createRace(1, 1);
      s.cars[0]!.speed = P.vmax;
      const tr = track(dir * C.hard!);
      for (let i = 0; i < 2 / DT; i++)
        step(s, [{ steer: i * DT < 0.05 ? dir : dir * 0.8, brake: false, drift: true }], tr, [P]);
      expect(s.cars[0]!.state).toBe('DRIFT');
      expect(relSide(s.cars[0]!)).toBe(0);
      const r = tickRec(s, { steer: 0, brake: false, drift: false }, tr);
      expect(s.cars[0]!.state).toBe('GRIP');
      expect(r.side).toBe(m);
      const vInf = vInfOf(P, dir * C.hard!, r.sp0);
      const v0 = r.vel0 * vInf > 0 ? r.vel0 : 0;
      expect(r.v).toBeCloseTo(v0 + m * 0.25 * DT, 12);
    });
  }
  it('a steer != 0, or input.drift, ends the memory on that tick', () => {
    for (const fr of [
      { steer: 0.3, brake: false, drift: false },
      { steer: -0.01, brake: false, drift: false },
      { steer: 0, brake: false, drift: true },
    ]) {
      const s = gripRace(C.medium!);
      for (let i = 0; i < 24; i++) tickRec(s, { steer: 0, brake: false, drift: false });
      expect(relSide(s.cars[0]!)).toBe(-1);
      expect(tickRec(s, fr).side).toBe(0);
    }
  });
  it('re-touch and release does not reset the slide: relV restarts from the vel already gained', () => {
    const s = gripRace(C.medium!);
    const z: InputFrame = { steer: 0, brake: false, drift: false };
    for (let i = 0; i < 1 / DT; i++) tickRec(s, z);
    expect(tickRec(s, { steer: 0.2, brake: false, drift: false }).side).toBe(0);
    const r = tickRec(s, z);
    expect(r.side).toBe(-1);
    expect(r.vel0).toBeLessThan(0); // already sliding outward
    expect(r.v).toBeCloseTo(r.vel0 - 0.25 * DT, 12);
  });
  it('never starts on a straight (A = 0): release from steer 1 and from a drift, relSide stays 0', () => {
    for (const S of [gripThen(1, 0.6), driftThen(-1, 1, 1)]) {
      const s = createRace(1, 1);
      const c = s.cars[0]!;
      c.speed = P.vmax;
      const fr: InputFrame = { steer: 0, brake: false, drift: false };
      for (let i = 0; i < 2 / DT; i++) {
        S(i * DT, c, fr);
        step(s, [fr], track(0), [P]);
        expect(relSide(c)).toBe(0);
      }
    }
  });
  it('the corner ending (straight ahead: sign(vInf) = 0) ends the memory on the first straight tick', () => {
    const tr = track(C.medium!, 0, 250); // corner on segments 0..249 (reached before the slide meets R13)
    const s = createRace(1, 1);
    const c = s.cars[0]!;
    c.speed = P.vmax;
    const fr: InputFrame = { steer: 1, brake: false, drift: false };
    for (let i = 0; i < 2 / DT; i++) step(s, [fr], tr, [P]);
    fr.steer = 0;
    let seen = false;
    for (let i = 0; i < 4 / DT; i++) {
      const seg = Math.floor(c.z);
      step(s, [fr], tr, [P]);
      if (seg < 250) {
        expect(relSide(c)).toBe(-1);
        seen = true;
      } else {
        expect(relSide(c)).toBe(0);
      }
    }
    expect(seen).toBe(true);
    expect(Math.floor(c.z)).toBeGreaterThan(260);
  });
  it('the slide reaches R13 (|relV| >= |vInf|): the memory ends there and does not restart', () => {
    const s = gripRace(C.medium!);
    const c = s.cars[0]!;
    const fr: InputFrame = { steer: 0, brake: false, drift: false };
    let prevV = 0;
    let end = -1;
    for (let i = 0; i < 8 / DT; i++) {
      const sp0 = c.speed;
      const r = tickRec(s, fr);
      const vInf = vInfOf(P, C.medium!, sp0);
      if (i > 0 && end < 0 && r.side === 0) {
        end = i;
        expect(Math.abs(prevV)).toBeGreaterThanOrEqual(Math.abs(vInf)); // the end condition
      }
      if (end < 0) {
        if (i > 0) expect(Math.abs(prevV)).toBeLessThan(Math.abs(vInf));
        prevV = r.v;
      } else {
        expect(r.side).toBe(0); // ordinary GRIP from here on
      }
    }
    // brief: |vInf|/releaseSlide = 3.7 s in medium (free speed)
    expect(end * DT).toBeGreaterThanOrEqual(2.5);
    expect(end * DT).toBeLessThanOrEqual(6);
  });
  it('releaseHold 0 (H20 A): relSide and relV stay 0 through a drift release and a GRIP release', () => {
    const p = { ...FP, ...H20_OFF } as CarParams;
    for (const [tr, S] of [
      [track(-C.hard!), driftThen(-1, 0.8, 1)],
      [track(C.medium!), gripThen(1, 1)],
    ] as const) {
      const s = createRace(1, 1);
      const c = s.cars[0]!;
      c.speed = p.vmax;
      const fr: InputFrame = { steer: 0, brake: false, drift: false };
      for (let i = 0; i < 3 / DT; i++) {
        S(i * DT, c, fr);
        step(s, [fr], tr, [p]);
        expect(relSide(c)).toBe(0);
        expect(relV(c)).toBe(0);
      }
    }
  });
});

describe('R85f properties: symmetry, determinism, JSON round trip, no allocations', () => {
  const P = F(0.5);
  function play(dir: number, n: number, s = createRace(1, 1), from = 0): RaceState {
    const c = s.cars[0]!;
    if (from === 0) c.speed = P.vmax;
    const fr: InputFrame = { steer: 0, brake: false, drift: false };
    const S = driftThen(dir, 0.7, 2);
    for (let i = from; i < n; i++) {
      S(i * DT, c, fr);
      step(s, [fr], track(dir * C.hard!), [P]);
    }
    return s;
  }
  it('left/right: mirrored corner and steer give mirrored x, vx, vel, yaw, relSide, relV every 0.1 s', () => {
    for (let n = 12; n <= 600; n += 12) {
      const a = play(-1, n).cars[0]!;
      const b = play(1, n).cars[0]!;
      for (const k of ['x', 'vx', 'vel', 'yaw', 'yawRate'] as const)
        expect(a[k]).toBeCloseTo(-b[k], 12);
      expect(num(relSide(a)) + num(relSide(b))).toBe(0); // mirrored, sign of zero ignored
      expect(num(relV(a))).toBeCloseTo(-num(relV(b)), 12);
    }
  });
  it('determinism: the same inputs twice give an identical state', () => {
    expect(JSON.stringify(play(-1, 600))).toBe(JSON.stringify(play(-1, 600)));
  });
  it('JSON round trip in the middle of the memory continues identically', () => {
    const a = play(-1, 300); // 1 s after the release at 2 s
    expect(relSide(a.cars[0]!)).toBe(1);
    expect(num(relV(a.cars[0]!))).toBeGreaterThan(0);
    const b = JSON.parse(JSON.stringify(a)) as RaceState;
    play(-1, 600, a, 300);
    play(-1, 600, b, 300);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it('step allocates nothing: same car objects and key set over 10000 seeded ticks; the keys include relSide, relV', () => {
    const s = createRace(7, 1);
    const cars = s.cars;
    const car = cars[0]!;
    car.speed = P.vmax;
    const keys = Object.keys(car).sort();
    expect(keys).toContain('relSide');
    expect(keys).toContain('relV');
    const tr = twistyTrack();
    const S = randomScript(5, true);
    const fr: InputFrame = { steer: 0, brake: false, drift: false };
    const params = [P];
    for (let i = 0; i < 10000; i++) {
      S(i * DT, car, fr);
      step(s, [fr], tr, params);
    }
    expect(s.cars).toBe(cars);
    expect(s.cars[0]).toBe(car);
    expect(Object.keys(car).sort()).toEqual(keys);
  });
});

// ------------------------------------------------------------------------------------------ R84c
describe('R84c drift rails: drift of x toward dir from 2 to 3 s of a steady drift', () => {
  // inward(u) = dir*(x(3 s) - x(2 s)), steer dir for 0.05 s, then dir*u (spike S6/S7).
  // Floor of the finger R83b: u = 0 and 0.5 are one point (uc = driftMinU 0.5).
  const inward = (p: CarParams, curve: number, dir: number, u: number): number => {
    const S = run(p, track(curve), 3, driftThen(dir, u, 1e9));
    return dir * (xAt(S, 3) - xAt(S, 2));
  };
  const P = (r: number): CarParams => ({ ...FP, ...rail(r) }) as CarParams;
  for (const dir of [-1, 1] as const) {
    it(`dir ${dir}, driftRail 0.5, finger on the floor (steer 0 and 0.5): medium -0.014, hard -0.086, sharp -0.123 (+-0.01; was -0.028 / -0.172 / -0.246)`, () => {
      const want: Record<string, number> = { medium: -0.014, hard: -0.086, sharp: -0.123 };
      for (const cls of CORNERS)
        for (const u of [0, 0.5])
          expect(Math.abs(inward(P(0.5), dir * C[cls]!, dir, u) - want[cls]!)).toBeLessThanOrEqual(
            0.01,
          );
    });
    it(`dir ${dir}, driftRail 1: on the floor |drift| <= 0.005 (follows the arc), full steer 0.230 +-0.01 inward, in medium, hard, sharp`, () => {
      for (const cls of CORNERS) {
        for (const u of [0, 0.5])
          expect(Math.abs(inward(P(1), dir * C[cls]!, dir, u))).toBeLessThanOrEqual(0.005);
        expect(Math.abs(inward(P(1), dir * C[cls]!, dir, 1) - 0.23)).toBeLessThanOrEqual(0.01);
      }
    });
    it(`dir ${dir}, any driftRail (0 / 0.5 / 1): easy 0.115 / 0.345 and straight 0.230 / 0.460 (steer 0 / 1, +-0.01)`, () => {
      for (const r of [0, 0.5, 1]) {
        expect(Math.abs(inward(P(r), dir * C.easy!, dir, 0) - 0.115)).toBeLessThanOrEqual(0.01);
        expect(Math.abs(inward(P(r), dir * C.easy!, dir, 1) - 0.345)).toBeLessThanOrEqual(0.01);
        expect(Math.abs(inward(P(r), 0, dir, 0) - 0.23)).toBeLessThanOrEqual(0.01);
        expect(Math.abs(inward(P(r), 0, dir, 1) - 0.46)).toBeLessThanOrEqual(0.01);
      }
    });
  }
  it('any driftRail: a drift against the corner leaves the road in 0.958 / 0.625 / 0.483 s (easy / medium / hard, +-0.01 s)', () => {
    const want: Record<string, number> = { easy: 0.958, medium: 0.625, hard: 0.483 };
    for (const r of [0, 0.5, 1]) {
      for (const cls of ['easy', 'medium', 'hard']) {
        // right corner, drift left (dir -1), steer -1 from x 0 (spike S8)
        const S = run(P(r), track(C[cls]!), 4, driftThen(-1, 1, 1e9));
        const k = S.findIndex((q) => q.x < -1 || q.x > 1);
        expect(k).toBeGreaterThanOrEqual(0);
        expect(Math.abs((k + 1) * DT - want[cls]!)).toBeLessThanOrEqual(0.01);
      }
    }
  });
  it('straight, easy and against the corner: driftRail 1 gives the same trajectory as 0, bit for bit', () => {
    const cases: [number, number, number][] = [
      [0, -1, 0],
      [0, 1, 1],
      [-C.easy!, -1, 0],
      [C.easy!, 1, 1],
      [C.hard!, -1, 1], // against
      [-C.medium!, 1, 0.5], // against
    ];
    for (const [curve, dir, u] of cases) {
      const a = run(P(0), track(curve), 3, driftThen(dir, u, 1e9));
      const b = run(P(1), track(curve), 3, driftThen(dir, u, 1e9));
      expect(b).toEqual(a);
    }
  });
  it('the finger can only narrow the line: inward(1) >= inward(0.5) >= inward(0) for every steer, and the floor (steer -1 / 0 / 0.5) is one point', () => {
    for (const cls of CORNERS) {
      for (const dir of [-1, 1]) {
        for (const u of [-1, 0, 0.5, 0.8, 1]) {
          const d0 = inward(P(0), dir * C[cls]!, dir, u);
          const d5 = inward(P(0.5), dir * C[cls]!, dir, u);
          const d1 = inward(P(1), dir * C[cls]!, dir, u);
          expect(d5).toBeGreaterThanOrEqual(d0 - 1e-9);
          expect(d1).toBeGreaterThanOrEqual(d5 - 1e-9);
        }
        const f = (u: number) => run(P(1), track(dir * C[cls]!), 3, driftThen(dir, u, 1e9));
        expect(f(-1)).toEqual(f(0.5));
        expect(f(0)).toEqual(f(0.5));
      }
    }
  });
  it('variant 5 (driftEntry 5): the rails do not act (R83c holds the line there)', () => {
    for (const dir of [-1, 1]) {
      const a = run(
        { ...FP, ...V5, ...rail(0) } as CarParams,
        track(dir * C.hard!),
        3,
        driftThen(dir, 0, 1e9),
      );
      const b = run(
        { ...FP, ...V5, ...rail(1) } as CarParams,
        track(dir * C.hard!),
        3,
        driftThen(dir, 0, 1e9),
      );
      expect(b).toEqual(a);
    }
  });
  it('hold steer (R83b) by the formula: driftLat*uc = driftPush*|A| - driftRail*max(0, driftPush*|A| - driftLat*driftMinU)', () => {
    // A at vmax: medium 9, hard 14, sharp 16.6; driftPush 0.0287, driftLat 0.46, driftMinU 0.5 (0.23)
    // rail 0: medium 0.2583/0.46 = 0.5615, hard 0.4018/0.46 = 0.8735
    // rail 0.5: hard (0.4018 - 0.5*0.1718)/0.46 = 0.6867, sharp (0.47642 - 0.5*0.24642)/0.46 = 0.7679
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(0.02);
    near(holdSteer(P(0), -C.medium!, -1), 0.5615);
    near(holdSteer(P(0), -C.hard!, -1), 0.8735);
    near(holdSteer(P(0.5), -C.hard!, -1), 0.6867);
    near(holdSteer(P(0.5), -C.sharp!, -1), 0.7679);
  });
});

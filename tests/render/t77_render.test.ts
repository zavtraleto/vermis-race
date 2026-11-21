// T77 render-side pure helpers (docs/brief.md R27d camera return, R89d one-sided "catch" term).
// Written before the implementation. Runs as tools/spike/release-pullback.ts part 5 (fields of the
// real `step`, 120 Hz, screen 360x640: 540 px per half-width at the car line; R27c on).
// ASSUMED API (the brief names the law, not the function; loaded at run time, the stub throws until it
// exists):
//   src/render/cameraLag.ts  export function stepCamOffset(o, vx, dt, tau, returnTau, max): number
//     R27d: o = x - camPosX; oT = clamp(vx*tau, +-max); o += (oT - o)*(1 - exp(-dt/T)), T = tau while
//     |oT| >= |o| and oT*o >= 0, else returnTau. Returns the new o (camPosX = x - o).
import { beforeAll, describe, expect, it } from 'vitest';
import camera from '../../src/data/camera.json';
import { baseCar } from '../../src/data/cars';
import { cameraConfig, roadConfig, spritesConfig } from '../../src/data/render';
import sprites from '../../src/data/sprites.json';
import tunables from '../../src/data/tunables.json';
import { stepCamDrift, type CamDriftConfig } from '../../src/render/cameraDrift';
import { stepCamLag } from '../../src/render/cameraLag';
import { bodyYawDeg } from '../../src/render/carWeight';
import { approach, roadHalfWidthPxAt } from '../../src/render/driftVisual';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { CarParams, InputFrame } from '../../src/sim/types';
import { C, driftThen, free, rail, run, track } from '../sim/t77_helpers';

type StepCamOffset = (
  o: number,
  vx: number,
  dt: number,
  tau: number,
  returnTau: number,
  max: number,
) => number;
let stepCamOffset: StepCamOffset = () => {
  throw new Error('not implemented: src/render/cameraLag.ts stepCamOffset (R27d)');
};
const CAMERA_LAG_MODULE = '../../src/render/cameraLag';
beforeAll(async () => {
  const m = (await import(/* @vite-ignore */ CAMERA_LAG_MODULE)) as {
    stepCamOffset?: StepCamOffset;
  };
  if (m.stepCamOffset) stepCamOffset = m.stepCamOffset;
});

const CAM = camera as unknown as Record<string, number>;
const W = (sprites as unknown as { weight: Record<string, number> }).weight;
const WCFG = { slipDeg: W.slipDeg!, velDeg: W.velDeg!, leadDeg: W.leadDeg!, minSpeed: W.minSpeed! };
const CFG = { slipDeg: 17, velDeg: 5, leadDeg: 8, minSpeed: 0.1 };
const P: CarParams = { ...baseCar, driftTurbo: 0, driftEntry: 3 };
const PX = roadHalfWidthPxAt(
  spritesConfig.player.baseY * cameraConfig.screenHeight,
  cameraConfig,
  roadConfig,
);

/**
 * Straight, vmax, free speed: steer `side` while t < tOff, then 0. Per tick: the car offset on the
 * screen (x - camPosX - shiftX of R27c, px) and the smoothed body yaw (R89 + yawTau), both with R27d
 * (`newCam`) or with the R27b stepCamLag of today.
 */
function screenRun(side: number, tOff: number, T: number, newCam: boolean) {
  const s = createRace(1, 1);
  const c = s.cars[0]!;
  c.speed = P.vmax;
  const fr: InputFrame = { steer: 0, brake: false, drift: false };
  const tr = track(0);
  const cdCfg = CAM as unknown as CamDriftConfig;
  const cd = { shiftX: 0, rollDeg: 0 };
  let o = 0;
  let camPos = 0;
  let body = 0;
  const off: number[] = [];
  const bodies: number[] = [];
  for (let i = 0; i < Math.round(T / DT); i++) {
    fr.steer = i * DT < tOff ? side : 0;
    step(s, [fr], tr, [P]);
    if (newCam) {
      o = stepCamOffset(o, c.vx, DT, CAM.camLagTau!, CAM.camReturnTau!, CAM.camLagMax!);
      camPos = c.x - o;
    } else {
      camPos = stepCamLag(camPos, c.x, DT, CAM.camLagTau!, CAM.camLagMax!);
    }
    const sp = c.speed / P.vmax;
    const by = bodyYawDeg(c.yaw, c.vel, c.carry, c.vx, sp, P.latScale, WCFG);
    body = approach(body, by, DT, W.yawTau!);
    stepCamDrift(cd, by / (P.slipFull * W.slipDeg!), c.state === 'DRIFT', DT, cdCfg);
    off.push((c.x - camPos - cd.shiftX) * PX);
    bodies.push(body);
  }
  return { off, bodies };
}
const at = (a: number[], t: number): number => a[Math.round(t / DT) - 1]!;

// ------------------------------------------------------------------------------------------ data
describe('R27d data', () => {
  const T = tunables as unknown as {
    numbers: Record<string, { min: number; max: number }>;
    meta: Record<string, { rule?: string; group?: string; tier?: string }>;
  };
  it('camera.json camReturnTau 0.4 s; camLagTau 0.08 and camLagMax 0.12 unchanged', () => {
    expect(CAM.camReturnTau).toBe(0.4);
    expect(CAM.camLagTau).toBe(0.08);
    expect(CAM.camLagMax).toBe(0.12);
  });
  it('dev panel: camera.camReturnTau slider with min 0, rule R27d, in the camera group at the tier of camDriftTau', () => {
    expect(T.numbers['camera.camReturnTau']).toBeDefined();
    expect(T.numbers['camera.camReturnTau']!.min).toBe(0);
    const m = T.meta['camera.camReturnTau'];
    expect(m?.rule).toBe('R27d');
    expect(m?.group).toBe(T.meta['camera.camDriftTau']!.group);
    expect(m?.tier).toBe(T.meta['camera.camDriftTau']!.tier);
  });
});

// ------------------------------------------------------------------------------------------ R27d
describe('R27d camera returns slowly (stepCamOffset)', () => {
  it('moving off: o 0, vx 1, dt 1/60: oT = 0.08, T = camLagTau 0.08 -> o = 0.08*(1 - exp(-0.208333)) = 0.0150451', () => {
    expect(stepCamOffset(0, 1, 1 / 60, 0.08, 0.4, 0.12)).toBeCloseTo(
      0.08 * (1 - Math.exp(-1 / 60 / 0.08)),
      12,
    );
    expect(stepCamOffset(0, 1, 1 / 60, 0.08, 0.4, 0.12)).toBeCloseTo(0.0150451, 6);
  });
  it('returning: o 0.08, vx 0: oT 0 is nearer zero -> T = camReturnTau 0.4 -> o = 0.08*exp(-1/24) = 0.0767351', () => {
    expect(stepCamOffset(0.08, 0, 1 / 60, 0.08, 0.4, 0.12)).toBeCloseTo(
      0.08 * Math.exp(-1 / 60 / 0.4),
      12,
    );
    expect(stepCamOffset(0.08, 0, 1 / 60, 0.08, 0.4, 0.12)).toBeCloseTo(0.0767351, 6);
  });
  it('the target is clamped: vx 10 -> oT = camLagMax 0.12 (from o 0: 0.12*0.188064 = 0.0225677)', () => {
    expect(stepCamOffset(0, 10, 1 / 60, 0.08, 0.4, 0.12)).toBeCloseTo(
      0.12 * (1 - Math.exp(-1 / 60 / 0.08)),
      12,
    );
  });
  it('target of the other sign (oT*o < 0) uses camReturnTau: o 0.05, vx -1 -> 0.05 - 0.13*(1 - exp(-1/24)) = 0.0446947', () => {
    expect(stepCamOffset(0.05, -1, 1 / 60, 0.08, 0.4, 0.12)).toBeCloseTo(
      0.05 + (-0.08 - 0.05) * (1 - Math.exp(-1 / 60 / 0.4)),
      12,
    );
  });
  it('|oT| = |o| same sign counts as moving off (camLagTau): o 0.08, vx 1 stays 0.08', () => {
    expect(stepCamOffset(0.08, 1, 1 / 60, 0.08, 0.4, 0.12)).toBeCloseTo(0.08, 12);
  });
  it('odd symmetry and never overshoots the target on the way back', () => {
    for (const [o, vx] of [
      [0.03, 0.9],
      [0.1, 0.2],
      [0.12, -0.5],
    ] as const)
      expect(stepCamOffset(-o, -vx, 1 / 60, 0.08, 0.4, 0.12)).toBeCloseTo(
        -stepCamOffset(o, vx, 1 / 60, 0.08, 0.4, 0.12),
        12,
      );
    let o = 0.12;
    for (let i = 0; i < 300; i++) {
      const n = stepCamOffset(o, 0, 1 / 60, 0.08, 0.4, 0.12);
      expect(n).toBeLessThanOrEqual(o);
      expect(n).toBeGreaterThanOrEqual(0);
      o = n;
    }
  });
  for (const side of [1, -1] as const) {
    it(`criterion side ${side}: full steer 0.6 s -> 0: back <= 20 px in the first 0.15 s (was 37), peak return <= 150 px/s (was 502), under 5 px for good within 1.2 s`, () => {
      const { off } = screenRun(side, 0.6, 3, true);
      const back15 = side * (at(off, 0.6) - at(off, 0.75));
      expect(back15).toBeLessThanOrEqual(20);
      const i0 = Math.round(0.6 / DT) - 1;
      let peak = 0;
      for (let k = 1; k <= Math.round(1 / DT); k++) {
        const v = (-side * (off[i0 + k]! - off[i0 + k - 1]!)) / DT;
        if (v > peak) peak = v;
      }
      expect(peak).toBeLessThanOrEqual(150);
      let t5 = NaN;
      for (let k = i0 + 1; k < off.length && Number.isNaN(t5); k++) {
        let ok = true;
        for (let j = k; j < off.length; j++) if (Math.abs(off[j]!) >= 5) ok = false;
        if (ok) t5 = (k + 1) * DT - 0.6;
      }
      expect(t5).toBeLessThanOrEqual(1.2);
    });
    it(`criterion side ${side}: 0.25 s after an instant full steer the car is no less off centre than with R27b (spike 46 vs 43 px)`, () => {
      const a = side * at(screenRun(side, 1, 0.25, true).off, 0.25);
      const b = side * at(screenRun(side, 1, 0.25, false).off, 0.25);
      expect(a).toBeGreaterThanOrEqual(b - 1e-9);
      expect(b).toBeGreaterThan(30); // the comparison is not vacuous
    });
  }
});

// ------------------------------------------------------------------------------------------ R89d
describe('R89d the lead term only toward the motion (lead*vx > 0)', () => {
  it('release: vel 0.5, vx 0 -> lead -0.5, lead*vx = 0 -> no term: 0*17 + 0.5*5 = 2.5 (R89 gave -1.5)', () => {
    expect(bodyYawDeg(0.5, 0.5, 0, 0, 1, 1, CFG)).toBeCloseTo(2.5, 12);
  });
  it('catching: vel 0.5, vx 0.1 -> lead -0.4 against vx > 0 -> no term: 2.5', () => {
    expect(bodyYawDeg(0.5, 0.5, 0, 0.1, 1, 1, CFG)).toBeCloseTo(2.5, 12);
  });
  it('lead toward the motion is kept: yaw 0.5, vel 0.3, carry 0.1, vx 0.8 -> 5.1 + 1.5 + 8*0.5 = 10.6', () => {
    expect(bodyYawDeg(0.5, 0.3, 0.1, 0.8, 1, 1, CFG)).toBeCloseTo(10.6, 12);
  });
  it('lead toward the motion against vel is kept: yaw -0.2, vel -0.2, vx 0.3 -> lead 0.5 -> -1 + 4 = 3', () => {
    expect(bodyYawDeg(-0.2, -0.2, 0, 0.3, 1, 1, CFG)).toBeCloseTo(3, 12);
  });
  it('odd symmetry: mirrored fields give the mirrored angle (kept and dropped term)', () => {
    for (const a of [
      [0.5, 0.5, 0, 0.1],
      [0.5, 0.3, 0.1, 0.8],
      [-0.2, -0.2, 0, 0.3],
    ] as const)
      expect(bodyYawDeg(-a[0], -a[1], -a[2], -a[3], 1, 1, CFG)).toBeCloseTo(
        -bodyYawDeg(a[0], a[1], a[2], a[3], 1, 1, CFG),
        12,
      );
  });
  for (const side of [1, -1] as const) {
    it(`criterion side ${side}: full steer 0.6 s -> 0, the smoothed body angle never below -1 deg in the next second (was -3.0)`, () => {
      const { bodies } = screenRun(side, 0.6, 1.6, false);
      for (let k = Math.round(0.6 / DT); k < bodies.length; k++)
        expect(side * bodies[k]!).toBeGreaterThanOrEqual(-1);
    });
    it(`criterion side ${side}: 60 ms after an instant full steer the angle is unchanged by R89d (spike 12.6 deg)`, () => {
      const S = createRace(1, 1);
      const c = S.cars[0]!;
      c.speed = P.vmax;
      for (let i = 0; i < Math.round(0.06 / DT); i++)
        step(S, [{ steer: side, brake: false, drift: false }], track(0), [P]);
      const sp = c.speed / P.vmax;
      const old =
        (c.yaw - c.vel + c.carry) * W.slipDeg! +
        c.vel * W.velDeg! +
        W.leadDeg! * (c.vx / (sp * P.latScale) - c.vel);
      expect(bodyYawDeg(c.yaw, c.vel, c.carry, c.vx, sp, P.latScale, WCFG)).toBeCloseTo(old, 12);
      expect(Math.abs(side * old - 12.6)).toBeLessThanOrEqual(0.3);
    });
  }
});

describe('R84c body angle on the floor of the finger stays 21-23 deg at any driftRail', () => {
  it('medium / hard / sharp, dir -1, steer 0, steady 3 s, driftRail 0 / 0.5 / 1', () => {
    for (const r of [0, 0.5, 1]) {
      const p = { ...free(P), ...rail(r) } as CarParams;
      for (const cls of ['medium', 'hard', 'sharp']) {
        const s = createRace(1, 1);
        s.cars[0]!.speed = p.vmax;
        run(p, track(-C[cls]!), 3, driftThen(-1, 0, 1e9), s);
        const c = s.cars[0]!;
        const deg = -bodyYawDeg(c.yaw, c.vel, c.carry, c.vx, c.speed / p.vmax, p.latScale, WCFG);
        expect(deg).toBeGreaterThanOrEqual(21);
        expect(deg).toBeLessThanOrEqual(23);
      }
    }
  });
});

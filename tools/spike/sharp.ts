// THROWAWAY SPIKE (R31b): calibrates the `sharp` curvature class on the REAL car data, model B,
// through the real src/sim `step` (same rigs as tests/sim/modelb_calibration.test.ts).
// Run: node tools/run-ts.mjs tools/spike/sharp.ts [--curves 7,8,9]
import { baseCar } from '../../src/data/cars';
import sprites from '../../src/data/sprites.json';
import { DT, SEG_PER_UNIT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { CarParams, InputFrame, Track } from '../../src/sim/types';
import { argValue, type Io } from '../io';

const REAL: CarParams = { ...baseCar, model: 1, crashMinSpeed: 1e9 };
const FREE: CarParams = {
  ...REAL,
  xLimit: 1e9,
  offroadMul: 1,
  offroadSteerMul: 1,
  offroadGrip: REAL.grip,
};
const SLIP_DEG = sprites.weight.slipDeg;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function constTrack(curve: number): Track {
  const segments = [];
  for (let i = 0; i < 4000; i++) segments.push({ curve });
  return { segments };
}

class Rig {
  race = createRace(1, 1);
  car = this.race.cars[0]!;
  frame: InputFrame = { steer: 0, brake: false, drift: false };
  track: Track;
  dx = 0;
  constructor(
    public p: CarParams,
    public curve: number,
  ) {
    this.track = constTrack(curve);
    this.car.speed = 1;
  }
  step(steer: number, drift: boolean, pin: boolean): void {
    if (pin) this.car.speed = 1;
    this.frame.steer = steer;
    this.frame.drift = drift;
    const x0 = this.car.x;
    step(this.race, [this.frame], this.track, [this.p]);
    this.dx = (this.car.x - x0) / DT;
    if (pin) this.car.speed = 1;
  }
  get slip(): number {
    return this.car.yaw - this.car.vel + this.car.carry;
  }
  enterDrift(s: number): void {
    const c = this.car;
    const p = this.p;
    c.state = 'DRIFT';
    c.dir = 1;
    c.driftHeld = true;
    const A = this.curve * c.speed * p.kYaw;
    const slip = p.slipFull * clamp(s, 0, 1);
    c.vel = p.driftLat * (slip / p.slipFull + Math.min(0, s)) - p.driftPush * A;
    c.yaw = c.vel + slip;
    c.yawRate = 0;
  }
}

/** GRIP, full steer inward from x = 0 (entering at the steady GRIP state of a straight). */
function grip(curve: number, pin: boolean) {
  const r = new Rig(FREE, curve);
  const dxAt: number[] = [];
  let tOff = NaN;
  for (let i = 1; i <= 480; i++) {
    r.step(1, false, pin);
    if (i === 60 || i === 120 || i === 240 || i === 360 || i === 480) dxAt.push(r.dx);
    if (Number.isNaN(tOff) && r.car.x < -1) tOff = i * DT;
  }
  return { dxAt, tOff, speed: r.car.speed };
}

function driftLat(curve: number, s: number, pin: boolean, secs: number) {
  const r = new Rig(FREE, curve);
  r.enterDrift(s);
  let sum = 0;
  let sl = 0;
  let n = 0;
  const N = Math.round(secs / DT);
  for (let i = 0; i < N; i++) {
    r.step(s, true, pin);
    if (i * DT >= secs - 1) {
      sum += r.dx;
      sl += r.slip;
      n++;
    }
  }
  return { vx: sum / n, slip: sl / n, speed: r.car.speed };
}
function driftHold(curve: number, pin: boolean, secs: number) {
  let lo = -1;
  let hi = 1;
  let res = { vx: 0, slip: 0, speed: 0 };
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    res = driftLat(curve, mid, pin, secs);
    if (res.vx > 0) hi = mid;
    else lo = mid;
  }
  return { steer: (lo + hi) / 2, deg: res.slip * SLIP_DEG, speed: res.speed };
}

export function main(io: Io): number {
  const list = (argValue(io.argv, 'curves') ?? '7,8,8.5,9,9.5,10').split(',').map(Number);
  io.log(`SEG_PER_UNIT ${SEG_PER_UNIT}: 1 s at vmax = ${SEG_PER_UNIT} segments`);
  for (const c of list) {
    const gp = grip(c, true);
    const gf = grip(c, false);
    const dp = driftHold(c, true, 3);
    const df = driftHold(c, false, 8);
    const f = (v: number): string => v.toFixed(2);
    io.log(
      `curve ${c}: GRIP pinned full steer dx/dt@0.5,1,2,3,4s ${gp.dxAt.map(f).join(' ')} off-road at ${f(gp.tOff)} s | ` +
        `GRIP free ${gf.dxAt.map(f).join(' ')} off at ${f(gf.tOff)} s speed ${f(gf.speed)} | ` +
        `DRIFT hold pinned ${f(dp.steer)} (${dp.deg.toFixed(1)} deg) free ${f(df.steer)} (${df.deg.toFixed(1)} deg, speed ${f(df.speed)})`,
    );
  }
  return 0;
}

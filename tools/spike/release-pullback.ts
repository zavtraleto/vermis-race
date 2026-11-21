// THROWAWAY SPIKE (docs/research/release-pullback.md): "on release the car is pulled to the wrong
// place" (author, phone, 2026-11-21). Measures x, vx, vel, yaw, carry after releasing the steer /
// the drift, plus the screen (R27b camPosX, R27c shift, R89 body yaw) for model B, variant 3.
// Everything runs through the REAL src/sim `step`; parameters are overridden in memory only; the
// render rules are re-run with their own pure functions (stepCamLag, stepCamDrift, bodyYawDeg).
// Prototype rule changes are emulated as wrappers (x post-shift after `step`, render-side filters).
// Run: node tools/run-ts.mjs tools/spike/release-pullback.ts [--part 1|2|3|4|5|6|all]
import { baseCar } from '../../src/data/cars';
import camera from '../../src/data/camera.json';
import road from '../../src/data/road.json';
import sprites from '../../src/data/sprites.json';
import { curveClasses } from '../../src/data/tracks';
import { stepCamDrift, type CamDriftConfig } from '../../src/render/cameraDrift';
import { stepCamLag } from '../../src/render/cameraLag';
import { bodyYawDeg } from '../../src/render/carWeight';
import { DT } from '../../src/sim/constants';
import { createRace, step } from '../../src/sim/race';
import type { Car, CarParams, InputFrame, Track } from '../../src/sim/types';
import { argValue, type Io } from '../io';

const C = curveClasses as Record<string, number>;
const RD = road as { halfWidth: number };
const CAM = camera as typeof camera & CamDriftConfig;
const SW = sprites as unknown as {
  weight: { slipDeg: number; velDeg: number; leadDeg: number; minSpeed: number; yawTau: number };
  player: { baseY: number };
};
/** px per half-width at the car line, 360x640 (roadHalfWidthPxAt). */
const PX =
  ((SW.player.baseY * CAM.screenHeight - CAM.horizon * CAM.screenHeight) / CAM.height) *
  RD.halfWidth;
// Author 2026-11-20: drift exit turbo off.
const P0: CarParams = { ...baseCar, driftTurbo: 0, driftEntry: 3 };
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
function table(io: Io, head: string[], rows: string[][]): void {
  io.log('| ' + head.join(' | ') + ' |');
  io.log('|' + head.map(() => ' --- ').join('|') + '|');
  for (const r of rows) io.log('| ' + r.join(' | ') + ' |');
  io.log('');
}
const approach = (v: number, t: number, dt: number, tau: number): number =>
  tau > 0 ? v + (t - v) * (1 - Math.exp(-dt / tau)) : t;

// ---------------------------------------------------------------- tracks
/** straight `pre` segs, curve c for `len` segs, then straight. len < 0 = curve forever. */
function track(c: number, pre = 0, len = -1): Track {
  const segments = [];
  for (let i = 0; i < 12000; i++) {
    const inC = i >= pre && (len < 0 || i < pre + len);
    segments.push({ curve: inC ? c : 0 });
  }
  return { segments };
}

// ---------------------------------------------------------------- render + proto knobs
interface Rnd {
  camLagTau: number;
  camLagMax: number;
  camDriftShift: number;
  leadDeg: number;
  /** proto R27b': separate time constant while |x - camPos| shrinks (0 = same as camLagTau). */
  camReturnTau: number;
  /** proto R89': lead term only when it points the way the car moves (lead*vx > 0). */
  leadOneSided: boolean;
  /** proto R27d: camPos = (1 - camFollowK)*x, no lag (0 = R27b as today). */
  camFollowK: number;
}
const R0: Rnd = {
  camLagTau: CAM.camLagTau,
  camLagMax: CAM.camLagMax,
  camDriftShift: CAM.camDriftShift ?? 0,
  leadDeg: SW.weight.leadDeg,
  camReturnTau: 0,
  leadOneSided: false,
  camFollowK: 0,
};
interface Proto {
  /**
   * proto R85b' (catch only): the GRIP lead (R85b + R85c) toward the finger (lead*steer > 0) is
   * kept; otherwise it may only cancel the course motion: vx stays between 0 and vel*sp*latScale.
   */
  leadCatch?: boolean;
  /** proto R82': for releaseLeadT s after a drift exit the GRIP lead is 0 (R85b, R85c). */
  exitNoLeadT?: number;
  /**
   * proto R80b (release memory): after a release (raw steer becomes exactly 0 from != 0, or a
   * drift exit) and while the raw steer stays 0, GRIP sees the steer sRoad*exp(-t/relTau), sRoad =
   * clamp((A + yawAlign*sG)/(yawRateMax*f), -1, 1) = the steer whose vStar is 0 on this curve
   * (holds the line). Straights: sRoad = 0, nothing changes. Any finger input cancels it.
   */
  relTau?: number;
  /**
   * proto R84c (rails), DRIFT only. 'naive': on a corner toward dir (A*dir > 0) the road push
   * driftPush*A is cut by the share k. 'cap': the push is cut only by the part above what the
   * R83b floor angle carries inward: velT += k*dir*max(0, driftPush*A*dir - driftLat*driftMinU)
   * (k 1: the finger at the floor holds the line; easy corners and straights unchanged).
   */
  rail?: { mode: 'naive' | 'cap'; k: number };
  /**
   * Release-memory candidates (all through the GRIP steer, R80 stage). The car is led to a target
   * lateral speed vT via the steer sFor(vT) = (yawAlign*(vT + sG) + A)/(yawRateMax*f) (unclipped),
   * the inverse of vStar (R85b); vInf = vStar(0) = the steady R13 slide at steer 0.
   * 'expU': vT = vT0 + (vInf - vT0)*(1 - exp(-t/T)).
   * 'accel': vT = vT0 + sign(vInf)*a*t until |vT| >= |vInf| (then the memory ends).
   * 'mult': not a memory: in GRIP always steer += (1 - m)*sFor(0) (R13 slide scaled by m).
   * vT0 = the outward part of vel at the release (0 if the car moved inward).
   */
  mem?: { kind: 'expU' | 'accel' | 'mult'; T?: number; a?: number; m?: number };
}

interface Sample {
  t: number;
  x: number;
  vx: number;
  vel: number;
  yaw: number;
  carry: number;
  state: string;
  cam: number; // camPosX + camShiftX
  off: number; // x - cam, half-widths (screen offset of the car / PX)
  body: number; // smoothed body yaw, deg
}

/** Run with a scripted input; returns samples per tick. `inp(t, car)` fills the frame. */
function run(
  p: CarParams,
  rnd: Rnd,
  tr: Track,
  T: number,
  inp: (t: number, c: Car, fr: InputFrame) => void,
  pr: Proto = {},
): Sample[] {
  const race = createRace(1, 1);
  const car = race.cars[0]!;
  car.speed = p.vmax;
  const fr: InputFrame = { steer: 0, brake: false, drift: false };
  let camPos = 0;
  let camO = 0;
  const cd = { shiftX: 0, rollDeg: 0 };
  const cdCfg: CamDriftConfig = { ...CAM, camDriftShift: rnd.camDriftShift };
  let body = 0;
  let sinceExit = 1e9;
  let relOn = false;
  let relT = 0;
  let prevUser = 0;
  let memOn = false;
  let memT = 0;
  let memV0 = 0;
  let memPrev = 0;
  // R80 clamps the steer to ±1, but holding hard/sharp needs up to 1.77: on memory ticks the step
  // runs with yawRateMax*K and the steer/K (the same R83/R85b), R86b scrub rescaled to match.
  const K = 3;
  const pK: CarParams = {
    ...p,
    yawRateMax: p.yawRateMax * K,
    scrubStart: p.scrubStart / K,
    scrubRate: p.scrubRate * K,
  };
  let useK = false;
  const out: Sample[] = [];
  const n = Math.round(T / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    inp(t, car, fr);
    const wasDrift = car.state === 'DRIFT';
    const sp = car.speed / p.vmax;
    if (pr.relTau !== undefined) {
      const user = fr.steer;
      if (user !== 0) {
        relOn = false;
      } else if (!fr.drift && (prevUser !== 0 || wasDrift)) {
        relOn = true;
        relT = 0;
      }
      prevUser = user;
      if (relOn && !fr.drift) {
        const seg = Math.floor(car.z) % tr.segments.length;
        const A = tr.segments[seg]!.curve * sp * p.kYaw;
        let sG = A / p.velGrip;
        if (sG > p.slipGripMax) sG = p.slipGripMax;
        if (sG < -p.slipGripMax) sG = -p.slipGripMax;
        const ff = Math.min(1, sp / p.yawFullSpeed);
        let sR = (A + p.yawAlign * sG) / (p.yawRateMax * ff);
        if (sR > 1) sR = 1;
        if (sR < -1) sR = -1;
        fr.steer = sR * Math.exp(-relT / pr.relTau);
        relT += DT;
      }
    }
    useK = false;
    if (pr.mem) {
      const user = fr.steer;
      const seg = Math.floor(car.z) % tr.segments.length;
      const A = tr.segments[seg]!.curve * sp * p.kYaw;
      let sG = A / p.velGrip;
      if (sG > p.slipGripMax) sG = p.slipGripMax;
      if (sG < -p.slipGripMax) sG = -p.slipGripMax;
      const ff = Math.min(1, sp / p.yawFullSpeed);
      const sFor = (vT: number): number => (p.yawAlign * (vT + sG) + A) / (p.yawRateMax * ff);
      const vInf = -A / p.yawAlign - sG;
      if (pr.mem.kind === 'mult') {
        if (!fr.drift) {
          fr.steer = (user + (1 - (pr.mem.m ?? 1)) * sFor(0)) / K;
          useK = true;
        }
      } else {
        if (user !== 0 || fr.drift) memOn = false;
        else if (memPrev !== 0 || wasDrift) {
          memOn = true;
          memT = 0;
          memV0 = car.vel * vInf > 0 ? car.vel : 0;
        }
        if (memOn) {
          let vT: number;
          if (pr.mem.kind === 'expU') {
            vT = memV0 + (vInf - memV0) * (1 - Math.exp(-memT / (pr.mem.T ?? 1)));
          } else {
            const sg = vInf > 0 ? 1 : vInf < 0 ? -1 : 0;
            vT = memV0 + sg * (pr.mem.a ?? 0.25) * memT;
            if (Math.abs(vT) >= Math.abs(vInf)) {
              memOn = false;
              vT = vInf;
            }
          }
          fr.steer = sFor(vT) / K;
          useK = true;
          memT += DT;
        }
      }
      memPrev = user;
    }
    const x0 = car.x;
    const seg0 = Math.floor(car.z) % tr.segments.length;
    step(race, [fr], tr, [useK ? pK : p]);
    // the lead rule F1 compares with the real steer sign (same as steer/K)
    if (pr.rail && car.state === 'DRIFT' && car.dir !== 0) {
      // R84c emulation: the extra velT enters vel through the same R84 chase of this tick
      const A = tr.segments[seg0]!.curve * sp * p.kYaw;
      const dir = car.dir;
      let dT = 0;
      if (pr.rail.mode === 'naive') {
        if (A * dir > 0) dT = pr.rail.k * p.driftPush * A;
      } else {
        const over = p.driftPush * A * dir - p.driftLat * p.driftMinU;
        if (over > 0) dT = pr.rail.k * dir * over;
      }
      if (dT !== 0) {
        const dv = dT * (1 - Math.exp(-p.velGripDrift * DT));
        car.vel += dv;
        car.yaw += dv;
        car.x += dv * sp * p.latScale * DT;
        car.vx += dv * sp * p.latScale;
      }
    }
    if (wasDrift && car.state === 'GRIP') sinceExit = 0;
    else sinceExit += DT;
    // --- proto sim wrappers (GRIP only): rewrite the R85b/R85c lead of this tick
    if (car.state === 'GRIP' && (pr.leadCatch || pr.exitNoLeadT !== undefined)) {
      const base = car.vel * sp * p.latScale;
      const lead = car.vx - base; // what step added (R85b + R85c)
      let nl = lead;
      if (pr.leadCatch && nl * fr.steer <= 0) {
        // not toward the finger: may only cancel the course motion (vx between 0 and base)
        if (base >= 0) nl = nl > 0 ? 0 : nl < -base ? -base : nl;
        else nl = nl < 0 ? 0 : nl > -base ? -base : nl;
      }
      if (pr.exitNoLeadT !== undefined && sinceExit < pr.exitNoLeadT) nl = 0;
      let x = x0 + (base + nl) * DT;
      if (x > p.xLimit) x = p.xLimit;
      if (x < -p.xLimit) x = -p.xLimit;
      car.x = x;
      car.vx = base + nl;
    }
    // --- render (R27b, R27c, R89 + yawTau smoothing)
    const vxAbs = car.vx;
    if (rnd.camFollowK > 0) {
      camPos = (1 - rnd.camFollowK) * car.x;
    } else if (rnd.camReturnTau > 0) {
      // proto R27b': the offset o = x - camPos chases oT = clamp(vx*camLagTau, ±camLagMax) (the
      // steady R27b lag): with camLagTau while |oT| > |o| (moving off), camReturnTau back.
      let oT = vxAbs * rnd.camLagTau;
      if (oT > rnd.camLagMax) oT = rnd.camLagMax;
      if (oT < -rnd.camLagMax) oT = -rnd.camLagMax;
      const tau =
        Math.abs(oT) >= Math.abs(camO) && oT * camO >= 0 ? rnd.camLagTau : rnd.camReturnTau;
      camO = approach(camO, oT, DT, tau);
      camPos = car.x - camO;
    } else {
      camPos = stepCamLag(camPos, car.x, DT, rnd.camLagTau, rnd.camLagMax);
    }
    const spN = car.speed / p.vmax;
    let lead = spN < SW.weight.minSpeed ? 0 : car.vx / (spN * p.latScale) - car.vel;
    if (rnd.leadOneSided && lead * car.vx <= 0) lead = 0;
    const by =
      bodyYawDeg(car.yaw, car.vel, car.carry, car.vx, spN, p.latScale, {
        ...SW.weight,
        leadDeg: 0,
      }) +
      rnd.leadDeg * lead;
    body = approach(body, by, DT, SW.weight.yawTau);
    const g = by / (p.slipFull * SW.weight.slipDeg);
    stepCamDrift(cd, g, car.state === 'DRIFT', DT, cdCfg);
    const cam = camPos + cd.shiftX;
    out.push({
      t: t + DT,
      x: car.x,
      vx: car.vx,
      vel: car.vel,
      yaw: car.yaw,
      carry: car.carry,
      state: car.state,
      cam,
      off: car.x - cam,
      body,
    });
  }
  return out;
}

// ---------------------------------------------------------------- metrics
interface M {
  xs: number[]; // s*(x - x0) at +0.1/0.3/0.6/1.0
  pull: number; // max -s*(x - x0) over 1 s, hw
  over: number; // max s*(x - x0) over 1 s, hw
  vxB: number; // s*vx before release
  vxA: number; // s*vx first tick after
  scrPull: number; // max -s*(off - off0) over 1 s, px (car moving back on screen)
  scrOff0: number; // s*off at release, px
  bodyB: number; // s*body at release
  bodyMin: number; // min s*body over 1 s after
  scr15: number; // -s*(off - off0) at +0.15 s, px
  scrV: number; // peak screen speed back (-s*d off/dt), px/s
}
function measure(S: Sample[], tRel: number, s: number): M {
  const i0 = Math.round(tRel / DT) - 1;
  const a = S[i0]!;
  const at = (dt: number): Sample => S[Math.min(S.length - 1, i0 + Math.round(dt / DT))]!;
  let pull = 0;
  let over = 0;
  let scr = 0;
  let bmin = 1e9;
  let scrV = 0;
  for (let k = 1; k <= Math.round(1 / DT) && i0 + k < S.length; k++) {
    const b = S[i0 + k]!;
    const d = s * (b.x - a.x);
    if (-d > pull) pull = -d;
    if (d > over) over = d;
    const ds = -s * (b.off - a.off);
    if (ds > scr) scr = ds;
    if (s * b.body < bmin) bmin = s * b.body;
    const v = (-s * (b.off - S[i0 + k - 1]!.off) * PX) / DT;
    if (v > scrV) scrV = v;
  }
  return {
    xs: [0.1, 0.3, 0.6, 1.0].map((dt) => s * (at(dt).x - a.x)),
    pull,
    over,
    vxB: s * a.vx,
    vxA: s * S[i0 + 1]!.vx,
    scrPull: scr * PX,
    scrOff0: s * a.off * PX,
    bodyB: s * a.body,
    bodyMin: bmin,
    scr15: -s * (at(0.15).off - a.off) * PX,
    scrV,
  };
}
function row(name: string, m: M): string[] {
  return [
    name,
    f(m.vxB) + ' → ' + f(m.vxA),
    m.xs.map((v) => f(v, 3)).join(' / '),
    f(m.pull, 3),
    f(m.over, 3),
    f(m.scrOff0, 0) + ' / ' + f(m.scrPull, 0) + ' / ' + f(m.scr15, 0) + ' / ' + f(m.scrV, 0),
    f(m.bodyB, 1) + ' → ' + f(m.bodyMin, 1),
  ];
}
const HEAD = [
  'случай',
  'vx·s до → после, полуш./с',
  's·Δx через 0.1/0.3/0.6/1.0 с',
  'откат, полуш.',
  'довыкат, полуш.',
  'экран: смещение / возврат / за 0.15 с, px / пик px/с',
  'кузов s·°: до → min',
];

// ---------------------------------------------------------------- scenarios
interface Variant {
  name: string;
  p: CarParams;
  r: Rnd;
  pr?: Proto;
}
function variants(): Variant[] {
  return [
    { name: 'сегодня', p: P0, r: R0 },
    { name: 'gripLead 0', p: { ...P0, gripLead: 0 }, r: R0 },
    { name: 'gripDodge 0', p: { ...P0, gripDodge: 0 }, r: R0 },
    { name: 'gripLead 0 + gripDodge 0', p: { ...P0, gripLead: 0, gripDodge: 0 }, r: R0 },
    { name: 'driftLead 0', p: { ...P0, driftLead: 0 }, r: R0 },
    { name: 'leadRamp 0', p: { ...P0, leadRamp: 0 }, r: R0 },
    { name: 'camLagTau 0', p: P0, r: { ...R0, camLagTau: 0 } },
    { name: 'leadDeg 0', p: P0, r: { ...R0, leadDeg: 0 } },
    { name: 'camDriftShift 0', p: P0, r: { ...R0, camDriftShift: 0 } },
  ];
}
function fixes(): Variant[] {
  return [
    { name: 'сегодня', p: P0, r: R0 },
    {
      name: 'F1 сим: опережение только ловит',
      p: P0,
      r: R0,
      pr: { leadCatch: true },
    },
    {
      name: 'F2 рендер: возврат камеры 0.4 с + кузов',
      p: P0,
      r: { ...R0, camReturnTau: 0.4, leadOneSided: true },
    },
    {
      name: 'F1 + F2',
      p: P0,
      r: { ...R0, camReturnTau: 0.4, leadOneSided: true },
      pr: { leadCatch: true },
    },
    { name: 'F3 сим: память отпускания 0.4 с', p: P0, r: R0, pr: { relTau: 0.4 } },
    { name: 'F1 + F3 (0.4 с)', p: P0, r: R0, pr: { leadCatch: true, relTau: 0.4 } },
    { name: 'F1 + F3 (0.6 с)', p: P0, r: R0, pr: { leadCatch: true, relTau: 0.6 } },
    {
      name: 'F4 рендер: камера без отставания, k 0.2',
      p: P0,
      r: { ...R0, camFollowK: 0.2, leadOneSided: true },
    },
    {
      name: 'F1 + F2 + F3 (0.4 с)',
      p: P0,
      r: { ...R0, camReturnTau: 0.4, leadOneSided: true },
      pr: { leadCatch: true, relTau: 0.4 },
    },
    {
      name: 'F1 + F3 (0.4 с) + F4',
      p: P0,
      r: { ...R0, camFollowK: 0.2, leadOneSided: true },
      pr: { leadCatch: true, relTau: 0.4 },
    },
  ];
}

/** Steer that holds |vx| ~ 0 in a steady drift of side dir on curve c (bisection, 3 s). */
function holdSteer(c: number, dir: number): number {
  const tr = track(c);
  let lo = -1;
  let hi = 1;
  for (let it = 0; it < 24; it++) {
    const u = (lo + hi) / 2;
    const S = run(P0, R0, tr, 3, (t, _c, fr) => {
      fr.drift = true;
      fr.steer = t < 0.05 ? dir : dir * u;
    });
    let m = 0;
    for (let k = S.length - 120; k < S.length; k++) m += S[k]!.vx;
    m /= 120;
    // more steer toward dir = more inward (toward dir): m*dir grows with u
    if (m * dir > 0) hi = u;
    else lo = u;
  }
  return (lo + hi) / 2;
}

function part1(io: Io): void {
  io.log(`px per half-width at the car line: ${f(PX, 1)}`);
  io.log('## S1/S2: straight, GRIP, steer s for T, then 0 (s = +1: expected x not to decrease)');
  for (const set of [variants(), fixes()]) {
    for (const amp of [1, 0.5]) {
      for (const T of [0.3, 0.6, 1.0]) {
        const rows: string[][] = [];
        for (const v of set) {
          const S = run(
            v.p,
            v.r,
            track(0),
            T + 1.2,
            (t, _c, fr) => {
              fr.steer = t < T ? amp : 0;
            },
            v.pr,
          );
          rows.push(row(v.name, measure(S, T, 1)));
        }
        io.log(`### руль ${amp} на ${T} с`);
        table(io, HEAD, rows);
      }
    }
  }
}

function part2(io: Io): void {
  io.log('## S3: GRIP corner (right, curve > 0), full steer inward 2 s, then 0 (s = +1)');
  for (const set of [variants(), fixes()]) {
    for (const cls of ['medium', 'hard']) {
      const rows: string[][] = [];
      for (const v of set) {
        const S = run(
          v.p,
          v.r,
          track(C[cls]!),
          3.2,
          (t, _c, fr) => {
            fr.steer = t < 2 ? 1 : 0;
          },
          v.pr,
        );
        rows.push(row(v.name, measure(S, 2, 1)));
      }
      io.log(`### ${cls} (curve ${C[cls]})`);
      table(io, HEAD, rows);
    }
  }
  io.log('## S3b: GRIP in a corner, steady at steer 0 — the R13 baseline (no release)');
  const rows: string[][] = [];
  for (const cls of ['medium', 'hard', 'sharp']) {
    for (const v of [variants()[0]!, variants()[3]!]) {
      const S = run(v.p, v.r, track(C[cls]!), 1.0, (_t, _c, fr) => {
        fr.steer = 0;
      });
      const x = (tt: number): number => S[Math.round(tt / DT) - 1]!.x;
      rows.push([cls, v.name, f(S[0]!.vx), f(x(0.1), 3), f(x(0.3), 3), f(x(0.6), 3)]);
    }
  }
  table(io, ['поворот', 'вариант', 'vx на 1-м тике', 'x 0.1 с', 'x 0.3 с', 'x 0.6 с'], rows);
}

function part3(io: Io): void {
  io.log('## S4: straight drift left (steer -1, drift) 1 s, release both (s = dir = -1)');
  for (const set of [variants(), fixes()]) {
    const rows: string[][] = [];
    for (const v of set) {
      const S = run(
        v.p,
        v.r,
        track(0),
        2.2,
        (t, _c, fr) => {
          fr.drift = t < 1;
          fr.steer = t < 1 ? -1 : 0;
        },
        v.pr,
      );
      rows.push(row(v.name, measure(S, 1, -1)));
    }
    table(io, HEAD, rows);
  }
  io.log('## S5: steady left drift (dir -1) in a left corner at the hold steer, release (s = -1)');
  for (const cls of ['medium', 'hard', 'sharp']) {
    const c = -C[cls]!;
    const u = holdSteer(c, -1);
    io.log(`### ${cls}: hold steer ${f(u, 3)} toward dir`);
    for (const where of ['mid', 'exit']) {
      for (const set of [variants(), fixes()]) {
        const rows: string[][] = [];
        for (const v of set) {
          // mid: constant corner, release at 3 s. exit: corner from z 0 for 3 s of road, straight
          // after; release on the first straight segment.
          const corner = 180;
          const tr = where === 'mid' ? track(c) : track(c, 0, corner);
          let tRel = 3;
          if (where === 'exit') {
            // find the tick the car reaches the corner end with the drift held
            // first tick whose step starts on a straight segment (z after the previous step)
            let k = 1;
            while (zAt(v, tr, u, k - 1) < corner) k++;
            tRel = k * DT;
          }
          const S = run(
            v.p,
            v.r,
            tr,
            tRel + 1.2,
            (t, _c, fr) => {
              fr.drift = t < tRel;
              fr.steer = t < tRel ? (t < 0.05 ? -1 : -u) : 0;
            },
            v.pr,
          );
          rows.push(row(v.name, measure(S, tRel, -1)));
        }
        io.log(`#### ${where === 'mid' ? 'середина поворота' : 'выход на прямую'}`);
        table(io, HEAD, rows);
      }
    }
  }
}

// z of the car per tick for the exit search (cached per variant/track/steer)
const zCache = new Map<string, number[]>();
function zAt(v: Variant, tr: Track, u: number, i: number): number {
  const key = v.name + '|' + String(u) + '|' + String(tr.segments[0]!.curve);
  let zs = zCache.get(key);
  if (!zs) {
    zs = [];
    const race = createRace(1, 1);
    const car = race.cars[0]!;
    car.speed = v.p.vmax;
    const fr: InputFrame = { steer: 0, brake: false, drift: true };
    for (let k = 0; k < Math.round(6 / DT); k++) {
      fr.steer = k * DT < 0.05 ? -1 : -u;
      step(race, [fr], tr, [v.p]);
      zs.push(car.z);
    }
    zCache.set(key, zs);
  }
  return zs[i]!;
}

const free = (p: CarParams): CarParams => ({
  ...p,
  xLimit: 1e9,
  offroadMul: 1,
  crashMinSpeed: 1e9,
});
const F13: Proto = { leadCatch: true, relTau: 0.4 };
function railSets(): { name: string; pr: Proto }[] {
  return [
    { name: 'сегодня (rail 0, без F1/F3)', pr: {} },
    { name: 'F1+F3, rail 0', pr: { ...F13 } },
    { name: 'F1+F3, naive 0.5', pr: { ...F13, rail: { mode: 'naive', k: 0.5 } } },
    { name: 'F1+F3, naive 1', pr: { ...F13, rail: { mode: 'naive', k: 1 } } },
    { name: 'F1+F3, cap 0.5', pr: { ...F13, rail: { mode: 'cap', k: 0.5 } } },
    { name: 'F1+F3, cap 1', pr: { ...F13, rail: { mode: 'cap', k: 1 } } },
  ];
}

function part4(io: Io): void {
  const p = free(P0);
  io.log('## S6: rails. Steady drift dir -1 in a left corner, steer u toward dir, 3 s; release');
  io.log('inward = toward dir. drift x 2->3 s; body at 3 s; release: outward x at +0.1/0.3/0.6 s');
  for (const cls of ['easy', 'medium', 'hard', 'sharp']) {
    const c = -C[cls]!;
    const tr = track(c);
    const rows: string[][] = [];
    for (const v of railSets()) {
      for (const u of [0, 0.5, 1]) {
        const S = run(
          p,
          R0,
          tr,
          3.7,
          (t, _c, fr) => {
            fr.drift = t < 3;
            fr.steer = t < 3 ? (t < 0.05 ? -1 : -u) : 0;
          },
          v.pr,
        );
        const at = (tt: number): Sample => S[Math.round(tt / DT) - 1]!;
        const inward = -(at(3).x - at(2).x);
        const out = (dt: number): number => at(3 + dt).x - at(3).x; // outward = +x (right)
        rows.push([
          v.name,
          f(u, 1),
          f(inward, 3),
          f(-at(3).body, 1),
          f(out(0.1), 3) + ' / ' + f(out(0.3), 3) + ' / ' + f(out(0.6), 3),
        ]);
      }
    }
    io.log(`### ${cls} (curve ${c})`);
    table(
      io,
      [
        'вариант',
        'руль к dir',
        'дрейф внутрь за 1 с, полуш.',
        'кузов к dir, °',
        'отпуск: наружу 0.1 / 0.3 / 0.6 с',
      ],
      rows,
    );
  }
  io.log('## S7: drift on a straight (dir -1, steer u): drift x over 1 s (2->3 s) toward dir');
  const rows7: string[][] = [];
  for (const v of railSets()) {
    for (const u of [0, 1]) {
      const S = run(
        p,
        R0,
        track(0),
        3.7,
        (t, _c, fr) => {
          fr.drift = t < 3;
          fr.steer = t < 3 ? (t < 0.05 ? -1 : -u) : 0;
        },
        v.pr,
      );
      const at = (tt: number): Sample => S[Math.round(tt / DT) - 1]!;
      rows7.push([v.name, f(u, 1), f(-(at(3).x - at(2).x), 4), f(at(3.6).x - at(3).x, 4)]);
    }
  }
  table(io, ['вариант', 'руль', 'к dir за 1 с', 'после отпуска 0.6 с'], rows7);
  io.log('## S8: drift against the corner: right corner, drift left (dir -1), steer -1 from x 0');
  io.log('time until x < -1 (leaves the road), and GRIP steer 0 (x > 1) for reference');
  const rows8: string[][] = [];
  for (const cls of ['easy', 'medium', 'hard']) {
    const tr = track(C[cls]!);
    const tOff = (S: Sample[]): string => {
      const k = S.findIndex((q) => q.x < -1 || q.x > 1);
      return k < 0 ? '—' : f((k + 1) * DT, 3);
    };
    const g = run(p, R0, tr, 4, (_t, _c, fr) => {
      fr.steer = 0;
    });
    for (const v of railSets()) {
      const S = run(
        p,
        R0,
        tr,
        4,
        (_t, _c, fr) => {
          fr.drift = true;
          fr.steer = -1;
        },
        v.pr,
      );
      rows8.push([cls, v.name, tOff(S), tOff(g)]);
    }
  }
  table(io, ['поворот', 'вариант', 'дрифт: уход с дороги, с', 'GRIP руль 0, с'], rows8);
}

function part5(io: Io): void {
  io.log('## S9: checks');
  // (a) bit-identity: wrappers with zero effect vs plain run
  const cases: [string, Track, (t: number, c: Car, fr: InputFrame) => void][] = [
    [
      'grip straight',
      track(0),
      (t, _c, fr) => {
        fr.steer = t < 0.6 ? 1 : 0;
      },
    ],
    [
      'grip hard',
      track(C.hard!),
      (t, _c, fr) => {
        fr.steer = t < 2 ? 1 : 0;
      },
    ],
    [
      'drift hard',
      track(-C.hard!),
      (t, _c, fr) => {
        fr.drift = t < 3;
        fr.steer = t < 3 ? -0.87 : 0;
      },
    ],
  ];
  for (const [nm, tr, inp] of cases) {
    const a = run(P0, R0, tr, 4, inp);
    const b = run(P0, R0, tr, 4, inp, { rail: { mode: 'cap', k: 0 } });
    const c2 = run(P0, R0, tr, 4, inp, { rail: { mode: 'naive', k: 0 } });
    let same = true;
    for (let i = 0; i < a.length; i++) {
      const q = a[i]!;
      for (const o of [b[i]!, c2[i]!]) {
        if (q.x !== o.x || q.vx !== o.vx || q.vel !== o.vel || q.yaw !== o.yaw) same = false;
      }
    }
    io.log(`bit-identical rail 0 (${nm}): ${same ? 'yes' : 'NO'}`);
  }
  io.log('');
  // (b) R27b criteria and R89 60 ms with/without F2; R89c lane with/without F1
  const rows: string[][] = [];
  const sets: [string, Rnd, Proto][] = [
    ['сегодня', R0, {}],
    ['F2', { ...R0, camReturnTau: 0.4, leadOneSided: true }, {}],
    ['F1+F2+F3', { ...R0, camReturnTau: 0.4, leadOneSided: true }, F13],
  ];
  for (const [nm, r, pr] of sets) {
    const S = run(
      P0,
      r,
      track(0),
      3,
      (t, _c, fr) => {
        fr.steer = t < 0.6 ? 1 : 0;
      },
      pr,
    );
    const at = (tt: number): Sample => S[Math.round(tt / DT) - 1]!;
    const off25 = at(0.25).off * PX;
    let t5 = -1;
    for (let k = Math.round(0.6 / DT); k < S.length && t5 < 0; k++) {
      let ok = true;
      for (let j = k; j < S.length; j++) if (Math.abs(S[j]!.off * PX) >= 5) ok = false;
      if (ok) t5 = (k + 1) * DT - 0.6;
    }
    const ret15 = (at(0.6).off - at(0.75).off) * PX;
    // lane change: full steer until x >= 0.25, then 0
    const L = run(
      P0,
      r,
      track(0),
      2,
      (_t, c, fr) => {
        fr.steer = c.x < 0.25 ? 1 : 0;
      },
      pr,
    );
    const kL = L.findIndex((q) => q.x >= 0.25);
    let maxX = 0;
    let stop = 0;
    for (let k = kL; k < L.length; k++) {
      if (L[k]!.x > maxX) maxX = L[k]!.x;
      if (Math.abs(L[k]!.vx) > 0.02) stop = (k - kL + 1) * DT;
    }
    // R89 unsmoothed body after 60 ms of full steer (formula on step fields, sp ~ 1)
    const B = run(
      P0,
      r,
      track(0),
      0.06,
      (_t, _c, fr) => {
        fr.steer = 1;
      },
      pr,
    );
    const q = B[B.length - 1]!;
    let lead = q.vx - q.vel;
    if (r.leadOneSided && lead * q.vx <= 0) lead = 0;
    const raw =
      (q.yaw - q.vel + q.carry) * SW.weight.slipDeg + q.vel * SW.weight.velDeg + r.leadDeg * lead;
    rows.push([
      nm,
      f(off25, 0),
      f(ret15, 0),
      f(t5, 2),
      f((kL + 1) * DT, 3),
      f(maxX - 0.25, 3),
      f(stop, 3),
      f(raw, 1),
    ]);
  }
  table(
    io,
    [
      'вариант',
      'экран через 0.25 с, px (R27b ≥ 50)',
      'назад за 0.15 с после отпуска, px',
      'после отпуска < 5 px навсегда, с',
      'полоса, с (R89c)',
      'перелёт',
      'остановка, с',
      'кузов 60 мс, ° (R89 ≥ 15)',
    ],
    rows,
  );
}

function memSets(): { name: string; pr: Proto }[] {
  return [
    { name: 'сегодня', pr: {} },
    { name: 'F1', pr: { leadCatch: true } },
    { name: 'F1+F3 (exp 0.4, обрезка 1)', pr: { ...F13 } },
    {
      name: '(а) F1 + exp без обрезки, T 1.5',
      pr: { leadCatch: true, mem: { kind: 'expU', T: 1.5 } },
    },
    { name: '(а) F1 + exp без обрезки, T 6', pr: { leadCatch: true, mem: { kind: 'expU', T: 6 } } },
    {
      name: '(б) F1 + разгон сноса a 0.25',
      pr: { leadCatch: true, mem: { kind: 'accel', a: 0.25 } },
    },
    {
      name: '(б) F1 + разгон сноса a 0.4',
      pr: { leadCatch: true, mem: { kind: 'accel', a: 0.4 } },
    },
    { name: '(в) F1 + снос ×0.5', pr: { leadCatch: true, mem: { kind: 'mult', m: 0.5 } } },
    { name: '(в) F1 + снос ×0.12', pr: { leadCatch: true, mem: { kind: 'mult', m: 0.12 } } },
    {
      name: '(б) a 0.25 + rail cap 0.5',
      pr: { leadCatch: true, mem: { kind: 'accel', a: 0.25 }, rail: { mode: 'cap', k: 0.5 } },
    },
  ];
}
const TS = [0.1, 0.3, 0.6, 1.0, 1.5, 3.0];
/** Outward displacement after the release at tRel (out = sign of outward), max |dvx| per tick in
 * the first 0.3 s, time until 1 half-width outward. */
function relRow(S: Sample[], tRel: number, out: number): string[] {
  const i0 = Math.round(tRel / DT) - 1;
  const a = S[i0]!;
  const xs = TS.map((dt) =>
    f(out * (S[Math.min(S.length - 1, i0 + Math.round(dt / DT))]!.x - a.x), 3),
  );
  let jump = 0;
  for (let k = 1; k <= Math.round(0.3 / DT); k++) {
    const d = out * (S[i0 + k]!.vx - S[i0 + k - 1]!.vx); // outward increment
    if (d > jump) jump = d;
  }
  let tEdge = '—';
  for (let k = 1; i0 + k < S.length; k++) {
    if (out * (S[i0 + k]!.x - a.x) >= 1) {
      tEdge = f(k * DT, 2);
      break;
    }
  }
  return [xs.join(' / '), f(jump, 3), tEdge];
}

function part6(io: Io): void {
  const p = free(P0);
  io.log(
    '## S10: release-memory candidates. Outward dx after release at 0.1/0.3/0.6/1.0/1.5/3.0 s',
  );
  io.log(
    'target: <= 0.05 at 0.3 s, <= 0.10 at 0.6 s, <= 0.30 at 1.5 s; jump = max outward dvx per tick, 0.3 s',
  );
  const head = [
    'вариант',
    'наружу 0.1 / 0.3 / 0.6 / 1.0 / 1.5 / 3.0 с',
    'скачок vx наружу за тик',
    'до 1 полуш., с',
  ];
  for (const cls of ['medium', 'hard', 'sharp']) {
    // GRIP: right corner, full steer inward 2 s, release (outward = -x)
    const rowsG: string[][] = [];
    const rowsD: string[][] = [];
    const u = holdSteer(-C[cls]!, -1);
    for (const v of memSets()) {
      const G = run(
        p,
        R0,
        track(C[cls]!),
        7,
        (t, _c, fr) => {
          fr.steer = t < 2 ? 1 : 0;
        },
        v.pr,
      );
      rowsG.push([v.name, ...relRow(G, 2, -1)]);
      // DRIFT: left corner, dir -1, hold steer 3 s, release (outward = +x)
      const D = run(
        p,
        R0,
        track(-C[cls]!),
        8,
        (t, _c, fr) => {
          fr.drift = t < 3;
          fr.steer = t < 3 ? (t < 0.05 ? -1 : -u) : 0;
        },
        v.pr,
      );
      rowsD.push([v.name, ...relRow(D, 3, 1)]);
    }
    io.log(`### ${cls}: GRIP, полный руль внутрь 2 с → 0`);
    table(io, head, rowsG);
    io.log(`### ${cls}: дрифт (руль удержания ${f(u, 2)}) 3 с → отпустить`);
    table(io, head, rowsD);
  }
  // hold steer for (c), from the formula: m*sFor(0) at vmax
  io.log('### (в): руль, держащий линию в GRIP на vmax (m*sRoad без обрезки; > 1 = не держит)');
  const rows: string[][] = [];
  for (const cls of ['easy', 'medium', 'hard', 'sharp']) {
    const A = C[cls]! * P0.kYaw;
    let sG = A / P0.velGrip;
    if (sG > P0.slipGripMax) sG = P0.slipGripMax;
    const s0 = (P0.yawAlign * sG + A) / P0.yawRateMax;
    rows.push([cls, f(s0, 2), f(0.5 * s0, 2), f(0.12 * s0, 2)]);
  }
  table(io, ['поворот', 'сегодня', '×0.5', '×0.12'], rows);
  // straight and drift entry unchanged
  io.log('### прямая: руль 1 на 0.6 с → 0 (довыкат через 0.6 с) и вход в дрифт (vx через 0.2 с)');
  const rowsS: string[][] = [];
  for (const v of memSets()) {
    const S = run(
      p,
      R0,
      track(0),
      1.4,
      (t, _c, fr) => {
        fr.steer = t < 0.6 ? 1 : 0;
      },
      v.pr,
    );
    const E = run(
      p,
      R0,
      track(-C.hard!),
      0.4,
      (t, _c, fr) => {
        fr.drift = t >= 0.2;
        fr.steer = -1;
      },
      v.pr,
    );
    rowsS.push([
      v.name,
      f(S[Math.round(1.2 / DT) - 1]!.x - S[Math.round(0.6 / DT) - 1]!.x, 4),
      f(E[E.length - 1]!.vx, 3) + ' ' + E[E.length - 1]!.state,
    ]);
  }
  table(io, ['вариант', 'довыкат, полуш.', 'hard: vx на 0.4 с (дрифт с 0.2 с)'], rowsS);
}

export function main(io: Io): number {
  const part = argValue(io.argv, 'part') ?? 'all';
  if (part === 'all' || part === '1') part1(io);
  if (part === 'all' || part === '2') part2(io);
  if (part === 'all' || part === '3') part3(io);
  if (part === 'all' || part === '4') part4(io);
  if (part === 'all' || part === '5') part5(io);
  if (part === 'all' || part === '6') part6(io);
  return 0;
}

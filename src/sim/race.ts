import { DT, SEG_PER_UNIT } from './constants';
import { nextRandom } from './rng';
import type {
  Car,
  CarParams,
  InputFrame,
  RaceState,
  RivalConfig,
  Track,
  TrafficConfig,
} from './types';

/** R200: every driving field back to 0. */
function clearDrive(c: Car): void {
  c.travel = 0;
  c.heading = 0;
  c.steer = 0;
  c.slipRate = 0;
  c.counter = 0;
  c.driftTimer = 0;
  c.edge = 0;
  c.refAngle = 0;
  c.wallTicks = 0;
  c.prevGas = 0;
  c.prevBrake = 0;
}

export function createRace(seed: number, carCount: number, trafficCount = 0): RaceState {
  const cars: Car[] = [];
  // R70: traffic cars are appended after the player and rivals.
  for (let i = 0; i < carCount + trafficCount; i++) {
    cars.push({
      kind: i >= carCount ? 'traffic' : i === 0 ? 'player' : 'rival',
      z: 0,
      x: 0,
      speed: 0,
      travel: 0,
      heading: 0,
      steer: 0,
      slipRate: 0,
      counter: 0,
      driftTimer: 0,
      edge: 0,
      refAngle: 0,
      wallTicks: 0,
      prevGas: 0,
      prevBrake: 0,
      bumpTicks: 0,
      draft: 0,
      boostTicks: 0,
      crashTicks: 0,
      crashSpeed0: 0,
      crashX0: 0,
      cruise: 0,
      skill: 0,
      pace: 1,
      nameId: -1,
      place: 0,
      role: 0,
      slot: 0,
      slotTicks: 0,
      nemesis: 0,
      band: 0,
      joinTicks: 0,
    });
  }
  // R2: RNG state is a plain 32-bit int inside the state.
  return { tick: 0, rng: seed | 0, cars };
}

/** Advances the race by exactly one DT, in place. inputs[i] and params[i] belong to cars[i]. */
export function step(
  state: RaceState,
  inputs: readonly InputFrame[],
  track: Track,
  params: readonly CarParams[],
  traffic?: TrafficConfig,
  rivals?: RivalConfig,
): void {
  const segCount = track.segments.length;
  const cars = state.cars;
  // R63: the rubber band distance uses the player z at the start of the step.
  const lead = cars[0];
  const hasPlayer = lead !== undefined && lead.kind === 'player';
  const playerZ0 = hasPlayer ? lead.z : 0;
  const bandOn = rivals !== undefined && rivals.rubberBand === 1 && hasPlayer;
  // R63: the band target is 0 for the first bandStartDelay seconds (tick at the start of the step).
  const bandDelayed = rivals !== undefined && state.tick < Math.round(rivals.bandStartDelay / DT);
  // R4: cars updated in index order, each with its own input and params.
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i]!;
    const input = inputs[i]!;
    const p = params[i]!;

    // R70: traffic is on rails: only its z advance runs (no input, no driving rules).
    if (car.kind === 'traffic') {
      // R41b: a pushed car returns to its cruise speed before it moves (player vmax, as in R71).
      if (car.speed > car.cruise) {
        const v = car.speed - p.bumpPushDecay * (hasPlayer ? params[0]!.vmax : p.vmax) * DT;
        car.speed = v > car.cruise ? v : car.cruise;
      }
      car.z += car.speed * DT * SEG_PER_UNIT;
      continue;
    }
    // R43: the invulnerability window counts down in the car's own update.
    if (car.bumpTicks > 0) car.bumpTicks--;

    if (car.kind === 'rival') {
      if (car.joinTicks > 0) car.joinTicks--; // R63b
      if (rivals !== undefined && car.slotTicks > 0) {
        // R62b: the slot is redrawn from the role range on the tick the timer reaches 0.
        car.slotTicks--;
        if (car.slotTicks === 0) drawSlot(state, car, rivals);
      }
      // R63: smoothed slot band; 0 without a rival config or with H15 B.
      if (bandOn) updateBand(car, rivals, car.z - playerZ0, bandDelayed);
      else car.band = 0;
    }

    // R48: during a crash input and the driving rules do not apply.
    if (car.crashTicks > 0) {
      crashStep(car, p);
      continue;
    }
    const z0 = car.z;
    drive(car, input, p, cars);
    lampHit(car, z0, p, segCount); // R47/R64: after the move, before R40
  }
  // R71: respawn after all cars moved, relative to the player.
  if (hasPlayer && traffic !== undefined) respawnTraffic(state, traffic, lead.z, params[0]!.vmax);
  // R63b: rivals beyond poolRadius of the player (end of the step) are replaced on this tick.
  if (hasPlayer && rivals !== undefined) poolRivals(state, rivals, lead);
  // R40/R64: traffic contact of every race car at the end of the step, in index order.
  for (let i = 0; i < cars.length; i++) {
    if (cars[i]!.kind !== 'traffic') bumpTraffic(cars[i]!, cars, params[i]!);
  }
  // R65: contact between race cars after R40 (rivalBumpLoss comes from the rival config).
  if (rivals !== undefined) raceContacts(cars, params, rivals);
  // R66: places at the end of the step.
  updatePlaces(cars);
  // R1: one fixed step.
  state.tick++;
}

/**
 * R200-R210 driving tick of a player or rival car. Demolition stub (ADR 0005): R203, R205-R209 and
 * the road turn of R210 are not implemented yet, so travel and heading stay as they are.
 */
function drive(car: Car, input: InputFrame, p: CarParams, cars: readonly Car[]): void {
  // R203 (stub): steer = the target, no smoothing yet.
  let steer = input.steer;
  if (steer > 1) steer = 1;
  if (steer < -1) steer = -1;
  car.steer = steer;
  const gas = input.gas < 0 ? 0 : input.gas > 1 ? 1 : input.gas;
  const brake = input.brake < 0 ? 0 : input.brake > 1 ? 1 : input.brake;
  car.prevGas = gas; // R200/R208
  car.prevBrake = brake;
  if (car.driftTimer > 0) car.driftTimer--; // R208

  // R50-R52: slipstream of the player on the positions at the start of the step; frozen in a drift.
  let boosted = false;
  if (car.kind === 'player') boosted = slipstream(car, cars, p, car.driftTimer > 0);

  // R204 (traction 1 in the stub): the cap is vmax*capMul, vcap = vmax*pace*(1 + band) (R62/R63).
  const vcap = p.vmax * car.pace * (1 + car.band);
  const cap = boosted ? vcap * p.draftCapMul : vcap;
  const accel = boosted ? p.accel * p.draftAccelMul : p.accel;
  let speed =
    car.speed + accel * gas * gas * DT - p.engineBrake * (1 - gas) * DT - p.brakeDecel * brake * DT;
  if (speed > cap) speed = cap;
  if (speed < 0) speed = 0;
  car.speed = speed;

  // R210: z and x from the speed and its direction travel (road turn under the car: TODO R210).
  const v = (speed * p.vmaxKmh) / 3.6;
  car.z += speed * DT * SEG_PER_UNIT * Math.cos(car.travel);
  car.x += (v * Math.sin(car.travel) * DT) / p.halfWidthM;

  // R18/R211: clamp to xLimit, travel toward the wall is zeroed.
  if (car.x > p.xLimit) {
    car.x = p.xLimit;
    if (car.travel > 0) car.travel = 0;
  } else if (car.x < -p.xLimit) {
    car.x = -p.xLimit;
    if (car.travel < 0) car.travel = 0;
  }
  // R15: offroad slowdown. TODO R15b: its grip and steer part waits for R206/R208.
  if (car.x > 1 || car.x < -1) car.speed *= Math.pow(p.offroadMul, 60 * DT);
}

/**
 * R47: the car hits a lamp post when z crossed (or reached) a boundary of a segment whose track
 * index is a multiple of lampEvery (the lamps R32 draws), |x| is inside the hit band around
 * lampOffset and the speed is above crashMinSpeed*vmax. Values are those of the end of the step.
 */
function lampHit(car: Car, z0: number, p: CarParams, segCount: number): void {
  const halfW = (p.carHitW + p.lampHitW) / 2;
  const ax = car.x < 0 ? -car.x : car.x;
  const d = ax - p.lampOffset;
  if (!(d < halfW && d > -halfW) || !(car.speed > p.crashMinSpeed * p.vmax)) return;
  // Segment boundaries b with z0 < b <= z (at most one per tick at road speeds).
  for (let b = Math.floor(z0) + 1; b <= car.z; b++) {
    let seg = b % segCount;
    if (seg < 0) seg += segCount;
    if (seg % p.lampEvery !== 0) continue;
    // R48: the crash starts with the speed and x of the end of this step; the driving state,
    // the slipstream charge and the boost are zeroed.
    car.crashTicks = Math.round(p.crashTime / DT);
    car.crashSpeed0 = car.speed;
    car.crashX0 = car.x;
    clearDrive(car);
    car.draft = 0;
    car.boostTicks = 0;
    return;
  }
}

/**
 * R48 crash tick: input ignored, speed falls linearly from crashSpeed0 to 0 and x moves linearly
 * from crashX0 to sign(crashX0)*crashReturnX over crashTime; z advances with the speed. The last
 * tick lands exactly on the road point with speed 0 and starts the R43 invulnerability.
 */
function crashStep(car: Car, p: CarParams): void {
  car.steer = 0;
  car.crashTicks--;
  const target = car.crashX0 < 0 ? -p.crashReturnX : p.crashReturnX;
  if (car.crashTicks === 0) {
    car.speed = 0;
    car.x = target;
    car.bumpTicks = Math.round(p.bumpInvulnTime / DT);
  } else {
    const f = car.crashTicks / Math.round(p.crashTime / DT);
    car.speed = car.crashSpeed0 * f;
    car.x = target + (car.crashX0 - target) * f;
  }
  car.z += car.speed * DT * SEG_PER_UNIT;
}

/** R50: a traffic car ahead with 0 < zT - z <= draftLength and |x - xT| <= draftWidth / 2. */
function inCone(car: Car, cars: readonly Car[], p: CarParams): boolean {
  const halfW = p.draftWidth / 2;
  for (let i = 0; i < cars.length; i++) {
    const t = cars[i]!;
    if (t.kind !== 'traffic') continue;
    const dz = t.z - car.z;
    const dx = car.x - t.x;
    if (dz > 0 && dz <= p.draftLength && dx <= halfW && dx >= -halfW) return true;
  }
  return false;
}

/** R51/R52: updates draft and boostTicks of the player for this step; returns whether it is boosted. */
function slipstream(car: Car, cars: readonly Car[], p: CarParams, drift: boolean): boolean {
  if (car.boostTicks > 0) car.boostTicks--; // R52 (H5 B): counts down from the step after it starts
  const cone = inCone(car, cars, p);
  if (car.draft >= 1 && !cone && p.draftBoost === 1) {
    // R52 (H5 B): leaving the cone with a full charge starts the boost (also in DRIFT).
    car.boostTicks = Math.round(p.boostTime / DT);
    car.draft = 0;
  } else if (!drift) {
    // R51: charge in the cone, decay outside, clamped to [0, 1]; frozen in DRIFT.
    let d = cone ? car.draft + DT / p.draftChargeTime : car.draft - DT / p.draftDecayTime;
    if (d > 1) d = 1;
    if (d < 0) d = 0;
    car.draft = d;
  }
  // R52: full charge in the cone (H5 A and B), or the H5 B boost counter.
  return car.boostTicks > 0 || (cone && car.draft >= 1);
}

/** R71: furthest z among traffic cars other than `skip`, -Infinity when there is none. */
function furthestTraffic(cars: readonly Car[], skip: Car): number {
  let far = -Infinity;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind === 'traffic' && c !== skip && c.z > far) far = c.z;
  }
  return far;
}

/** R71: places one traffic car beyond `furthest`, not closer than spawnAhead to the player. */
function spawnTraffic(
  state: RaceState,
  car: Car,
  cfg: TrafficConfig,
  furthest: number,
  playerZ: number,
  playerVmax: number,
): void {
  // R71: rng draws in fixed order: gap, lane, speed.
  const gap = cfg.trafficGapMin + (cfg.trafficGapMax - cfg.trafficGapMin) * nextRandom(state);
  const lane = Math.floor(nextRandom(state) * cfg.lanes);
  const sp = cfg.trafficSpeedMin + (cfg.trafficSpeedMax - cfg.trafficSpeedMin) * nextRandom(state);
  let z = furthest + gap;
  const minZ = playerZ + cfg.trafficSpawnAhead;
  if (!(z >= minZ)) z = minZ;
  car.z = z;
  car.x = -1 + ((lane + 0.5) * 2) / cfg.lanes; // R70: lane centre
  car.speed = sp * playerVmax;
  car.cruise = car.speed; // R41b
}

/** R71: cars more than trafficDespawnBehind behind the player reappear ahead, in index order. */
function respawnTraffic(state: RaceState, cfg: TrafficConfig, playerZ: number, vmax: number): void {
  const cars = state.cars;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind !== 'traffic' || c.z >= playerZ - cfg.trafficDespawnBehind) continue;
    spawnTraffic(state, c, cfg, furthestTraffic(cars, c), playerZ, vmax);
  }
}

/** R40-R44 (R64: player and rivals): at most one contact per step, traffic in index order. */
function bumpTraffic(car: Car, cars: readonly Car[], p: CarParams): void {
  if (car.bumpTicks !== 0) return; // R43
  if (car.crashTicks > 0) return; // R48: no contacts during a crash
  const halfW = (p.carHitW + p.trafficHitW) / 2;
  for (let i = 0; i < cars.length; i++) {
    const t = cars[i]!;
    if (t.kind !== 'traffic') continue;
    const dz = car.z - t.z;
    const dx = car.x - t.x;
    if (!(dz < p.carLength && dz > -p.carLength && dx < halfW && dx > -halfW)) continue; // R40
    // R41: rear hit vs side contact; the hitter never gains speed.
    const v0 = car.speed;
    const floor = p.bumpFloor * p.vmax;
    let target: number;
    if (car.z < t.z - p.carLength / 2) {
      target = v0 - p.bumpSpeedLoss * p.vmax;
      const push = v0 + p.bumpPush * p.vmax; // R41: the traffic car is pushed forward
      if (push > t.speed) t.speed = push;
    } else target = v0 - p.bumpSideLoss * p.vmax;
    if (target < floor) target = floor;
    if (target < v0) car.speed = target;
    // R42: lateral kick away from the traffic car; on a tie toward the road centre (right at 0).
    const side = dx > 0 ? 1 : dx < 0 ? -1 : t.x > 0 ? -1 : 1;
    kick(car, side, p);
    car.draft = 0; // R51: a contact zeroes the charge and the boost
    car.boostTicks = 0;
    return;
  }
}

/**
 * R42/R44/R43: the lateral kick (R42) and the drift angle loss (R44) used fields removed by ADR 0005
 * (vx, angle); until the collisions slice they do nothing. Only the R43 invulnerability is set.
 */
function kick(car: Car, _side: number, p: CarParams): void {
  car.bumpTicks = Math.round(p.bumpInvulnTime / DT); // R43
}

/**
 * R63: target from the slot error (asymmetric bandBoost / bandSlow), scaled inside the view window
 * (0 < d < bandViewDist) by bandViewMul (nemesisViewMul for the nemesis), 0 while delayed; then
 * exponential smoothing with bandAttack when |target| > |band|, else bandRelease.
 * d = z - zPlayer at the start of the step.
 */
function updateBand(car: Car, cfg: RivalConfig, d: number, delayed: boolean): void {
  let target = 0;
  if (!delayed) {
    let raw = (car.slot - d) / cfg.bandRange;
    if (raw > 1) raw = 1;
    if (raw < -1) raw = -1;
    target = raw > 0 ? cfg.bandBoost * raw : cfg.bandSlow * raw;
    if (d > 0 && d < cfg.bandViewDist)
      target *= car.nemesis === 1 ? cfg.nemesisViewMul : cfg.bandViewMul;
  }
  const b = car.band;
  const k = (target < 0 ? -target : target) > (b < 0 ? -b : b) ? cfg.bandAttack : cfg.bandRelease;
  car.band = b + (target - b) * (1 - Math.exp(-k * DT));
}

/**
 * R62b: draws the slot from the range of the role (nemesisSlot for the nemesis) and restarts the
 * slot timer at slotTimeMin..slotTimeMax seconds. Draws: slot, timer.
 */
function drawSlot(state: RaceState, car: Car, cfg: RivalConfig): void {
  const r =
    car.nemesis === 1
      ? cfg.nemesisSlot
      : car.role === 0
        ? cfg.slotClose
        : car.role === 1
          ? cfg.slotAhead
          : cfg.slotBehind;
  car.slot = r[0] + (r[1] - r[0]) * nextRandom(state);
  car.slotTicks = Math.round(
    (cfg.slotTimeMin + (cfg.slotTimeMax - cfg.slotTimeMin) * nextRandom(state)) / DT,
  );
}

/**
 * R62: k-th name (k from the RNG) among the names no other race car holds and, when another free
 * name exists, other than `car`'s own; with no free name at all the car keeps its name.
 */
function drawName(state: RaceState, car: Car, cfg: RivalConfig): void {
  const cars = state.cars;
  let free = 0;
  for (let id = 0; id < cfg.rivalNameCount; id++) if (!nameUsed(cars, id)) free++;
  if (free === 0) return;
  let k = Math.floor(nextRandom(state) * free);
  for (let id = 0; id < cfg.rivalNameCount; id++) {
    if (nameUsed(cars, id)) continue;
    if (k === 0) {
      car.nameId = id;
      return;
    }
    k--;
  }
}

function nameUsed(cars: readonly Car[], id: number): boolean {
  for (let j = 0; j < cars.length; j++)
    if (cars[j]!.kind === 'rival' && cars[j]!.nameId === id) return true;
  return false;
}

/**
 * R63b: a rival with |z - zPlayer| > poolRadius (end of the step) is replaced on this tick: new
 * lane, skill, pace, name and slot of the same role (nemesis kept), z = zPlayer - poolSpawnBehind,
 * the player's speed, clean drive state, band 0, joinTicks = joinShowTime. Rivals in index order.
 * Draws per replaced rival: lane, skill, pace, name, slot, slot timer.
 */
function poolRivals(state: RaceState, cfg: RivalConfig, player: Car): void {
  const cars = state.cars;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind !== 'rival') continue;
    const d = c.z - player.z;
    if (!(d > cfg.poolRadius || d < -cfg.poolRadius)) continue;
    c.z = player.z - cfg.poolSpawnBehind;
    const lane = Math.floor(nextRandom(state) * cfg.lanes);
    c.x = -1 + ((lane + 0.5) * 2) / cfg.lanes; // R70 lane centre
    c.speed = player.speed;
    drawCharacter(state, c, cfg);
    drawName(state, c, cfg);
    drawSlot(state, c, cfg);
    clearDrive(c);
    c.bumpTicks = 0;
    c.draft = 0;
    c.boostTicks = 0;
    c.crashTicks = 0;
    c.crashSpeed0 = 0;
    c.crashX0 = 0;
    c.cruise = 0; // R41b
    c.band = 0;
    c.joinTicks = Math.round(cfg.joinShowTime / DT);
  }
}

/** R62: skill by rivalSkillWeights, pace in 1 +- rivalPaceSpread. Draws: skill, pace. */
function drawCharacter(state: RaceState, c: Car, cfg: RivalConfig): void {
  const w = cfg.rivalSkillWeights;
  const r = nextRandom(state) * (w[0] + w[1] + w[2]);
  c.skill = r < w[0] ? 0 : r < w[0] + w[1] ? 1 : 2;
  c.pace = 1 + cfg.rivalPaceSpread * (2 * nextRandom(state) - 1);
}

/** R65: race car pairs in index order; a contact sets bumpTicks, so each car touches at most once. */
function raceContacts(cars: readonly Car[], params: readonly CarParams[], cfg: RivalConfig): void {
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i]!;
    if (a.kind === 'traffic') continue;
    const pa = params[i]!;
    for (let j = i + 1; j < cars.length; j++) {
      if (a.bumpTicks !== 0 || a.crashTicks !== 0) break;
      const b = cars[j]!;
      if (b.kind === 'traffic' || b.bumpTicks !== 0 || b.crashTicks !== 0) continue;
      const dz = a.z - b.z;
      const dx = a.x - b.x;
      if (!(dz < pa.carLength && dz > -pa.carLength && dx < pa.carHitW && dx > -pa.carHitW))
        continue;
      const pb = params[j]!;
      // R65: the rear car (lower z, on a tie the larger index) slows; the front keeps its speed.
      const aRear = a.z < b.z;
      const rear = aRear ? a : b;
      const front = aRear ? b : a;
      const pr = aRear ? pa : pb;
      let target = front.speed - cfg.rivalBumpLoss * pr.vmax;
      const floor = pr.bumpFloor * pr.vmax;
      if (target < floor) target = floor;
      if (target < rear.speed) rear.speed = target;
      // R65/R42: both pushed away from each other; on equal x the smaller index goes left.
      const sideA = dx > 0 ? 1 : -1;
      kick(a, sideA, pa);
      kick(b, -sideA, pb);
    }
  }
}

/** R66: place = 1 + race cars with a larger z + race cars with an equal z and a smaller index. */
function updatePlaces(cars: readonly Car[]): void {
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind === 'traffic') continue;
    let place = 1;
    for (let j = 0; j < cars.length; j++) {
      const o = cars[j]!;
      if (o.kind === 'traffic') continue;
      if (o.z > c.z || (o.z === c.z && j < i)) place++;
    }
    c.place = place;
  }
}

/** R71: initial traffic placement with the seeded RNG, traffic cars in index order. */
export function placeTraffic(state: RaceState, traffic: TrafficConfig, playerVmax: number): void {
  const cars = state.cars;
  const playerZ = cars[0]!.z;
  let furthest = -Infinity;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind !== 'traffic') continue;
    spawnTraffic(state, c, traffic, furthest, playerZ, playerVmax);
    furthest = c.z;
  }
}

/**
 * R61/R62: start grid and character of the rivals cars[1..rivalCount], seeded RNG in index order.
 * Draws per rival: lane, skill, pace, name.
 */
export function placeRivals(state: RaceState, cfg: RivalConfig): void {
  const cars = state.cars;
  let prevLane = -1;
  let n = 0;
  for (let i = 1; i <= cfg.rivalCount && i < cars.length; i++) {
    const c = cars[i]!;
    if (c.kind !== 'rival') break;
    // R61: grid z, speed 0, a lane centre other than the lane of the previous rival (its
    // neighbour in z): draw among lanes - 1 lanes and skip the previous one.
    c.z = cfg.rivalGridGap * (i - cfg.rivalGridBehind - 0.5);
    c.speed = 0;
    let lane: number;
    if (prevLane < 0) lane = Math.floor(nextRandom(state) * cfg.lanes);
    else {
      lane = Math.floor(nextRandom(state) * (cfg.lanes - 1));
      if (lane >= prevLane) lane++;
    }
    prevLane = lane;
    c.x = -1 + ((lane + 0.5) * 2) / cfg.lanes; // R70 lane centre
    // R62: skill by the weights, pace in 1 +- spread, the k-th name not taken by an earlier rival.
    drawCharacter(state, c, cfg);
    let k = Math.floor(nextRandom(state) * (cfg.rivalNameCount - (i - 1)));
    let id = 0;
    for (;;) {
      let used = false;
      for (let j = 1; j < i; j++) if (cars[j]!.nameId === id) used = true;
      if (!used) {
        if (k === 0) break;
        k--;
      }
      id++;
    }
    c.nameId = id;
    n = i;
  }
  // R62b: roles by the rivalRoles counts (close, ahead, behind; past the counts cyclically), then a
  // seeded Fisher-Yates shuffle over the rivals. Draws: n - 1 swaps.
  const roles = cfg.rivalRoles;
  const listed = roles[0] + roles[1] + roles[2];
  for (let i = 1; i <= n; i++) {
    const r = i - 1;
    cars[i]!.role =
      r >= listed ? (r - listed) % 3 : r < roles[0] ? 0 : r < roles[0] + roles[1] ? 1 : 2;
  }
  for (let i = n; i > 1; i--) {
    const j = 1 + Math.floor(nextRandom(state) * i);
    const t = cars[i]!.role;
    cars[i]!.role = cars[j]!.role;
    cars[j]!.role = t;
  }
  // R62b: the first close rival by index is the nemesis; then slots and timers in index order.
  let hunter = false;
  for (let i = 1; i <= n; i++) {
    const c = cars[i]!;
    c.nemesis = !hunter && c.role === 0 ? 1 : 0;
    if (c.nemesis === 1) hunter = true;
    drawSlot(state, c, cfg);
  }
}

import * as THREE from 'three';
import { baseCar } from '../data/cars';
import {
  cameraConfig,
  car3dConfig,
  paletteConfig,
  ribbonMapConfig,
  roadConfig,
  spritesConfig,
} from '../data/render';
import hypotheses from '../data/hypotheses.json';
import { inputConfig } from '../data/input';
import { trafficConfig } from '../data/traffic';
import scenarios from '../data/scenarios.json';
import { createAutoDrift } from '../input/autoDrift';
import { createKeyboardInput } from '../input/keyboard';
import { createFlickDrift } from '../input/flickDrift';
import { createRetouchDrift } from '../input/retouchDrift';
import { attachKeyboard } from '../input/keyboardDom';
import { createPlayerInput, type PlayerInput } from '../input/player';
import { attachPointer } from '../input/pointerDom';
import { resolveTouchScheme } from '../input/scheme';
import { createTouchStick } from '../input/touchStick';
import { BumpFeedback, playerLineOffset } from '../render/bumpFeedback';
import { CarView } from '../render/carModel';
import { CarWeight } from '../render/carWeight';
import { ScreenRoll } from '../render/screenRoll';
import { TrafficModels } from '../render/trafficModels';
import { readSpeed, Speedometer, type SpeedReading } from '../ui/speedometer';
import { DriftVisual, roadHalfWidthPxAt } from '../render/driftVisual';
import { createProjection, project } from '../render/projection';
import { ribbonThresholds } from '../render/ribbonMap';
import { RibbonMapMesh } from '../render/ribbonMapMesh';
import { RoadMesh } from '../render/roadMesh';
import { buildRoadside, indexBySegment } from '../render/roadside';
import { SpriteBatch } from '../render/spriteBatch';
import { WorldSprites } from '../render/worldSprites';
import { DT } from '../sim/constants';
import { createRace, placeTraffic } from '../sim/race';
import { buildTrack, makeStraightTrack } from '../sim/track';
import { curveClasses, loadTestTwisty } from '../data/tracks';
import type { InputFrame, Track, TrafficConfig } from '../sim/types';
import { FrameStats } from '../ui/frameStats';
import { FrameHud } from '../ui/hud';
import { installErrorCollectors, parseParams, type GameDebug } from './debug';
import { copyInputFrame, createReadInput } from './input';
import { createLoop } from './loop';
import { installDev } from '../dev/install';

const WIDTH = 360;
const HEIGHT = 640;
// Length of the literal screenshot/stress tracks.
const STRAIGHT_TRACK_SEGMENTS = 1000;
// Frame-time window: ~4 s at 60 Hz.
const FRAME_STATS_WINDOW = 256;
// Longest frame time fed to visual smoothing (a background tab returns with a huge dt).
const MAX_VISUAL_DT = 0.1;

const errors: string[] = [];
installErrorCollectors(errors);
const params = parseParams(window.location.search);
// Dev tuning: live config objects + saved/URL diff, before anything reads them (T4).
const tunables = installDev(
  { car: baseCar, input: inputConfig, camera: cameraConfig, sprites: spritesConfig, hypotheses },
  window.location.search,
);

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas #game missing');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setClearColor(paletteConfig.sky, 1);
renderer.info.autoReset = false;
// Two passes per frame (road, then the 3D car over a cleared depth buffer): clear manually.
renderer.autoClear = false;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.z = 1;

// Literal constant-curve track for the curve and stress scenarios.
function constantCurveTrack(length: number, curve: number): Track {
  const segments = [];
  for (let i = 0; i < length; i++) segments.push({ curve });
  return { segments };
}
const stress = params.scenario === 'stress' ? scenarios.stress : null;
const curveScenario =
  params.scenario === 'curve-left' || params.scenario === 'curve-right'
    ? scenarios[params.scenario]
    : null;
const straightScenario = params.scenario === 'straight' ? scenarios.straight : null;
// R32 roadside: literal straight track, car placed where a lamp pair, a billboard and buildings are in view.
const roadsideScenario = params.scenario === 'roadside' ? scenarios.roadside : null;
// R45 traffic look: literal straight track, traffic cars at fixed positions, no respawn.
const trafficScenario = params.scenario === 'traffic' ? scenarios.traffic : null;
// drift-right / drift-camera: constant hard curve, drift held from an initial speed (R24 drift look,
// R27 drift camera screenshots; drift-camera also places traffic and shows the UI).
const driftScenario =
  params.scenario === 'drift-right' || params.scenario === 'drift-camera'
    ? scenarios[params.scenario]
    : null;
// map-curve: the default twisty loop, pinned shortly before a corner (ribbon map screenshot).
const mapScenario = params.scenario === 'map-curve' ? scenarios['map-curve'] : null;
// R30 hill-crest / hill-dip: literal straight track with hills, car placed at a fixed z.
const hillScenario =
  params.scenario === 'hill-crest' || params.scenario === 'hill-dip'
    ? scenarios[params.scenario]
    : null;
// Screenshot scenarios: literal track, fixed tick count and a fixed scenario input.
const fixedScenario =
  curveScenario ??
  straightScenario ??
  roadsideScenario ??
  trafficScenario ??
  mapScenario ??
  driftScenario ??
  hillScenario;
const curve = curveScenario ?? driftScenario;
const track = curve
  ? constantCurveTrack(STRAIGHT_TRACK_SEGMENTS, curve.curve)
  : stress
    ? constantCurveTrack(STRAIGHT_TRACK_SEGMENTS, stress.curve)
    : straightScenario || roadsideScenario || trafficScenario
      ? makeStraightTrack(STRAIGHT_TRACK_SEGMENTS)
      : hillScenario
        ? buildTrack({ sections: hillScenario.sections })
        : buildTrack(loadTestTwisty().def);
const view = stress ? { ...cameraConfig, drawDistance: stress.drawDistance } : cameraConfig;
// R27: one roll uniform shared by every game-layer material (road, sprites, traffic).
const screenRoll = new ScreenRoll(spritesConfig.driftCamera, view.screenWidth / view.screenHeight);
const overscan = spritesConfig.driftCamera;
let proj = createProjection(view, roadConfig);
let road = new RoadMesh(view, roadConfig, paletteConfig, screenRoll.uniform, overscan);
scene.add(road.mesh);
const sprites = new SpriteBatch(
  spritesConfig.capacity,
  view.screenWidth,
  view.screenHeight,
  screenRoll.uniform,
);
scene.add(sprites.mesh);
let world = new WorldSprites(spritesConfig, view, paletteConfig);
// R32: roadside placement is built once per track (deterministic from the seed).
const roadside = buildRoadside(track.segments.length, spritesConfig.roadside, params.seed);
const roadsideIndex = indexBySegment(roadside, track.segments.length);
const driftVisual = new DriftVisual(spritesConfig.drift);
// R25: the player car is a 3D model in its own scene, drawn after the road pass.
const carView = new CarView(car3dConfig, spritesConfig.player, view, paletteConfig);
// R26: yaw from the real lateral motion, roll and pitch with weight.
const weight = new CarWeight(spritesConfig.weight);
// R45: traffic as 3D bodies, one instanced draw call in the road pass.
const trafficModels = new TrafficModels(
  car3dConfig,
  spritesConfig.traffic,
  view,
  roadConfig,
  paletteConfig,
  screenRoll.uniform,
  overscan,
);
scene.add(trafficModels.mesh);
// drawDistance sizes the projection and road buffers: rebuild them when it is tuned live.
let builtDrawDistance = view.drawDistance;
function rebuildForDrawDistance(): void {
  if (view.drawDistance === builtDrawDistance) return;
  builtDrawDistance = view.drawDistance;
  scene.remove(road.mesh);
  road.mesh.geometry.dispose();
  road.mesh.material.dispose();
  proj = createProjection(view, roadConfig);
  road = new RoadMesh(view, roadConfig, paletteConfig, screenRoll.uniform, overscan);
  scene.add(road.mesh);
  world = new WorldSprites(spritesConfig, view, paletteConfig);
}
const ribbon = new RibbonMapMesh(
  ribbonMapConfig,
  view,
  paletteConfig,
  ribbonThresholds(curveClasses),
);
// Off by default (author's playtest 2026-11-19); ?map=1 or the map-curve screenshot turns it on.
ribbon.enabled = ribbonMapConfig.enabled && (params.map || mapScenario !== null);
scene.add(ribbon.mesh);
const frameStats = new FrameStats(FRAME_STATS_WINDOW);
const hud = params.hud ? new FrameHud(document.body) : null;
// R28 UI layer: on unless ?ui=0; screenshot scenarios show it only when they opt in.
const uiOn =
  params.ui && (fixedScenario === null || ('ui' in fixedScenario && fixedScenario.ui === true));
const speedometer = uiOn ? new Speedometer(document.body, canvas, spritesConfig.speedometer) : null;
const speedReading: SpeedReading = { ratio: 0, boosting: false };

// Input: keyboard + touch scheme (H2; only A exists, the resolve warns on a bad flag).
resolveTouchScheme(hypotheses.H2_touchSteering, (m) => console.warn(m));
const now = (): number => performance.now();
const keyboard = createKeyboardInput(inputConfig.keyboard);
const touchStick = createTouchStick(inputConfig.touch);
attachKeyboard(window, keyboard, now);
// H3 D re-touch drift and H3 E flick drift, live config (dev panel); fed alongside the stick.
// Mouse (left button) goes through the same pointer path.
const retouch = createRetouchDrift(inputConfig.touch);
const flick = createFlickDrift(inputConfig.touch);
attachPointer(canvas, touchStick, now, retouch, flick);
// Constant input for screenshot scenarios so the frame does not depend on the keyboard.
function fixedInput(steer: number, drift: boolean): PlayerInput {
  const last: InputFrame = { steer, brake: false, drift };
  return {
    last,
    read(out: InputFrame): void {
      out.steer = steer;
      out.brake = false;
      out.drift = drift;
    },
  };
}
const player = fixedScenario
  ? fixedInput(fixedScenario.steer, driftScenario !== null)
  : createPlayerInput(keyboard, touchStick, now, {
      // H3 read live: A = pull-down gesture, C = auto drift from the stick deflection,
      // D = re-touch and swipe sideways, E = sharp sideways flick, held until release.
      hypotheses,
      autoDrift: createAutoDrift(inputConfig.touch),
      retouch,
      flick,
      warn: (m) => console.warn(m),
    });

// R70/R71: the default track runs with a traffic pool (off with ?traffic=0); screenshot and
// stress scenarios run without traffic unless they opt in (the traffic scenario places its own).
const trafficOn = fixedScenario === null && stress === null && params.traffic;
const traffic: TrafficConfig = { ...trafficConfig, lanes: roadConfig.lanes };
// Screenshot scenarios that place traffic cars at fixed gaps (no respawn).
const scenarioCars =
  trafficScenario ?? (params.scenario === 'drift-camera' ? scenarios['drift-camera'] : null);
const trafficCount = trafficOn ? traffic.trafficMax : scenarioCars ? scenarioCars.cars.length : 0;
const race = createRace(params.seed, 1, trafficCount);
if (trafficOn) placeTraffic(race, traffic, baseCar.vmax);
// Screenshot scenario may start at speed (app-side initial state, the sim is not touched later).
if (driftScenario) {
  race.cars[0]!.speed = driftScenario.speed;
  // R20 needs a rising edge with the steer already past driftEnterSteer: start with it applied.
  race.cars[0]!.steer = driftScenario.steer;
}
if (hillScenario) race.cars[0]!.z = hillScenario.z;
if (roadsideScenario) race.cars[0]!.z = roadsideScenario.z;
if (scenarioCars) {
  race.cars[0]!.z = scenarioCars.z;
  scenarioCars.cars.forEach((t, i) => {
    const c = race.cars[i + 1]!;
    c.z = scenarioCars.z + t.dz;
    c.x = -1 + ((t.lane + 0.5) * 2) / roadConfig.lanes; // R70 lane centre
    c.speed = t.speed;
  });
}
const bump = new BumpFeedback(spritesConfig.bump);
const loop = createLoop(race, {
  track,
  params: race.cars.map(() => baseCar),
  readInput: createReadInput(player),
  traffic: trafficOn ? traffic : undefined,
});

let lastCalls = 0;
let lastTriangles = 0;
const game: GameDebug = {
  frames: 0,
  done: false,
  errors,
  params,
  rendererInfo: () => ({
    calls: lastCalls,
    triangles: lastTriangles,
    instances: sprites.count,
    dropped: sprites.dropped,
    traffic: trafficModels.count,
  }),
  frameStats: () => frameStats.summarize({ p50: 0, p99: 0, max: 0, samples: 0 }),
  get tick() {
    return loop.curr.tick;
  },
  state: () => JSON.parse(JSON.stringify(loop.curr)) as typeof loop.curr,
  stepTicks: (n) => loop.stepTicks(n),
  input: () => copyInputFrame(player.last),
  tunables,
};
window.__game = game;

function renderFrame(): void {
  rebuildForDrawDistance();
  // Camera follows the player car, interpolated between the last two sim states.
  const a = loop.alpha;
  const p = loop.prev.cars[0]!;
  const c = loop.curr.cars[0]!;
  // R24: in DRIFT the camera moves toward the inside of the corner; the car is drawn off-centre.
  // R45: the contact shake moves the whole camera (road, traffic and the car line together).
  const camX = driftVisual.cameraX + bump.shake;
  project(proj, track, p.z + (c.z - p.z) * a, p.x + (c.x - p.x) * a + camX, view, roadConfig);
  road.update(proj);
  sprites.begin();
  const carY = spritesConfig.player.baseY * view.screenHeight;
  const carDx = -camX * roadHalfWidthPxAt(carY, view, roadConfig);
  // R26 weight (yaw from the real lateral motion, roll, pitch); R27 the car rolls with the picture.
  carView.update(weight.yaw, weight.roll, carDx, weight.pitch, screenRoll.deg);
  carView.scene.visible = bump.visible; // R45 blink while bumpTicks > 0
  world.drawSmoke(sprites, driftVisual, carView, view.drawDistance);
  world.drawRoadside(sprites, proj, roadside, roadsideIndex);
  trafficModels.update(
    proj,
    loop.prev.cars,
    loop.curr.cars,
    a,
    playerLineOffset(view, roadConfig, spritesConfig.player.baseY),
    // R45: car width in world units (one lane = 2 * halfWidth / lanes), read live.
    (spritesConfig.traffic.widthLanes * 2 * roadConfig.halfWidth) / roadConfig.lanes,
  );
  if (stress) world.drawStress(sprites, proj, stress.fill);
  sprites.end();
  if (speedometer)
    speedometer.update(readSpeed(speedReading, c, p.speed + (c.speed - p.speed) * a, baseCar.vmax));
  ribbon.update(
    track,
    p.z + (c.z - p.z) * a,
    p.speed + (c.speed - p.speed) * a,
    p.x + (c.x - p.x) * a,
  );
  renderer.info.reset();
  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(carView.scene, carView.camera);
  lastCalls = renderer.info.render.calls;
  lastTriangles = renderer.info.render.triangles;
  game.frames += 1;
}

/** Smoothed render-only state of the player, advanced by dt (frame time live, DT on the fixed path). */
function updateVisuals(dt: number, angle: number, alpha: number): void {
  const p = loop.prev.cars[0]!;
  const c = loop.curr.cars[0]!;
  driftVisual.update(dt, c, angle);
  screenRoll.update(dt, c, angle);
  weight.update(
    dt,
    p,
    c,
    p.speed + (c.speed - p.speed) * alpha,
    driftVisual.yaw,
    spritesConfig.drift.yawMaxDeg,
    car3dConfig.driftRollDeg,
    roadConfig.halfWidth,
    roadConfig.segmentLength,
  );
  bump.update(dt, c.bumpTicks);
}

let lastTime = -1;
function frame(time: number): void {
  const frameSeconds = lastTime < 0 ? 0 : (time - lastTime) / 1000;
  lastTime = time;
  if (frameSeconds > 0) frameStats.push(frameSeconds * 1000);
  loop.advance(frameSeconds);
  // R24: drift yaw from the sim angle, interpolated like the other car fields.
  const pa = loop.prev.cars[0]!.angle;
  const ca = loop.curr.cars[0]!.angle;
  updateVisuals(Math.min(frameSeconds, MAX_VISUAL_DT), pa + (ca - pa) * loop.alpha, loop.alpha);
  renderFrame();
  hud?.update(time, frameStats, lastCalls);
  if (params.frames !== null && game.frames >= params.frames) {
    game.done = true;
    return;
  }
  requestAnimationFrame(frame);
}

// Screenshot scenarios pin the sim to a fixed tick unless ?ticks= overrides it.
const fixedTicks = params.ticks ?? fixedScenario?.ticks ?? null;
if (fixedTicks !== null) {
  // Deterministic debug run: exact tick count, one rendered frame, no rAF loop.
  // Drift visuals follow each tick with the fixed DT, so the frame is deterministic.
  for (let i = 0; i < fixedTicks; i++) {
    loop.stepTicks(1);
    updateVisuals(DT, loop.curr.cars[0]!.angle, 1);
  }
  renderFrame();
  game.done = true;
} else if (params.frames === 0) game.done = true;
else requestAnimationFrame(frame);

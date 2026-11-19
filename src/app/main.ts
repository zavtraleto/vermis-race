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
import scenarios from '../data/scenarios.json';
import { createAutoDrift } from '../input/autoDrift';
import { createKeyboardInput } from '../input/keyboard';
import { attachKeyboard } from '../input/keyboardDom';
import { createPlayerInput, type PlayerInput } from '../input/player';
import { attachPointer } from '../input/pointerDom';
import { resolveTouchScheme } from '../input/scheme';
import { createTouchStick } from '../input/touchStick';
import { CarView } from '../render/carModel';
import { DriftVisual, roadHalfWidthPxAt } from '../render/driftVisual';
import { createProjection, project } from '../render/projection';
import { ribbonThresholds } from '../render/ribbonMap';
import { RibbonMapMesh } from '../render/ribbonMapMesh';
import { RoadMesh } from '../render/roadMesh';
import { SpriteBatch } from '../render/spriteBatch';
import { WorldSprites } from '../render/worldSprites';
import { DT } from '../sim/constants';
import { createRace } from '../sim/race';
import { buildTrack, makeStraightTrack } from '../sim/track';
import { curveClasses, loadTestTwisty } from '../data/tracks';
import type { InputFrame, Track } from '../sim/types';
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
// drift-right: constant hard curve, drift held from an initial speed (R24 drift look screenshot).
const driftScenario = params.scenario === 'drift-right' ? scenarios['drift-right'] : null;
// map-curve: the default twisty loop, pinned shortly before a corner (ribbon map screenshot).
const mapScenario = params.scenario === 'map-curve' ? scenarios['map-curve'] : null;
// R30 hill-crest / hill-dip: literal straight track with hills, car placed at a fixed z.
const hillScenario =
  params.scenario === 'hill-crest' || params.scenario === 'hill-dip'
    ? scenarios[params.scenario]
    : null;
// Screenshot scenarios: literal track, fixed tick count and a fixed scenario input.
const fixedScenario =
  curveScenario ?? straightScenario ?? mapScenario ?? driftScenario ?? hillScenario;
const curve = curveScenario ?? driftScenario;
const track = curve
  ? constantCurveTrack(STRAIGHT_TRACK_SEGMENTS, curve.curve)
  : stress
    ? constantCurveTrack(STRAIGHT_TRACK_SEGMENTS, stress.curve)
    : straightScenario
      ? makeStraightTrack(STRAIGHT_TRACK_SEGMENTS)
      : hillScenario
        ? buildTrack({ sections: hillScenario.sections })
        : buildTrack(loadTestTwisty().def);
const view = stress ? { ...cameraConfig, drawDistance: stress.drawDistance } : cameraConfig;
let proj = createProjection(view, roadConfig);
let road = new RoadMesh(view, roadConfig, paletteConfig);
scene.add(road.mesh);
const sprites = new SpriteBatch(spritesConfig.capacity, view.screenWidth, view.screenHeight);
scene.add(sprites.mesh);
let world = new WorldSprites(spritesConfig, view, paletteConfig);
const driftVisual = new DriftVisual(spritesConfig.drift);
// R25: the player car is a 3D model in its own scene, drawn after the road pass.
const carView = new CarView(car3dConfig, spritesConfig.player, view, paletteConfig);
// drawDistance sizes the projection and road buffers: rebuild them when it is tuned live.
let builtDrawDistance = view.drawDistance;
function rebuildForDrawDistance(): void {
  if (view.drawDistance === builtDrawDistance) return;
  builtDrawDistance = view.drawDistance;
  scene.remove(road.mesh);
  road.mesh.geometry.dispose();
  road.mesh.material.dispose();
  proj = createProjection(view, roadConfig);
  road = new RoadMesh(view, roadConfig, paletteConfig);
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

// Input: keyboard + touch scheme (H2; only A exists, the resolve warns on a bad flag).
resolveTouchScheme(hypotheses.H2_touchSteering, (m) => console.warn(m));
const now = (): number => performance.now();
const keyboard = createKeyboardInput(inputConfig.keyboard);
const touchStick = createTouchStick(inputConfig.touch);
attachKeyboard(window, keyboard, now);
attachPointer(canvas, touchStick, now);
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
      // H3 read live: A = pull-down gesture, C = auto drift from the stick deflection.
      hypotheses,
      autoDrift: createAutoDrift(inputConfig.touch),
      warn: (m) => console.warn(m),
    });

const race = createRace(params.seed, 1);
// Screenshot scenario may start at speed (app-side initial state, the sim is not touched later).
if (driftScenario) race.cars[0]!.speed = driftScenario.speed;
if (hillScenario) race.cars[0]!.z = hillScenario.z;
const loop = createLoop(race, {
  track,
  params: [baseCar],
  readInput: createReadInput(player),
});

let lastCalls = 0;
let lastTriangles = 0;
const game: GameDebug = {
  frames: 0,
  done: false,
  errors,
  params,
  rendererInfo: () => ({ calls: lastCalls, triangles: lastTriangles, instances: sprites.count }),
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
  const camX = driftVisual.cameraX;
  project(proj, track, p.z + (c.z - p.z) * a, p.x + (c.x - p.x) * a + camX, view, roadConfig);
  road.update(proj);
  sprites.begin();
  const carY = spritesConfig.player.baseY * view.screenHeight;
  const carDx = -camX * roadHalfWidthPxAt(carY, view, roadConfig);
  // R25: GRIP lean from steer; DRIFT adds the smoothed drift yaw (degrees) and rolls outward.
  const steer = p.steer + (c.steer - p.steer) * a;
  const yaw = steer * car3dConfig.leanYawDeg + driftVisual.yaw;
  const roll =
    steer * car3dConfig.leanRollDeg -
    (driftVisual.yaw / spritesConfig.drift.yawMaxDeg) * car3dConfig.driftRollDeg;
  carView.update(yaw, roll, carDx);
  world.drawSmoke(sprites, driftVisual, carView, view.drawDistance);
  world.drawPosts(sprites, proj);
  if (stress) world.drawStress(sprites, proj, stress.fill);
  sprites.end();
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

let lastTime = -1;
function frame(time: number): void {
  const frameSeconds = lastTime < 0 ? 0 : (time - lastTime) / 1000;
  lastTime = time;
  if (frameSeconds > 0) frameStats.push(frameSeconds * 1000);
  loop.advance(frameSeconds);
  driftVisual.update(Math.min(frameSeconds, MAX_VISUAL_DT), loop.curr.cars[0]!);
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
    driftVisual.update(DT, loop.curr.cars[0]!);
  }
  renderFrame();
  game.done = true;
} else if (params.frames === 0) game.done = true;
else requestAnimationFrame(frame);

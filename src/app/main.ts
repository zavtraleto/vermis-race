import * as THREE from 'three';
import { baseCar } from '../data/cars';
import { cameraConfig, paletteConfig, roadConfig, spritesConfig } from '../data/render';
import hypotheses from '../data/hypotheses.json';
import { inputConfig } from '../data/input';
import scenarios from '../data/scenarios.json';
import { createKeyboardInput } from '../input/keyboard';
import { attachKeyboard } from '../input/keyboardDom';
import { createPlayerInput, type PlayerInput } from '../input/player';
import { attachPointer } from '../input/pointerDom';
import { resolveTouchScheme } from '../input/scheme';
import { createTouchStick } from '../input/touchStick';
import { createProjection, project } from '../render/projection';
import { RoadMesh } from '../render/roadMesh';
import { SpriteBatch } from '../render/spriteBatch';
import { WorldSprites } from '../render/worldSprites';
import { createRace } from '../sim/race';
import { buildTrack, makeStraightTrack } from '../sim/track';
import { loadTestTwisty } from '../data/tracks';
import type { InputFrame, Track } from '../sim/types';
import { FrameStats } from '../ui/frameStats';
import { FrameHud } from '../ui/hud';
import { installErrorCollectors, parseParams, type GameDebug } from './debug';
import { copyInputFrame, createReadInput } from './input';
import { createLoop } from './loop';

const WIDTH = 360;
const HEIGHT = 640;
// Length of the literal screenshot/stress tracks.
const STRAIGHT_TRACK_SEGMENTS = 1000;
// Frame-time window: ~4 s at 60 Hz.
const FRAME_STATS_WINDOW = 256;

const errors: string[] = [];
installErrorCollectors(errors);
const params = parseParams(window.location.search);

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas #game missing');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setClearColor(paletteConfig.sky, 1);
renderer.info.autoReset = false;

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
// Screenshot scenarios: literal track, fixed tick count and a fixed scenario input.
const fixedScenario = curveScenario ?? straightScenario;
const track = curveScenario
  ? constantCurveTrack(STRAIGHT_TRACK_SEGMENTS, curveScenario.curve)
  : stress
    ? constantCurveTrack(STRAIGHT_TRACK_SEGMENTS, stress.curve)
    : straightScenario
      ? makeStraightTrack(STRAIGHT_TRACK_SEGMENTS)
      : buildTrack(loadTestTwisty().def);
const view = stress ? { ...cameraConfig, drawDistance: stress.drawDistance } : cameraConfig;
const proj = createProjection(view, roadConfig);
const road = new RoadMesh(view, roadConfig, paletteConfig);
scene.add(road.mesh);
const sprites = new SpriteBatch(spritesConfig.capacity, view.screenWidth, view.screenHeight);
scene.add(sprites.mesh);
const world = new WorldSprites(spritesConfig, view, paletteConfig);
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
function fixedInput(steer: number): PlayerInput {
  const last: InputFrame = { steer, brake: false, drift: false };
  return {
    last,
    read(out: InputFrame): void {
      out.steer = steer;
      out.brake = false;
      out.drift = false;
    },
  };
}
const player = fixedScenario
  ? fixedInput(fixedScenario.steer)
  : createPlayerInput(keyboard, touchStick, now);

const loop = createLoop(createRace(params.seed, 1), {
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
};
window.__game = game;

function renderFrame(): void {
  // Camera follows the player car, interpolated between the last two sim states.
  const a = loop.alpha;
  const p = loop.prev.cars[0]!;
  const c = loop.curr.cars[0]!;
  project(proj, track, p.z + (c.z - p.z) * a, p.x + (c.x - p.x) * a, view, roadConfig);
  road.update(proj);
  sprites.begin();
  world.drawPlayer(sprites, c.steer);
  world.drawPosts(sprites, proj);
  if (stress) world.drawStress(sprites, proj, stress.fill);
  sprites.end();
  renderer.info.reset();
  renderer.render(scene, camera);
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
  loop.stepTicks(fixedTicks);
  renderFrame();
  game.done = true;
} else if (params.frames === 0) game.done = true;
else requestAnimationFrame(frame);

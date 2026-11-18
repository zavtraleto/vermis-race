import * as THREE from 'three';
import { baseCar } from '../data/cars';
import { cameraConfig, paletteConfig, roadConfig, spritesConfig } from '../data/render';
import scenarios from '../data/scenarios.json';
import { createProjection, project } from '../render/projection';
import { RoadMesh } from '../render/roadMesh';
import { SpriteBatch } from '../render/spriteBatch';
import { WorldSprites } from '../render/worldSprites';
import { createRace } from '../sim/race';
import { makeStraightTrack } from '../sim/track';
import type { InputFrame, Track } from '../sim/types';
import { FrameStats } from '../ui/frameStats';
import { FrameHud } from '../ui/hud';
import { installErrorCollectors, parseParams, type GameDebug } from './debug';
import { createLoop } from './loop';

const WIDTH = 360;
const HEIGHT = 640;
// Placeholder tracks until real tracks exist.
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
const track = curveScenario
  ? constantCurveTrack(STRAIGHT_TRACK_SEGMENTS, curveScenario.curve)
  : stress
    ? constantCurveTrack(STRAIGHT_TRACK_SEGMENTS, stress.curve)
    : makeStraightTrack(STRAIGHT_TRACK_SEGMENTS);
const view = stress ? { ...cameraConfig, drawDistance: stress.drawDistance } : cameraConfig;
const proj = createProjection(view, roadConfig);
const road = new RoadMesh(view, roadConfig, paletteConfig);
scene.add(road.mesh);
const sprites = new SpriteBatch(spritesConfig.capacity, view.screenWidth, view.screenHeight);
scene.add(sprites.mesh);
const world = new WorldSprites(spritesConfig, view, paletteConfig);
const frameStats = new FrameStats(FRAME_STATS_WINDOW);
const hud = params.hud ? new FrameHud(document.body) : null;

// Input stub until src/input exists: automatic throttle, no steering, no brake.
function readStubInput(_tick: number, out: InputFrame[]): void {
  for (let i = 0; i < out.length; i++) {
    const f = out[i]!;
    f.steer = 0;
    f.brake = false;
    f.drift = false;
  }
}

const loop = createLoop(createRace(params.seed, 1), {
  track,
  params: [baseCar],
  readInput: readStubInput,
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
const fixedScenario = curveScenario ?? (params.scenario === 'straight' ? scenarios.straight : null);
const fixedTicks = params.ticks ?? fixedScenario?.ticks ?? null;
if (fixedTicks !== null) {
  // Deterministic debug run: exact tick count, one rendered frame, no rAF loop.
  loop.stepTicks(fixedTicks);
  renderFrame();
  game.done = true;
} else if (params.frames === 0) game.done = true;
else requestAnimationFrame(frame);

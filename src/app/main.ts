import * as THREE from 'three';
import { baseCar } from '../data/cars';
import { cameraConfig, paletteConfig, roadConfig } from '../data/render';
import hypotheses from '../data/hypotheses.json';
import { inputConfig } from '../data/input';
import scenarios from '../data/scenarios.json';
import { createKeyboardInput } from '../input/keyboard';
import { attachKeyboard } from '../input/keyboardDom';
import { createPlayerInput } from '../input/player';
import { attachPointer } from '../input/pointerDom';
import { resolveTouchScheme } from '../input/scheme';
import { createTouchStick } from '../input/touchStick';
import { createProjection, project } from '../render/projection';
import { RoadMesh } from '../render/roadMesh';
import { createRace } from '../sim/race';
import { makeStraightTrack } from '../sim/track';
import { installErrorCollectors, parseParams, type GameDebug } from './debug';
import { copyInputFrame, createReadInput } from './input';
import { createLoop } from './loop';

const WIDTH = 360;
const HEIGHT = 640;
// Placeholder straight track until real tracks exist.
const STRAIGHT_TRACK_SEGMENTS = 1000;

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

const track = makeStraightTrack(STRAIGHT_TRACK_SEGMENTS);
const proj = createProjection(cameraConfig, roadConfig);
const road = new RoadMesh(cameraConfig, roadConfig, paletteConfig);
scene.add(road.mesh);

// Input: keyboard + touch scheme (H2; only A exists, the resolve warns on a bad flag).
resolveTouchScheme(hypotheses.H2_touchSteering, (m) => console.warn(m));
const now = (): number => performance.now();
const keyboard = createKeyboardInput(inputConfig.keyboard);
const touchStick = createTouchStick(inputConfig.touch);
attachKeyboard(window, keyboard, now);
attachPointer(canvas, touchStick, now);
const player = createPlayerInput(keyboard, touchStick, now);

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
  rendererInfo: () => ({ calls: lastCalls, triangles: lastTriangles }),
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
  project(proj, track, p.z + (c.z - p.z) * a, p.x + (c.x - p.x) * a, cameraConfig, roadConfig);
  road.update(proj);
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
  loop.advance(frameSeconds);
  renderFrame();
  if (params.frames !== null && game.frames >= params.frames) {
    game.done = true;
    return;
  }
  requestAnimationFrame(frame);
}

// Screenshot scenarios pin the sim to a fixed tick unless ?ticks= overrides it.
const fixedTicks =
  params.ticks ?? (params.scenario === 'straight' ? scenarios.straight.ticks : null);
if (fixedTicks !== null) {
  // Deterministic debug run: exact tick count, one rendered frame, no rAF loop.
  loop.stepTicks(fixedTicks);
  renderFrame();
  game.done = true;
} else if (params.frames === 0) game.done = true;
else requestAnimationFrame(frame);

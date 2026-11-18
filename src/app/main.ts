import * as THREE from 'three';
import { baseCar } from '../data/cars';
import { createRace } from '../sim/race';
import { makeStraightTrack } from '../sim/track';
import type { InputFrame } from '../sim/types';
import { installErrorCollectors, parseParams, type GameDebug } from './debug';
import { createLoop } from './loop';

const WIDTH = 360;
const HEIGHT = 640;
// Art bible placeholder palette.
const SKY = 0x0c0c12;
const ROAD = 0x5a5a5e;
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
renderer.setClearColor(SKY, 1);
renderer.info.autoReset = false;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.z = 1;

// Flat placeholder road quad covering the lower half of the screen.
const road = new THREE.Mesh(
  new THREE.PlaneGeometry(1.2, 1),
  new THREE.MeshBasicMaterial({ color: ROAD }),
);
road.position.set(0, -0.5, 0);
scene.add(road);

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
  track: makeStraightTrack(STRAIGHT_TRACK_SEGMENTS),
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
  rendererInfo: () => ({ calls: lastCalls, triangles: lastTriangles }),
  get tick() {
    return loop.curr.tick;
  },
  state: () => JSON.parse(JSON.stringify(loop.curr)) as typeof loop.curr,
  stepTicks: (n) => loop.stepTicks(n),
};
window.__game = game;

function renderFrame(): void {
  // T3: render(loop.prev, loop.curr, loop.alpha)
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

if (params.ticks !== null) {
  // Deterministic debug run: exact tick count, one rendered frame, no rAF loop.
  loop.stepTicks(params.ticks);
  renderFrame();
  game.done = true;
} else if (params.frames === 0) game.done = true;
else requestAnimationFrame(frame);

import * as THREE from 'three';
import { installErrorCollectors, parseParams, type GameDebug } from './debug';

const WIDTH = 360;
const HEIGHT = 640;
// Art bible placeholder palette.
const SKY = 0x0c0c12;
const ROAD = 0x5a5a5e;

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

let lastCalls = 0;
let lastTriangles = 0;
const game: GameDebug = {
  frames: 0,
  done: false,
  errors,
  params,
  rendererInfo: () => ({ calls: lastCalls, triangles: lastTriangles }),
};
window.__game = game;

function frame(): void {
  renderer.info.reset();
  renderer.render(scene, camera);
  lastCalls = renderer.info.render.calls;
  lastTriangles = renderer.info.render.triangles;
  game.frames += 1;
  if (params.frames !== null && game.frames >= params.frames) {
    game.done = true;
    return;
  }
  requestAnimationFrame(frame);
}

if (params.frames === 0) game.done = true;
else requestAnimationFrame(frame);

import * as THREE from 'three';
import { cameraConfig, paletteConfig, roadConfig } from '../data/render';
import scenarios from '../data/scenarios.json';
import { createProjection, project } from '../render/projection';
import { RoadMesh } from '../render/roadMesh';
import { makeStraightTrack } from '../sim/track';
import { installErrorCollectors, parseParams, type GameDebug } from './debug';

const WIDTH = 360;
const HEIGHT = 640;

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

const track = makeStraightTrack(scenarios.trackLength);
const proj = createProjection(cameraConfig, roadConfig);
const road = new RoadMesh(cameraConfig, roadConfig, paletteConfig);
scene.add(road.mesh);

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
  // TEMP: dev stub until the game loop (T2) drives the camera
  const still = params.scenario === 'straight';
  const z = still ? scenarios.straight.z : game.frames * scenarios.cruiseSegmentsPerFrame;
  const x = still ? scenarios.straight.x : 0;
  project(proj, track, z, x, cameraConfig, roadConfig);
  road.update(proj);
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

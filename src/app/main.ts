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
import { mistakeConfig, rivalConfig, rivalNames, rivalUiConfig } from '../data/rivals';
import { trafficConfig } from '../data/traffic';
import tunablesRivals from '../data/tunablesRivals.json';
import scenarios from '../data/scenarios.json';
import { createKeyboardInput } from '../input/keyboard';
import { attachKeyboard } from '../input/keyboardDom';
import { createPlayerInput, type PlayerInput } from '../input/player';
import { attachPointer } from '../input/pointerDom';
import { createPad } from '../input/pad';
import { BumpFeedback, playerLineOffset } from '../render/bumpFeedback';
import { CarView } from '../render/carModel';
import { CrashTumble } from '../render/crashTumble';
import { ScreenRoll } from '../render/screenRoll';
import { WheelSteer } from '../render/wheelSteer';
import { RivalModels } from '../render/rivalModels';
import { TailLights } from '../render/tailLights';
import { TrafficModels } from '../render/trafficModels';
import { readSpeed, Speedometer, type SpeedReading } from '../ui/speedometer';
import { DriftVisual, inDrift, roadHalfWidthPxAt, slipSide } from '../render/driftVisual';
import { cameraLineOffset, createProjection, focalPx, project } from '../render/projection';
import { slopePitchDeg } from '../render/roadSlope';
import { ribbonThresholds } from '../render/ribbonMap';
import { RibbonMapMesh } from '../render/ribbonMapMesh';
import { RoadMesh } from '../render/roadMesh';
import { buildRoadside, indexBySegment } from '../render/roadside';
import { SpriteBatch } from '../render/spriteBatch';
import { roadPointAt, TyreMarks } from '../render/tyreMarks';
import { stepWheelSpin } from '../render/wheelSpin';
import { WorldSprites } from '../render/worldSprites';
import { DT, SEG_PER_UNIT } from '../sim/constants';
import { createRivalDrivers, fillRivalInputs } from '../bot/rivals';
import { createRace, placeRivals, placeTraffic } from '../sim/race';
import { buildTrack, makeStraightTrack } from '../sim/track';
import { curveClasses, loadTestTwisty, loadTrackByName } from '../data/tracks';
import type { CarParams, InputFrame, RivalConfig, Track, TrafficConfig } from '../sim/types';
import { Leaderboard } from '../ui/leaderboard';
import { NameLabels } from '../ui/nameLabels';
import { FrameStats } from '../ui/frameStats';
import { FrameHud } from '../ui/hud';
import { GameMenu } from '../ui/menu';
import { installErrorCollectors, parseParams, type GameDebug } from './debug';
import { copyInputFrame, createReadInput } from './input';
import { copyRaceState, createLoop } from './loop';
import { createGameFlow, menuEnabled } from './gameFlow';
import { installDev } from '../dev/install';
import type { TunableSpec } from '../dev/tunables';
import render3dJson from '../data/render3d.json';
import tunables3d from '../data/tunables3d.json';
import { Render3d } from '../render3d/render3d';
import type { Render3dConfig } from '../render3d/road3d';

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
// Spike E1: ?render=3d draws the same game as a true 3D scene (src/render3d).
const render3dConfig: Render3dConfig = render3dJson;
const use3d = params.render === '3d';
// R60-R66: the live rivals config the sim reads every tick (dev panel group «Соперники»).
const rivalsCfg: RivalConfig = { ...rivalConfig, lanes: roadConfig.lanes };
// Rival sliders live in their own range file (src/data/tunablesRivals.json); merged with the
// spike E1 render3d ranges when that renderer runs.
type MetaSpec = TunableSpec & { meta?: Record<string, unknown> };
const rivalSpec = tunablesRivals as MetaSpec;
const extraSpec: MetaSpec = use3d
  ? {
      numbers: { ...rivalSpec.numbers, ...(tunables3d as MetaSpec).numbers },
      flags: { ...rivalSpec.flags, ...(tunables3d as MetaSpec).flags },
      meta: { ...rivalSpec.meta, ...(tunables3d as MetaSpec).meta },
    }
  : rivalSpec;
// Dev tuning: live config objects + saved/URL diff, before anything reads them (T4).
const tunables = installDev(
  {
    car: baseCar,
    input: inputConfig,
    camera: cameraConfig,
    sprites: spritesConfig,
    hypotheses,
    render3d: render3dConfig,
    rivals: rivalsCfg,
    mistakes: mistakeConfig,
    rivalUi: rivalUiConfig,
  },
  window.location.search,
  extraSpec,
);
// R47: the sim hits the lamps the roadside layout draws. The layout is built once below from the
// (dev-diffed) sprites config and its lamp sliders apply after a reload, so one copy here at load
// keeps the sim and the drawn lamps equal (a live slider move changes neither until the reload).
baseCar.lampEvery = spritesConfig.roadside.lamps.every;
baseCar.lampOffset = spritesConfig.roadside.lamps.offset;
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
// R49 crash look: literal straight track, car aimed at the right lamp pair, frozen mid-crash.
const crashScenario = params.scenario === 'crash' ? scenarios.crash : null;
// R45 traffic look: literal straight track, traffic cars at fixed positions, no respawn.
// traffic-20 (spike E1 budget check): the same with 20 cars in view.
const trafficScenario =
  params.scenario === 'traffic' || params.scenario === 'traffic-20'
    ? scenarios[params.scenario]
    : null;
// drift-right / drift-camera: constant hard curve from an initial speed with the scenario steer (no
// drift until the new driving model, ADR 0005); drift-camera also places traffic and shows the UI.
const driftScenario =
  params.scenario === 'drift-right' || params.scenario === 'drift-camera'
    ? scenarios[params.scenario]
    : null;
// sharp (R31b): drift-run (pinned), just before the first hook (no drift entry yet, ADR 0005).
const sharpScenario = params.scenario === 'sharp' ? scenarios.sharp : null;
// map-curve: the test-twisty loop (pinned, not the default track), shortly before a corner (ribbon map screenshot).
const mapScenario = params.scenario === 'map-curve' ? scenarios['map-curve'] : null;
// R67 rivals look: literal straight track, rivals at fixed gaps ahead, labels and leaderboard.
const rivalsScenario = params.scenario === 'rivals' ? scenarios.rivals : null;
// R30b hill-cars / hill-cars-down: a steady climb / descent with traffic and a rival on the slope.
const hillCarsScenario =
  params.scenario === 'hill-cars' || params.scenario === 'hill-cars-down'
    ? scenarios[params.scenario]
    : null;
// R30 hill-crest / hill-dip: literal straight track with hills, car placed at a fixed z.
const hillScenario =
  params.scenario === 'hill-crest' || params.scenario === 'hill-dip'
    ? scenarios[params.scenario]
    : hillCarsScenario;
// Screenshot scenarios: literal track, fixed tick count and a fixed scenario input.
const fixedScenario =
  curveScenario ??
  straightScenario ??
  roadsideScenario ??
  crashScenario ??
  trafficScenario ??
  mapScenario ??
  driftScenario ??
  sharpScenario ??
  hillScenario ??
  rivalsScenario;
const curve = curveScenario ?? driftScenario;
const track = curve
  ? constantCurveTrack(STRAIGHT_TRACK_SEGMENTS, curve.curve)
  : stress
    ? constantCurveTrack(STRAIGHT_TRACK_SEGMENTS, stress.curve)
    : straightScenario || roadsideScenario || crashScenario || trafficScenario || rivalsScenario
      ? makeStraightTrack(STRAIGHT_TRACK_SEGMENTS)
      : hillScenario
        ? buildTrack({ sections: hillScenario.sections })
        : mapScenario
          ? buildTrack(loadTestTwisty().def)
          : sharpScenario
            ? buildTrack(loadTrackByName(sharpScenario.track).def)
            : buildTrack(loadTrackByName(params.track).def);
const view = stress ? { ...cameraConfig, drawDistance: stress.drawDistance } : cameraConfig;
// One roll uniform shared by every game-layer material (road, sprites, traffic); roll 0 (R213).
const screenRoll = new ScreenRoll(view.screenWidth / view.screenHeight);
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
// R25b: front-wheel angle from the player's steer.
const wheelSteer = new WheelSteer();
// R24b: drift smoke in an overlay batch inside the car scene, drawn after the car (one extra draw
// call only while puffs are alive: the mesh is hidden when empty).
const smokeBatch = new SpriteBatch(
  spritesConfig.drift.smokeCapacity,
  view.screenWidth,
  view.screenHeight,
  screenRoll.uniform,
  true,
);
carView.scene.add(smokeBatch.mesh);
// R24c: tyre marks of the player in DRIFT, drawn into the road-pass sprite batch.
const tyreMarks = new TyreMarks(spritesConfig.tyreMarks);
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

// Input: keyboard + the R202 control pad (mouse = finger while the left button is held).
const now = (): number => performance.now();
const keyboard = createKeyboardInput();
const pad = createPad(inputConfig.pad);
attachKeyboard(window, keyboard, now);
attachPointer(canvas, pad, now);
// Constant input for screenshot scenarios so the frame does not depend on the keyboard (R201:
// steer from the scenario, full gas).
function fixedInput(steer: number): PlayerInput {
  const last: InputFrame = { steer, gas: 1, brake: 0, driftTap: false };
  return {
    last,
    read(out: InputFrame): void {
      out.steer = steer;
      out.gas = 1;
      out.brake = 0;
      out.driftTap = false;
    },
  };
}
const player = fixedScenario
  ? fixedInput(fixedScenario.steer)
  : createPlayerInput(keyboard, pad, now);

// R70/R71: the default track runs with a traffic pool (off with ?traffic=0); screenshot and
// stress scenarios run without traffic unless they opt in (the traffic scenario places its own).
const trafficOn = fixedScenario === null && stress === null && params.traffic;
const traffic: TrafficConfig = { ...trafficConfig, lanes: roadConfig.lanes };
// Screenshot scenarios that place traffic cars at fixed gaps (no respawn).
const scenarioCars =
  trafficScenario ??
  (params.scenario === 'drift-camera' ? scenarios['drift-camera'] : null) ??
  hillCarsScenario;
const trafficCount = trafficOn ? traffic.trafficMax : scenarioCars ? scenarioCars.cars.length : 0;
// R60: the default track runs with rivals (off with ?rivals=0); screenshot and stress scenarios
// run without them so their frames do not change (the rivals scenario places its own).
const rivalsOn = fixedScenario === null && stress === null && params.rivals;
// Screenshot scenarios that place rivals at fixed gaps.
const scenarioRivals = rivalsScenario ?? hillCarsScenario;
const rivalCount = rivalsOn
  ? Math.max(0, Math.floor(rivalsCfg.rivalCount))
  : scenarioRivals
    ? scenarioRivals.rivals.length
    : 0;
const race = createRace(params.seed, 1 + rivalCount, trafficCount);
if (rivalsOn) placeRivals(race, rivalsCfg);
if (trafficOn) placeTraffic(race, traffic, baseCar.vmax);
if (scenarioRivals) {
  race.cars[0]!.z = scenarioRivals.z;
  race.cars[0]!.speed = scenarioRivals.speed;
  scenarioRivals.rivals.forEach((t, i) => {
    const c = race.cars[i + 1]!;
    c.z = scenarioRivals.z + t.dz;
    c.x = -1 + ((t.lane + 0.5) * 2) / roadConfig.lanes; // R70 lane centre
    c.speed = t.speed;
    c.nameId = t.nameId;
    c.nemesis = t.nemesis;
    c.joinTicks = t.join * Math.round(rivalsCfg.joinShowTime / DT);
  });
}
// Screenshot scenario may start at speed (app-side initial state, the sim is not touched later).
if (driftScenario) race.cars[0]!.speed = driftScenario.speed;
if (sharpScenario) {
  race.cars[0]!.z = sharpScenario.z;
  race.cars[0]!.speed = sharpScenario.speed;
}
if (hillScenario) race.cars[0]!.z = hillScenario.z;
if (roadsideScenario) race.cars[0]!.z = roadsideScenario.z;
if (crashScenario) {
  race.cars[0]!.z = crashScenario.z;
  race.cars[0]!.x = crashScenario.x;
  race.cars[0]!.speed = crashScenario.speed;
}
if (scenarioCars) {
  race.cars[0]!.z = scenarioCars.z;
  scenarioCars.cars.forEach((t, i) => {
    // R70: traffic comes after the player and the rivals.
    const c = race.cars[1 + rivalCount + i]!;
    c.z = scenarioCars.z + t.dz;
    c.x = -1 + ((t.lane + 0.5) * 2) / roadConfig.lanes; // R70 lane centre
    c.speed = t.speed;
  });
}
// R49: the crash shake is stronger than the bump shake (own numbers in sprites.json "crash").
const bump = new BumpFeedback(spritesConfig.bump, spritesConfig.crash);
const tumble = new CrashTumble(spritesConfig.crash);
// R25c: wheel angles about their axles, rad (render fields).
let spinFront = 0;
let spinRear = 0;
const render3d = use3d
  ? new Render3d(renderer, {
      cfg: render3dConfig,
      track,
      road: roadConfig,
      palette: paletteConfig,
      car3d: car3dConfig,
      sprites: spritesConfig,
      screenWidth: WIDTH,
      screenHeight: HEIGHT,
      drift: driftVisual,
      bump,
      roadside,
      roadsideIndex,
    })
  : null;
// H23-H26 reach the sim as CarParams numbers (1 = A, 0 = B), read live from the dev panel;
// synced before the rival copies are made so every race car starts with the same flags.
const syncHypotheses = (): void => {
  baseCar.hypAssist = hypotheses.H23_assist === 'B' ? 0 : 1;
  baseCar.hypEdge = hypotheses.H24_edge === 'B' ? 0 : 1;
  baseCar.hypRef = hypotheses.H25_ref === 'B' ? 0 : 1;
  baseCar.hypBrakeTap = hypotheses.H26_brakeTap === 'B' ? 0 : 1;
};
syncHypotheses();
// R60: every rival drives its own copy of the car params (the sim scales vmax by pace and band);
// the copies follow live dev-panel edits of the player car.
const carParams: CarParams[] = race.cars.map((c) =>
  c.kind === 'rival' ? { ...baseCar } : baseCar,
);
tunables.onChange(() => {
  syncHypotheses();
  for (const p of carParams) if (p !== baseCar) Object.assign(p, baseCar);
});
let rivalDrivers = rivalsOn ? createRivalDrivers(race, params.seed) : null;
const readPlayer = createReadInput(player);
const readInput = rivalDrivers
  ? (tick: number, out: InputFrame[]): void => {
      readPlayer(tick, out);
      // H15 read live: A = rubber band on (R63), B = off; R63c reads the live bandBoost.
      rivalsCfg.rubberBand = hypotheses.H15_rubberBand === 'B' ? 0 : 1;
      mistakeConfig.bandBoost = rivalsCfg.bandBoost;
      if (rivalDrivers)
        fillRivalInputs(rivalDrivers, loop.curr, track, carParams, mistakeConfig, out);
    }
  : readPlayer;
// R67: rivals drawn with the player's model (one instanced draw call in the road pass), names
// over them and the leaderboard in the UI layer.
const rivalModels =
  rivalCount > 0
    ? new RivalModels(
        car3dConfig,
        spritesConfig.rivals,
        spritesConfig.traffic,
        spritesConfig.bump,
        spritesConfig.crash,
        view,
        roadConfig,
        paletteConfig,
        screenRoll.uniform,
        overscan,
      )
    : null;
if (rivalModels) scene.add(rivalModels.mesh);
// R45b: tail lights of traffic and rivals, pushed into the sprite batch (no extra draw call).
const tailLights = new TailLights(spritesConfig.tailLights, view);
const rivalUiOn = uiOn && rivalCount > 0 && !use3d;
const nameLabels = rivalUiOn
  ? new NameLabels(document.body, canvas, rivalNames, WIDTH, HEIGHT, spritesConfig.rivals)
  : null;
// Metres per segment from the speedometer scale: vmax shows as vmaxKmh.
const metersPerSegment = spritesConfig.speedometer.vmaxKmh / 3.6 / (baseCar.vmax * SEG_PER_UNIT);
const leaderboard = rivalUiOn
  ? new Leaderboard(
      document.body,
      canvas,
      rivalUiConfig,
      rivalNames,
      1 + rivalCount,
      metersPerSegment,
      spritesConfig.leaderboard,
    )
  : null;
// Frame seconds of the last updateVisuals() (the place flash).
let visualDt = 0;
const loop = createLoop(race, {
  track,
  params: carParams,
  readInput,
  traffic: trafficOn ? traffic : undefined,
  rivals: rivalsOn ? rivalsCfg : undefined,
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
    traffic: render3d ? render3d.info().traffic : trafficModels.count,
    rivals: rivalModels ? rivalModels.count : 0,
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
// Spike E1 budget measurement (tools/spike/render3d-shots.mjs): one full render frame on demand.
(window as unknown as { __spikeFrame: () => void }).__spikeFrame = () => {
  render3d?.update(loop.prev.cars, loop.curr.cars, 1, DT);
  renderFrame();
};

// R30b: segments from the camera to the player's line, set by poseFrame for the frame.
let lineOff = 0;

/**
 * Projects the road and poses the player car for the current interpolated state, then records the
 * R24c tyre marks from the rear wheel points. Called by renderFrame and, on the fixed screenshot
 * path, after every tick so the marks are laid like in the live loop.
 */
function poseFrame(): void {
  rebuildForDrawDistance();
  // Camera follows the player car, interpolated between the last two sim states.
  const a = loop.alpha;
  const p = loop.prev.cars[0]!;
  const c = loop.curr.cars[0]!;
  // R213: the camera simply follows the car x; R45: the contact shake moves the whole camera.
  const camX = p.x + (c.x - p.x) * a + bump.shake;
  const zCam = p.z + (c.z - p.z) * a;
  // R30b: the camera rides above the road at the player's line (the line traffic and rivals are
  // drawn at too), pulled back toward z only on descents too steep for it (cameraLineOffset).
  lineOff = playerLineOffset(view, roadConfig, spritesConfig.player.baseY);
  const slope = car3dConfig.slope;
  const camOff = cameraLineOffset(track, zCam, lineOff, view, roadConfig, slope.eyeClearance);
  project(proj, track, zCam, camX, view, roadConfig, camOff);
  // R30b (c): pitch along the road under the car; CarView pitch > 0 is nose down, so subtract.
  // The car's own camera looks down at it far less than the road camera does, so the angle is
  // scaled by playerPitchGain to read the same on screen.
  const slopePitch = slopePitchDeg(
    track,
    zCam + lineOff,
    slope.slopeHalfSpan,
    slope.slopePitchGain * slope.playerPitchGain,
  );
  const carY = spritesConfig.player.baseY * view.screenHeight;
  const carDx = (p.x + (c.x - p.x) * a - camX) * roadHalfWidthPxAt(carY, view, roadConfig);
  // R213: body yaw = the sim heading (degrees, > 0 = nose right), no roll or pitch of its own.
  // R49: while crashTicks > 0 the car tumbles (roll and spin) and hops above the road.
  const yawDeg = ((p.heading + (c.heading - p.heading) * a) * 180) / Math.PI;
  carView.update(
    yawDeg + tumble.yawDeg,
    0,
    carDx,
    -slopePitch,
    screenRoll.total,
    tumble.rollDeg,
    tumble.hop,
    spritesConfig.crash.pivotY,
    wheelSteer.deg,
    spinFront,
    spinRear,
  );
  const found =
    roadPointAt(tyreMarks.left, proj, carView.rearLX, carView.rearLY) &&
    roadPointAt(tyreMarks.right, proj, carView.rearRX, carView.rearRY);
  // R24d: front-wheel marks need the drift scale of the new model (slipFull is gone, ADR 0005):
  // off until the drift slice restates R24d.
  const front = false;
  const frontFound =
    front &&
    roadPointAt(tyreMarks.frontLeft, proj, carView.frontLX, carView.frontLY) &&
    roadPointAt(tyreMarks.frontRight, proj, carView.frontRX, carView.frontRY);
  tyreMarks.track(inDrift(c) && slipSide(c) !== 0, found, proj.length, front, frontFound);
}

function renderFrame(): void {
  if (render3d) {
    render3d.render();
    const c3 = loop.curr.cars[0]!;
    const p3 = loop.prev.cars[0]!;
    const speed3 = p3.speed + (c3.speed - p3.speed) * loop.alpha;
    if (speedometer) speedometer.update(readSpeed(speedReading, c3, speed3, baseCar.vmax));
    lastCalls = renderer.info.render.calls;
    lastTriangles = renderer.info.render.triangles;
    game.frames += 1;
    return;
  }
  poseFrame();
  const a = loop.alpha;
  const p = loop.prev.cars[0]!;
  const c = loop.curr.cars[0]!;
  road.update(proj);
  sprites.begin();
  // R45 blink while bumpTicks > 0 (the car only: the R24b smoke stays in view).
  carView.mesh.visible = bump.visible;
  smokeBatch.begin();
  world.drawSmoke(smokeBatch, driftVisual, carView);
  smokeBatch.end();
  smokeBatch.mesh.visible = smokeBatch.count > 0;
  world.drawTyreMarks(sprites, proj, tyreMarks);
  world.drawRoadside(sprites, proj, roadside, roadsideIndex);
  tailLights.begin(sprites, focalPx(view), view.screenWidth / 2, view.horizon * view.screenHeight);
  trafficModels.update(
    proj,
    loop.prev.cars,
    loop.curr.cars,
    a,
    lineOff,
    // R45: car width in world units (one lane = 2 * halfWidth / lanes), read live.
    (spritesConfig.traffic.widthLanes * 2 * roadConfig.halfWidth) / roadConfig.lanes,
    tailLights,
    track,
  );
  if (rivalModels) {
    rivalModels.update(
      proj,
      loop.prev.cars,
      loop.curr.cars,
      a,
      lineOff,
      Math.round(baseCar.crashTime / DT),
      rivalUiConfig.rivalNameDistance,
      tailLights,
      track,
    );
    nameLabels?.draw(rivalModels, loop.curr.cars, screenRoll.total);
  }
  leaderboard?.update(visualDt, loop.curr.cars);
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
function updateVisuals(dt: number, alpha: number): void {
  const p = loop.prev.cars[0]!;
  const c = loop.curr.cars[0]!;
  visualDt = dt;
  driftVisual.update(dt, c);
  const speed = p.speed + (c.speed - p.speed) * alpha;
  // R25c: every wheel rolls at the world speed (m/s from the speedometer scale) over its radius.
  const mps = (speed / baseCar.vmax) * (spritesConfig.speedometer.vmaxKmh / 3.6);
  spinFront = stepWheelSpin(spinFront, mps, carView.frontRadius, dt);
  spinRear = stepWheelSpin(spinRear, mps, carView.rearRadius, dt);
  bump.update(dt, c.bumpTicks, c.crashTicks);
  // R25b: the wheels follow the interpolated steer of the car.
  wheelSteer.update(p.steer + (c.steer - p.steer) * alpha, dt, car3dConfig.player);
  // R49: tumble from crashTicks (interpolated) and the side of the lamp (sign of crashX0).
  tumble.update(
    p.crashTicks,
    c.crashTicks,
    Math.round(baseCar.crashTime / DT),
    c.crashX0 < 0 ? -1 : 1,
    alpha,
  );
  render3d?.update(loop.prev.cars, loop.curr.cars, alpha, dt);
}

// R95: start screen and pause (outside the sim); automation (?menu=0, any scenario) runs without them.
// The e2e pages driven by stepTicks (?frames= / ?ticks=, no rAF loop) count as automation too.
const menuOn =
  menuEnabled(window.location.search) && params.frames === null && params.ticks === null;
const flow = createGameFlow({ menu: menuOn });
// Releases the active touch and held keys (pause entry, start): steer 0, full gas.
function releaseInput(): void {
  const t = now();
  const id = pad.activeId;
  if (id !== null) {
    pad.pointerCancel(id, t);
  }
  keyboard.releaseAll(t);
}
// R95 "Заново": the race starts again from the state built at load (same seed); render-only state
// that would carry over (tyre marks, smoke) is cleared.
function restartRace(): void {
  copyRaceState(race, loop.curr);
  copyRaceState(race, loop.prev);
  if (rivalsOn) rivalDrivers = createRivalDrivers(race, params.seed);
  tyreMarks.ring.clear();
  tyreMarks.open = false;
  driftVisual.smoke.clear();
}
const menu = menuOn
  ? new GameMenu(document.body, canvas, spritesConfig.menu, {
      start: () => {
        flow.start();
        releaseInput();
        menu?.show(flow.phase);
      },
      pause: () => {
        flow.pause();
        releaseInput();
        menu?.show(flow.phase);
      },
      resume: () => {
        flow.resume();
        menu?.show(flow.phase);
      },
      restart: () => {
        if (flow.restart()) restartRace();
        releaseInput();
        menu?.show(flow.phase);
      },
    })
  : null;
if (menu) {
  menu.show(flow.phase);
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const phase = flow.phase;
    if (phase === 'menu' && (e.code === 'Enter' || e.code === 'Space')) {
      e.preventDefault();
      flow.start();
      releaseInput();
    } else if (e.code === 'Escape' || e.code === 'KeyP') {
      if (phase === 'run') {
        flow.pause();
        releaseInput();
      } else if (phase === 'pause') flow.resume();
      else return;
      e.preventDefault();
    } else return;
    menu.show(flow.phase);
  });
}

let lastTime = -1;
function frame(time: number): void {
  const frameSeconds = lastTime < 0 ? 0 : (time - lastTime) / 1000;
  lastTime = time;
  if (frameSeconds > 0) frameStats.push(frameSeconds * 1000);
  // R95: outside 'run' the sim does not step and the accumulator does not grow.
  const running = flow.simRunning;
  loop.advance(running ? frameSeconds : 0);
  updateVisuals(running ? Math.min(frameSeconds, MAX_VISUAL_DT) : 0, loop.alpha);
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
    updateVisuals(DT, 1);
    if (!render3d) poseFrame();
  }
  renderFrame();
  game.done = true;
} else if (params.frames === 0) game.done = true;
else requestAnimationFrame(frame);

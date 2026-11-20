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
import { createAutoDrift } from '../input/autoDrift';
import { createKeyboardInput } from '../input/keyboard';
import { createFlickDrift } from '../input/flickDrift';
import { createRetouchDrift } from '../input/retouchDrift';
import { attachKeyboard } from '../input/keyboardDom';
import { createPlayerInput, type PlayerInput } from '../input/player';
import { attachPointer } from '../input/pointerDom';
import { resolveTouchScheme } from '../input/scheme';
import { createTouchStick } from '../input/touchStick';
import { createZoneStick } from '../input/zoneStick';
import { BumpFeedback, playerLineOffset } from '../render/bumpFeedback';
import { CarView } from '../render/carModel';
import { CarWeight } from '../render/carWeight';
import { CrashTumble } from '../render/crashTumble';
import { ScreenRoll } from '../render/screenRoll';
import { RivalModels } from '../render/rivalModels';
import { TailLights } from '../render/tailLights';
import { TrafficModels } from '../render/trafficModels';
import { readSpeed, Speedometer, type SpeedReading } from '../ui/speedometer';
import { StickOverlay } from '../ui/stickOverlay';
import { DriftVisual, roadHalfWidthPxAt } from '../render/driftVisual';
import { createProjection, focalPx, project } from '../render/projection';
import { ribbonThresholds } from '../render/ribbonMap';
import { RibbonMapMesh } from '../render/ribbonMapMesh';
import { RoadMesh } from '../render/roadMesh';
import { buildRoadside, indexBySegment } from '../render/roadside';
import { SpriteBatch } from '../render/spriteBatch';
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
import { DriftEntryProbe, driftEntryOf, onOffOf } from './driftEntryProbe';
import { installErrorCollectors, parseParams, type GameDebug } from './debug';
import { copyInputFrame, createReadInput } from './input';
import { createLoop } from './loop';
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
// H14: ?model=a|b picks the driving model before the dev registry reads its defaults (so it is not
// saved as a tuning diff); the panel switch car.model still changes it live.
if (params.model !== null) baseCar.model = params.model;
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
// H16 (R81b, R81c): the model B drift entry variant follows the hypothesis flag (A/B/C/D -> 0..3), on load
// and on every panel change (the rival copies below take it with the rest of baseCar).
const applyDriftEntry = (): void => {
  baseCar.driftEntry = driftEntryOf(hypotheses.H16_driftEntry);
  baseCar.gripScrub = onOffOf(hypotheses.H17_gripScrub); // H17 (R86b)
  baseCar.driftTurbo = onOffOf(hypotheses.H18_driftTurbo); // H18 (R86c)
};
applyDriftEntry();

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
// drift-right / drift-camera: constant hard curve, drift held from an initial speed (R24 drift look,
// R27 drift camera screenshots; drift-camera also places traffic and shows the UI).
const driftScenario =
  params.scenario === 'drift-right' || params.scenario === 'drift-camera'
    ? scenarios[params.scenario]
    : null;
// sharp (R31b): drift-run (pinned), drift entered by a flick just before the first hook.
const sharpScenario = params.scenario === 'sharp' ? scenarios.sharp : null;
// map-curve: the test-twisty loop (pinned, not the default track), shortly before a corner (ribbon map screenshot).
const mapScenario = params.scenario === 'map-curve' ? scenarios['map-curve'] : null;
// R67 rivals look: literal straight track, rivals at fixed gaps ahead, labels and leaderboard.
const rivalsScenario = params.scenario === 'rivals' ? scenarios.rivals : null;
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
// R81b (отладка): last model B drift-entry readout on the ?hud=1 overlay.
const entryProbe = hud ? new DriftEntryProbe() : null;
// R86d (отладка): the drift charge and the remaining turbo ticks of the player under the entry line.
const entryText = entryProbe
  ? (): string => {
      const c = loop.curr.cars[0]!;
      return `${entryProbe.text()}\nзаряд ${c.turbo.toFixed(2)} турбо ${c.turboTicks}`;
    }
  : undefined;
// R28 UI layer: on unless ?ui=0; screenshot scenarios show it only when they opt in.
const uiOn =
  params.ui && (fixedScenario === null || ('ui' in fixedScenario && fixedScenario.ui === true));
const speedometer = uiOn ? new Speedometer(document.body, canvas, spritesConfig.speedometer) : null;
const speedReading: SpeedReading = { ratio: 0, boosting: false };

// Input: keyboard + touch scheme (H2; only A exists, the resolve warns on a bad flag).
resolveTouchScheme(hypotheses.H2_touchSteering, (m) => console.warn(m));
const now = (): number => performance.now();
// R81: the keyboard reads the same live car model the player input gets (drift entry in model B).
const keyboard = createKeyboardInput(inputConfig.keyboard, baseCar);
// R81c: in model B with driftEntry 3 (H16 D, the default) the touch input is the zone stick, chosen at
// load (a panel switch of H14 / H16 changes the touch stick after a reload).
const zoneStick =
  baseCar.model === 1 && baseCar.driftEntry === 3 ? createZoneStick(inputConfig.touch) : null;
const touchStick = zoneStick ?? createTouchStick(inputConfig.touch);
attachKeyboard(window, keyboard, now);
// H3 D re-touch drift and H3 E flick drift, live config (dev panel); fed alongside the stick.
// Mouse (left button) goes through the same pointer path.
const retouch = createRetouchDrift(inputConfig.touch);
const flick = createFlickDrift(inputConfig.touch);
attachPointer(canvas, touchStick, now, retouch, flick);
// Constant input for screenshot scenarios so the frame does not depend on the keyboard. Drift
// scenarios first hold `flickFrom` for `flickTicks` reads (one read per tick), then `steer`: the
// R81 flick that enters a drift in model B (model A enters on the R20 edge as before).
function fixedInput(steer: number, drift: boolean, flickFrom = steer, flickTicks = 0): PlayerInput {
  const last: InputFrame = { steer, brake: false, drift };
  let reads = 0;
  return {
    last,
    read(out: InputFrame): void {
      out.steer = reads < flickTicks ? flickFrom : steer;
      reads++;
      out.brake = false;
      out.drift = drift;
    },
  };
}
const flickScenario = driftScenario ?? sharpScenario;
const player = fixedScenario
  ? flickScenario
    ? fixedInput(flickScenario.steer, true, flickScenario.flickFrom, flickScenario.flickTicks)
    : fixedInput(fixedScenario.steer, false)
  : createPlayerInput(keyboard, touchStick, now, {
      // H3 read live: A = pull-down gesture, C = auto drift from the stick deflection,
      // D = re-touch and swipe sideways, E = sharp sideways flick, held until release.
      hypotheses,
      autoDrift: createAutoDrift(inputConfig.touch),
      retouch,
      flick,
      // H14 read live: in model B the touch drift input is "pointer held", H3 is ignored.
      car: baseCar,
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
// R60: the default track runs with rivals (off with ?rivals=0); screenshot and stress scenarios
// run without them so their frames do not change (the rivals scenario places its own).
const rivalsOn = fixedScenario === null && stress === null && params.rivals;
const rivalCount = rivalsOn
  ? Math.max(0, Math.floor(rivalsCfg.rivalCount))
  : rivalsScenario
    ? rivalsScenario.rivals.length
    : 0;
const race = createRace(params.seed, 1 + rivalCount, trafficCount);
if (rivalsOn) placeRivals(race, rivalsCfg);
if (trafficOn) placeTraffic(race, traffic, baseCar.vmax);
if (rivalsScenario) {
  race.cars[0]!.z = rivalsScenario.z;
  race.cars[0]!.speed = rivalsScenario.speed;
  rivalsScenario.rivals.forEach((t, i) => {
    const c = race.cars[i + 1]!;
    c.z = rivalsScenario.z + t.dz;
    c.x = -1 + ((t.lane + 0.5) * 2) / roadConfig.lanes; // R70 lane centre
    c.speed = t.speed;
    c.nameId = t.nameId;
    c.nemesis = t.nemesis;
    c.joinTicks = t.join * Math.round(rivalsCfg.joinShowTime / DT);
  });
}
// Screenshot scenario may start at speed (app-side initial state, the sim is not touched later).
if (driftScenario) {
  race.cars[0]!.speed = driftScenario.speed;
  // R20 needs a rising edge with the steer already past driftEnterSteer: start with it applied.
  race.cars[0]!.steer = driftScenario.steer;
}
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
    const c = race.cars[i + 1]!;
    c.z = scenarioCars.z + t.dz;
    c.x = -1 + ((t.lane + 0.5) * 2) / roadConfig.lanes; // R70 lane centre
    c.speed = t.speed;
  });
}
// R49: the crash shake is stronger than the bump shake (own numbers in sprites.json "crash").
const bump = new BumpFeedback(spritesConfig.bump, spritesConfig.crash);
const tumble = new CrashTumble(spritesConfig.crash);
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
      weight,
      roll: screenRoll,
      bump,
      roadside,
      roadsideIndex,
    })
  : null;
// R60: every rival drives its own copy of the car params (the sim scales vmax by pace and band);
// the copies follow live dev-panel edits of the player car.
const carParams: CarParams[] = race.cars.map((c) =>
  c.kind === 'rival' ? { ...baseCar } : baseCar,
);
tunables.onChange(() => {
  applyDriftEntry();
  for (const p of carParams) if (p !== baseCar) Object.assign(p, baseCar);
});
const rivalDrivers = rivalsOn ? createRivalDrivers(race, params.seed) : null;
const readPlayerRaw = createReadInput(player);
// R81b (отладка): the probe sees the player car after each tick (loop.curr before the next one).
const readPlayer = entryProbe
  ? (tick: number, out: InputFrame[]): void => {
      entryProbe.observe(loop.curr.cars[0]!, baseCar, track.segments);
      readPlayerRaw(tick, out);
    }
  : readPlayerRaw;
const readInput = rivalDrivers
  ? (tick: number, out: InputFrame[]): void => {
      readPlayer(tick, out);
      // H15 read live: A = rubber band on (R63), B = off; R63c reads the live bandBoost.
      rivalsCfg.rubberBand = hypotheses.H15_rubberBand === 'B' ? 0 : 1;
      mistakeConfig.bandBoost = rivalsCfg.bandBoost;
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
        spritesConfig.weight,
        spritesConfig.bump,
        spritesConfig.crash,
        view,
        roadConfig,
        paletteConfig,
        screenRoll.uniform,
        overscan,
        race.cars.length,
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
    )
  : null;
// Frame seconds of the last updateVisuals() (rival yaw smoothing and the place flash).
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

// R81d: the zone stick is visible while the finger is on the screen (UI layer).
const stickOverlay =
  uiOn && zoneStick
    ? new StickOverlay(document.body, canvas, spritesConfig.stick, () => inputConfig.touch.driftEdge)
    : null;

function renderFrame(): void {
  // R81d: drawn with the player's current input.drift (touch latch or keyboard).
  if (stickOverlay && zoneStick) stickOverlay.update(zoneStick, player.last.drift);
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
  // R49: while crashTicks > 0 the car tumbles (roll and spin) and hops above the road.
  carView.update(
    weight.yaw + tumble.yawDeg,
    weight.roll,
    carDx,
    weight.pitch,
    screenRoll.deg,
    tumble.rollDeg,
    tumble.hop,
    spritesConfig.crash.pivotY,
  );
  carView.scene.visible = bump.visible; // R45 blink while bumpTicks > 0
  world.drawSmoke(sprites, driftVisual, carView, view.drawDistance);
  world.drawRoadside(sprites, proj, roadside, roadsideIndex);
  tailLights.begin(sprites, focalPx(view), view.screenWidth / 2, view.horizon * view.screenHeight);
  trafficModels.update(
    proj,
    loop.prev.cars,
    loop.curr.cars,
    a,
    playerLineOffset(view, roadConfig, spritesConfig.player.baseY),
    // R45: car width in world units (one lane = 2 * halfWidth / lanes), read live.
    (spritesConfig.traffic.widthLanes * 2 * roadConfig.halfWidth) / roadConfig.lanes,
    tailLights,
  );
  if (rivalModels) {
    rivalModels.update(
      proj,
      loop.prev.cars,
      loop.curr.cars,
      a,
      visualDt,
      playerLineOffset(view, roadConfig, spritesConfig.player.baseY),
      baseCar.model,
      Math.round(baseCar.crashTime / DT),
      spritesConfig.drift.yawMaxDeg,
      rivalUiConfig.rivalNameDistance,
      tailLights,
    );
    nameLabels?.draw(rivalModels, loop.curr.cars);
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
function updateVisuals(dt: number, angle: number, alpha: number): void {
  const p = loop.prev.cars[0]!;
  const c = loop.curr.cars[0]!;
  visualDt = dt;
  driftVisual.update(dt, c, angle);
  screenRoll.update(dt, c, angle);
  // R89: in model B the body yaw is vis*slipDeg + vel*velDeg with the visible slip
  // vis = yaw - vel + carry (interpolated, both states).
  let bodyYaw: number | null = null;
  if (baseCar.model === 1) {
    const vel = p.vel + (c.vel - p.vel) * alpha;
    const vis = p.yaw + (c.yaw - p.yaw) * alpha - vel + p.carry + (c.carry - p.carry) * alpha;
    const w = spritesConfig.weight;
    bodyYaw = vis * w.slipDeg + vel * w.velDeg;
  }
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
    bodyYaw,
  );
  bump.update(dt, c.bumpTicks, c.crashTicks);
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
  hud?.update(time, frameStats, lastCalls, baseCar.model === 1 ? entryText : undefined);
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

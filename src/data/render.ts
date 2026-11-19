import type { Car3dConfig } from '../render/carModel';
import type { CameraConfig } from '../render/projection';
import type { RibbonMapRenderConfig } from '../render/ribbonMapMesh';
import type { RoadMeshConfig } from '../render/roadMesh';
import type { SpritesConfig } from '../render/worldSprites';
import camera from './camera.json';
import car3d from './car3d.json';
import palette from './palette.json';
import ribbonMap from './ribbonMap.json';
import road from './road.json';
import sprites from './sprites.json';

// Palette entries are sRGB hex strings; [light, dark] pairs alternate by stripe.
export interface Palette {
  sky: string;
  asphalt: string[];
  rumble: string[];
  lane: string;
  centreLine: string;
  shoulder: string;
  verge: string[];
  player: string;
  carShadow: string;
  carWheel: string;
  carGlass: string;
  carLamp: string;
  post: string;
  lampPole: string;
  lampHead: string;
  billboardLeg: string;
  billboardFrame: string;
  billboard: string[];
  billboardStripe: string;
  building: string[];
  buildingWindow: string;
  smoke: string;
  mapBacking: string;
  mapStraight: string;
  mapEasy: string;
  mapMedium: string;
  mapHard: string;
  mapMarker: string;
}

export const cameraConfig: CameraConfig = camera;
export const roadConfig: RoadMeshConfig = road;
export const paletteConfig: Palette = palette;
export const spritesConfig: SpritesConfig = sprites;
export const car3dConfig: Car3dConfig = car3d;
export const ribbonMapConfig: RibbonMapRenderConfig = ribbonMap;

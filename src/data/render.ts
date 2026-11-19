import type { CameraConfig, RoadConfig } from '../render/projection';
import type { RibbonMapRenderConfig } from '../render/ribbonMapMesh';
import type { SpritesConfig } from '../render/worldSprites';
import camera from './camera.json';
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
  verge: string[];
  player: string;
  carShadow: string;
  carWheel: string;
  carGlass: string;
  carLamp: string;
  post: string;
  postCap: string;
  smoke: string;
  mapBacking: string;
  mapStraight: string;
  mapEasy: string;
  mapMedium: string;
  mapHard: string;
  mapMarker: string;
}

export const cameraConfig: CameraConfig = camera;
export const roadConfig: RoadConfig = road;
export const paletteConfig: Palette = palette;
export const spritesConfig: SpritesConfig = sprites;
export const ribbonMapConfig: RibbonMapRenderConfig = ribbonMap;

import type { CameraConfig, RoadConfig } from '../render/projection';
import camera from './camera.json';
import palette from './palette.json';
import road from './road.json';

// Palette entries are sRGB hex strings; [light, dark] pairs alternate by stripe.
export interface Palette {
  sky: string;
  asphalt: string[];
  rumble: string[];
  lane: string;
  verge: string[];
}

export const cameraConfig: CameraConfig = camera;
export const roadConfig: RoadConfig = road;
export const paletteConfig: Palette = palette;

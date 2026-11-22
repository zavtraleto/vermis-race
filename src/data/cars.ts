import type { CarParams } from '../sim/types';
import base from './cars/base.json';
import sprites from './sprites.json';

// R47: the lamps the sim hits are the lamps R32 draws; the one source is sprites.json
// roadside.lamps (the app copies them again after the dev diff is applied, see main.ts).
export const baseCar: CarParams = {
  ...base,
  lampEvery: sprites.roadside.lamps.every,
  lampOffset: sprites.roadside.lamps.offset,
  // R156/R158: model C reads the R89 slipDeg of sprites.json weight (one source of the number).
  slipDeg: sprites.weight.slipDeg,
};

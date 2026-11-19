import { baseCar } from '../../src/data/cars';
import type { CarParams } from '../../src/sim/types';

/** Real car data pinned to driving model A (H14: the data default is model B since 2026-11-19). */
export const baseCarA: CarParams = {
  ...baseCar,
  model: 0,
  // R47 lamps off: tests using this car are about their own rules, not about lamp crashes.
  crashMinSpeed: 1e9,
};

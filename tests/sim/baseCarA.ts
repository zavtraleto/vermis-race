import { baseCar } from '../../src/data/cars';
import type { CarParams } from '../../src/sim/types';

/**
 * Real car data for rule tests. [ADR 0005] one driving model since 2026-11-22: the old model A pin
 * and the H17/H18 pins are gone; only the R47 lamps stay off.
 */
export const baseCarA: CarParams = {
  ...baseCar,
  // R47 lamps off: tests using this car are about their own rules, not about lamp crashes.
  crashMinSpeed: 1e9,
};

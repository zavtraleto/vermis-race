import type { MeasureConfig } from '../src/bot/run';
import type { CurveClass } from '../src/data/tracks';

export type Severity = 'no-go' | 'conditional';

export interface BoundRule {
  id: string;
  type?: 'bound';
  bot: string; // bot name or "*"
  metric: string;
  min?: number;
  max?: number;
  above?: number; // strict lower bound: value must be > above
  severity: Severity;
  note?: string;
}

export interface GapRule {
  id: string;
  type: 'gap';
  fast: string;
  slow: string;
  metric: string; // lower is better; gap = (slow - fast) / slow
  min?: number;
  max?: number;
  severity: Severity;
  note?: string;
}

/** A bound on a metric of results.json itself (not per bot/track), e.g. recovery.seconds. */
export interface ResultRule {
  id: string;
  type: 'result';
  metric: string;
  min?: number;
  max?: number;
  severity: Severity;
  note?: string;
}

export interface RecoveryConfig {
  curveClass: CurveClass;
  speed: number;
  depth: number;
  maxSeconds: number;
}

export interface RegressionMetric {
  metric: string;
  better: 'lower' | 'higher';
  floor: number; // denominator floor so a zero baseline does not explode
}

export interface GateConfig {
  measure: MeasureConfig;
  defaultSeeds: number;
  determinismSeed: number;
  recovery: RecoveryConfig;
  corridor: (BoundRule | GapRule | ResultRule)[];
  regression: { noGoWorseBy: number; conditionalWorseBy: number; metrics: RegressionMetric[] };
}

export const GATE_CONFIG = 'gate.config.json';
export const RESULTS = 'results.json';
export const BASELINE = 'results.baseline.json';

export function readGateConfig(text: string): GateConfig {
  const c = JSON.parse(text) as GateConfig;
  if (!c.measure || !Array.isArray(c.corridor) || !c.regression) {
    throw new Error(`${GATE_CONFIG}: needs measure, corridor, regression`);
  }
  return c;
}

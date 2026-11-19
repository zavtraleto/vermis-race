import {
  MAX_DELAY_TICKS,
  type AimMode,
  type BotParams,
  type DriftLine,
  type DriftMode,
  type SpeedMode,
} from '../bot/driver';
import { DT } from '../sim/constants';
import raw from './bots.json';

export const BOT_NAMES = ['novice', 'average', 'expert'] as const;
export type BotName = (typeof BOT_NAMES)[number];

function num(r: Record<string, unknown>, f: string, name: string): number {
  const v = r[f];
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new Error(`bots.${name}.${f} must be a number`);
  return v;
}

/** Validates one skill level from bots.json. */
export function parseBot(name: string, v: unknown): BotParams {
  if (typeof v !== 'object' || v === null) throw new Error(`bots.${name}: not an object`);
  const r = v as Record<string, unknown>;
  const aim = r.aim;
  if (aim !== 'centre' && aim !== 'inside') throw new Error(`bots.${name}.aim: centre | inside`);
  const speed = r.speed;
  if (speed !== 'never' && speed !== 'hold' && speed !== 'late') {
    throw new Error(`bots.${name}.speed: never | hold | late`);
  }
  const drift = r.drift;
  if (drift !== 'never' && drift !== 'corners') {
    throw new Error(`bots.${name}.drift: never | corners`);
  }
  const driftLine = r.driftLine;
  if (driftLine !== 'fixed' && driftLine !== 'width') {
    throw new Error(`bots.${name}.driftLine: fixed | width`);
  }
  const bp: BotParams = {
    steerLookahead: num(r, 'steerLookahead', name),
    brakeLookahead: num(r, 'brakeLookahead', name),
    aim: aim as AimMode,
    insideX: num(r, 'insideX', name),
    insideFullCurve: num(r, 'insideFullCurve', name),
    speed: speed as SpeedMode,
    steerReserve: num(r, 'steerReserve', name),
    edgeMargin: num(r, 'edgeMargin', name),
    noiseAmp: num(r, 'noiseAmp', name),
    noiseTau: num(r, 'noiseTau', name),
    reactionDelay: num(r, 'reactionDelay', name),
    drift: drift as DriftMode,
    driftMinCurve: num(r, 'driftMinCurve', name),
    driftLookahead: num(r, 'driftLookahead', name),
    driftApproach: num(r, 'driftApproach', name),
    driftEntryX: num(r, 'driftEntryX', name),
    driftLineX: num(r, 'driftLineX', name),
    driftKickSteer: num(r, 'driftKickSteer', name),
    driftFeedLookahead: num(r, 'driftFeedLookahead', name),
    driftGain: num(r, 'driftGain', name),
    driftLine: driftLine as DriftLine,
    driftExitX: num(r, 'driftExitX', name),
    driftAngleFloor: num(r, 'driftAngleFloor', name),
    driftPlanMin: num(r, 'driftPlanMin', name),
  };
  if (bp.steerLookahead <= 0) throw new Error(`bots.${name}.steerLookahead must be > 0`);
  if (bp.reactionDelay < 0 || bp.reactionDelay > MAX_DELAY_TICKS * DT) {
    throw new Error(`bots.${name}.reactionDelay must be in [0, ${MAX_DELAY_TICKS * DT}] s`);
  }
  if (bp.driftLine === 'width' && bp.driftPlanMin <= 0) {
    throw new Error(`bots.${name}.driftPlanMin must be > 0`);
  }
  if (bp.noiseAmp > 0 && bp.noiseTau <= 0) throw new Error(`bots.${name}.noiseTau must be > 0`);
  return bp;
}

export const botParams: Record<BotName, BotParams> = {
  novice: parseBot('novice', raw.novice),
  average: parseBot('average', raw.average),
  expert: parseBot('expert', raw.expert),
};

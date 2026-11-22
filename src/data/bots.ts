import { MAX_DELAY_TICKS, type AimMode, type BotParams, type TrafficMode } from '../bot/driver';
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
  const traffic = r.traffic;
  if (traffic !== 'ignore' && traffic !== 'avoid') {
    throw new Error(`bots.${name}.traffic: ignore | avoid`);
  }
  const bp: BotParams = {
    steerLookahead: num(r, 'steerLookahead', name),
    aim: aim as AimMode,
    insideX: num(r, 'insideX', name),
    insideFullCurve: num(r, 'insideFullCurve', name),
    steerGain: num(r, 'steerGain', name),
    aimTime: num(r, 'aimTime', name),
    noiseAmp: num(r, 'noiseAmp', name),
    noiseTau: num(r, 'noiseTau', name),
    reactionDelay: num(r, 'reactionDelay', name),
    traffic: traffic as TrafficMode,
    trafficLookaheadSeg: num(r, 'trafficLookaheadSeg', name),
    trafficMargin: num(r, 'trafficMargin', name),
    trafficEdge: num(r, 'trafficEdge', name),
  };
  if (bp.steerLookahead <= 0) throw new Error(`bots.${name}.steerLookahead must be > 0`);
  if (bp.reactionDelay < 0 || bp.reactionDelay > MAX_DELAY_TICKS * DT) {
    throw new Error(`bots.${name}.reactionDelay must be in [0, ${MAX_DELAY_TICKS * DT}] s`);
  }
  if (bp.noiseAmp > 0 && bp.noiseTau <= 0) throw new Error(`bots.${name}.noiseTau must be > 0`);
  return bp;
}

export const botParams: Record<BotName, BotParams> = {
  novice: parseBot('novice', raw.novice),
  average: parseBot('average', raw.average),
  expert: parseBot('expert', raw.expert),
};

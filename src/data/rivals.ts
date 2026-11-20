import type { MistakeConfig } from '../bot/mistakes';
import type { RivalConfig } from '../sim/types';
import names from './rivalNames.json';
import rivals from './rivals.json';

/** Lane count comes from the road (src/data/road.json), so it is added by the caller. */
const {
  mistakePeriod,
  mistakeTimeMin,
  mistakeTimeMax,
  mistakeSteerMin,
  mistakeSteerMax,
  mistakeBandMul,
  rivalNameDistance,
  leaderboardRows,
  placeFlashTime,
  rivalDriftEntry,
  ...sim
} = rivals;

export const rivalConfig: Omit<RivalConfig, 'lanes'> = {
  ...sim,
  rivalRoles: [rivals.rivalRoles[0]!, rivals.rivalRoles[1]!, rivals.rivalRoles[2]!],
  slotClose: [rivals.slotClose[0]!, rivals.slotClose[1]!],
  slotAhead: [rivals.slotAhead[0]!, rivals.slotAhead[1]!],
  slotBehind: [rivals.slotBehind[0]!, rivals.slotBehind[1]!],
  nemesisSlot: [rivals.nemesisSlot[0]!, rivals.nemesisSlot[1]!],
  rivalSkillWeights: [
    rivals.rivalSkillWeights[0]!,
    rivals.rivalSkillWeights[1]!,
    rivals.rivalSkillWeights[2]!,
  ],
};

/** R63c bot mistakes (src/bot/mistakes.ts). */
export const mistakeConfig: MistakeConfig = {
  mistakePeriod: [mistakePeriod[0]!, mistakePeriod[1]!, mistakePeriod[2]!],
  mistakeTimeMin,
  mistakeTimeMax,
  mistakeSteerMin,
  mistakeSteerMax,
  mistakeBandMul,
  bandBoost: rivals.bandBoost,
};

/** R81e: the drift entry variant of the rival param copies (bots do not know variant 4). */
export { rivalDriftEntry };

/** R67 rival names (src/data/rivalNames.json), indexed by Car.nameId. */
export const rivalNames: readonly string[] = names;

/** R67 rivals on screen: name labels and the leaderboard. */
export const rivalUiConfig = { rivalNameDistance, leaderboardRows, placeFlashTime };
export type RivalUiConfig = typeof rivalUiConfig;

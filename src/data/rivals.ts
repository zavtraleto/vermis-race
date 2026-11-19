import type { RivalConfig } from '../sim/types';
import rivals from './rivals.json';

/** Lane count comes from the road (src/data/road.json), so it is added by the caller. */
export const rivalConfig: Omit<RivalConfig, 'lanes'> = {
  ...rivals,
  rivalSkillWeights: [rivals.rivalSkillWeights[0]!, rivals.rivalSkillWeights[1]!, rivals.rivalSkillWeights[2]!],
};

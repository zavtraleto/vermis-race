import type { RivalConfig } from '../sim/types';
import rivals from './rivals.json';

/** Lane count comes from the road (src/data/road.json), so it is added by the caller. */
export const rivalConfig: Omit<RivalConfig, 'lanes'> = {
  ...rivals,
  rivalRoles: [rivals.rivalRoles[0]!, rivals.rivalRoles[1]!, rivals.rivalRoles[2]!],
  slotClose: [rivals.slotClose[0]!, rivals.slotClose[1]!],
  slotAhead: [rivals.slotAhead[0]!, rivals.slotAhead[1]!],
  slotBehind: [rivals.slotBehind[0]!, rivals.slotBehind[1]!],
  nemesisSlot: [rivals.nemesisSlot[0]!, rivals.nemesisSlot[1]!],
  rivalSkillWeights: [rivals.rivalSkillWeights[0]!, rivals.rivalSkillWeights[1]!, rivals.rivalSkillWeights[2]!],
};

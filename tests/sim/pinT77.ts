/**
 * T77 hypotheses switched off (docs/brief.md R85f / H20 and R84c / H21): `releaseHold` 0 = H20 A ("as
 * without the rule"), `driftRail` 0 = H21 A ("bit for bit as it was"). Spread into any model B car built
 * from base.json whose test is about an older rule or a criterion measured before T77, so it keeps
 * testing that rule (same precedent as NO_T68, NO_GRIP_LEAD, ENTRY_A).
 * R85e has no switch (brief: "Новых чисел нет"); with gripLead 0 and gripDodge 0 it has nothing to clip.
 * Spread from a variable: the new CarParams fields may not exist in the type yet.
 */
export const NO_T77 = { releaseHold: 0, driftRail: 0 };

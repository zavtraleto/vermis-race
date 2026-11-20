/**
 * T68 rules switched off: R85c dodge (`gripDodge`), R83b drift steer floor (`driftMinU`), R84b dive
 * (`driftDive`), R85d lead ramp (`leadRamp`), R86e scrub debt (`debtTime`). Each rule says "0 = as it
 * was". Spread into any model B car built from base.json whose test is about an older rule, so it
 * keeps testing that rule (same precedent as NO_H17_H18, ENTRY_A, NO_GRIP_LEAD).
 * Spread from a variable: the new CarParams fields may not exist in the type yet.
 */
export const NO_T68 = { gripDodge: 0, driftMinU: 0, driftDive: 0, leadRamp: 0, debtTime: 0 };

/**
 * T70 numbers that T71 changed in cars/base.json (docs/balance.md T71): R86 drift angle cap
 * (`driftSpeedLoss` 0.08 -> 0, R86f), R86e scrub debt (`debtTime` 0.5 -> 0, R86e withdrawn), R85c dodge
 * (`gripDodge` 0.45 -> 0.1). Spread into a car built from base.json whose test is about a rule or
 * criterion measured with the T70 numbers on a mechanism that still exists in code (variant 3/4 drift,
 * the debt path), so it keeps testing that mechanism (same precedent as NO_T68, ENTRY_A).
 * Spread from a variable: the fields may be renamed or dropped from CarParams later.
 */
export const T70_NUMBERS = { driftSpeedLoss: 0.08, debtTime: 0.5, gripDodge: 0.45 };
/**
 * R81c driftEntry 3 (H16 D) pinned. T71 moves base.json to driftEntry 5 (R81f); tests of R81c,
 * R85d, R89b "DRIFT on a straight" and the bot/rival rules measured on variant 3 pin it (brief R81f
 * "Параметры машины").
 */
export const ENTRY_D = { driftEntry: 3 };

/**
 * H17 (R86b gripScrub) and H18 (R86c driftTurbo) switched off. Spread into any car built from base.json
 * so that older tests keep testing their own rule (same precedent as `crashMinSpeed: 1e9`).
 * Spread from a variable: the new CarParams fields may not exist in the type yet.
 */
export const NO_H17_H18 = { gripScrub: 0, driftTurbo: 0 };

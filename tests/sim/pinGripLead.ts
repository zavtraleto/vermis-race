/**
 * R85b GRIP lead (`gripLead`) switched off. base.json starts it at 0.9; spread into any model B car
 * built from base.json whose test is about an older rule, so it keeps testing that rule (same
 * precedent as NO_H17_H18, ENTRY_A and `crashMinSpeed: 1e9`).
 * Spread from a variable: the new CarParams field may not exist in the type yet.
 * T77: R85e (the GRIP lead only catches) has no switch of its own; with gripLead 0 (and gripDodge 0,
 * NO_T68) there is no lead for it to clip, so PB tests stay as they were.
 */
export const NO_GRIP_LEAD = { gripLead: 0 };

// Structural constants, must match docs/brief.md section 3.
export const DT = 1 / 120;
export const SEG_PER_UNIT = 60;
// R17: placeholder, to be calibrated when background rotation is implemented.
export const K_HEADING = 1;
// R81: length of the raw steer ring buffer; must be >= flickWindow / DT (0.12 * 120 = 14.4) with margin.
export const STEER_HIST = 16;

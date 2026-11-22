// Structural constants, must match docs/brief.md section 3.
export const DT = 1 / 120;
export const SEG_PER_UNIT = 60;

// R200 units paragraph: gravity, m/s^2.
export const G = 9.81;
// R200: OR2 runs at 60.2 ticks per second; a share k per OR2 tick is 1 - (1 - k)^(60.2*DT) per tick.
export const OR2_HZ = 60.2;
export const perTick = (k: number): number => 1 - Math.pow(1 - k, OR2_HZ * DT);
// R206: counter moves toward its target by 0.1 per OR2 tick (CC:225-232).
export const COUNTER_SHARE = perTick(0.1);
// R207: travelRate catches the desired rate by 1/4 per OR2 tick (CC:173-219).
export const TRAVEL_SHARE = perTick(0.25);
// R209: refAngle moves toward its target by 1/10 per OR2 tick (CC:815-883).
export const REF_SHARE = perTick(0.1);

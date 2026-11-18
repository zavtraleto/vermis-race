/** Touch steering schemes (H2). Only A (relative stick) is implemented. */
export type TouchScheme = 'A';

/**
 * Maps the H2 flag value to an implemented scheme. 'A' -> 'A' silently; anything else -> 'A'
 * and exactly one call of `warn` with a message naming the bad value and the fallback.
 */
export function resolveTouchScheme(flag: unknown, warn: (message: string) => void): TouchScheme {
  if (flag === 'A') return 'A';
  warn(`H2_touchSteering: unknown touch scheme "${String(flag)}", falling back to "A"`);
  return 'A';
}

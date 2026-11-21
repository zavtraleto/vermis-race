// R95: remembered H19_touchDrift choice (key 'vermis.touchDrift'). Stub — implementation pending.

export type TouchDrift = 'A' | 'B' | 'C';

export function loadTouchDrift(
  storage: { getItem(k: string): string | null } | null,
  fallback: TouchDrift,
): TouchDrift {
  void storage;
  void fallback;
  throw new Error('not implemented');
}

export function saveTouchDrift(
  storage: { setItem(k: string, v: string): void } | null,
  value: TouchDrift,
): void {
  void storage;
  void value;
  throw new Error('not implemented');
}

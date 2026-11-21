// R95: remembered H19_touchDrift choice (key 'vermis.touchDrift').

export type TouchDrift = 'A' | 'B' | 'C';

const KEY = 'vermis.touchDrift';

export function isTouchDrift(v: unknown): v is TouchDrift {
  return v === 'A' || v === 'B' || v === 'C';
}

export function loadTouchDrift(
  storage: { getItem(k: string): string | null } | null,
  fallback: TouchDrift,
): TouchDrift {
  if (storage === null) return fallback;
  try {
    const v = storage.getItem(KEY);
    return isTouchDrift(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveTouchDrift(
  storage: { setItem(k: string, v: string): void } | null,
  value: TouchDrift,
): void {
  if (storage === null) return;
  try {
    storage.setItem(KEY, value);
  } catch {
    // Private mode / storage disabled: the choice holds for this session only.
  }
}

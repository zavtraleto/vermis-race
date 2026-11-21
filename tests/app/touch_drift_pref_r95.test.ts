import { describe, expect, it } from 'vitest';
import { loadTouchDrift, saveTouchDrift } from '../../src/app/touchDriftPref';

/**
 * Spec: docs/brief.md R95 "Пауза": the chosen drift mode (H19_touchDrift) is remembered in
 * localStorage and taken from there on the next load. Key 'vermis.touchDrift'. Pure module:
 * storage is injected; any failure falls back / is swallowed.
 */
const KEY = 'vermis.touchDrift';
const mem = (init: Record<string, string> = {}) => {
  const m = new Map<string, string>(Object.entries(init));
  return {
    m,
    getItem: (k: string): string | null => m.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      m.set(k, v);
    },
  };
};

describe('R95 loadTouchDrift', () => {
  it.each(['A', 'B', 'C'] as const)('stored %s is returned', (v) => {
    expect(loadTouchDrift(mem({ [KEY]: v }), 'A')).toBe(v);
  });
  it.each(['B', 'C'] as const)('missing key -> fallback %s', (fb) => {
    expect(loadTouchDrift(mem(), fb)).toBe(fb);
  });
  it.each(['', 'a', 'D', ' A', 'AB', 'null'])('invalid stored value %j -> fallback', (v) => {
    expect(loadTouchDrift(mem({ [KEY]: v }), 'B')).toBe('B');
  });
  it('null storage -> fallback', () => {
    expect(loadTouchDrift(null, 'C')).toBe('C');
  });
  it('getItem throwing -> fallback, no throw', () => {
    const bad = {
      getItem: (): string | null => {
        throw new Error('SecurityError');
      },
    };
    expect(loadTouchDrift(bad, 'A')).toBe('A');
  });
  it('reads only the key vermis.touchDrift', () => {
    expect(loadTouchDrift(mem({ touchDrift: 'C', 'vermis.other': 'C' }), 'A')).toBe('A');
  });
});

describe('R95 saveTouchDrift', () => {
  it.each(['A', 'B', 'C'] as const)('writes %s under vermis.touchDrift; load round-trips', (v) => {
    const s = mem();
    saveTouchDrift(s, v);
    expect(s.m.get(KEY)).toBe(v);
    expect(loadTouchDrift(s, v === 'A' ? 'B' : 'A')).toBe(v);
  });
  it('setItem throwing is swallowed', () => {
    const bad = {
      getItem: (): string | null => null,
      setItem: (): void => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => saveTouchDrift(bad, 'C')).not.toThrow();
  });
  it('null storage is accepted without throwing', () => {
    expect(() => saveTouchDrift(null, 'B')).not.toThrow();
  });
});

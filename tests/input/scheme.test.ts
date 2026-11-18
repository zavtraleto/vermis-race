import { describe, expect, it, vi } from 'vitest';
import { resolveTouchScheme } from '../../src/input/scheme';

describe('resolveTouchScheme', () => {
  it("'A' -> 'A', no warning", () => {
    const warn = vi.fn();
    expect(resolveTouchScheme('A', warn)).toBe('A');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([['B'], ['C'], ['x'], [undefined]])(
    '%s -> A with exactly one warning naming it',
    (bad) => {
      const warn = vi.fn();
      expect(resolveTouchScheme(bad, warn)).toBe('A');
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]?.[0]);
      expect(msg).toContain(String(bad));
      expect(msg).toContain('A');
    },
  );
});

import type { KeyboardInput } from './keyboard';

/** Thin DOM adapter: feeds KeyboardEvent.code into the pure keyboard model. */
export function attachKeyboard(target: Window, kb: KeyboardInput, now: () => number): void {
  target.addEventListener('keydown', (e) => {
    // Browser/OS shortcuts (Ctrl+D, Cmd+S, ...) are not game input; macOS may never send their keyup.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (kb.keyDown(e.code, now())) e.preventDefault();
  });
  // keyup is always forwarded so a key pressed before a modifier is still released.
  target.addEventListener('keyup', (e) => {
    if (kb.keyUp(e.code, now())) e.preventDefault();
  });
  target.addEventListener('blur', () => {
    kb.releaseAll(now());
  });
  target.document.addEventListener('visibilitychange', () => {
    if (target.document.visibilityState === 'hidden') kb.releaseAll(now());
  });
}

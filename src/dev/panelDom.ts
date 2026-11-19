/** Small DOM helpers and styles shared by the dev panel modules. */

export const BG = 'rgba(14, 14, 20, 0.92)';
export const FG = '#e4e4e4';
export const DIM = '#9a9aa0';
export const ACCENT = '#e0485c';
export const LINE = '#4a4a50';
export const CHANGED_BG = 'rgba(224, 72, 92, 0.14)';
/** Thumb target size (Apple HIG minimum). */
export const TAP = 44;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export const BUTTON_CSS =
  `min-width:${TAP}px;height:${TAP}px;padding:0 10px;font:600 14px system-ui,sans-serif;` +
  `color:${FG};background:rgba(90,90,96,0.5);border:1px solid ${LINE};border-radius:10px;` +
  'touch-action:manipulation;flex:0 0 auto;box-sizing:border-box;cursor:pointer;';

export function button(label: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', BUTTON_CSS, label);
  b.type = 'button';
  if (title !== undefined) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  b.addEventListener('click', () => {
    onClick();
    // Keep keyboard focus off the panel so Space/arrows keep driving.
    b.blur();
  });
  return b;
}

/** Marks a toggle button as on/off. */
export function setPressed(b: HTMLButtonElement, on: boolean): void {
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.style.background = on ? ACCENT : 'rgba(90,90,96,0.5)';
  b.style.borderColor = on ? ACCENT : LINE;
  b.style.color = on ? '#fff' : FG;
}

export function decimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private mode / storage disabled: the panel still works for this session.
  }
}

import type { Pad } from './pad';

/**
 * Thin DOM adapter: Pointer Events -> pure control pad (R202). Coordinates are relative to `area`
 * (the letterboxed game canvas), CSS px. Mouse works like a finger while the left button is held.
 */
export function attachPointer(area: HTMLElement, stick: Pad, now: () => number): void {
  // Rect cached at pointerdown for move conversion. A resize/rotation in the middle of a gesture
  // keeps the old origin and R until the finger is lifted (accepted for now).
  let left = 0;
  let top = 0;

  // Listened on document: UI overlays may cover the canvas.
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rect = area.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    stick.setArea(rect.width, rect.height);
    const t = now();
    if (!stick.pointerDown(e.pointerId, x, y, t)) return;
    left = rect.left;
    top = rect.top;
    try {
      area.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events have no active pointer (NotFoundError); capture is optional.
    }
    e.preventDefault();
  });

  window.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stick.activeId) return;
    const id = e.pointerId;
    const coalesced = e.getCoalescedEvents?.();
    if (coalesced !== undefined && coalesced.length > 0) {
      for (let i = 0; i < coalesced.length; i++) {
        const c = coalesced[i]!;
        const t = now();
        stick.pointerMove(id, c.clientX - left, c.clientY - top, t);
      }
    } else {
      const t = now();
      stick.pointerMove(id, e.clientX - left, e.clientY - top, t);
    }
  });
  window.addEventListener('pointerup', (e) => {
    if (e.pointerId !== stick.activeId) return;
    const t = now();
    stick.pointerUp(e.pointerId, t);
  });
  window.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== stick.activeId) return;
    const t = now();
    stick.pointerCancel(e.pointerId, t);
  });

  // Losing focus may swallow pointerup (desktop mouse): treat it as a cancel.
  const cancelActive = (): void => {
    const id = stick.activeId;
    if (id === null) return;
    const t = now();
    stick.pointerCancel(id, t);
  };
  window.addEventListener('blur', cancelActive);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') cancelActive();
  });

  // Keep iOS from scrolling, zooming, selecting or opening menus.
  const block = (e: Event): void => {
    e.preventDefault();
  };
  const opts = { passive: false };
  document.addEventListener('touchmove', block, opts);
  document.addEventListener('gesturestart', block, opts);
  document.addEventListener('dblclick', block, opts);
  document.addEventListener('contextmenu', block, opts);
}

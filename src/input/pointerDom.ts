import type { TouchStick } from './touchStick';

/**
 * Thin DOM adapter: Pointer Events -> pure touch stick. Coordinates are relative to `area`
 * (the letterboxed game canvas). Mouse uses the same scheme while the left button is held.
 */
export function attachPointer(area: HTMLElement, stick: TouchStick, now: () => number): void {
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
    if (!stick.pointerDown(e.pointerId, x, y, now())) return;
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
        stick.pointerMove(id, c.clientX - left, c.clientY - top, now());
      }
    } else stick.pointerMove(id, e.clientX - left, e.clientY - top, now());
  });
  window.addEventListener('pointerup', (e) => {
    if (e.pointerId === stick.activeId) stick.pointerUp(e.pointerId, now());
  });
  window.addEventListener('pointercancel', (e) => {
    if (e.pointerId === stick.activeId) stick.pointerCancel(e.pointerId, now());
  });

  // Losing focus may swallow pointerup (desktop mouse): treat it as a cancel.
  const cancelActive = (): void => {
    const id = stick.activeId;
    if (id !== null) stick.pointerCancel(id, now());
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

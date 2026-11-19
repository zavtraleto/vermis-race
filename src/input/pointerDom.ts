import type { RetouchDrift } from './retouchDrift';
import type { TouchStick } from './touchStick';

/**
 * Thin DOM adapter: Pointer Events -> pure touch stick. Coordinates are relative to `area`
 * (the letterboxed game canvas), CSS px. Mouse uses the same scheme while the left button is held.
 * `retouch` (H3 D) gets the same events of the stick's active pointer.
 */
export function attachPointer(
  area: HTMLElement,
  stick: TouchStick,
  now: () => number,
  retouch?: RetouchDrift,
): void {
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
    retouch?.down(x, t);
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
        retouch?.move(c.clientX - left, t);
      }
    } else {
      const t = now();
      stick.pointerMove(id, e.clientX - left, e.clientY - top, t);
      retouch?.move(e.clientX - left, t);
    }
  });
  window.addEventListener('pointerup', (e) => {
    if (e.pointerId !== stick.activeId) return;
    const t = now();
    stick.pointerUp(e.pointerId, t);
    retouch?.up(t);
  });
  window.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== stick.activeId) return;
    const t = now();
    stick.pointerCancel(e.pointerId, t);
    retouch?.up(t);
  });

  // Losing focus may swallow pointerup (desktop mouse): treat it as a cancel.
  const cancelActive = (): void => {
    const id = stick.activeId;
    if (id === null) return;
    const t = now();
    stick.pointerCancel(id, t);
    retouch?.up(t);
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

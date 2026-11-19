import type { InputFrame } from '../sim/types';
import type { FlickDrift } from './flickDrift';
import type { RetouchDrift } from './retouchDrift';
import type { TouchStick } from './touchStick';

/**
 * Thin DOM adapter: Pointer Events -> pure touch stick. Coordinates are relative to `area`
 * (the letterboxed game canvas), CSS px. Mouse uses the same scheme while the left button is held.
 * `retouch` (H3 D) gets the same events of the stick's active pointer; `flick` (H3 E) gets the
 * stick's steer after each down / move of that pointer, and up / cancel.
 */
export function attachPointer(
  area: HTMLElement,
  stick: TouchStick,
  now: () => number,
  retouch?: RetouchDrift,
  flick?: FlickDrift,
): void {
  const frame: InputFrame = { steer: 0, brake: false, drift: false };
  // H3 E: report the stick's current steer to the flick detector.
  const sampleFlick = (t: number): void => {
    if (flick === undefined) return;
    stick.read(t, frame);
    flick.sample(frame.steer, t);
  };
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
    flick?.down(t);
    sampleFlick(t);
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
        sampleFlick(t);
      }
    } else {
      const t = now();
      stick.pointerMove(id, e.clientX - left, e.clientY - top, t);
      retouch?.move(e.clientX - left, t);
      sampleFlick(t);
    }
  });
  window.addEventListener('pointerup', (e) => {
    if (e.pointerId !== stick.activeId) return;
    const t = now();
    stick.pointerUp(e.pointerId, t);
    retouch?.up(t);
    flick?.up(t);
  });
  window.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== stick.activeId) return;
    const t = now();
    stick.pointerCancel(e.pointerId, t);
    retouch?.up(t);
    flick?.up(t);
  });

  // Losing focus may swallow pointerup (desktop mouse): treat it as a cancel.
  const cancelActive = (): void => {
    const id = stick.activeId;
    if (id === null) return;
    const t = now();
    stick.pointerCancel(id, t);
    retouch?.up(t);
    flick?.up(t);
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

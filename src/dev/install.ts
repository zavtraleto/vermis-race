import tunablesSpec from '../data/tunables.json';
import { DevPanel } from './panel';
import type { PanelItemMeta } from './panelModel';
import { parseDevParams } from './params';
import { createTunables, type Tunables, type TunableSpec } from './tunables';

/** localStorage key of the current diff (JSON text). */
export const TUNE_STORAGE_KEY = 'vermis-race.tune';

function load(): string | null {
  try {
    return window.localStorage.getItem(TUNE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function save(t: Tunables): void {
  try {
    const json = t.serialize();
    if (json === '{}') window.localStorage.removeItem(TUNE_STORAGE_KEY);
    else window.localStorage.setItem(TUNE_STORAGE_KEY, json);
  } catch {
    // Private mode / storage disabled: tuning still works for this session.
  }
}

function applyFrom(t: Tunables, json: string, source: string): void {
  try {
    const rejected = t.apply(json);
    console.info(`dev: tuning from ${source}: ${t.serialize()}`);
    if (rejected.length > 0) console.warn(`dev: ${source}: skipped ${rejected.join(', ')}`);
  } catch (e) {
    console.warn(`dev: ${source}: not a JSON diff (${String(e)})`);
  }
}

/**
 * Builds the tunables registry over the live config objects, restores the saved diff
 * (localStorage), then ?tune= (a shared link wins, but is saved only after the next change),
 * and installs the panel triggers: ?dev=1, three-finger tap, backquote key.
 * Call before the render objects are built so drawDistance starts from the tuned value.
 */
export function installDev(
  roots: Record<string, object>,
  search: string,
  // Spike E1: extra ranges (render3d sliders) merged in only when that renderer runs.
  extra?: TunableSpec,
): Tunables {
  const base = tunablesSpec as TunableSpec;
  const spec: TunableSpec = extra
    ? { numbers: { ...base.numbers, ...extra.numbers }, flags: { ...base.flags, ...extra.flags } }
    : base;
  const t = createTunables(roots, spec);
  // Panel metadata sits next to the ranges (`meta`); the registry itself ignores it.
  const metaOf = (s: unknown): Record<string, PanelItemMeta> =>
    (s as { meta?: Record<string, PanelItemMeta> }).meta ?? {};
  const meta = { ...metaOf(base), ...(extra ? metaOf(extra) : {}) };
  const params = parseDevParams(search);
  const stored = load();
  if (stored !== null) applyFrom(t, stored, 'localStorage');
  if (params.tune !== null) applyFrom(t, params.tune, '?tune=');
  t.onChange(() => save(t));

  const shareUrl = (json: string): string => {
    const u = new URL(window.location.href);
    u.searchParams.set('dev', '1');
    u.searchParams.set('tune', json);
    return u.toString();
  };
  let panel: DevPanel | null = null;
  const open = (): DevPanel => (panel ??= new DevPanel(document.body, t, shareUrl, meta));
  if (params.open) open().show();
  const toggle = (): void => {
    if (panel === null) open().setMode('open');
    else panel.toggle();
  };

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote' || e.repeat) return;
    const target = e.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    toggle();
  });
  document.addEventListener(
    'touchstart',
    (e) => {
      // Fires once, when the third finger lands.
      if (e.touches.length === 3 && e.changedTouches.length >= 1) toggle();
    },
    { capture: true, passive: true },
  );
  return t;
}

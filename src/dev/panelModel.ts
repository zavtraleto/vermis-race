/** Pure model of the dev panel (no DOM): which items to show, layout clamping, persistence. */

export type Tier = 'core' | 'more' | 'legacy';

export interface PanelItemMeta {
  title: string;
  /** What happens when the value goes up (plain words). */
  hint: string;
  tier: Tier;
  group: string;
  /** Read only by this driving model (car.model 0 = A, 1 = B). */
  model?: 'A' | 'B';
  /** The change is picked up only after a page reload. */
  reload?: boolean;
  /** Rule / hypothesis id, shown small next to the path. */
  rule?: string;
  /** Labels of the values min, min + step, ... of a small integer switch (segmented buttons). */
  options?: string[];
}

export interface PanelViewState {
  model: 'A' | 'B';
  query: string;
  onlyChanged: boolean;
  showMore: boolean;
  favourites: readonly string[];
}

export interface PanelSection {
  id: string;
  title: string;
  paths: string[];
}

export interface PanelLayout {
  dock: 'float' | 'side';
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  collapsed: boolean;
}

export interface Viewport {
  w: number;
  h: number;
  gameLeft: number;
  gameRight: number;
}

export const FAV_ID = 'fav';
const FAV_TITLE = 'Избранное';
/** Free width beside the game needed to dock the panel there. */
const SIDE_MIN = 320;
const SIDE_MAX_W = 420;
const MARGIN = 8;
/** Default floating panel height, fraction of the screen: the R33 steering zone stays free. */
const FLOAT_H_FRAC = 0.45;
const MIN_W = 240;
const MIN_H = 160;
const MIN_OPACITY = 0.3;

function forModel(x: PanelItemMeta, model: 'A' | 'B'): boolean {
  return x.model === undefined || x.model === model;
}

function matches(path: string, x: PanelItemMeta, q: string): boolean {
  return (
    x.title.toLowerCase().includes(q) ||
    x.hint.toLowerCase().includes(q) ||
    x.group.toLowerCase().includes(q) ||
    path.toLowerCase().includes(q)
  );
}

/**
 * Sections to show, in group order of first appearance in `meta`.
 * Search (non-blank query): every model and tier, no favourites. Only-changed: changed paths of the
 * active model. Default: favourites first, then core (+ more with showMore) and every changed path.
 */
export function buildSections(
  meta: Readonly<Record<string, PanelItemMeta>>,
  state: PanelViewState,
  changed: ReadonlySet<string>,
): PanelSection[] {
  const q = state.query.trim().toLowerCase();
  const out: PanelSection[] = [];
  const taken = new Set<string>();
  const searching = q !== '';

  if (!searching && !state.onlyChanged) {
    const fav: string[] = [];
    for (const p of state.favourites) {
      const x = meta[p];
      if (x !== undefined && forModel(x, state.model) && !taken.has(p)) {
        fav.push(p);
        taken.add(p);
      }
    }
    if (fav.length > 0) out.push({ id: FAV_ID, title: FAV_TITLE, paths: fav });
  }

  const groups = new Map<string, PanelSection>();
  const order: PanelSection[] = [];
  for (const [path, x] of Object.entries(meta)) {
    let section = groups.get(x.group);
    if (section === undefined) {
      section = { id: `group:${x.group}`, title: x.group, paths: [] };
      groups.set(x.group, section);
      order.push(section);
    }
    if (taken.has(path)) continue;
    let show: boolean;
    if (searching) show = matches(path, x, q) && (!state.onlyChanged || changed.has(path));
    else if (!forModel(x, state.model)) show = false;
    else if (state.onlyChanged) show = changed.has(path);
    else show = x.tier === 'core' || (state.showMore && x.tier === 'more') || changed.has(path);
    if (show) section.paths.push(path);
  }
  for (const s of order) if (s.paths.length > 0) out.push(s);
  return out;
}

function sideLayout(x: number, w: number, vp: Viewport): PanelLayout {
  return {
    dock: 'side',
    x,
    y: MARGIN,
    w,
    h: vp.h - 2 * MARGIN,
    opacity: 1,
    collapsed: false,
  };
}

/** Beside the game when >= 320 px is free (right first), else a collapsed float at the top. */
export function defaultLayout(vp: Viewport): PanelLayout {
  const freeRight = vp.w - vp.gameRight;
  const freeLeft = vp.gameLeft;
  if (freeRight >= SIDE_MIN) {
    const w = Math.min(SIDE_MAX_W, freeRight - 2 * MARGIN);
    return sideLayout(vp.gameRight + MARGIN, w, vp);
  }
  if (freeLeft >= SIDE_MIN) {
    const w = Math.min(SIDE_MAX_W, freeLeft - 2 * MARGIN);
    return sideLayout(vp.gameLeft - MARGIN - w, w, vp);
  }
  const w = Math.max(Math.min(vp.w, MIN_W), vp.w - 2 * MARGIN);
  const h = Math.max(Math.min(vp.h, MIN_H), Math.round(vp.h * FLOAT_H_FRAC));
  return {
    dock: 'float',
    x: Math.max(0, vp.w - MARGIN - w),
    y: Math.min(MARGIN, Math.max(0, vp.h - h)),
    w,
    h,
    opacity: 1,
    collapsed: true,
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Size within [240, vp.w] x [160, vp.h], fully on screen, opacity in [0.3, 1]; bad fields -> default. */
export function clampLayout(l: PanelLayout, vp: Viewport): PanelLayout {
  const d = defaultLayout(vp);
  const w = clamp(num(l.w, d.w), Math.min(MIN_W, vp.w), vp.w);
  const h = clamp(num(l.h, d.h), Math.min(MIN_H, vp.h), vp.h);
  return {
    dock: l.dock === 'side' || l.dock === 'float' ? l.dock : d.dock,
    x: clamp(num(l.x, d.x), 0, vp.w - w),
    y: clamp(num(l.y, d.y), 0, vp.h - h),
    w,
    h,
    opacity: clamp(num(l.opacity, d.opacity), MIN_OPACITY, 1),
    collapsed: typeof l.collapsed === 'boolean' ? l.collapsed : d.collapsed,
  };
}

type ViewPart = Pick<PanelViewState, 'showMore' | 'favourites' | 'onlyChanged'>;

export function serializeView(state: ViewPart, layout: PanelLayout): string {
  return JSON.stringify({
    v: 1,
    state: {
      showMore: state.showMore,
      onlyChanged: state.onlyChanged,
      favourites: [...state.favourites],
    },
    layout: {
      dock: layout.dock,
      x: layout.x,
      y: layout.y,
      w: layout.w,
      h: layout.h,
      opacity: layout.opacity,
      collapsed: layout.collapsed,
    },
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Inverse of serializeView; anything missing or malformed falls back to the defaults. */
export function parseView(
  text: string | null,
  vp: Viewport,
): { state: ViewPart; layout: PanelLayout } {
  let parsed: unknown = null;
  if (text !== null) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  const root = isObject(parsed) ? parsed : {};
  const s = isObject(root.state) ? root.state : {};
  const favs = Array.isArray(s.favourites)
    ? s.favourites.filter((f): f is string => typeof f === 'string')
    : [];
  const state: ViewPart = {
    showMore: s.showMore === true,
    onlyChanged: s.onlyChanged === true,
    favourites: favs,
  };
  const layout = isObject(root.layout)
    ? clampLayout(root.layout as unknown as PanelLayout, vp)
    : defaultLayout(vp);
  return { state, layout };
}

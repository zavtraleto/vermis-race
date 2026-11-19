/* eslint-disable @typescript-eslint/no-unused-vars -- type-only stubs until implemented */
/** Pure model of the dev panel (no DOM): which items to show, layout clamping, persistence. */

export type Tier = 'core' | 'more' | 'legacy';

export interface PanelItemMeta {
  title: string;
  hint: string;
  tier: Tier;
  group: string;
  model?: 'A' | 'B';
  reload?: boolean;
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

export function buildSections(
  _meta: Readonly<Record<string, PanelItemMeta>>,
  _state: PanelViewState,
  _changed: ReadonlySet<string>,
): PanelSection[] {
  throw new Error('not implemented');
}

export function defaultLayout(_vp: Viewport): PanelLayout {
  throw new Error('not implemented');
}

export function clampLayout(_l: PanelLayout, _vp: Viewport): PanelLayout {
  throw new Error('not implemented');
}

export function serializeView(
  _state: Pick<PanelViewState, 'showMore' | 'favourites' | 'onlyChanged'>,
  _layout: PanelLayout,
): string {
  throw new Error('not implemented');
}

export function parseView(
  _text: string | null,
  _vp: Viewport,
): {
  state: Pick<PanelViewState, 'showMore' | 'favourites' | 'onlyChanged'>;
  layout: PanelLayout;
} {
  throw new Error('not implemented');
}

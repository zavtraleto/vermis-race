import {
  FAV_ID,
  buildSections,
  clampLayout,
  defaultLayout,
  parseView,
  serializeView,
  type PanelItemMeta,
  type PanelLayout,
  type PanelViewState,
  type Viewport,
} from './panelModel';
import {
  ACCENT,
  BG,
  DIM,
  FG,
  LINE,
  TAP,
  button,
  el,
  readStore,
  setPressed,
  writeStore,
} from './panelDom';
import { flagRow, numberRow, pinStrip, type Row, type RowContext } from './panelRows';
import type { Tunables } from './tunables';

/**
 * Dev tuning panel (DOM) over the pure view-model in panelModel.ts.
 * Phone: a pill in the top-right corner opens a floating window (drag by the title bar, resize by
 * the corner grip, opacity, collapse); by default it covers only the upper part of the screen, so
 * the R33 steering zone stays free. Wide window: docked beside the game canvas, never over it.
 * Pointer/touch/key events that start on the panel never reach the game's document/window
 * listeners (steering, keyboard, iOS gesture blockers). Layout, favourites, filters, closed
 * sections and the pinned slider persist in localStorage.
 */

const VIEW_KEY = 'vermis-race.panel';
const CLOSED_KEY = 'vermis-race.panel.closed';
const PIN_KEY = 'vermis-race.panel.pin';
const DENSITY_KEY = 'vermis-race.panel.density';
/** Narrower than this: compact rows by default (details on tap). */
const COMPACT_BELOW_W = 600;
const SECTION_H = 32;
const OPACITY_STEPS = [1, 0.85, 0.7, 0.5, 0.35];
/** Delay before a value change that adds/removes rows re-filters (never moves a row mid-drag). */
const REFILTER_MS = 700;
const PILL_W = 92;
const STRIP_H = 56;

type Mode = 'hidden' | 'open' | 'collapsed';

// Events that the game listens for on document/window; stopped at the panel root.
const ISOLATED = ['pointerdown', 'touchmove', 'contextmenu', 'dblclick', 'gesturestart'] as const;

function isFormControl(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement
  );
}

function readClosed(): Set<string> {
  try {
    const v: unknown = JSON.parse(readStore(CLOSED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export class DevPanel {
  private readonly root: HTMLDivElement;
  private readonly box: HTMLDivElement;
  private readonly tab: HTMLButtonElement;
  private readonly strip: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly pool: HTMLDivElement;
  private readonly io: HTMLDivElement;
  private readonly text: HTMLTextAreaElement;
  private readonly status: HTMLDivElement;
  private readonly densityBtn: HTMLButtonElement;
  /** Compact: two-line rows, one row's details open at a time; full: every row shows details. */
  private compact: boolean;
  private expanded: string | null = null;
  private sectionCounts: { span: HTMLSpanElement; paths: string[] }[] = [];
  private readonly moreBtn: HTMLButtonElement;
  private readonly changedBtn: HTMLButtonElement;
  private readonly opacityBtn: HTMLButtonElement;
  private readonly dockBtn: HTMLButtonElement;
  private readonly search: HTMLInputElement;
  private readonly rows = new Map<string, Row>();
  private readonly meta: Record<string, PanelItemMeta> = {};
  private readonly view: PanelViewState;
  private layout: PanelLayout;
  private readonly hadSavedView: boolean;
  private readonly closed = readClosed();
  private pinned: { path: string; row: Row } | null = null;
  private mode: Mode = 'hidden';
  private shownKey = '';
  private refilterTimer: ReturnType<typeof setTimeout> | null = null;
  private undoJson: string | null = null;
  private readonly ctx: RowContext;

  constructor(
    parent: HTMLElement,
    private readonly t: Tunables,
    private readonly shareUrl: (json: string) => string,
    meta: Readonly<Record<string, PanelItemMeta>>,
  ) {
    this.ctx = {
      t,
      isFavourite: (p) => this.view.favourites.includes(p),
      toggleFavourite: (p) => this.toggleFavourite(p),
      pin: (p) => this.pin(p),
      toggleExpand: (p) => this.toggleExpand(p),
    };
    const density = readStore(DENSITY_KEY);
    this.compact =
      density === 'compact' || (density !== 'full' && window.innerWidth < COMPACT_BELOW_W);
    // Panel metadata for every registered path, in meta order (unknown paths go last).
    const paths = [...t.numbers.map((n) => n.path), ...t.flags.map((f) => f.path)];
    const known = new Set(paths);
    for (const [p, m] of Object.entries(meta)) if (known.has(p)) this.meta[p] = m;
    for (const p of paths) this.meta[p] ??= { title: p, hint: '—', tier: 'more', group: 'Прочее' };

    const saved = readStore(VIEW_KEY);
    this.hadSavedView = saved !== null;
    const parsed = parseView(saved, this.viewport());
    this.layout = parsed.layout;
    this.view = {
      model: this.model(),
      query: '',
      onlyChanged: parsed.state.onlyChanged,
      showMore: parsed.state.showMore,
      favourites: parsed.state.favourites,
    };

    const root = el(
      'div',
      'position:fixed;inset:0;z-index:20;pointer-events:none;' +
        `font:14px/1.25 system-ui,sans-serif;color:${FG};`,
    );
    root.id = 'dev-panel';
    // Safari draws its own disclosure marker on <summary>; the headers draw ▸ / ▾ themselves.
    root.appendChild(el('style', '', '#dev-panel summary::-webkit-details-marker{display:none}'));
    for (const type of ISOLATED) root.addEventListener(type, (e) => e.stopPropagation());
    // Typing in a field must not steer (the keyboard model preventDefaults A/D/S/arrows/space).
    const stopTyping = (e: KeyboardEvent): void => {
      if (isFormControl(e.target)) e.stopPropagation();
    };
    root.addEventListener('keydown', stopTyping);
    root.addEventListener('keyup', stopTyping);
    // A tap on the game takes keyboard focus off a panel field (the game may preventDefault it).
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (this.mode === 'hidden') return;
        const a = document.activeElement;
        if (a instanceof HTMLElement && root.contains(a) && !root.contains(e.target as Node))
          a.blur();
      },
      { capture: true, passive: true },
    );
    this.root = root;

    // Collapsed: the pill (top-right corner, outside the steering zone) and the pinned strip.
    this.tab = button('dev', () => this.setMode('open'), 'открыть настройки');
    this.tab.id = 'dev-tab';
    this.tab.style.cssText +=
      `position:absolute;right:6px;top:calc(env(safe-area-inset-top) + 4px);width:${PILL_W}px;` +
      `background:${BG};border-radius:22px;pointer-events:auto;`;
    this.strip = el(
      'div',
      `position:absolute;left:0;right:0;top:env(safe-area-inset-top);height:${STRIP_H}px;` +
        `background:${BG};border-bottom:1px solid ${LINE};pointer-events:auto;display:none;`,
    );

    const box = el(
      'div',
      `position:absolute;display:flex;flex-direction:column;background:${BG};` +
        `border:1px solid ${LINE};border-radius:12px;box-sizing:border-box;overflow:hidden;` +
        'pointer-events:auto;box-shadow:0 6px 24px rgba(0,0,0,0.5);',
    );
    this.box = box;

    // Row 1: drag grip, search, opacity, dock, collapse.
    const bar = el(
      'div',
      `display:flex;align-items:center;gap:4px;padding:4px;border-bottom:1px solid ${LINE};`,
    );
    const handle = el(
      'div',
      `flex:0 0 auto;width:36px;height:${TAP}px;display:flex;align-items:center;` +
        `justify-content:center;font-size:20px;color:${DIM};cursor:move;touch-action:none;` +
        'user-select:none;',
      '⠿',
    );
    handle.title = 'перетащить панель';
    this.dragOn(handle, (dx, dy, s) => {
      if (this.layout.dock === 'side') this.layout.dock = 'float';
      this.layout.x = s.x + dx;
      this.layout.y = s.y + dy;
    });
    this.search = el(
      'input',
      `flex:1 1 auto;min-width:0;height:${TAP}px;box-sizing:border-box;padding:0 10px;` +
        `font:16px system-ui,sans-serif;color:${FG};background:rgba(0,0,0,0.45);` +
        `border:1px solid ${LINE};border-radius:10px;user-select:text;-webkit-user-select:text;`,
    );
    this.search.type = 'search';
    this.search.placeholder = 'поиск…';
    this.search.title = 'поиск по названию, подсказке, группе';
    this.search.enterKeyHint = 'search';
    this.search.addEventListener('input', () => {
      this.view.query = this.search.value;
      this.refilter();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') this.search.blur();
    });
    this.opacityBtn = button('', () => this.cycleOpacity(), 'прозрачность');
    this.opacityBtn.style.padding = '0 6px';
    this.dockBtn = button('', () => this.toggleDock());
    const collapse = button('▴', () => this.setMode('collapsed'), 'свернуть');
    collapse.style.fontSize = '18px';
    bar.append(handle, this.search, this.opacityBtn, this.dockBtn, collapse);

    // Filters and actions.
    // One line even in a narrow window (scrolls sideways) so the header stays two rows.
    const tools = el(
      'div',
      'display:flex;flex-wrap:nowrap;gap:4px;padding:6px;overflow-x:auto;touch-action:pan-x;' +
        'scrollbar-width:none;flex:0 0 auto;',
    );
    this.moreBtn = button(
      'ещё',
      () => {
        this.view.showMore = !this.view.showMore;
        this.saveView();
        this.refilter();
      },
      'показать второстепенные настройки',
    );
    this.changedBtn = button(
      'изменённые',
      () => {
        this.view.onlyChanged = !this.view.onlyChanged;
        this.saveView();
        this.refilter();
      },
      'только изменённые',
    );
    const reset = button('↺ Reset', () => this.resetAll(), 'сбросить всё');
    const more = button('⋯', () => this.toggleIo(), 'экспорт и вставка');
    this.densityBtn = button('', () => this.setDensity(!this.compact));
    tools.append(this.moreBtn, this.changedBtn, reset, more, this.densityBtn);
    this.status = el('div', `display:none;padding:0 8px 6px;font-size:12px;color:${FG};`);

    this.io = el('div', 'display:none;padding:0 6px 6px;');
    this.text = el(
      'textarea',
      'width:100%;box-sizing:border-box;height:72px;font:12px ui-monospace,Menlo,monospace;' +
        `color:${FG};background:rgba(0,0,0,0.6);border:1px solid ${LINE};border-radius:6px;` +
        'user-select:text;-webkit-user-select:text;-webkit-touch-callout:default;touch-action:auto;',
    );
    this.text.id = 'dev-io';
    this.text.spellcheck = false;
    const ioBar = el('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;');
    ioBar.append(
      button('Копировать', () => this.copy(t.serialize(), 'diff'), 'скопировать изменения (JSON)'),
      button('Ссылка', () => this.copy(this.shareUrl(t.serialize()), 'ссылка')),
      button('Вставить', () => this.paste()),
      button('Применить', () => this.applyText()),
      button('Закрыть', () => {
        this.io.style.display = 'none';
      }),
    );
    this.io.append(this.text, ioBar);

    this.list = el(
      'div',
      'flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;' +
        'touch-action:pan-y;overscroll-behavior:contain;padding:0 0 48px;',
    );
    this.pool = el('div', 'display:none;');

    const grip = el(
      'div',
      `position:absolute;right:0;bottom:0;width:${TAP}px;height:${TAP}px;display:flex;` +
        `align-items:flex-end;justify-content:flex-end;padding:4px;box-sizing:border-box;` +
        `color:${DIM};font-size:18px;cursor:nwse-resize;touch-action:none;user-select:none;`,
      '◢',
    );
    grip.title = 'изменить размер';
    this.dragOn(grip, (dx, dy, s) => {
      if (this.layout.dock === 'side') this.layout.dock = 'float';
      this.layout.w = s.w + dx;
      this.layout.h = s.h + dy;
    });

    box.append(bar, tools, this.status, this.io, this.list, grip);
    root.append(box, this.strip, this.tab, this.pool);

    const ctx = this.ctx;
    for (const n of t.numbers) this.addRow(n.path, numberRow(n, this.meta[n.path], ctx));
    for (const f of t.flags) this.addRow(f.path, flagRow(f, this.meta[f.path], ctx));
    this.restorePin();
    this.setDensity(this.compact, false);

    t.onChange((path) => this.onValue(path));
    window.addEventListener('resize', () => {
      if (this.mode !== 'hidden') this.applyLayout();
    });

    parent.appendChild(root);
    this.updateCounter();
    this.refilter();
    this.setMode('hidden');
  }

  get state(): Mode {
    return this.mode;
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.root.style.display = mode === 'hidden' ? 'none' : 'block';
    this.box.style.display = mode === 'open' ? 'flex' : 'none';
    this.tab.style.display = mode === 'collapsed' ? 'block' : 'none';
    const strip = mode === 'collapsed' && this.pinned !== null;
    this.strip.style.display = strip ? 'block' : 'none';
    // With a pinned strip the pill sits just under it.
    this.tab.style.top = strip
      ? `calc(env(safe-area-inset-top) + ${STRIP_H + 4}px)`
      : 'calc(env(safe-area-inset-top) + 4px)';
    if (mode !== 'hidden' && this.layout.collapsed !== (mode === 'collapsed')) {
      this.layout.collapsed = mode === 'collapsed';
      this.saveView();
    }
    if (mode === 'open') this.applyLayout();
  }

  /** ?dev=1: open, unless the author left the panel collapsed last time. */
  show(): void {
    this.setMode(this.hadSavedView && this.layout.collapsed ? 'collapsed' : 'open');
  }

  /** Three-finger tap / backquote: hidden or collapsed -> open, open -> hidden. */
  toggle(): void {
    this.setMode(this.mode === 'open' ? 'hidden' : 'open');
  }

  private model(): 'A' | 'B' | 'C' {
    const m = this.t.get('car.model');
    return m === 2 ? 'C' : m === 1 ? 'B' : 'A';
  }

  private viewport(): Viewport {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const canvas = document.getElementById('game');
    if (canvas === null) return { w, h, gameLeft: 0, gameRight: w };
    const r = canvas.getBoundingClientRect();
    return { w, h, gameLeft: Math.max(0, r.left), gameRight: Math.min(w, r.right) };
  }

  private addRow(path: string, row: Row): void {
    this.rows.set(path, row);
    this.pool.appendChild(row.el);
  }

  private onValue(path: string | null): void {
    if (path === null) for (const r of this.rows.values()) r.update();
    else this.rows.get(path)?.update();
    if (this.pinned !== null && (path === null || path === this.pinned.path))
      this.pinned.row.update();
    this.updateCounter();
    if (path === null || path === 'car.model') {
      this.view.model = this.model();
      this.refilter();
    } else {
      // Membership may change (a changed value is always shown); re-filter after the drag ends.
      if (this.refilterTimer !== null) clearTimeout(this.refilterTimer);
      this.refilterTimer = setTimeout(() => {
        this.refilterTimer = null;
        this.refilter();
      }, REFILTER_MS);
    }
  }

  private changedSet(): Set<string> {
    return new Set(Object.keys(this.t.diff()));
  }

  private updateCounter(): void {
    const n = Object.keys(this.t.diff()).length;
    this.changedBtn.textContent = n > 0 ? `изменённые · ${n}` : 'изменённые';
    const changed = this.changedSet();
    for (const c of this.sectionCounts) {
      const k = c.paths.filter((p) => changed.has(p)).length;
      c.span.textContent = k > 0 ? `изменено ${k}` : '';
    }
    this.tab.textContent = n > 0 ? `dev · ${n}` : 'dev';
    setPressed(this.moreBtn, this.view.showMore);
    setPressed(this.changedBtn, this.view.onlyChanged);
  }

  /** Rebuilds the sections from the view-model; rows are moved, never recreated. */
  private refilter(): void {
    setPressed(this.moreBtn, this.view.showMore);
    setPressed(this.changedBtn, this.view.onlyChanged);
    const sections = buildSections(this.meta, this.view, this.changedSet());
    const key = JSON.stringify(sections);
    if (key === this.shownKey) return;
    this.shownKey = key;
    const used = new Set<string>();
    const sectionCounts: { span: HTMLSpanElement; paths: string[] }[] = [];
    const frag = document.createDocumentFragment();
    for (const s of sections) {
      const d = el('details', `border-top:1px solid ${LINE};`);
      d.open = !this.closed.has(s.id);
      const summary = el(
        'summary',
        `padding:0 10px;height:${SECTION_H}px;display:flex;align-items:center;gap:6px;` +
          `font:700 14px system-ui,sans-serif;cursor:pointer;background:rgba(255,255,255,0.05);` +
          'list-style:none;' +
          (s.id === FAV_ID ? `color:#ffd27a;` : ''),
      );
      const changedCount = el(
        'span',
        `margin-left:auto;font:600 12px system-ui,sans-serif;color:${ACCENT};`,
      );
      sectionCounts.push({ span: changedCount, paths: s.paths });
      summary.append(
        el('span', `color:${DIM};font-size:14px;width:12px;`, d.open ? '▾' : '▸'),
        el('span', '', (s.id === FAV_ID ? '★ ' : '') + s.title),
        el('span', `font-weight:400;font-size:12px;color:${DIM};`, String(s.paths.length)),
        changedCount,
      );
      d.appendChild(summary);
      d.addEventListener('toggle', () => {
        const arrow = summary.firstChild;
        if (arrow !== null) arrow.textContent = d.open ? '▾' : '▸';
        if (d.open) this.closed.delete(s.id);
        else this.closed.add(s.id);
        writeStore(CLOSED_KEY, JSON.stringify([...this.closed]));
      });
      for (const p of s.paths) {
        const row = this.rows.get(p);
        if (row === undefined) continue;
        d.appendChild(row.el);
        used.add(p);
      }
      frag.appendChild(d);
    }
    for (const [p, row] of this.rows) if (!used.has(p)) this.pool.appendChild(row.el);
    this.list.replaceChildren(frag);
    this.sectionCounts = sectionCounts;
    this.updateCounter();
    if (sections.length === 0) {
      const msg =
        this.view.query.trim() !== ''
          ? 'ничего не найдено'
          : this.view.onlyChanged
            ? 'ничего не изменено'
            : 'пусто';
      this.list.appendChild(el('div', `padding:16px;color:${DIM};text-align:center;`, msg));
    }
  }

  private setDensity(compact: boolean, save = true): void {
    this.compact = compact;
    if (save) writeStore(DENSITY_KEY, compact ? 'compact' : 'full');
    this.densityBtn.textContent = compact ? '☰' : '≡';
    this.densityBtn.title = compact
      ? 'показать подсказки у всех'
      : 'компактно: подсказки по нажатию на название';
    this.expanded = null;
    for (const r of this.rows.values()) r.setExpanded(!compact);
  }

  /** Compact: one row's details at a time; full: each row toggles on its own. */
  private toggleExpand(path: string): void {
    const row = this.rows.get(path);
    if (row === undefined) return;
    if (!this.compact) return;
    if (this.expanded !== null && this.expanded !== path)
      this.rows.get(this.expanded)?.setExpanded(false);
    const open = this.expanded !== path;
    row.setExpanded(open);
    this.expanded = open ? path : null;
  }

  private toggleFavourite(path: string): void {
    const f = this.view.favourites;
    this.view.favourites = f.includes(path) ? f.filter((p) => p !== path) : [...f, path];
    this.rows.get(path)?.update();
    this.saveView();
    this.refilter();
  }

  private restorePin(): void {
    const p = readStore(PIN_KEY);
    const n = this.t.numbers.find((x) => x.path === p);
    if (n === undefined) return;
    this.pinned = { path: n.path, row: pinStrip(n, this.meta[n.path], this.ctx) };
    this.strip.replaceChildren(this.pinned.row.el);
  }

  /** One pinned slider at a time; pinning collapses the panel so the game is visible. */
  private pin(path: string | null): void {
    const n = path === null ? undefined : this.t.numbers.find((x) => x.path === path);
    if (n === undefined) {
      this.pinned = null;
      this.strip.replaceChildren();
      writeStore(PIN_KEY, null);
      this.setMode(this.mode);
      return;
    }
    this.pinned = { path: n.path, row: pinStrip(n, this.meta[n.path], this.ctx) };
    this.strip.replaceChildren(this.pinned.row.el);
    writeStore(PIN_KEY, n.path);
    this.setMode('collapsed');
  }

  private saveView(): void {
    writeStore(VIEW_KEY, serializeView(this.view, this.layout));
  }

  /** Clamps to the viewport; a docked panel follows the free side of the game (or floats). */
  private applyLayout(): void {
    const vp = this.viewport();
    const d = defaultLayout(vp);
    if (this.layout.dock === 'side') {
      if (d.dock === 'side')
        this.layout = { ...d, opacity: this.layout.opacity, collapsed: this.layout.collapsed };
      else
        this.layout = {
          ...d,
          opacity: this.layout.opacity,
          collapsed: this.layout.collapsed,
          dock: 'float',
        };
    }
    this.layout = clampLayout(this.layout, vp);
    const l = this.layout;
    const s = this.box.style;
    s.left = `${l.x}px`;
    s.top = `${l.y}px`;
    s.width = `${l.w}px`;
    s.height = `${l.h}px`;
    s.opacity = String(l.opacity);
    this.opacityBtn.textContent = `◐ ${Math.round(l.opacity * 100)}%`;
    const canDock = d.dock === 'side';
    this.dockBtn.style.display = canDock ? '' : 'none';
    this.dockBtn.textContent = l.dock === 'side' ? 'окно' : 'сбоку';
    this.dockBtn.title =
      l.dock === 'side' ? 'открепить в плавающее окно' : 'прикрепить сбоку от игры';
  }

  private toggleDock(): void {
    const vp = this.viewport();
    if (this.layout.dock === 'side') {
      // Float in the middle of the game, about the size of the phone default.
      const w = Math.min(380, vp.w - 16);
      this.layout = {
        ...this.layout,
        dock: 'float',
        x: (vp.gameLeft + vp.gameRight - w) / 2,
        y: 8,
        w,
        h: Math.round(vp.h * 0.45),
      };
    } else this.layout = { ...this.layout, dock: 'side' };
    this.applyLayout();
    this.saveView();
  }

  private cycleOpacity(): void {
    const cur = this.layout.opacity;
    let i = OPACITY_STEPS.findIndex((o) => o < cur - 1e-6);
    if (i < 0) i = 0;
    this.layout.opacity = OPACITY_STEPS[i]!;
    this.applyLayout();
    this.saveView();
  }

  /** Pointer drag with capture on `handle`; `move` gets the offset and the layout at the start. */
  private dragOn(
    handle: HTMLElement,
    move: (dx: number, dy: number, start: PanelLayout) => void,
  ): void {
    let id: number | null = null;
    let sx = 0;
    let sy = 0;
    let start: PanelLayout = this.layout;
    handle.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      start = { ...this.layout };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      move(e.clientX - sx, e.clientY - sy, start);
      this.applyLayout();
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      id = null;
      this.saveView();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  private resetAll(): void {
    const before = this.t.serialize();
    this.t.reset();
    if (before === '{}') {
      this.say('всё и так по умолчанию', false);
      return;
    }
    this.undoJson = before;
    this.say('всё сброшено к значениям из src/data', true);
  }

  /** Status line; with `undo` it offers to bring back the values before the last reset. */
  private say(msg: string, undo = false): void {
    this.status.replaceChildren(el('span', '', msg));
    if (undo && this.undoJson !== null) {
      const json = this.undoJson;
      const b = button('вернуть', () => {
        this.t.apply(json);
        this.undoJson = null;
        this.say('значения возвращены');
      });
      b.style.cssText += `margin-left:8px;height:32px;min-height:32px;color:${ACCENT};`;
      this.status.appendChild(b);
    }
    this.status.style.display = 'block';
  }

  private toggleIo(): void {
    this.io.style.display = this.io.style.display === 'none' ? 'block' : 'none';
    if (this.io.style.display === 'block' && this.text.value === '')
      this.text.value = this.t.serialize();
  }

  private showIo(value: string): void {
    this.io.style.display = 'block';
    this.text.value = value;
  }

  /** Clipboard API needs a secure context (not plain-http LAN); the textarea is the fallback. */
  private copy(value: string, what: string): void {
    this.showIo(value);
    this.text.select();
    const done = (): void => this.say(`${what} скопирован(а) в буфер`);
    const manual = (): void => {
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      if (ok) done();
      else this.say(`${what}: скопируйте из поля вручную`);
    };
    const clip = navigator.clipboard as Clipboard | undefined;
    if (clip?.writeText) clip.writeText(value).then(done, manual);
    else manual();
  }

  private paste(): void {
    this.showIo('');
    this.say('вставьте diff JSON или ссылку и нажмите «Применить»');
    this.text.focus();
    const clip = navigator.clipboard as Clipboard | undefined;
    if (clip?.readText)
      clip.readText().then(
        (v) => {
          if (v.trim() !== '') this.text.value = v;
        },
        () => undefined,
      );
  }

  private applyText(): void {
    let json = this.text.value.trim();
    // A shared link works too: take its ?tune= parameter.
    if (/^https?:\/\//.test(json)) {
      try {
        json = new URL(json).searchParams.get('tune') ?? '';
      } catch {
        json = '';
      }
    }
    if (json === '') json = '{}';
    try {
      const rejected = this.t.apply(json);
      this.say(
        rejected.length === 0 ? 'применено' : `применено, пропущено: ${rejected.join(', ')}`,
      );
    } catch (e) {
      this.say(`не JSON-объект: ${String(e)}`);
    }
    this.text.blur();
  }
}

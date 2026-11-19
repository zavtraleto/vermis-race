import type { PanelItemMeta } from './panelModel';
import {
  ACCENT,
  BUTTON_CSS,
  CHANGED_BG,
  DIM,
  FG,
  LINE,
  TAP,
  button,
  decimals,
  el,
  setPressed,
} from './panelDom';
import type { FlagTunable, NumberTunable, Tunables } from './tunables';

/** What a row needs from the panel around it. */
export interface RowContext {
  readonly t: Tunables;
  isFavourite(path: string): boolean;
  toggleFavourite(path: string): void;
  /** Pins one slider as a strip at the top edge (null = nothing pinned). */
  pin(path: string | null): void;
}

export interface Row {
  readonly el: HTMLElement;
  /** Re-reads the value (and the favourite star). */
  update(): void;
}

function fmt(v: number, dec: number): string {
  return v.toFixed(dec);
}

function footText(path: string, m: PanelItemMeta | undefined): string {
  const parts = [path];
  if (m?.rule !== undefined) parts.push(m.rule);
  if (m?.model !== undefined) parts.push(`только модель ${m.model}`);
  return parts.join(' · ');
}

const ROW_CSS =
  'display:grid;grid-template-columns:minmax(0,1fr) auto auto auto auto;column-gap:4px;' +
  `row-gap:2px;align-items:center;padding:8px 6px 8px 8px;border-left:3px solid transparent;` +
  `border-top:1px solid rgba(255,255,255,0.06);`;
const TITLE_CSS = `grid-area:1/1/2/2;font:600 15px/1.2 system-ui,sans-serif;color:${FG};min-width:0;`;
const HINT_CSS = `grid-column:1/-1;font:12px/1.3 system-ui,sans-serif;color:${FG};opacity:0.78;`;
const FOOT_CSS = `grid-column:1/-1;font:11px/1.3 ui-monospace,Menlo,monospace;color:${DIM};`;
const ICON_CSS = BUTTON_CSS + `width:${TAP}px;padding:0;font-size:17px;background:transparent;`;
const RELOAD_CSS =
  `display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;font:600 11px system-ui,sans-serif;` +
  `color:#ffd27a;border:1px solid #806a3a;`;

/** Title, favourite / pin / reset icons, hint and the grey path line: shared by every row kind. */
function frame(
  path: string,
  m: PanelItemMeta | undefined,
  ctx: RowContext,
  reset: () => void,
  pinnable: boolean,
): {
  row: HTMLDivElement;
  fav: HTMLButtonElement;
  foot: HTMLDivElement;
  def: HTMLSpanElement;
  place(control: HTMLElement): void;
} {
  const row = el('div', ROW_CSS);
  row.dataset.path = path;
  const title = el('div', TITLE_CSS, m?.title ?? path);
  if (m?.reload === true) title.appendChild(el('span', RELOAD_CSS, 'после перезагрузки'));
  const fav = button('☆', () => ctx.toggleFavourite(path), 'в избранное');
  fav.style.cssText = ICON_CSS + 'grid-area:1/2/2/3;';
  const pin = button('📌', () => ctx.pin(path), 'закрепить сверху');
  pin.style.cssText = ICON_CSS + 'grid-area:1/3/2/4;';
  if (!pinnable) pin.style.visibility = 'hidden';
  const back = button('↺', reset, 'вернуть значение по умолчанию');
  back.style.cssText = ICON_CSS + 'grid-area:1/4/2/5;';
  const hint = el('div', HINT_CSS, m?.hint ?? '');
  const foot = el('div', FOOT_CSS, footText(path, m));
  const def = el('span', `color:${ACCENT};margin-left:6px;`);
  foot.appendChild(def);
  row.append(title, fav, pin, back);
  return {
    row,
    fav,
    foot,
    def,
    place(control: HTMLElement): void {
      row.append(control, hint, foot);
    },
  };
}

function star(b: HTMLButtonElement, on: boolean): void {
  b.textContent = on ? '★' : '☆';
  b.style.color = on ? '#ffd27a' : DIM;
}

function markChanged(row: HTMLElement, back: HTMLSpanElement, changed: boolean, def: string): void {
  row.style.background = changed ? CHANGED_BG : 'transparent';
  row.style.borderLeftColor = changed ? ACCENT : 'transparent';
  back.textContent = changed ? `по умолч. ${def}` : '';
}

/** Segmented buttons (values of a small switch). */
function segmented(
  labels: readonly string[],
  onPick: (i: number) => void,
): { el: HTMLDivElement; set(i: number): void } {
  const wrap = el('div', 'grid-column:1/-1;display:flex;gap:4px;flex-wrap:wrap;');
  const bs = labels.map((label, i) => {
    const b = button(label, () => onPick(i));
    b.style.flex = '1 1 0';
    wrap.appendChild(b);
    return b;
  });
  return {
    el: wrap,
    set(i: number): void {
      bs.forEach((b, k) => setPressed(b, k === i));
    },
  };
}

export function numberRow(n: NumberTunable, m: PanelItemMeta | undefined, ctx: RowContext): Row {
  const t = ctx.t;
  const options = m?.options;
  // A 0/1 (or few-step) integer switch with labelled values renders as segmented buttons.
  if (options !== undefined && options.length === Math.round((n.max - n.min) / n.step) + 1) {
    const f = frame(n.path, m, ctx, () => t.set(n.path, n.default), false);
    const seg = segmented(options, (i) => t.set(n.path, n.min + i * n.step));
    f.place(seg.el);
    const label = (v: number): string => options[Math.round((v - n.min) / n.step)] ?? String(v);
    const update = (): void => {
      seg.set(Math.round((n.value - n.min) / n.step));
      markChanged(f.row, f.def, n.value !== n.default, label(n.default));
      star(f.fav, ctx.isFavourite(n.path));
    };
    update();
    return { el: f.row, update };
  }

  const dec = decimals(n.step);
  const f = frame(n.path, m, ctx, () => t.set(n.path, n.default), true);
  const nudge = (dir: number): void => {
    t.set(n.path, Number((n.value + dir * n.step).toFixed(dec)));
  };
  const ctrl = el('div', 'grid-column:1/-1;display:flex;align-items:center;gap:6px;');
  const minus = button('−', () => nudge(-1), 'меньше на шаг');
  const plus = button('+', () => nudge(1), 'больше на шаг');
  minus.style.fontSize = plus.style.fontSize = '20px';
  minus.style.width = plus.style.width = '52px';
  const range = el(
    'input',
    `flex:1 1 auto;min-width:0;height:${TAP}px;margin:0;accent-color:${ACCENT};touch-action:pan-y;`,
  );
  range.type = 'range';
  range.min = String(n.min);
  range.max = String(n.max);
  range.step = String(n.step);
  range.addEventListener('input', () => t.set(n.path, Number(range.value)));
  range.addEventListener('change', () => range.blur());
  ctrl.append(minus, range, plus);
  f.place(ctrl);

  // Current value: tap to type a number. Kept as the row's last button.
  const value = el(
    'button',
    BUTTON_CSS +
      'grid-area:1/5/2/6;min-width:76px;padding:0 6px;font:700 15px ui-monospace,Menlo,monospace;',
  );
  value.type = 'button';
  value.title = 'ввести число';
  const edit = el(
    'input',
    `grid-area:1/5/2/6;display:none;width:84px;height:${TAP}px;box-sizing:border-box;` +
      `font:700 15px ui-monospace,Menlo,monospace;color:#fff;background:#000;` +
      `border:1px solid ${ACCENT};border-radius:10px;padding:0 6px;user-select:text;-webkit-user-select:text;`,
  );
  edit.type = 'text';
  edit.inputMode = 'decimal';
  edit.enterKeyHint = 'done';
  let editing = false;
  const finish = (commit: boolean): void => {
    if (!editing) return;
    editing = false;
    const v = Number(edit.value.trim().replace(',', '.'));
    edit.style.display = 'none';
    value.style.display = '';
    if (commit && edit.value.trim() !== '' && Number.isFinite(v)) t.set(n.path, v);
    edit.blur();
  };
  value.addEventListener('click', () => {
    editing = true;
    edit.value = fmt(n.value, dec);
    value.style.display = 'none';
    edit.style.display = 'block';
    edit.focus();
    edit.select();
  });
  edit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  edit.addEventListener('blur', () => finish(true));
  f.row.append(edit, value);

  const update = (): void => {
    const v = n.value;
    range.value = String(v);
    value.textContent = fmt(v, dec);
    const changed = v !== n.default;
    value.style.borderColor = changed ? ACCENT : LINE;
    value.style.color = changed ? '#fff' : FG;
    markChanged(f.row, f.def, changed, fmt(n.default, dec));
    star(f.fav, ctx.isFavourite(n.path));
  };
  update();
  return { el: f.row, update };
}

const SELECT_CSS =
  `grid-column:1/-1;height:${TAP}px;width:100%;font:600 15px system-ui,sans-serif;color:${FG};` +
  `background:rgba(90,90,96,0.5);border:1px solid ${LINE};border-radius:10px;padding:0 8px;`;

/** Up to two options: segmented buttons; more: a native select (a wheel picker on iOS). */
export function flagRow(fl: FlagTunable, m: PanelItemMeta | undefined, ctx: RowContext): Row {
  const t = ctx.t;
  const f = frame(fl.path, m, ctx, () => t.set(fl.path, fl.default), false);
  let set: (v: string) => void;
  if (fl.options.length <= 2) {
    const seg = segmented(fl.options, (i) => t.set(fl.path, fl.options[i]!));
    f.place(seg.el);
    set = (v) => seg.set(fl.options.indexOf(v));
  } else {
    const select = el('select', SELECT_CSS);
    for (const o of fl.options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      t.set(fl.path, select.value);
      select.blur();
    });
    f.place(select);
    set = (v) => {
      select.value = v;
    };
  }
  const update = (): void => {
    set(fl.value);
    markChanged(f.row, f.def, fl.value !== fl.default, fl.default);
    star(f.fav, ctx.isFavourite(fl.path));
  };
  update();
  return { el: f.row, update };
}

/** The pinned one-slider strip: − [title, value / slider] + and unpin. */
export function pinStrip(n: NumberTunable, m: PanelItemMeta | undefined, ctx: RowContext): Row {
  const t = ctx.t;
  const dec = decimals(n.step);
  const strip = el(
    'div',
    'display:flex;align-items:center;gap:4px;padding:2px 4px;box-sizing:border-box;height:100%;',
  );
  strip.dataset.pin = n.path;
  const mid = el('div', 'flex:1 1 auto;min-width:0;display:flex;flex-direction:column;');
  const top = el(
    'div',
    `display:flex;gap:6px;align-items:baseline;font:600 12px/1.2 system-ui,sans-serif;color:${FG};`,
  );
  const name = el(
    'span',
    'flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;',
    m?.title ?? n.path,
  );
  const val = el('span', 'font:700 13px ui-monospace,Menlo,monospace;');
  top.append(name, val);
  const range = el(
    'input',
    `width:100%;height:32px;margin:0;accent-color:${ACCENT};touch-action:none;`,
  );
  range.type = 'range';
  range.min = String(n.min);
  range.max = String(n.max);
  range.step = String(n.step);
  range.addEventListener('input', () => t.set(n.path, Number(range.value)));
  range.addEventListener('change', () => range.blur());
  mid.append(top, range);
  const nudge = (dir: number): void => {
    t.set(n.path, Number((n.value + dir * n.step).toFixed(dec)));
  };
  const minus = button('−', () => nudge(-1), 'меньше на шаг');
  const plus = button('+', () => nudge(1), 'больше на шаг');
  minus.style.fontSize = plus.style.fontSize = '20px';
  const close = button('✕', () => ctx.pin(null), 'открепить');
  close.style.background = 'transparent';
  strip.append(minus, mid, plus, close);
  const update = (): void => {
    range.value = String(n.value);
    val.textContent = fmt(n.value, dec);
    val.style.color = n.value !== n.default ? ACCENT : '#fff';
  };
  update();
  return { el: strip, update };
}

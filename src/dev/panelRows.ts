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
  /** Tap on a row title: open its details (one row at a time in compact density). */
  toggleExpand(path: string): void;
}

export interface Row {
  readonly el: HTMLElement;
  /** Re-reads the value (and the favourite star). */
  update(): void;
  /** Shows or hides the details: hint, path line, favourite / pin / reset buttons. */
  setExpanded(on: boolean): void;
}

const GOLD = '#ffd27a';
/** Line 1 (title + value) height; line 2 holds the 44 px controls: 30 + 44 + 4 = 78 px per row. */
const LINE1 = 30;

function fmt(v: number, dec: number): string {
  return v.toFixed(dec);
}

function footText(path: string, m: PanelItemMeta | undefined): string {
  const parts = [path];
  if (m?.rule !== undefined) parts.push(m.rule);
  return parts.join(' · ');
}

const ROW_CSS =
  'display:grid;grid-template-columns:minmax(0,1fr) auto auto;column-gap:6px;align-items:center;' +
  'padding:2px 6px 2px 5px;border-left:3px solid transparent;' +
  'border-top:1px solid rgba(255,255,255,0.06);';
const TITLE_CSS =
  `grid-area:1/1/2/2;height:${LINE1}px;min-width:0;display:flex;align-items:center;gap:5px;` +
  `font:600 14px system-ui,sans-serif;color:${FG};cursor:pointer;`;
const TEXT_CSS = 'min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;';
const WAS_CSS = `grid-area:1/3/2/4;font:12px ui-monospace,Menlo,monospace;color:${ACCENT};white-space:nowrap;`;
const DETAILS_CSS = 'grid-column:1/-1;display:none;padding:2px 0 6px;';
const HINT_CSS = `font:13px/1.3 system-ui,sans-serif;color:${FG};opacity:0.85;`;
const FOOT_CSS = `margin-top:3px;font:11px/1.3 ui-monospace,Menlo,monospace;color:${DIM};`;
const RELOAD_CSS =
  'display:inline-block;margin-top:4px;padding:0 5px;border-radius:4px;' +
  `font:600 11px system-ui,sans-serif;color:${GOLD};border:1px solid #806a3a;`;

interface Frame {
  row: HTMLDivElement;
  /** Puts the line-2 control and the details in place (before the value, which stays last). */
  place(control: HTMLElement): void;
  /** Marks the row changed (dot, tint, «было …») and refreshes the favourite stars. */
  mark(changed: boolean, def: string): void;
  setExpanded(on: boolean): void;
}

/** Title line, «было …», expandable details: shared by every row kind. */
function frame(
  path: string,
  m: PanelItemMeta | undefined,
  ctx: RowContext,
  reset: () => void,
  pinnable: boolean,
): Frame {
  const row = el('div', ROW_CSS);
  row.dataset.path = path;
  const title = el('div', TITLE_CSS);
  title.title = 'подробнее';
  const dot = el(
    'span',
    `flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:${ACCENT};display:none;`,
  );
  const favMark = el('span', `flex:0 0 auto;color:${GOLD};display:none;`, '★');
  const text = el('span', TEXT_CSS, m?.title ?? path);
  title.append(dot, favMark, text);
  if (m?.reload === true) {
    const r = el('span', `flex:0 0 auto;color:${GOLD};font-size:13px;`, '⟳');
    r.title = 'после перезагрузки';
    title.appendChild(r);
  }
  title.addEventListener('click', () => ctx.toggleExpand(path));
  const was = el('span', WAS_CSS);

  const details = el('div', DETAILS_CSS);
  details.appendChild(el('div', HINT_CSS, m?.hint ?? ''));
  if (m?.reload === true) details.appendChild(el('div', RELOAD_CSS, 'после перезагрузки'));
  details.appendChild(el('div', FOOT_CSS, footText(path, m)));
  const actions = el('div', 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;');
  const fav = button('', () => ctx.toggleFavourite(path));
  actions.appendChild(fav);
  if (pinnable)
    actions.appendChild(button('📌 закрепить', () => ctx.pin(path), 'закрепить сверху'));
  actions.appendChild(button('↺ по умолчанию', reset, 'вернуть значение по умолчанию'));
  details.appendChild(actions);

  row.append(title, was);
  return {
    row,
    place(control: HTMLElement): void {
      row.append(control, details);
    },
    mark(changed: boolean, def: string): void {
      row.style.background = changed ? CHANGED_BG : 'transparent';
      row.style.borderLeftColor = changed ? ACCENT : 'transparent';
      dot.style.display = changed ? 'block' : 'none';
      was.textContent = changed ? `· было ${def}` : '';
      const isFav = ctx.isFavourite(path);
      favMark.style.display = isFav ? 'inline' : 'none';
      fav.textContent = isFav ? '★ убрать из избранного' : '☆ в избранное';
      fav.style.color = isFav ? GOLD : FG;
    },
    setExpanded(on: boolean): void {
      details.style.display = on ? 'block' : 'none';
      title.style.color = on ? '#fff' : FG;
    },
  };
}

/** Segmented buttons (values of a small switch). */
function segmented(
  labels: readonly string[],
  onPick: (i: number) => void,
): { el: HTMLDivElement; set(i: number): void } {
  const wrap = el('div', 'grid-column:1/-1;display:flex;gap:4px;');
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

function range(n: NumberTunable, t: Tunables, css: string): HTMLInputElement {
  const r = el('input', `margin:0;accent-color:${ACCENT};` + css);
  r.type = 'range';
  r.min = String(n.min);
  r.max = String(n.max);
  r.step = String(n.step);
  r.addEventListener('input', () => t.set(n.path, Number(r.value)));
  r.addEventListener('change', () => r.blur());
  return r;
}

function stepButtons(n: NumberTunable, t: Tunables): [HTMLButtonElement, HTMLButtonElement] {
  const dec = decimals(n.step);
  const nudge = (dir: number): void => {
    t.set(n.path, Number((n.value + dir * n.step).toFixed(dec)));
  };
  const minus = button('−', () => nudge(-1), 'меньше на шаг');
  const plus = button('+', () => nudge(1), 'больше на шаг');
  minus.style.fontSize = plus.style.fontSize = '20px';
  minus.style.width = plus.style.width = '52px';
  return [minus, plus];
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
      f.mark(n.value !== n.default, label(n.default));
    };
    update();
    return { el: f.row, update, setExpanded: f.setExpanded };
  }

  const dec = decimals(n.step);
  const f = frame(n.path, m, ctx, () => t.set(n.path, n.default), true);
  const ctrl = el('div', 'grid-column:1/-1;display:flex;align-items:center;gap:6px;');
  const [minus, plus] = stepButtons(n, t);
  const slider = range(n, t, `flex:1 1 auto;min-width:0;height:${TAP}px;touch-action:pan-y;`);
  ctrl.append(minus, slider, plus);
  f.place(ctrl);

  // Current value: tap to type a number. Kept as the row's last button.
  const value = el(
    'button',
    BUTTON_CSS +
      `grid-area:1/2/2/3;height:${LINE1}px;min-width:64px;padding:0 6px;` +
      'font:700 15px ui-monospace,Menlo,monospace;',
  );
  value.type = 'button';
  value.title = 'ввести число';
  const edit = el(
    'input',
    `grid-area:1/2/2/3;display:none;width:80px;height:${LINE1}px;box-sizing:border-box;` +
      'font:700 16px ui-monospace,Menlo,monospace;color:#fff;background:#000;' +
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
    slider.value = String(v);
    value.textContent = fmt(v, dec);
    const changed = v !== n.default;
    value.style.borderColor = changed ? ACCENT : LINE;
    value.style.color = changed ? '#fff' : FG;
    f.mark(changed, fmt(n.default, dec));
  };
  update();
  return { el: f.row, update, setExpanded: f.setExpanded };
}

const SELECT_CSS =
  `grid-column:1/-1;height:${TAP}px;width:100%;font:600 16px system-ui,sans-serif;color:${FG};` +
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
    f.mark(fl.value !== fl.default, fl.default);
  };
  update();
  return { el: f.row, update, setExpanded: f.setExpanded };
}

/** The pinned one-slider strip: − [title, value «было …» / slider] + and unpin. */
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
  const name = el('span', 'flex:1 1 auto;' + TEXT_CSS, m?.title ?? n.path);
  const val = el('span', 'font:700 13px ui-monospace,Menlo,monospace;');
  const was = el(
    'span',
    `font:11px ui-monospace,Menlo,monospace;color:${ACCENT};white-space:nowrap;`,
  );
  top.append(name, val, was);
  const slider = range(n, t, 'width:100%;height:32px;touch-action:none;');
  mid.append(top, slider);
  const [minus, plus] = stepButtons(n, t);
  minus.style.width = plus.style.width = `${TAP}px`;
  const close = button('✕', () => ctx.pin(null), 'открепить');
  close.style.background = 'transparent';
  strip.append(minus, mid, plus, close);
  const update = (): void => {
    const changed = n.value !== n.default;
    slider.value = String(n.value);
    val.textContent = fmt(n.value, dec);
    val.style.color = changed ? ACCENT : '#fff';
    was.textContent = changed ? `было ${fmt(n.default, dec)}` : '';
  };
  update();
  return { el: strip, update, setExpanded: () => undefined };
}

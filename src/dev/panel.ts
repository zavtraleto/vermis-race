import type { FlagTunable, NumberTunable, Tunables } from './tunables';

/**
 * Dev tuning panel (DOM). Top of the screen, semi-transparent, thumb-sized controls, so the
 * steering zone at the bottom stays free and the road stays visible. Collapses to a small tab.
 * Pointer/touch/key events that start on the panel never reach the game's document/window
 * listeners (steering, keyboard, iOS gesture blockers).
 */

const BG = 'rgba(12, 12, 18, 0.72)';
const FG = '#d8d8d8';
const ACCENT = '#c0283c';
const LINE = '#5a5a5e';
const BTN_H = '44px';

type Mode = 'hidden' | 'open' | 'collapsed';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

const BUTTON_CSS =
  `min-width:${BTN_H};height:${BTN_H};padding:0 10px;font:600 14px system-ui,sans-serif;` +
  `color:${FG};background:rgba(90,90,94,0.55);border:1px solid ${LINE};border-radius:8px;` +
  'touch-action:manipulation;flex:0 0 auto;';

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', BUTTON_CSS, label);
  b.type = 'button';
  b.addEventListener('click', () => {
    onClick();
    // Keep keyboard focus off the panel so Space/arrows keep driving.
    b.blur();
  });
  return b;
}

function decimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

// Events that the game listens for on document/window; stopped at the panel root.
const ISOLATED = [
  'pointerdown',
  'touchmove',
  'contextmenu',
  'dblclick',
  'gesturestart',
] as const;

export class DevPanel {
  private readonly root: HTMLDivElement;
  private readonly main: HTMLDivElement;
  private readonly tab: HTMLButtonElement;
  private readonly io: HTMLDivElement;
  private readonly text: HTMLTextAreaElement;
  private readonly status: HTMLDivElement;
  private readonly rows = new Map<string, () => void>();
  private mode: Mode = 'hidden';

  constructor(
    parent: HTMLElement,
    private readonly t: Tunables,
    private readonly shareUrl: (json: string) => string,
  ) {
    const root = el(
      'div',
      'position:fixed;top:0;left:0;right:0;margin:0 auto;max-width:440px;z-index:20;' +
        'box-sizing:border-box;padding-top:env(safe-area-inset-top);' +
        `font:14px/1.25 system-ui,sans-serif;color:${FG};pointer-events:none;`,
    );
    root.id = 'dev-panel';
    for (const type of ISOLATED) root.addEventListener(type, (e) => e.stopPropagation());
    // Typing in the textarea must not steer (the keyboard model preventDefaults A/D/S/arrows/space).
    const stopTyping = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLTextAreaElement) e.stopPropagation();
    };
    root.addEventListener('keydown', stopTyping);
    root.addEventListener('keyup', stopTyping);
    this.root = root;

    // Collapsed state: only this tab takes input (top-right corner, outside the steering zone).
    this.tab = button('dev', () => this.setMode('open'));
    this.tab.id = 'dev-tab';
    this.tab.style.cssText += `position:absolute;right:6px;top:6px;background:${BG};pointer-events:auto;`;
    root.appendChild(this.tab);

    const main = el('div', `background:${BG};pointer-events:auto;border-bottom:1px solid ${LINE};`);
    this.main = main;
    root.appendChild(main);

    const bar = el('div', 'display:flex;gap:6px;padding:6px;overflow-x:auto;');
    bar.append(
      button('▴', () => this.setMode('collapsed')),
      button('Reset', () => {
        t.reset();
        this.say('сброшено к значениям из src/data');
      }),
      button('Copy', () => this.copy(t.serialize(), 'diff')),
      button('Link', () => this.copy(this.shareUrl(t.serialize()), 'ссылка')),
      button('Paste', () => this.paste()),
    );
    main.appendChild(bar);

    this.io = el('div', 'display:none;padding:0 6px 6px;');
    this.text = el(
      'textarea',
      'width:100%;box-sizing:border-box;height:72px;font:12px ui-monospace,Menlo,monospace;' +
        `color:${FG};background:rgba(0,0,0,0.6);border:1px solid ${LINE};border-radius:6px;` +
        'user-select:text;-webkit-user-select:text;-webkit-touch-callout:default;touch-action:auto;',
    );
    this.text.id = 'dev-io';
    this.text.spellcheck = false;
    const ioBar = el('div', 'display:flex;gap:6px;margin-top:6px;');
    ioBar.append(
      button('Apply', () => this.applyText()),
      button('Close', () => {
        this.io.style.display = 'none';
      }),
    );
    this.status = el('div', 'min-height:18px;padding:4px 2px 0;font-size:12px;opacity:0.85;');
    this.io.append(this.text, ioBar, this.status);
    main.appendChild(this.io);

    const list = el(
      'div',
      'max-height:calc(55vh - 56px);overflow-y:auto;-webkit-overflow-scrolling:touch;' +
        'touch-action:pan-y;overscroll-behavior:contain;padding:0 6px 6px;',
    );
    this.build(list);
    main.appendChild(list);

    t.onChange((path) => {
      if (path === null) for (const update of this.rows.values()) update();
      else this.rows.get(path)?.();
    });

    parent.appendChild(root);
    this.setMode('hidden');
  }

  get state(): Mode {
    return this.mode;
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.root.style.display = mode === 'hidden' ? 'none' : 'block';
    this.main.style.display = mode === 'open' ? 'block' : 'none';
    this.tab.style.display = mode === 'collapsed' ? 'block' : 'none';
  }

  /** Three-finger tap / backquote: hidden or collapsed -> open, open -> hidden. */
  toggle(): void {
    this.setMode(this.mode === 'open' ? 'hidden' : 'open');
  }

  private build(list: HTMLElement): void {
    const sections = new Map<string, HTMLElement>();
    const section = (name: string): HTMLElement => {
      let body = sections.get(name);
      if (body !== undefined) return body;
      const d = el('details', `border-top:1px solid ${LINE};`);
      d.open = true;
      const s = el('summary', 'padding:10px 2px;font-weight:700;cursor:pointer;', name);
      d.appendChild(s);
      body = el('div', '');
      d.appendChild(body);
      list.appendChild(d);
      sections.set(name, body);
      return body;
    };
    for (const n of this.t.numbers) section(n.section).appendChild(this.numberRow(n));
    for (const f of this.t.flags) section(f.section).appendChild(this.flagRow(f));
  }

  private numberRow(n: NumberTunable): HTMLElement {
    const dec = decimals(n.step);
    const row = el('div', 'padding:4px 0 8px;');
    row.dataset.path = n.path;
    const label = el('div', 'font-size:12px;opacity:0.85;padding-bottom:2px;', n.label);
    const line = el('div', 'display:flex;align-items:center;gap:6px;');
    const range = el(
      'input',
      'flex:1 1 auto;min-width:0;height:44px;margin:0;accent-color:' +
        ACCENT +
        ';touch-action:pan-y;',
    );
    range.type = 'range';
    range.min = String(n.min);
    range.max = String(n.max);
    range.step = String(n.step);
    // Tap on the readout = back to the default.
    const out = el(
      'button',
      BUTTON_CSS + 'min-width:68px;font:600 14px ui-monospace,Menlo,monospace;padding:0 4px;',
    );
    out.type = 'button';
    const nudge = (dir: number): void => {
      this.t.set(n.path, Number((n.value + dir * n.step).toFixed(dec)));
    };
    range.addEventListener('input', () => this.t.set(n.path, Number(range.value)));
    range.addEventListener('change', () => range.blur());
    out.addEventListener('click', () => this.t.set(n.path, n.default));
    line.append(
      button('−', () => nudge(-1)),
      range,
      button('+', () => nudge(1)),
      out,
    );
    row.append(label, line);

    const update = (): void => {
      const v = n.value;
      range.value = String(v);
      out.textContent = v.toFixed(dec);
      const changed = v !== n.default;
      out.style.color = changed ? '#fff' : FG;
      out.style.borderColor = changed ? ACCENT : LINE;
      out.title = `default ${n.default}`;
    };
    update();
    this.rows.set(n.path, update);
    return row;
  }

  private flagRow(f: FlagTunable): HTMLElement {
    const row = el('div', 'display:flex;align-items:center;gap:8px;padding:4px 0;');
    row.dataset.path = f.path;
    const label = el('div', 'flex:1 1 auto;font-size:13px;', f.label);
    const select = el(
      'select',
      `height:${BTN_H};min-width:96px;font:600 14px system-ui,sans-serif;color:${FG};` +
        `background:rgba(90,90,94,0.55);border:1px solid ${LINE};border-radius:8px;`,
    );
    for (const o of f.options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      this.t.set(f.path, select.value);
      // Nothing reads the flags live yet (H2 is resolved once at start-up).
      console.info(`dev: ${f.path} = ${select.value} (no live consumer yet)`);
      select.blur();
    });
    row.append(label, select);
    const update = (): void => {
      select.value = f.value;
      select.style.borderColor = f.value !== f.default ? ACCENT : LINE;
    };
    update();
    this.rows.set(f.path, update);
    return row;
  }

  private say(msg: string): void {
    this.status.textContent = msg;
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
    this.say('вставьте diff JSON или ссылку и нажмите Apply');
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
  }
}

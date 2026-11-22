import type { GamePhase } from '../app/gameFlow';
import type { TouchDrift } from '../app/touchDriftPref';
import { HudFontFit, hudEm, type HudLayout } from './speedometer';

/** What the R95 overlay asks the game to do. */
export interface MenuActions {
  start(): void;
  pause(): void;
  resume(): void;
  restart(): void;
  /** A drift mode was picked (start screen or pause). */
  mode(m: TouchDrift): void;
}

const MODES: readonly TouchDrift[] = ['A', 'B', 'C'];
// R81h names and one-line descriptions of the touch drift modes.
const MODE_NAME: Record<TouchDrift, string> = { A: 'Рывок вбок', B: 'Вниз', C: 'Нижняя зона' };
const MODE_LINE: Record<TouchDrift, string> = {
  A: 'коснись и сразу рвани вбок',
  B: 'потяни палец вниз',
  C: 'коснись в нижней половине зоны',
};
// R95 start screen: how to drive with the current mode.
const CONTROLS: Record<TouchDrift, string> = {
  A: 'Коснись и сразу рвани вбок — дрифт. Отпусти — выход. Коснись и веди плавно — обычный руль',
  B: 'Веди пальцем вбок — руль. Потяни вниз — дрифт. Отпусти — выход',
  C: 'Нижняя половина зоны — дрифт, верхняя — обычный руль. Отпусти — выход',
};
const KEYBOARD = 'Клавиатура: стрелки — руль, пробел — дрифт';
// R151 (model C, H14 = C): one way to drift, the H19 choice is hidden.
const CONTROLS_C =
  'Веди пальцем вбок — руль. Потяни вниз и поверни — дрифт. В дрифте: вбок — угол, вверх — шире, вниз — круче. Отпусти — машина выпрямится.';
const KEYBOARD_C =
  'Клавиатура: стрелки влево/вправо — руль, вниз + поворот — дрифт, вверх/вниз в дрифте — шире/круче';

// Look of the HUD plates (docs/art-bible.md "HUD", as the leaderboard): flat dark plates with cut
// corners and a hard grey edge, monospace heavy type, the warning yellow for the main action and the
// selected drift mode (as an edge). Every touch target is at least 3em (>= 44 CSS px at 360 px width).
const STYLE = `
#menu,#pause-btn{position:fixed;z-index:15;font-family:ui-monospace,"Lucida Console",Consolas,
monospace;font-weight:900;color:#e8e8e8;line-height:1.15;-webkit-font-smoothing:none;
font-smooth:never;-webkit-text-size-adjust:100%;text-size-adjust:100%;-webkit-text-zoom:reset;
touch-action:none;user-select:none;-webkit-user-select:none}
#menu{display:none;flex-direction:column;align-items:center;justify-content:center;
background:rgba(12,12,18,0.78);box-sizing:border-box}
#menu .plate{width:20em;box-sizing:border-box;background:rgba(28,28,34,0.94);
border-left:0.25em solid #8a8a92;padding:1em 1em 1.1em 1em;display:none;flex-direction:column;gap:0.6em;
clip-path:polygon(0 0,calc(100% - 1.1em) 0,100% 1.1em,100% 100%,0.45em 100%,0 calc(100% - 0.45em))}
#menu .title{font-size:2em;letter-spacing:0.08em;text-align:center;color:#ffe14a;margin-bottom:0.1em}
#menu .head{font-size:1.2em;text-transform:uppercase;letter-spacing:0.2em;text-align:center;color:#b8b8c0}
#menu .ctrl{font-size:0.95em;font-weight:700;color:#e8e8e8}
#menu .kb{font-size:0.8em;font-weight:700;color:#8a8a92}
#menu .label{font-size:0.75em;text-transform:uppercase;letter-spacing:0.2em;color:#8a8a92;margin-top:0.2em}
#menu button{font:inherit;color:inherit;border:0;margin:0;cursor:pointer;min-height:3.2em;
background:#3a3a42;text-align:left;padding:0.45em 0.7em;display:flex;flex-direction:column;
justify-content:center;gap:0.15em;-webkit-tap-highlight-color:transparent}
#menu button .n{font-size:1em}
#menu button .d{font-size:0.75em;font-weight:700;color:#b8b8c0}
#menu button.on{background:#4a4a54;box-shadow:inset 0.35em 0 0 #ffe14a;color:#ffe14a}
#menu button.on .d{color:#e8e8e8}
#menu button.main{background:#ffe14a;color:#0c0c12;font-size:1.25em;align-items:center;
letter-spacing:0.15em;min-height:2.6em;text-transform:uppercase}
#menu .modes{display:flex;flex-direction:column;gap:0.3em}
#pause-btn{display:none;width:3.2em;height:3.2em;border:0;margin:0;padding:0;cursor:pointer;
background:rgba(28,28,34,0.88);border-left:0.2em solid #8a8a92;color:#e8e8e8;
-webkit-tap-highlight-color:transparent;
clip-path:polygon(0 0,100% 0,100% calc(100% - 0.6em),calc(100% - 0.6em) 100%,0 100%)}
#pause-btn::before,#pause-btn::after{content:'';position:absolute;top:0.95em;width:0.42em;
height:1.3em;background:#e8e8e8}
#pause-btn::before{left:1.05em}
#pause-btn::after{left:1.75em}
`;

interface ModeList {
  root: HTMLDivElement;
  buttons: HTMLButtonElement[];
}

/**
 * R95 start screen, pause button and pause panel: DOM over the 9:16 canvas, outside the sim.
 * Pointer events on the overlay never reach the touch stick (pointerdown stops propagating before
 * the document listener of pointerDom). Layout is recomputed only on resize, never per frame.
 */
export class GameMenu {
  private readonly root: HTMLDivElement;
  private readonly startPlate: HTMLDivElement;
  private readonly pausePlate: HTMLDivElement;
  private readonly ctrl: HTMLDivElement;
  private readonly kb: HTMLDivElement;
  /** R151: the H19 labels and lists, hidden in model C. */
  private readonly modeParts: HTMLElement[] = [];
  private mode: TouchDrift;
  private readonly lists: ModeList[] = [];
  private readonly pauseBtn: HTMLButtonElement;
  private readonly fit: HudFontFit;
  private readonly btnFit: HudFontFit;

  constructor(
    parent: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly layoutCfg: HudLayout,
    actions: MenuActions,
    mode: TouchDrift,
    /** R151, read live: model C has no touch drift modes (H19). */
    private readonly modelC: () => boolean = () => false,
  ) {
    this.mode = mode;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    const stop = (e: Event): void => {
      e.stopPropagation();
    };

    const root = document.createElement('div');
    root.id = 'menu';
    root.addEventListener('pointerdown', stop);

    // Start screen.
    const sp = plate();
    sp.dataset.screen = 'start';
    sp.append(div('title', 'VERMIS RACE'));
    this.ctrl = div('ctrl', '');
    this.kb = div('kb', KEYBOARD);
    const startLabel = div('label', 'Способ дрифта');
    const startList = this.modeList(actions).root;
    sp.append(this.ctrl, this.kb, startLabel, startList);
    sp.append(mainButton('Старт', 'start', () => actions.start()));

    // Pause panel.
    const pp = plate();
    pp.dataset.screen = 'pause';
    pp.append(div('head', 'Пауза'));
    pp.append(mainButton('Продолжить', 'resume', () => actions.resume()));
    const pauseLabel = div('label', 'Способ дрифта');
    const pauseList = this.modeList(actions).root;
    pp.append(pauseLabel, pauseList);
    this.modeParts.push(startLabel, startList, pauseLabel, pauseList);
    pp.append(textButton('Заново', 'restart', () => actions.restart()));

    root.append(sp, pp);
    parent.appendChild(root);
    this.root = root;
    this.startPlate = sp;
    this.pausePlate = pp;

    const btn = document.createElement('button');
    btn.id = 'pause-btn';
    btn.setAttribute('aria-label', 'Пауза');
    btn.addEventListener('pointerdown', stop);
    btn.addEventListener('click', () => actions.pause());
    parent.appendChild(btn);
    this.pauseBtn = btn;

    this.setMode(mode);
    this.fit = new HudFontFit(root, () => this.layout());
    this.btnFit = new HudFontFit(btn, () => this.layout());
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  /** Shows the overlay for the phase: start screen, pause panel, or only the pause button. */
  show(phase: GamePhase): void {
    this.root.style.display = phase === 'run' ? 'none' : 'flex';
    this.startPlate.style.display = phase === 'menu' ? 'flex' : 'none';
    this.pausePlate.style.display = phase === 'pause' ? 'flex' : 'none';
    this.pauseBtn.style.display = phase === 'run' ? 'block' : 'none';
    this.setMode(this.mode);
  }

  /** Highlights the current drift mode in both lists and rewrites the controls text. */
  setMode(m: TouchDrift): void {
    this.mode = m;
    const c = this.modelC();
    this.ctrl.textContent = c ? CONTROLS_C : CONTROLS[m];
    this.kb.textContent = c ? KEYBOARD_C : KEYBOARD;
    for (const e of this.modeParts) e.style.display = c ? 'none' : '';
    for (const l of this.lists)
      for (let i = 0; i < MODES.length; i++) l.buttons[i]!.classList.toggle('on', MODES[i] === m);
  }

  /** Fits the overlay to the canvas rectangle and the pause button into its top-left corner. */
  layout(): void {
    const r = this.canvas.getBoundingClientRect();
    const em = hudEm(r, this.layoutCfg);
    const s = this.root.style;
    this.fit.apply(em);
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    const m = em * this.layoutCfg.marginEm;
    this.btnFit.apply(em);
    const b = this.pauseBtn.style;
    b.left = `${r.left + m}px`;
    b.top = `${r.top + m}px`;
  }

  private modeList(actions: MenuActions): ModeList {
    const root = document.createElement('div');
    root.className = 'modes';
    const buttons: HTMLButtonElement[] = [];
    for (const m of MODES) {
      const b = document.createElement('button');
      b.dataset.mode = m;
      b.append(span('n', `${m} — ${MODE_NAME[m]}`), span('d', MODE_LINE[m]));
      b.addEventListener('click', () => actions.mode(m));
      buttons.push(b);
      root.appendChild(b);
    }
    const list = { root, buttons };
    this.lists.push(list);
    return list;
  }
}

function div(cls: string, text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function plate(): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'plate';
  return d;
}

function mainButton(text: string, action: string, fn: () => void): HTMLButtonElement {
  const b = textButton(text, action, fn);
  b.classList.add('main');
  return b;
}

function textButton(text: string, action: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.dataset.action = action;
  b.append(span('n', text));
  b.addEventListener('click', fn);
  return b;
}

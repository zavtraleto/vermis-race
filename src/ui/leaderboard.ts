import type { Car } from '../sim/types';
import { fillLeaderboard, placeChange, type LeaderRow } from './leaderboardModel';
import { hudEm, type HudLayout } from './speedometer';

/** R67 leaderboard numbers (src/data/rivals.json). */
export interface LeaderboardConfig {
  leaderboardRows: number;
  placeFlashTime: number; // s the big place stays highlighted after the player's place changes
}

// Gap labels are prebuilt for |gap| <= GAP_CACHE metres, so the frame path never formats text.
const GAP_CACHE = 3000;
const PLAYER_NAME = 'ты';
const JOINED = 'вошёл';

// HUD look (docs/art-bible.md "HUD"): one flat dark plate built like the speedometer's (cut
// corners mirrored for the top-right corner, hard grey edge on the screen side); the place and the
// player's row on the warning yellow; rival marks are solid skewed squares before the name; the
// place change is a hard colour step (no transition) for placeFlashTime.
const STYLE = `
#board{position:fixed;pointer-events:none;z-index:5;font-family:ui-monospace,"Lucida Console",
Consolas,monospace;font-weight:900;color:#e8e8e8;line-height:1;-webkit-font-smoothing:none;
font-smooth:never;display:flex;flex-direction:column;align-items:flex-end;
background:rgba(12,12,18,0.78);border-right:0.25em solid #8a8a92;padding:0 0 0.5em 0.3em;
clip-path:polygon(0 0,calc(100% - 0.45em) 0,100% 0.45em,100% 100%,1.1em 100%,0 calc(100% - 1.1em))}
#board .big{font-size:2.6em;font-variant-numeric:tabular-nums;background:#ffe14a;color:#0c0c12;
padding:0.06em 0.12em 0.04em 0.4em;clip-path:polygon(0 0,100% 0,100% 100%,0.3em 100%,0 calc(100% - 0.3em))}
#board .big small{font-size:0.5em;margin-left:0.1em;letter-spacing:0.1em}
#board.up .big{background:#b4ff39}
#board.down .big{background:#ff4f6a}
#board .rows{margin-top:0.3em;display:flex;flex-direction:column;gap:0.16em;align-self:stretch}
#board .row{display:flex;gap:0.5em;align-items:baseline;justify-content:flex-end;
font-size:0.95em;padding:0.14em 0.35em 0.12em 0.35em}
#board .row .p{width:1.2em;text-align:right;color:#8a8a92}
#board .row .n{max-width:9em;overflow:hidden;white-space:nowrap}
#board .row .n::before{content:'';display:inline-block;width:0.5em;height:0.5em;margin:0 0.4em 0 0.1em;
background:#5a5a62;transform:skewX(-18deg)}
#board .row .g{width:4.4em;text-align:right;font-variant-numeric:tabular-nums;color:#b8b8c0}
#board .row .j{font-family:"Arial Narrow","Roboto Condensed",sans-serif-condensed,Bahnschrift,
ui-monospace,monospace;font-stretch:condensed;font-size:0.75em;font-weight:700;color:#39e6ff;
text-transform:uppercase;letter-spacing:0.15em;display:none}
#board .row.joined .n::before{background:#39e6ff}
#board .row.joined .j{display:inline}
#board .row.me{background:#ffe14a;color:#0c0c12}
#board .row.me .p,#board .row.me .g{color:#0c0c12}
#board .row.me .n::before{background:#0c0c12}
#board .row.nem .n{color:#ff4f6a}
#board .row.nem .n::before{background:#ff4f6a}
`;

interface RowView {
  root: HTMLDivElement;
  place: HTMLSpanElement;
  name: HTMLSpanElement;
  gap: HTMLSpanElement;
  shownPlace: number;
  shownName: number;
  shownGap: number;
  shownMe: boolean;
  shownNem: boolean;
  shownJoined: boolean;
}

/**
 * R67 io-style leaderboard in the top-right corner of the 9:16 game area: big "place / total" and
 * up to leaderboardRows rows around the player (place, name, signed gap in metres; player row
 * highlighted, nemesis tinted, "вошёл" while joined). The big place flashes on a place change.
 * DOM over the canvas, pointer-transparent; text and classes change only when the value does,
 * all strings prebuilt (no allocations per frame).
 */
export class Leaderboard {
  private readonly root: HTMLDivElement;
  private readonly bigPlace: HTMLSpanElement;
  private readonly views: RowView[] = [];
  private readonly rows: LeaderRow[] = [];
  private readonly numbers: string[] = [];
  private readonly gaps: string[] = [];
  private shownPlace = -1;
  private flash = 0;
  private flashDir = 0;

  constructor(
    parent: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly cfg: LeaderboardConfig,
    private readonly names: readonly string[],
    private readonly raceCount: number,
    private readonly metersPerSegment: number,
    /** Size and corner offset (sprites.json "leaderboard"). */
    private readonly layoutCfg: HudLayout,
  ) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    for (let i = 0; i <= raceCount; i++) this.numbers.push(String(i));
    for (let g = -GAP_CACHE; g <= GAP_CACHE; g++) this.gaps.push(gapText(g));
    const root = document.createElement('div');
    root.id = 'board';
    const big = document.createElement('div');
    big.className = 'big';
    this.bigPlace = document.createElement('span');
    const tot = document.createElement('small');
    tot.textContent = `/${raceCount}`;
    big.append(this.bigPlace, tot);
    const list = document.createElement('div');
    list.className = 'rows';
    const max = Math.max(1, Math.min(Math.floor(cfg.leaderboardRows), raceCount));
    for (let i = 0; i < max; i++) {
      this.rows.push({
        place: 0,
        nameId: -1,
        gapM: 0,
        isPlayer: false,
        nemesis: false,
        joined: false,
      });
      const r = document.createElement('div');
      r.className = 'row';
      const place = document.createElement('span');
      place.className = 'p';
      const name = document.createElement('span');
      name.className = 'n';
      const joined = document.createElement('span');
      joined.className = 'j';
      joined.textContent = JOINED;
      const gap = document.createElement('span');
      gap.className = 'g';
      r.append(place, name, joined, gap);
      list.appendChild(r);
      this.views.push({
        root: r,
        place,
        name,
        gap,
        shownPlace: -1,
        shownName: -2,
        shownGap: NaN,
        shownMe: false,
        shownNem: false,
        shownJoined: false,
      });
    }
    root.append(big, list);
    parent.appendChild(root);
    this.root = root;
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  /** Fits the widget into the top-right corner of the canvas rectangle (the 9:16 game area). */
  layout(): void {
    const r = this.canvas.getBoundingClientRect();
    const s = this.root.style;
    const em = hudEm(r, this.layoutCfg);
    const m = em * this.layoutCfg.marginEm;
    s.fontSize = `${em}px`;
    s.right = `${window.innerWidth - r.right + m}px`;
    s.top = `${r.top + m}px`;
  }

  /** dt = frame seconds; cars = newest sim state (cars[0] is the player). */
  update(dt: number, cars: readonly Car[]): void {
    const place = cars[0]!.place;
    if (place !== this.shownPlace) {
      if (this.shownPlace > 0) {
        const dir = placeChange(this.shownPlace, place);
        this.flash = this.cfg.placeFlashTime;
        if (dir !== this.flashDir) {
          this.root.classList.toggle('up', dir < 0);
          this.root.classList.toggle('down', dir > 0);
          this.flashDir = dir;
        }
      }
      this.shownPlace = place;
      this.bigPlace.textContent = this.num(place);
    }
    if (this.flash > 0) {
      this.flash -= dt;
      if (this.flash <= 0 && this.flashDir !== 0) {
        this.root.classList.remove('up', 'down');
        this.flashDir = 0;
      }
    }
    const n = fillLeaderboard(
      cars,
      this.raceCount,
      this.rows.length,
      this.metersPerSegment,
      this.rows,
    );
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i]!;
      if (i >= n) {
        if (v.shownPlace !== 0) {
          v.root.style.display = 'none';
          v.shownPlace = 0;
        }
        continue;
      }
      const row = this.rows[i]!;
      if (v.shownPlace !== row.place) {
        if (v.shownPlace === 0) v.root.style.display = '';
        v.shownPlace = row.place;
        v.place.textContent = this.num(row.place);
      }
      const nameId = row.isPlayer ? -1 : row.nameId;
      if (v.shownName !== nameId) {
        v.shownName = nameId;
        v.name.textContent = nameId < 0 ? PLAYER_NAME : (this.names[nameId] ?? '?');
      }
      if (v.shownGap !== row.gapM) {
        v.shownGap = row.gapM;
        const g = row.gapM;
        v.gap.textContent =
          g >= -GAP_CACHE && g <= GAP_CACHE ? this.gaps[g + GAP_CACHE]! : gapText(g);
      }
      if (v.shownMe !== row.isPlayer) {
        v.shownMe = row.isPlayer;
        v.root.classList.toggle('me', row.isPlayer);
      }
      if (v.shownNem !== row.nemesis) {
        v.shownNem = row.nemesis;
        v.root.classList.toggle('nem', row.nemesis);
      }
      if (v.shownJoined !== row.joined) {
        v.shownJoined = row.joined;
        v.root.classList.toggle('joined', row.joined);
      }
    }
  }

  private num(v: number): string {
    return v >= 0 && v < this.numbers.length ? this.numbers[v]! : String(v);
  }
}

/** Signed gap label: "+12 м", "−7 м", "0" for the player. */
function gapText(g: number): string {
  if (g === 0) return '0';
  return `${g > 0 ? '+' : '−'}${Math.abs(g)} м`;
}

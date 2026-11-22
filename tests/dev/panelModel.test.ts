import { describe, expect, it } from 'vitest';
import tunablesJson from '../../src/data/tunables.json';
import {
  buildSections,
  clampLayout,
  defaultLayout,
  parseView,
  serializeView,
  type PanelItemMeta,
  type PanelLayout,
  type PanelViewState,
  type Viewport,
} from '../../src/dev/panelModel';

// Written from the dev-panel redesign contract, not from the implementation.

function m(
  group: string,
  tier: PanelItemMeta['tier'],
  extra: Partial<PanelItemMeta> = {},
): PanelItemMeta {
  return { title: 'T', hint: 'h', tier, group, ...extra };
}

// Insertion order matters: groups appear as G1, G2, G3; items keep this order inside a group.
const META: Record<string, PanelItemMeta> = {
  'a.core1': m('G1', 'core', { title: 'Alpha', hint: 'raises speed' }),
  'b.more1': m('G2', 'more', { title: 'Beta' }),
  'a.core2': m('G1', 'core', { title: 'Gamma' }),
  'c.legacy1': m('G3', 'legacy', { title: 'Delta', hint: 'ancient knob' }),
  'b.core3': m('G2', 'core', { title: 'Epsilon' }),
  'a.onlyA': m('G1', 'core', { title: 'OnlyA' }),
  'b.onlyB': m('G2', 'core', { title: 'OnlyB' }),
  'c.more2': m('G3', 'more', { title: 'MoreB' }),
};

function state(over: Partial<PanelViewState> = {}): PanelViewState {
  return {
    query: '',
    onlyChanged: false,
    showMore: false,
    favourites: [],
    ...over,
  };
}
const NONE: ReadonlySet<string> = new Set();
const ids = (s: { id: string }[]) => s.map((x) => x.id);
const allPaths = (s: { paths: string[] }[]) => s.flatMap((x) => x.paths);
const byTitle = (s: { title: string; paths: string[] }[], t: string) =>
  s.find((x) => x.title === t)?.paths;

describe('P2 default view', () => {
  it('shows only core items grouped by first appearance, meta order inside a group', () => {
    const s = buildSections(META, state(), NONE);
    // core = a.core1, a.core2, a.onlyA (G1), b.core3, b.onlyB (G2); G3 has no core -> omitted
    expect(s.map((x) => x.title)).toEqual(['G1', 'G2']);
    expect(byTitle(s, 'G1')).toEqual(['a.core1', 'a.core2', 'a.onlyA']);
    expect(byTitle(s, 'G2')).toEqual(['b.core3', 'b.onlyB']);
  });

  it('omits empty sections and returns [] for empty meta', () => {
    expect(buildSections({}, state(), NONE)).toEqual([]);
    const only = { x: m('Z', 'legacy') };
    expect(buildSections(only, state(), NONE)).toEqual([]);
  });

  it('section ids are unique and non-empty', () => {
    const s = buildSections(META, state({ showMore: true }), NONE);
    expect(new Set(ids(s)).size).toBe(s.length);
    for (const x of s) expect(x.id.length).toBeGreaterThan(0);
  });
});

describe('P3 tiers', () => {
  it('showMore adds tier more but never legacy', () => {
    const s = buildSections(META, state({ showMore: true }), NONE);
    const p = allPaths(s);
    expect(p).toContain('b.more1');
    expect(p).toContain('c.more2');
    expect(p).not.toContain('c.legacy1');
    expect(byTitle(s, 'G2')).toEqual(['b.more1', 'b.core3', 'b.onlyB']);
  });
});

describe('P4 favourites', () => {
  it("puts a 'fav' section first in the user's order, without repeats in groups", () => {
    const s = buildSections(
      META,
      state({ favourites: ['b.core3', 'c.legacy1', 'a.core1', 'zzz.unknown'] }),
      NONE,
    );
    expect(s[0]?.id).toBe('fav');
    expect(s[0]?.title).toBe('Избранное');
    expect(s[0]?.paths).toEqual(['b.core3', 'c.legacy1', 'a.core1']);
    const rest = allPaths(s.slice(1));
    for (const p of s[0]?.paths ?? []) expect(rest).not.toContain(p);
    expect(byTitle(s, 'G1')).toEqual(['a.core2', 'a.onlyA']);
  });

  it('has no fav section when favourites are empty or all unknown', () => {
    expect(ids(buildSections(META, state(), NONE))).not.toContain('fav');
    expect(ids(buildSections(META, state({ favourites: ['nope'] }), NONE))).not.toContain('fav');
  });
});

describe('P5 search', () => {
  it('matches title, hint, group and path, case-insensitive and trimmed', () => {
    const q = (query: string) => allPaths(buildSections(META, state({ query }), NONE));
    expect(q('  ALPHA ')).toEqual(['a.core1']); // title
    expect(q('ancient')).toEqual(['c.legacy1']); // hint, legacy tier
    expect(q('g3')).toEqual(['c.legacy1', 'c.more2']); // group
    expect(q('b.more1')).toEqual(['b.more1']); // path
  });

  it('searches all tiers, returns matches in their groups, no fav', () => {
    const s = buildSections(META, state({ query: 'only', favourites: ['a.core1'] }), NONE);
    expect(ids(s)).not.toContain('fav');
    expect(byTitle(s, 'G1')).toEqual(['a.onlyA']);
    expect(byTitle(s, 'G2')).toEqual(['b.onlyB']);
  });

  it('returns [] when nothing matches', () => {
    expect(buildSections(META, state({ query: 'qqqq-no-such' }), NONE)).toEqual([]);
  });

  it('whitespace-only query behaves like an empty query', () => {
    expect(buildSections(META, state({ query: '   ' }), NONE)).toEqual(
      buildSections(META, state(), NONE),
    );
  });
});

describe('P6 only changed', () => {
  it('shows only changed paths, any tier', () => {
    const s = buildSections(
      META,
      state({ onlyChanged: true }),
      new Set(['c.legacy1', 'b.more1', 'a.onlyA']),
    );
    expect(allPaths(s)).toEqual(['a.onlyA', 'b.more1', 'c.legacy1']);
  });

  it('is empty when nothing changed', () => {
    expect(buildSections(META, state({ onlyChanged: true }), NONE)).toEqual([]);
  });

  it('combined with a query it is the intersection', () => {
    const changed = new Set(['a.core1', 'a.core2', 'b.core3']);
    const s = buildSections(META, state({ onlyChanged: true, query: 'g1' }), changed);
    expect(allPaths(s)).toEqual(['a.core1', 'a.core2']);
  });
});

describe('P7 changed values are never hidden', () => {
  it('shows changed more/legacy items in the default view', () => {
    const s = buildSections(META, state(), new Set(['b.more1', 'c.legacy1', 'a.onlyA']));
    expect(byTitle(s, 'G2')).toEqual(['b.more1', 'b.core3', 'b.onlyB']);
    expect(byTitle(s, 'G3')).toEqual(['c.legacy1']);
  });
});

describe('P8 purity', () => {
  it('does not mutate inputs and is deterministic', () => {
    const metaCopy = JSON.parse(JSON.stringify(META));
    const st = state({ favourites: ['a.core1'], showMore: true });
    const stCopy = JSON.parse(JSON.stringify(st));
    const changed = new Set(['c.legacy1']);
    const r1 = buildSections(META, st, changed);
    const r2 = buildSections(META, st, changed);
    expect(r1).toEqual(r2);
    expect(META).toEqual(metaCopy);
    expect(st).toEqual(stCopy);
    expect([...changed]).toEqual(['c.legacy1']);
    expect(Object.keys(META)).toEqual(Object.keys(metaCopy));
  });
});

const DESKTOP: Viewport = { w: 1200, h: 800, gameLeft: 346, gameRight: 854 };
const PHONE: Viewport = { w: 390, h: 844, gameLeft: 0, gameRight: 390 };

describe('P9 defaultLayout', () => {
  it('docks at the right side when >= 320 px is free there', () => {
    // free right = 1200 - 854 = 346 >= 320
    const l = defaultLayout(DESKTOP);
    expect(l.dock).toBe('side');
    expect(l.x).toBeGreaterThanOrEqual(DESKTOP.gameRight);
    expect(l.x + l.w).toBeLessThanOrEqual(DESKTOP.w);
    expect(l.y).toBeGreaterThanOrEqual(0);
    expect(l.y + l.h).toBeLessThanOrEqual(DESKTOP.h);
  });

  it('docks at the left side when only the left has >= 320 px', () => {
    // free left = 340 >= 320, free right = 0
    const vp: Viewport = { w: 1200, h: 800, gameLeft: 340, gameRight: 1200 };
    const l = defaultLayout(vp);
    expect(l.dock).toBe('side');
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.x + l.w).toBeLessThanOrEqual(vp.gameLeft);
  });

  it('prefers the right when both sides are free', () => {
    const vp: Viewport = { w: 1400, h: 800, gameLeft: 450, gameRight: 950 };
    const l = defaultLayout(vp);
    expect(l.x).toBeGreaterThanOrEqual(vp.gameRight);
  });

  it('floats collapsed in the top-right corner when there is no room beside the game', () => {
    // free right = 0, free left = 0
    const l = defaultLayout(PHONE);
    expect(l.dock).toBe('float');
    expect(l.collapsed).toBe(true);
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.y).toBeGreaterThanOrEqual(0);
    expect(l.x + l.w).toBeLessThanOrEqual(PHONE.w);
    expect(PHONE.w - (l.x + l.w)).toBeLessThanOrEqual(24);
    expect(l.y).toBeLessThanOrEqual(24);
  });

  it('319 px free is not enough', () => {
    const vp: Viewport = { w: 1000, h: 700, gameLeft: 0, gameRight: 681 };
    expect(defaultLayout(vp).dock).toBe('float');
  });
});

function inside(l: PanelLayout, vp: Viewport) {
  expect(l.x).toBeGreaterThanOrEqual(0);
  expect(l.y).toBeGreaterThanOrEqual(0);
  expect(l.x + l.w).toBeLessThanOrEqual(vp.w + 1e-9);
  expect(l.y + l.h).toBeLessThanOrEqual(vp.h + 1e-9);
}

describe('P10 clampLayout', () => {
  const base: PanelLayout = {
    dock: 'float',
    x: 100,
    y: 100,
    w: 300,
    h: 400,
    opacity: 0.8,
    collapsed: false,
  };

  it('leaves a valid layout unchanged', () => {
    expect(clampLayout(base, DESKTOP)).toEqual(base);
  });

  it('clamps size to [240, vp.w] x [160, vp.h] and opacity to [0.3, 1]', () => {
    const small = clampLayout({ ...base, w: 10, h: 10, opacity: 0 }, DESKTOP);
    expect(small.w).toBe(240);
    expect(small.h).toBe(160);
    expect(small.opacity).toBe(0.3);
    const big = clampLayout({ ...base, w: 9999, h: 9999, opacity: 5 }, DESKTOP);
    expect(big.w).toBe(DESKTOP.w);
    expect(big.h).toBe(DESKTOP.h);
    expect(big.opacity).toBe(1);
  });

  it('moves a panel dragged off-screen back inside', () => {
    inside(clampLayout({ ...base, x: -500, y: -500 }, DESKTOP), DESKTOP);
    inside(clampLayout({ ...base, x: 5000, y: 5000 }, DESKTOP), DESKTOP);
    // exact: x max = 1200 - 300 = 900, y max = 800 - 400 = 400
    const l = clampLayout({ ...base, x: 5000, y: 5000 }, DESKTOP);
    expect([l.x, l.y]).toEqual([900, 400]);
  });

  it('keeps the panel inside after the viewport shrinks (rotation)', () => {
    const wide: Viewport = { w: 1000, h: 500, gameLeft: 0, gameRight: 1000 };
    const tall: Viewport = { w: 500, h: 1000, gameLeft: 0, gameRight: 500 };
    const l = clampLayout({ ...base, x: 650, y: 100, w: 340, h: 380 }, tall);
    inside(l, tall);
    inside(clampLayout(l, wide), wide);
    inside(
      clampLayout({ ...base, w: 600, h: 900 }, { w: 320, h: 480, gameLeft: 0, gameRight: 320 }),
      {
        w: 320,
        h: 480,
        gameLeft: 0,
        gameRight: 320,
      },
    );
  });

  it('falls back to the default for NaN / undefined fields', () => {
    const d = defaultLayout(DESKTOP);
    const bad = {
      ...base,
      x: NaN,
      y: undefined,
      w: NaN,
      h: undefined,
      opacity: NaN,
    } as unknown as PanelLayout;
    const l = clampLayout(bad, DESKTOP);
    expect(l.x).toBe(d.x);
    expect(l.y).toBe(d.y);
    expect(l.w).toBe(d.w);
    expect(l.h).toBe(d.h);
    expect(l.opacity).toBe(d.opacity);
  });

  it('is idempotent', () => {
    const once = clampLayout({ ...base, x: -9, y: 9999, w: 5, opacity: 9 }, PHONE);
    expect(clampLayout(once, PHONE)).toEqual(once);
  });
});

describe('P11 serializeView / parseView', () => {
  const st = { showMore: true, onlyChanged: true, favourites: ['car.accel', 'camera.fovDeg'] };
  const lay: PanelLayout = {
    dock: 'float',
    x: 20,
    y: 30,
    w: 320,
    h: 420,
    opacity: 0.7,
    collapsed: false,
  };

  it('round-trips', () => {
    const r = parseView(serializeView(st, lay), DESKTOP);
    expect(r.state).toEqual(st);
    expect(r.layout).toEqual(lay);
  });

  it('serialization is deterministic', () => {
    expect(serializeView(st, lay)).toBe(serializeView(st, lay));
  });

  it('returns defaults for null, garbage and wrong types', () => {
    const d = {
      state: { showMore: false, onlyChanged: false, favourites: [] },
      layout: defaultLayout(DESKTOP),
    };
    expect(parseView(null, DESKTOP)).toEqual(d);
    expect(parseView('{not json', DESKTOP)).toEqual(d);
    expect(parseView('42', DESKTOP)).toEqual(d);
    expect(parseView('null', DESKTOP)).toEqual(d);
    expect(parseView('{"state":"x","layout":7}', DESKTOP)).toEqual(d);
  });

  it('keeps only string favourites', () => {
    const text = JSON.stringify({
      state: { ...st, favourites: ['a', 1, null, 'b', {}] },
      layout: lay,
    });
    // The storage shape is private, so build it through serializeView and patch the favourites.
    const real = JSON.parse(serializeView(st, lay));
    const patch = (o: unknown): unknown => {
      if (Array.isArray(o) && o.includes('car.accel')) return ['a', 1, null, 'b', {}];
      if (o && typeof o === 'object')
        return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, patch(v)]));
      return o;
    };
    expect(text.length).toBeGreaterThan(0);
    const r = parseView(JSON.stringify(patch(real)), DESKTOP);
    expect(r.state.favourites).toEqual(['a', 'b']);
  });

  it('clamps the parsed layout to the given viewport', () => {
    const r = parseView(serializeView(st, { ...lay, x: 5000, y: 5000, w: 9999 }), PHONE);
    inside(r.layout, PHONE);
  });
});

// ---- data sanity for src/data/tunables.json ----

// Contract choice: metadata lives in a top-level `meta` map {path -> PanelItemMeta}, so that
// the existing `numbers` / `flags` shapes stay untouched.
const spec = tunablesJson as unknown as {
  numbers: Record<string, unknown>;
  flags: Record<string, string[]>;
  meta?: Record<string, PanelItemMeta>;
};
const meta: Record<string, PanelItemMeta> = spec.meta ?? {};
const specPaths = [...Object.keys(spec.numbers), ...Object.keys(spec.flags)];
const TIERS = ['core', 'more', 'legacy'];

describe('P12 every tunable has well-formed metadata', () => {
  it('has a meta map', () => {
    expect(spec.meta).toBeDefined();
  });

  it('every number and flag has {title, hint, tier, group}', () => {
    const missing = specPaths.filter((p) => {
      const x = meta[p];
      return !x || !x.title || !x.hint || !TIERS.includes(x.tier) || !x.group;
    });
    expect(missing).toEqual([]);
  });

  it('title <= 28 chars, hint non-empty and <= 90 chars', () => {
    const bad = specPaths.filter((p) => {
      const x = meta[p];
      return x && (x.title.length > 28 || x.hint.trim().length === 0 || x.hint.length > 90);
    });
    expect(bad).toEqual([]);
  });

  it('titles are unique within a group', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const p of specPaths) {
      const x = meta[p];
      if (!x) continue;
      const k = `${x.group}|${x.title}`;
      if (seen.has(k)) dup.push(`${p} duplicates ${seen.get(k)}`);
      else seen.set(k, p);
    }
    expect(dup).toEqual([]);
  });

  it('meta has no stale paths absent from numbers/flags', () => {
    const set = new Set(specPaths);
    expect(Object.keys(meta).filter((p) => !set.has(p))).toEqual([]);
  });
});

describe('P13 curated core set', () => {
  const core = specPaths.filter((p) => meta[p]?.tier === 'core');

  it('6..14 core items', () => {
    expect(core.length).toBeGreaterThanOrEqual(6);
    expect(core.length).toBeLessThanOrEqual(14);
  });

  it('at most 8 core items per group', () => {
    const per = new Map<string, number>();
    for (const p of core) {
      const g = meta[p]?.group ?? '';
      per.set(g, (per.get(g) ?? 0) + 1);
    }
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(8);
  });
});

// Raw text of every source file outside src/data and src/dev (vite glob, no node types needed).
const rawGlob = (
  import.meta as unknown as {
    glob: (p: string[], o: object) => Record<string, string>;
  }
).glob(['../../src/**/*.ts', '!../../src/data/**', '!../../src/dev/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('P14 unread hypothesis flags are not shown', () => {
  const sources = Object.values(rawGlob).join('\n');
  for (const path of Object.keys(spec.flags)) {
    const key = path.split('.').pop() as string;
    it(`${path}: read by code, or legacy, or absent`, () => {
      const used = sources.includes(key);
      const x = meta[path];
      if (!used) expect(x === undefined || x.tier === 'legacy').toBe(true);
      // a flag the code reads must be documented in the panel
      else expect(x).toBeDefined();
    });
  }
});

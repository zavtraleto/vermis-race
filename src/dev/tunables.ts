/**
 * Registry of live-tunable config values (pure, no DOM).
 *
 * Each entry points at a field of a loaded config object (`car.accel` -> roots.car.accel).
 * set() clamps and writes straight into that object, so the sim, input and render pick the
 * value up on their next read; nothing here runs in the tick or frame path.
 * Ranges come from `src/data/tunables.json`.
 */

export interface NumberRange {
  min: number;
  max: number;
  step: number;
  label?: string;
}

export interface TunableSpec {
  numbers: Record<string, NumberRange>;
  /** Path -> allowed string values (hypothesis flags). */
  flags: Record<string, string[]>;
}

export interface NumberTunable {
  readonly path: string;
  /** Path without its last segment (`input.touch`). */
  readonly section: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
  readonly value: number;
}

export interface FlagTunable {
  readonly path: string;
  readonly section: string;
  readonly label: string;
  readonly options: readonly string[];
  readonly default: string;
  readonly value: string;
}

export type TuneValue = number | string;
export type TuneDiff = Record<string, TuneValue>;
/** Called after a change; path is null when many values changed at once (apply, reset). */
export type ChangeListener = (path: string | null) => void;

export interface Tunables {
  readonly numbers: readonly NumberTunable[];
  readonly flags: readonly FlagTunable[];
  get(path: string): TuneValue | undefined;
  /** Clamps numbers to [min, max]; throws on unknown path, wrong type, non-finite or unknown option. */
  set(path: string, value: TuneValue): TuneValue;
  /** Only values that differ from defaults. */
  diff(): TuneDiff;
  /** JSON of diff(), keys in registry order. */
  serialize(): string;
  /**
   * Resets to defaults, then applies a JSON diff. Unknown keys and invalid values are skipped and
   * returned. Malformed JSON or a non-object throws before anything changes.
   */
  apply(json: string): string[];
  reset(): void;
  /** Returns an unsubscribe function. */
  onChange(fn: ChangeListener): () => void;
}

type Holder = Record<string, unknown>;

interface Slot {
  holder: Holder;
  key: string;
}

function resolve(roots: Record<string, object>, path: string): Slot {
  const parts = path.split('.');
  let node: unknown = roots;
  for (let i = 0; i < parts.length - 1; i++) {
    node = typeof node === 'object' && node !== null ? (node as Holder)[parts[i]!] : undefined;
  }
  if (typeof node !== 'object' || node === null)
    throw new Error(`tunables: path '${path}' not found`);
  return { holder: node as Holder, key: parts[parts.length - 1]! };
}

function sectionOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(0, i);
}

function labelOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

class NumberEntry implements NumberTunable {
  readonly section: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;

  constructor(
    readonly path: string,
    private readonly slot: Slot,
    range: NumberRange,
  ) {
    const v = slot.holder[slot.key];
    if (typeof v !== 'number') throw new Error(`tunables: '${path}' is not a number`);
    if (!(range.min < range.max)) throw new Error(`tunables: '${path}' min must be < max`);
    if (!(range.step > 0)) throw new Error(`tunables: '${path}' step must be > 0`);
    if (v < range.min || v > range.max)
      throw new Error(`tunables: '${path}' default ${v} outside [${range.min}, ${range.max}]`);
    this.section = sectionOf(path);
    this.label = range.label ?? labelOf(path);
    this.min = range.min;
    this.max = range.max;
    this.step = range.step;
    this.default = v;
  }

  get value(): number {
    return this.slot.holder[this.slot.key] as number;
  }

  /** Clamped number, or null if the value is not a finite number. */
  check(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value < this.min ? this.min : value > this.max ? this.max : value;
  }

  write(v: number): void {
    this.slot.holder[this.slot.key] = v;
  }

  /** Checks and writes; the written value, or null if rejected (nothing written). */
  assign(value: unknown): number | null {
    const v = this.check(value);
    if (v !== null) this.write(v);
    return v;
  }
}

class FlagEntry implements FlagTunable {
  readonly section: string;
  readonly label: string;
  readonly options: readonly string[];
  readonly default: string;

  constructor(
    readonly path: string,
    private readonly slot: Slot,
    options: string[],
  ) {
    const v = slot.holder[slot.key];
    if (typeof v !== 'string') throw new Error(`tunables: flag '${path}' is not a string`);
    if (!options.includes(v))
      throw new Error(`tunables: flag '${path}' value '${v}' not in options`);
    this.section = sectionOf(path);
    this.label = labelOf(path);
    this.options = options.slice();
    this.default = v;
  }

  get value(): string {
    return this.slot.holder[this.slot.key] as string;
  }

  check(value: unknown): string | null {
    return typeof value === 'string' && this.options.includes(value) ? value : null;
  }

  write(v: string): void {
    this.slot.holder[this.slot.key] = v;
  }

  assign(value: unknown): string | null {
    const v = this.check(value);
    if (v !== null) this.write(v);
    return v;
  }
}

export function createTunables(roots: Record<string, object>, spec: TunableSpec): Tunables {
  const numbers: NumberEntry[] = [];
  const flags: FlagEntry[] = [];
  const byPath = new Map<string, NumberEntry | FlagEntry>();
  for (const [path, range] of Object.entries(spec.numbers)) {
    const e = new NumberEntry(path, resolve(roots, path), range);
    numbers.push(e);
    byPath.set(path, e);
  }
  for (const [path, options] of Object.entries(spec.flags)) {
    const e = new FlagEntry(path, resolve(roots, path), options);
    flags.push(e);
    byPath.set(path, e);
  }
  const all: (NumberEntry | FlagEntry)[] = [...numbers, ...flags];
  const listeners = new Set<ChangeListener>();
  const emit = (path: string | null): void => {
    for (const fn of listeners) fn(path);
  };

  function resetAll(): void {
    for (const e of numbers) e.write(e.default);
    for (const e of flags) e.write(e.default);
  }

  function diff(): TuneDiff {
    const out: TuneDiff = {};
    for (const e of all) if (e.value !== e.default) out[e.path] = e.value;
    return out;
  }

  return {
    numbers,
    flags,
    get(path) {
      return byPath.get(path)?.value;
    },
    set(path, value) {
      const e = byPath.get(path);
      if (e === undefined) throw new Error(`tunables: unknown path '${path}'`);
      const v = e.assign(value);
      if (v === null) throw new Error(`tunables: invalid value ${String(value)} for '${path}'`);
      emit(path);
      return v;
    },
    diff,
    serialize() {
      return JSON.stringify(diff());
    },
    apply(json) {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('tunables: diff must be a JSON object');
      resetAll();
      const rejected: string[] = [];
      for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
        const e = byPath.get(path);
        if (e === undefined || e.assign(value) === null) rejected.push(path);
      }
      emit(null);
      return rejected;
    },
    reset() {
      resetAll();
      emit(null);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

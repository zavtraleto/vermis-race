import type { TrackDef, TrackSection } from '../../sim/types';
import curves from './curves.json';
import figures from './figures.json';
import figuresSharp from './figures-sharp.json';
import driftRun from './drift-run.json';
import twisty from './test-twisty.json';

/** R31b: `sharp` is steeper than `hard`. */
export type CurveClass = 'easy' | 'medium' | 'hard' | 'sharp';
/** Class values; `sharp` (R31b) is optional so older class sets stay valid (resolve throws if a section needs it). */
export type CurveClasses = Record<Exclude<CurveClass, 'sharp'>, number> & { sharp?: number };
/** R31: a section is a corner of one class or a straight (curve 0). */
export type SectionClass = CurveClass | 'straight';

/** Track section as stored in src/data/tracks/*.json: steepness class + side instead of a raw curve. */
export interface ClassedSection {
  enter: number;
  hold: number;
  leave: number;
  curveClass: SectionClass;
  side: -1 | 1; // +1 right, -1 left
  hill?: number; // R30 height change over the section, segment lengths (+ up)
}

/** Class values from curves.json; straight is structurally 0 (R31). */
export const curveClasses: Record<SectionClass, number> = { ...curves, straight: 0 };

function parseLength(v: unknown, field: string, i: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`section ${i}: ${field} must be a non-negative integer`);
  }
  return v;
}

/** Validates raw JSON sections; throws on a non-integer/negative length, unknown curveClass or side. */
export function parseSections(raw: unknown): ClassedSection[] {
  if (!Array.isArray(raw)) throw new Error('sections must be an array');
  return raw.map((item: unknown, i): ClassedSection => {
    if (typeof item !== 'object' || item === null) throw new Error(`section ${i}: not an object`);
    const r = item as Record<string, unknown>;
    const curveClass = r.curveClass;
    if (
      curveClass !== 'easy' &&
      curveClass !== 'medium' &&
      curveClass !== 'hard' &&
      curveClass !== 'sharp' &&
      curveClass !== 'straight'
    ) {
      throw new Error(`section ${i}: unknown curveClass ${String(curveClass)}`);
    }
    const side = r.side;
    if (side !== 1 && side !== -1) throw new Error(`section ${i}: side must be 1 or -1`);
    const out: ClassedSection = {
      enter: parseLength(r.enter, 'enter', i),
      hold: parseLength(r.hold, 'hold', i),
      leave: parseLength(r.leave, 'leave', i),
      curveClass,
      side,
    };
    if (r.hill !== undefined) {
      if (typeof r.hill !== 'number' || !Number.isFinite(r.hill)) {
        throw new Error(`section ${i}: hill must be a number`);
      }
      out.hill = r.hill;
    }
    return out;
  });
}

function classValue(classes: CurveClasses, c: CurveClass): number {
  const v = classes[c];
  if (v === undefined) throw new Error(`curve class ${c} has no value`);
  return v;
}

/** curve = side * classes[curveClass] (straight: 0); lengths copied as is. */
export function resolveSections(
  sections: readonly ClassedSection[],
  classes: CurveClasses,
): TrackDef {
  return {
    sections: sections.map((s) => {
      const out: TrackSection = {
        enter: s.enter,
        hold: s.hold,
        leave: s.leave,
        // R31: a straight is curve +0 on either side.
        curve: s.curveClass === 'straight' ? 0 : s.side * classValue(classes, s.curveClass),
      };
      if (s.hill !== undefined) out.hill = s.hill;
      return out;
    }),
  };
}

/** R31: part of a named figure; side is relative to the placement (1 = same side, -1 = opposite). */
export interface FigurePart {
  enter: number;
  hold: number;
  leave: number;
  curveClass: SectionClass;
  side: -1 | 1;
}
export interface FigureDef {
  parts: FigurePart[];
}
export interface FigureRef {
  figure: string;
  side: -1 | 1;
  hill?: number;
}
export type ExpandedSection = ClassedSection;

/** R31 figure dictionary (figures.json) plus the R31b figures (figures-sharp.json). */
export const figureDict: Readonly<Record<string, FigureDef>> = {
  ...(figures as Record<string, FigureDef>),
  ...(figuresSharp as Record<string, FigureDef>),
};

/**
 * R31: expands figure placements into track sections, in order. side -1 mirrors every part;
 * the placement's hill is split over the parts in proportion to their length.
 */
export function expandFigures(
  refs: readonly FigureRef[],
  dict: Readonly<Record<string, FigureDef>>,
): ExpandedSection[] {
  const out: ExpandedSection[] = [];
  for (const ref of refs) {
    const f = Object.prototype.hasOwnProperty.call(dict, ref.figure) ? dict[ref.figure] : undefined;
    if (!f) throw new Error(`unknown figure ${ref.figure}`);
    let total = 0;
    for (const p of f.parts) total += p.enter + p.hold + p.leave;
    for (const p of f.parts) {
      const s: ExpandedSection = {
        enter: p.enter,
        hold: p.hold,
        leave: p.leave,
        curveClass: p.curveClass,
        side: p.side === ref.side ? 1 : -1,
      };
      if (ref.hill !== undefined) {
        s.hill = total > 0 ? (ref.hill * (p.enter + p.hold + p.leave)) / total : 0;
      }
      out.push(s);
    }
  }
  return out;
}

/** A track file: either explicit "sections" or R31 "figures" placements. */
export function trackSections(raw: { sections?: unknown; figures?: unknown }): ClassedSection[] {
  if (Array.isArray(raw.figures)) {
    return parseSections(expandFigures(raw.figures as FigureRef[], figureDict));
  }
  return parseSections(raw.sections);
}

export interface LoadedDef {
  name: string;
  sections: ClassedSection[];
  def: TrackDef;
}

function load(raw: { name: string; figures?: unknown; sections?: unknown }): LoadedDef {
  const sections = trackSections(raw);
  return { name: raw.name, sections, def: resolveSections(sections, curveClasses) };
}

/** The test loop (R31 figures): classed sections (for tests and the ribbon map) and the resolved TrackDef. */
export function loadTestTwisty(): LoadedDef {
  return load(twisty);
}

/** R31b: the game's main track. */
export const DEFAULT_TRACK = 'drift-run';

/** Track by name (?track=): drift-run or test-twisty; anything else is the default track. */
export function loadTrackByName(name: string): LoadedDef {
  return load(name === twisty.name ? twisty : driftRun);
}

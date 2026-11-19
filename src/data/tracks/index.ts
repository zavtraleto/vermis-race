import type { TrackDef, TrackSection } from '../../sim/types';
import curves from './curves.json';
import twisty from './test-twisty.json';

export type CurveClass = 'easy' | 'medium' | 'hard';
export type CurveClasses = Record<CurveClass, number>;

/** Track section as stored in src/data/tracks/*.json: steepness class + side instead of a raw curve. */
export interface ClassedSection {
  enter: number;
  hold: number;
  leave: number;
  curveClass: CurveClass;
  side: -1 | 1; // +1 right, -1 left
  hill?: number; // R30 height change over the section, segment lengths (+ up)
}

export const curveClasses: CurveClasses = curves;

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
    if (curveClass !== 'easy' && curveClass !== 'medium' && curveClass !== 'hard') {
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

/** curve = side * classes[curveClass]; lengths copied as is. */
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
        curve: s.side * classes[s.curveClass],
      };
      if (s.hill !== undefined) out.hill = s.hill;
      return out;
    }),
  };
}

/** The grey test loop: classed sections (for tests and the ribbon map) and the resolved TrackDef. */
export function loadTestTwisty(): { name: string; sections: ClassedSection[]; def: TrackDef } {
  const sections = parseSections(twisty.sections);
  return { name: twisty.name, sections, def: resolveSections(sections, curveClasses) };
}

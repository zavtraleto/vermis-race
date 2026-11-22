// npm run trackmap: for every track in src/data/tracks, writes docs/tracks/<name>.svg (top-down
// outline integrated from segment curvature, coloured by class, figure labels, start marker,
// elevation strip) and docs/tracks/<name>.md (one row per figure placement, R31).
import {
  figureDict,
  type ClassedSection,
  type FigureRef,
  type SectionClass,
} from '../src/data/tracks';
import { SEG_PER_UNIT } from '../src/sim/constants';
import { loadTracks, TRACK_DIR, type LoadedTrack } from './botlib';
import type { Io } from './io';

const OUT_DIR = 'docs/tracks';
const COLOURS: Record<SectionClass, string> = {
  straight: '#9a9a9a',
  easy: '#3a9d4a',
  medium: '#e08a1e',
  hard: '#d0312d',
  sharp: '#7b1fa2',
};

// Plan-view turn per curve unit (the old K_HEADING placeholder 1; R210 roadTurn will replace it).
const K_HEADING = 1;

interface Placement {
  figure: string;
  side: -1 | 1;
  hill: number;
  first: number; // index of the first section
  count: number; // sections of this placement
}

function placementsOf(
  raw: { figures?: unknown },
  sections: readonly ClassedSection[],
): Placement[] {
  const out: Placement[] = [];
  if (Array.isArray(raw.figures)) {
    let first = 0;
    for (const r of raw.figures as FigureRef[]) {
      const count = figureDict[r.figure]!.parts.length;
      out.push({ figure: r.figure, side: r.side, hill: r.hill ?? 0, first, count });
      first += count;
    }
  } else {
    sections.forEach((s, i) =>
      out.push({ figure: s.curveClass, side: s.side, hill: s.hill ?? 0, first: i, count: 1 }),
    );
  }
  return out;
}

/** Plan-view points: one unit step per segment, heading += curve*K_HEADING/SEG_PER_UNIT (R17 per segment at any speed). */
function outline(t: LoadedTrack): { x: number[]; y: number[] } {
  const segs = t.track.segments;
  const x = [0];
  const y = [0];
  let h = 0;
  for (const s of segs) {
    h += (s.curve * K_HEADING) / SEG_PER_UNIT;
    x.push(x[x.length - 1]! + Math.sin(h));
    y.push(y[y.length - 1]! - Math.cos(h)); // screen y down, start heading up
  }
  return { x, y };
}

const f1 = (v: number): string => v.toFixed(1);

function svg(t: LoadedTrack, pl: Placement[]): { text: string; gap: number } {
  const { x, y } = outline(t);
  const n = t.track.segments.length;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i <= n; i++) {
    minX = Math.min(minX, x[i]!);
    maxX = Math.max(maxX, x[i]!);
    minY = Math.min(minY, y[i]!);
    maxY = Math.max(maxY, y[i]!);
  }
  const W = 900;
  const pad = 40; // the map keeps an extra pad on the right for labels
  const scale = (W - 3 * pad) / Math.max(maxX - minX, maxY - minY, 1);
  const mapH = (maxY - minY) * scale + 2 * pad + 10;
  const profH = 120;
  const H = mapH + profH + 40;
  const px = (i: number): string => f1(pad + (x[i]! - minX) * scale);
  const py = (i: number): string => f1(pad + 10 + (y[i]! - minY) * scale);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${f1(H)}" viewBox="0 0 ${W} ${f1(H)}" font-family="sans-serif">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="${pad}" y="22" font-size="16">${t.name}: ${n} segments, ${(n / SEG_PER_UNIT).toFixed(1)} s at vmax</text>`,
  );
  // Sections, coloured by class.
  let seg = 0;
  for (const s of t.sections) {
    const len = s.enter + s.hold + s.leave;
    const pts: string[] = [];
    for (let i = seg; i <= seg + len; i++) pts.push(`${px(i)},${py(i)}`);
    parts.push(
      `<polyline points="${pts.join(' ')}" fill="none" stroke="${COLOURS[s.curveClass]}" stroke-width="4" stroke-linejoin="round"/>`,
    );
    seg += len;
  }
  // Figure labels at the middle of each placement.
  const startOf: number[] = [];
  let acc = 0;
  for (const s of t.sections) {
    startOf.push(acc);
    acc += s.enter + s.hold + s.leave;
  }
  pl.forEach((p, k) => {
    const a = startOf[p.first]!;
    const b = p.first + p.count < startOf.length ? startOf[p.first + p.count]! : n;
    const mid = Math.floor((a + b) / 2);
    parts.push(
      `<text x="${px(mid)}" y="${py(mid)}" font-size="12" fill="#222" stroke="#fff" stroke-width="3" paint-order="stroke">${k + 1} ${p.figure} ${p.side > 0 ? 'R' : 'L'}</text>`,
    );
  });
  // Start marker and the loose end.
  parts.push(
    `<circle cx="${px(0)}" cy="${py(0)}" r="7" fill="#1565c0"/>`,
    `<text x="${f1(Number(px(0)) + 10)}" y="${f1(Number(py(0)) - 8)}" font-size="13" fill="#1565c0">START</text>`,
    `<circle cx="${px(n)}" cy="${py(n)}" r="4" fill="none" stroke="#1565c0" stroke-width="2"/>`,
  );
  // Legend.
  (['straight', 'easy', 'medium', 'hard', 'sharp'] as const).forEach((c, i) => {
    const lx = W - pad - 375 + i * 75;
    const ly = 18;
    parts.push(
      `<line x1="${lx}" y1="${ly}" x2="${lx + 20}" y2="${ly}" stroke="${COLOURS[c]}" stroke-width="4"/>`,
      `<text x="${lx + 26}" y="${ly + 4}" font-size="12">${c}</text>`,
    );
  });
  // Elevation profile strip (R30): y over z.
  const segs = t.track.segments;
  let minE = 0;
  let maxE = 0;
  for (const s of segs) {
    minE = Math.min(minE, s.y ?? 0);
    maxE = Math.max(maxE, s.y ?? 0);
  }
  const top = mapH + 20;
  const ey = (v: number): string =>
    f1(top + profH - ((v - minE) / Math.max(maxE - minE, 1)) * profH);
  const ex = (i: number): string => f1(pad + (i / n) * (W - 2 * pad));
  const prof: string[] = [`${ex(0)},${ey(0)}`];
  for (let i = 0; i < n; i++) prof.push(`${ex(i + 1)},${ey(segs[i]!.y ?? 0)}`);
  parts.push(
    `<rect x="${pad}" y="${f1(top)}" width="${W - 2 * pad}" height="${profH}" fill="#f4f4f4"/>`,
    `<line x1="${pad}" y1="${ey(0)}" x2="${W - pad}" y2="${ey(0)}" stroke="#bbb" stroke-dasharray="4 4"/>`,
    `<polyline points="${prof.join(' ')}" fill="none" stroke="#555" stroke-width="2"/>`,
    `<text x="${pad + 4}" y="${f1(top + 14)}" font-size="12">elevation, ${f1(minE)}..${f1(maxE)} segment lengths</text>`,
    '</svg>',
  );
  const gap = Math.hypot(x[n]! - x[0]!, y[n]! - y[0]!);
  return { text: parts.join('\n') + '\n', gap };
}

function md(t: LoadedTrack, pl: Placement[], gap: number): string {
  const n = t.track.segments.length;
  // R31b: share of corner length (all non-straight sections) in classes that need a drift (hard, sharp).
  let cornerLen = 0;
  let driftLen = 0;
  for (const s of t.sections) {
    if (s.curveClass === 'straight') continue;
    const len = s.enter + s.hold + s.leave;
    cornerLen += len;
    if (s.curveClass === 'hard' || s.curveClass === 'sharp') driftLen += len;
  }
  let turn = 0;
  for (const s of t.track.segments) turn += (s.curve * K_HEADING) / SEG_PER_UNIT;
  const lines = [
    `# Трасса ${t.name}`,
    '',
    `Сгенерировано \`npm run trackmap\` из \`${TRACK_DIR}\` (R31). Схема: [${t.name}.svg](${t.name}.svg).`,
    '',
    `Длина ${n} сегментов, ${(n / SEG_PER_UNIT).toFixed(1)} с на \`vmax\`. Угол удержания и скорость — R22b из \`cars/base.json\` (установившийся дрифт на \`hold\` класса).`,
    '',
    `Схема псевдо-3D, сама по себе не замыкается: конец кольца отстоит от старта на ${gap.toFixed(0)} сегментов, суммарный поворот курса ${turn.toFixed(1)} рад (\`K_HEADING\` ${K_HEADING}).`,
    '',
    `Повороты — ${cornerLen} сегментов (${((100 * cornerLen) / n).toFixed(0)}% круга); из них нужен дрифт (\`hard\`, \`sharp\`) на ${((100 * driftLen) / Math.max(cornerLen, 1)).toFixed(0)}% (R31b: 45–65%).`,
    '',
    '| # | фигура | сторона | сегментов | классы | hill |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  pl.forEach((q, k) => {
    const secs = t.sections.slice(q.first, q.first + q.count);
    const len = secs.reduce((a, s) => a + s.enter + s.hold + s.leave, 0);
    const cls = secs.map((s) => `${s.curveClass} ${s.side > 0 ? 'R' : 'L'}`).join(' → ');
    lines.push(
      `| ${k + 1} | ${q.figure} | ${q.side > 0 ? 'R' : 'L'} | ${len} | ${cls} | ${q.hill} |`,
    );
  });
  return lines.join('\n') + '\n';
}

export function main(io: Io): number {
  if (!io.exists(OUT_DIR)) {
    io.log(`${OUT_DIR} does not exist; create it first`);
    return 2;
  }
  for (const t of loadTracks(io)) {
    const raw = JSON.parse(io.read(`${TRACK_DIR}/${t.file ?? `${t.name}.json`}`)) as {
      figures?: unknown;
    };
    const pl = placementsOf(raw, t.sections);
    const { text, gap } = svg(t, pl);
    io.write(`${OUT_DIR}/${t.name}.svg`, text);
    io.write(`${OUT_DIR}/${t.name}.md`, md(t, pl, gap));
    io.log(
      `wrote ${OUT_DIR}/${t.name}.svg and .md: ${pl.length} placements, ends ${gap.toFixed(0)} apart`,
    );
  }
  return 0;
}

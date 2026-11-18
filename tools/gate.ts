// npm run gate [-- --update-baseline [--force]]: reads results.json + gate.config.json,
// prints the metric table and a verdict GO / CONDITIONAL / NO-GO (kickoff-process section 7).
// Tier 1 stability, tier 2 balance corridor, tier 3 regression against results.baseline.json.
// Exit code: 0 for GO and CONDITIONAL, 1 for NO-GO, 2 for a usage/input error.
import { loadTracks, metricOf, runOne, type BotName, type Entry, type Results } from './botlib';
import {
  BASELINE,
  GATE_CONFIG,
  readGateConfig,
  RESULTS,
  type BoundRule,
  type GapRule,
  type GateConfig,
} from './gateConfig';
import type { Io } from './io';

type Status = 'PASS' | 'COND' | 'FAIL' | 'SKIP';
export type Verdict = 'GO' | 'CONDITIONAL' | 'NO-GO';

interface Check {
  tier: 1 | 2 | 3;
  id: string;
  scope: string;
  value: string;
  bound: string;
  status: Status;
}

const pct = (v: number): string => `${(100 * v).toFixed(1)}%`;
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : String(v));

function bounds(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `[${min}, ${max}]`;
  if (min !== undefined) return `>= ${min}`;
  if (max !== undefined) return `<= ${max}`;
  return '-';
}

function boundsOf(r: BoundRule): string {
  return r.above !== undefined ? `> ${r.above}` : bounds(r.min, r.max);
}

function within(v: number, min: number | undefined, max: number | undefined): boolean {
  return (min === undefined || v >= min) && (max === undefined || v <= max);
}

function hasNaN(v: unknown): boolean {
  if (typeof v === 'number') return Number.isNaN(v);
  if (Array.isArray(v)) return v.some(hasNaN);
  if (typeof v === 'object' && v !== null) return Object.values(v).some(hasNaN);
  return false;
}

function table(rows: string[][]): string[] {
  const w = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  return rows.map((r) =>
    r
      .map((cell, c) => cell.padEnd(w[c]!))
      .join('  ')
      .trimEnd(),
  );
}

function stability(io: Io, res: Results, cfg: GateConfig, out: Check[]): void {
  for (const e of res.entries) {
    const scope = `${e.bot}/${e.track}`;
    out.push({
      tier: 1,
      id: 'finished',
      scope,
      value: `${Math.round(e.finishedFraction * e.runs)}/${e.runs}`,
      bound: 'all',
      status: e.finishedFraction === 1 ? 'PASS' : 'FAIL',
    });
    const bad = e.nan || hasNaN({ ...e, corners: [] });
    out.push({
      tier: 1,
      id: 'no-NaN',
      scope,
      value: bad ? 'NaN' : 'ok',
      bound: '-',
      status: bad ? 'FAIL' : 'PASS',
    });
  }
  // Re-run one seed per bot/track now and compare with the fingerprint stored in results.json.
  const tracks = loadTracks(io);
  const seed = cfg.determinismSeed;
  for (const e of res.entries) {
    const t = tracks.find((x) => x.name === e.track);
    const want = e.fingerprints[String(seed)];
    const scope = `${e.bot}/${e.track} seed ${seed}`;
    if (!t || want === undefined) {
      out.push({
        tier: 1,
        id: 'deterministic',
        scope,
        value: 'missing',
        bound: 'match',
        status: 'FAIL',
      });
      continue;
    }
    const got = runOne(e.bot, t, seed, res.measure).fingerprint;
    out.push({
      tier: 1,
      id: 'deterministic',
      scope,
      value: got === want ? got : `${got} != ${want}`,
      bound: 'match',
      status: got === want ? 'PASS' : 'FAIL',
    });
  }
}

function corridor(res: Results, cfg: GateConfig, out: Check[]): void {
  const fail = (sev: string): Status => (sev === 'conditional' ? 'COND' : 'FAIL');
  for (const track of res.tracks) {
    const of = (bot: string): Entry | undefined =>
      res.entries.find((e) => e.track === track && e.bot === bot);
    for (const rule of cfg.corridor) {
      if (rule.type === 'gap') {
        const g = rule as GapRule;
        const fast = of(g.fast);
        const slow = of(g.slow);
        const a = fast && metricOf(fast, g.metric);
        const b = slow && metricOf(slow, g.metric);
        const scope = `${g.fast} vs ${g.slow}/${track}`;
        if (a === undefined || b === undefined || !b) {
          out.push({
            tier: 2,
            id: g.id,
            scope,
            value: 'missing',
            bound: bounds(g.min, g.max),
            status: 'FAIL',
          });
          continue;
        }
        const gap = (b - a) / b;
        out.push({
          tier: 2,
          id: g.id,
          scope,
          value: pct(gap),
          bound: bounds(g.min, g.max),
          status: within(gap, g.min, g.max) ? 'PASS' : fail(g.severity),
        });
        continue;
      }
      const r = rule as BoundRule;
      const bots =
        r.bot === '*' ? res.entries.filter((e) => e.track === track).map((e) => e.bot) : [r.bot];
      for (const bot of bots) {
        const e = of(bot);
        const v = e && metricOf(e, r.metric);
        const scope = `${bot}/${track}`;
        if (v === undefined) {
          out.push({
            tier: 2,
            id: r.id,
            scope,
            value: 'missing',
            bound: boundsOf(r),
            status: 'FAIL',
          });
          continue;
        }
        out.push({
          tier: 2,
          id: r.id,
          scope,
          value: f2(v),
          bound: boundsOf(r),
          status:
            within(v, r.min, r.max) && (r.above === undefined || v > r.above)
              ? 'PASS'
              : fail(r.severity),
        });
      }
    }
  }
}

function regression(res: Results, base: Results | null, cfg: GateConfig, out: Check[]): void {
  if (!base) {
    out.push({
      tier: 3,
      id: 'baseline',
      scope: '-',
      value: `no ${BASELINE}`,
      bound: '-',
      status: 'SKIP',
    });
    return;
  }
  const rg = cfg.regression;
  for (const e of res.entries) {
    const b = base.entries.find((x) => x.bot === e.bot && x.track === e.track);
    if (!b) continue;
    for (const m of rg.metrics) {
      const cur = metricOf(e, m.metric);
      const old = metricOf(b, m.metric);
      if (cur === undefined || old === undefined) continue;
      const delta = m.better === 'lower' ? cur - old : old - cur;
      const worse = delta / Math.max(Math.abs(old), m.floor);
      let status: Status = 'PASS';
      if (worse > rg.noGoWorseBy) status = 'FAIL';
      else if (worse > rg.conditionalWorseBy) status = 'COND';
      out.push({
        tier: 3,
        id: m.metric,
        scope: `${e.bot}/${e.track}`,
        value: `${f2(old)} -> ${f2(cur)} (${worse > 0 ? '+' : ''}${pct(worse)} worse)`,
        bound: `<= ${pct(rg.conditionalWorseBy)} / ${pct(rg.noGoWorseBy)}`,
        status,
      });
    }
  }
}

function metricTable(res: Results): string[] {
  const head = [
    'bot/track',
    'lap mean',
    'sd',
    'best',
    'fly mean',
    'fly sd',
    'off time',
    'off/lap',
    'e+m/lap',
    'hard/lap',
    'sat',
    'v mean',
    'v min',
    'brake',
    'dead',
    'walls',
  ];
  const rows = [head];
  for (const e of res.entries) {
    rows.push([
      `${e.bot}/${e.track}`,
      f2(e.lapTime.mean),
      f2(e.lapTime.stdev),
      f2(e.lapTime.best),
      f2(e.flyingLap.mean),
      f2(e.flyingLap.stdev),
      pct(e.offroadFraction),
      f2(e.offroadEventsPerLap.total),
      f2(e.offroadEventsPerLap.easyMedium),
      f2(e.offroadEventsPerLap.hard),
      pct(e.steerSaturation),
      f2(e.speed.mean),
      f2(e.speed.min),
      pct(e.brakeFraction),
      pct(e.deadTimeFraction),
      String(e.wallHits.total),
    ]);
  }
  return table(rows);
}

function cornerTable(res: Results): string[] {
  const out: string[] = [];
  for (const track of res.tracks) {
    const es = res.entries.filter((e) => e.track === track);
    const first = es[0];
    if (!first) continue;
    const head = [
      '#',
      'class',
      'side',
      ...es.flatMap((e) => [`${e.bot} v in`, 'max|x|', 'off/lap']),
    ];
    const rows = [head];
    first.corners.forEach((c, i) => {
      rows.push([
        String(i),
        c.curveClass,
        c.side > 0 ? 'R' : 'L',
        ...es.flatMap((e) => {
          const k = e.corners[i]!;
          return [f2(k.entrySpeed.mean), f2(k.maxAbsX), f2(k.offroadEventsPerLap)];
        }),
      ]);
    });
    out.push(
      `corners on ${track} (v in = speed/vmax at hold start, mean over laps and seeds):`,
      ...table(rows),
    );
  }
  return out;
}

export function verdictOf(checks: readonly Check[]): Verdict {
  if (checks.some((c) => c.status === 'FAIL')) return 'NO-GO';
  if (checks.some((c) => c.status === 'COND')) return 'CONDITIONAL';
  return 'GO';
}

export function main(io: Io): number {
  if (!io.exists(RESULTS)) {
    io.log(`${RESULTS} not found: run npm run bot first`);
    return 2;
  }
  const cfg = readGateConfig(io.read(GATE_CONFIG));
  const res = JSON.parse(io.read(RESULTS)) as Results;
  const base = io.exists(BASELINE) ? (JSON.parse(io.read(BASELINE)) as Results) : null;
  const checks: Check[] = [];
  stability(io, res, cfg, checks);
  corridor(res, cfg, checks);
  regression(res, base, cfg, checks);

  io.log(
    `results: ${res.tracks.join(', ')} | ${res.seeds.length} seeds x ${res.laps} laps | car ${res.car}`,
  );
  io.log('');
  for (const l of metricTable(res)) io.log(l);
  io.log('');
  for (const l of cornerTable(res)) io.log(l);
  const names: Record<number, string> = { 1: 'stability', 2: 'balance corridor', 3: 'regression' };
  for (const tier of [1, 2, 3] as const) {
    const cs = checks.filter((c) => c.tier === tier);
    io.log('');
    io.log(`tier ${tier}: ${names[tier]} — ${verdictOf(cs)}`);
    const rows = [['status', 'check', 'scope', 'value', 'bound']];
    for (const c of cs) rows.push([c.status, c.id, c.scope, c.value, c.bound]);
    for (const l of table(rows)) io.log(`  ${l}`);
  }
  const verdict = verdictOf(checks);
  io.log('');
  io.log(`VERDICT: ${verdict}`);

  if (io.argv.includes('--update-baseline')) {
    if (verdict === 'GO' || io.argv.includes('--force')) {
      io.write(BASELINE, io.read(RESULTS));
      io.log(`saved ${RESULTS} as ${BASELINE}`);
    } else {
      io.log(`baseline not updated: verdict is ${verdict} (add --force to save anyway)`);
    }
  }
  return verdict === 'NO-GO' ? 1 : 0;
}

export type { BotName };

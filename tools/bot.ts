// npm run bot [-- --seeds N]: every bot x every track in src/data/tracks x N seeds, headless.
// Writes results.json for tools/gate.ts.
import { BOT_NAMES, loadTracks, runOne, summarize, type Entry, type Results } from './botlib';
import { GATE_CONFIG, readGateConfig, RESULTS } from './gateConfig';
import { argValue, type Io } from './io';

export function main(io: Io): number {
  const cfg = readGateConfig(io.read(GATE_CONFIG));
  const seedsArg = argValue(io.argv, 'seeds');
  const nSeeds = seedsArg === undefined ? cfg.defaultSeeds : Number(seedsArg);
  if (!Number.isInteger(nSeeds) || nSeeds < 1) {
    io.log(`--seeds must be a positive integer, got ${String(seedsArg)}`);
    return 2;
  }
  const seeds: number[] = [];
  for (let s = 1; s <= nSeeds; s++) seeds.push(s);
  const tracks = loadTracks(io);
  const m = cfg.measure;
  const entries: Entry[] = [];
  for (const t of tracks) {
    for (const bot of BOT_NAMES) {
      const runs = seeds.map((s) => runOne(bot, t, s, m));
      const e = summarize(bot, t, runs, m.laps);
      entries.push(e);
      io.log(
        `${t.name.padEnd(12)} ${bot.padEnd(8)} lap ${e.lapTime.mean.toFixed(2)} s ` +
          `(sd ${e.lapTime.stdev.toFixed(2)}, best ${e.lapTime.best.toFixed(2)})  ` +
          `off ${(100 * e.offroadFraction).toFixed(1)}%  finished ${e.finishedFraction * runs.length}/${runs.length}`,
      );
    }
  }
  const results: Results = {
    version: 1,
    car: 'base',
    laps: m.laps,
    seeds,
    measure: m,
    tracks: tracks.map((t) => t.name),
    entries,
  };
  io.write(RESULTS, JSON.stringify(results, null, 2) + '\n');
  io.log(
    `wrote ${RESULTS}: ${entries.length} bot/track entries x ${seeds.length} seeds x ${m.laps} laps`,
  );
  return 0;
}

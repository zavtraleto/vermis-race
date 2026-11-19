// npm run bot [-- --seeds N]: every bot x every track in src/data/tracks x N seeds, headless.
// Writes results.json for tools/gate.ts.
import {
  BOT_NAMES,
  EXPERT_BLIND,
  loadTracks,
  runBlindTraffic,
  runOne,
  runOneTraffic,
  summarize,
  summarizeTraffic,
  type Entry,
  type Results,
  type TrafficEntry,
} from './botlib';
import { recoverySeconds } from '../src/bot/recovery';
import { baseCar } from '../src/data/cars';
import { curveClasses } from '../src/data/tracks';
import { GATE_CONFIG, readGateConfig, RESULTS } from './gateConfig';
import { argValue, type Io } from './io';

function trafficLine(label: string, tr: TrafficEntry): string {
  return (
    `${''.padEnd(12)} ${label.padEnd(8)} lap ${tr.lapTime.traffic.toFixed(2)} s ` +
    `(x${tr.lapTime.ratio.toFixed(3)})  bumps/lap ${tr.bumpsPerLap.toFixed(2)}  ` +
    `in drift/lap ${tr.bumpsInDriftPerLap.toFixed(2)}  ` +
    `runs w/o drift bump ${(100 * tr.zeroDriftBumpRuns).toFixed(0)}%  ` +
    `passed/lap ${tr.passedPerLap.toFixed(1)}  boosts/lap ${tr.boostsPerLap.toFixed(2)}  crashes/lap ${tr.crashesPerLap.toFixed(2)}  finished ${tr.finishedFraction * tr.runs}/${tr.runs}`
  );
}

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
  const traffic: TrafficEntry[] = [];
  for (const t of tracks) {
    for (const bot of BOT_NAMES) {
      const runs = seeds.map((s) => runOne(bot, t, s, m));
      const e = summarize(bot, t, runs, m);
      entries.push(e);
      io.log(
        `${t.name.padEnd(12)} ${bot.padEnd(8)} lap ${e.lapTime.mean.toFixed(2)} s ` +
          `(sd ${e.lapTime.stdev.toFixed(2)}, best ${e.lapTime.best.toFixed(2)})  ` +
          `off ${(100 * e.offroadFraction).toFixed(1)}%  crashes/lap ${e.crashesPerLap.toFixed(2)}  finished ${e.finishedFraction * runs.length}/${runs.length}`,
      );
      // R46: the same seeds again with the traffic pool.
      const tr = summarizeTraffic(
        e,
        seeds.map((s) => runOneTraffic(bot, t, s, m)),
        m,
      );
      traffic.push(tr);
      io.log(trafficLine('+traffic', tr));
      if (bot === 'expert') {
        // R46: expert pace with avoidance off, compared with the weaving expert.
        const bl = summarizeTraffic(
          e,
          seeds.map((s) => runBlindTraffic(t, s, m)),
          m,
          EXPERT_BLIND,
        );
        bl.vsWeaving = bl.lapTime.traffic / tr.lapTime.traffic;
        traffic.push(bl);
        io.log(
          `${t.name.padEnd(12)} ${EXPERT_BLIND}
` +
            trafficLine('+traffic', bl) +
            `  vs weaving x${bl.vsWeaving.toFixed(3)}`,
        );
      }
    }
  }
  const { curveClass, speed, depth, maxSeconds } = cfg.recovery;
  const rec = { curveClass, speed, depth };
  const secs = recoverySeconds(
    { curve: curveClasses[curveClass], speed, depth, maxSeconds },
    baseCar,
  );
  io.log(
    `recovery after an exit on ${curveClass} at ${speed} vmax, ${depth} beyond the edge: ${secs.toFixed(2)} s`,
  );
  const results: Results = {
    version: 1,
    car: 'base',
    laps: m.laps,
    seeds,
    measure: m,
    tracks: tracks.map((t) => t.name),
    entries,
    traffic,
    recovery: { ...rec, seconds: Number.isFinite(secs) ? secs : null },
  };
  io.write(RESULTS, JSON.stringify(results, null, 2) + '\n');
  io.log(
    `wrote ${RESULTS}: ${entries.length} bot/track entries x ${seeds.length} seeds x ${m.laps} laps`,
  );
  return 0;
}

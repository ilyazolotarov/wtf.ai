// Outage benchmark: replays every log with simulated GNSS outages at fixed windows and
// aggregates the held-out error, so navigator changes can be compared on the same drives.
//
//   npm run replay:bench -- tools/triplog/logs/*.ulg
//   npm run replay:bench -- tools/triplog/logs/*.ulg --nav '{"ekf":{"initYawScaleSigma":0}}'
//   npm run replay:bench -- tools/triplog/logs/*.ulg --mm [--seeds 3] [--mm-config '{"particles":1000}'] [--graph <file>]
//   npm run replay:bench -- tools/triplog/logs/*.ulg --jam-start [--every 60] [--seeds 3] [--mm-config '<json>'] [--graph <file>]
//
// With --mm the particle filter runs in every window (open loop) and its dominant cluster is
// scored against the same held-out fixes as the EKF (MAPMATCH-SPEC §10.2). --jam-start runs the
// heading-init benchmark instead (init-bench.ts, MAPMATCH-SPEC §8).
//
// The particle filter is random and one run of it is noisy, so whatever uses it runs with `--seeds`
// seeds (default 3, from `--mm-config`'s `seed`, else 1) and the results are pooled. With the map the
// EKF varies by seed too (a map start sets its pose); without it, it is deterministic and runs once.
// `--seeds 1` for a quick look.

import { readFileSync } from "node:fs";
import path from "node:path";

import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { NavConfig } from "../../src/nav/navigator";
import { replayTrip, type CutResult, type ReplayOptions } from "../../src/nav/replay/replay";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";
import { runInitBench } from "./init-bench";

const DURATIONS_S = [60, 120, 240];
/** Particle-filter runs pooled per window or session (one seed is too noisy to compare changes by). */
const DEFAULT_SEEDS = 3;
const STEP_S = 30;
/** A window counts when held-out satellite fixes cover most of it (clean GNSS). */
const MIN_TRUTH_SHARE = 0.8;
/** And the car actually drives in it. */
const MIN_DISTANCE_M = 200;
/**
 * And the phone is in the car: skip windows with this many satellite fixes moving while OBD reads 0
 * or is silent (a driver walking off with the phone after parking; the odometry can't follow that).
 * One or two such fixes are normal when stopping: CoreLocation's speed lags OBD.
 */
const MAX_PHONE_AWAY_FIXES = 5;

/** Log times (s) of satellite fixes that move while OBD says the car doesn't (or says nothing). */
function phoneAwayTimes(trip: TripLog): number[] {
  const obd = trip.obdSpeed;
  const out: number[] = [];
  let j = 0;
  for (const f of trip.gnss) {
    if (!isSatelliteFix(f) || f.speedMps === undefined) continue;
    while (j + 1 < obd.length && obd[j + 1].tUs <= f.tUs) j++;
    const o = obd[j];
    const fresh = o !== undefined && o.tUs <= f.tUs && f.tUs - o.tUs < 2_500_000;
    if ((fresh && o.rawKph === 0 && f.speedMps >= 1.5) || (!fresh && f.speedMps >= 1)) out.push((f.tUs - trip.startUs) / 1e6);
  }
  return out;
}

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let nav: Partial<NavConfig> = {};
  let verbose = false;
  let mm = false;
  let mmConfig: Partial<MapMatchConfig> = {};
  let graph: string | undefined;
  let jamStart = false;
  let compass = false;
  let everyS = 60;
  let seedCount = DEFAULT_SEEDS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nav") nav = JSON.parse(argv[++i]) as Partial<NavConfig>;
    else if (argv[i] === "--verbose") verbose = true;
    else if (argv[i] === "--mm") mm = true;
    else if (argv[i] === "--mm-config") mmConfig = JSON.parse(argv[++i]) as Partial<MapMatchConfig>;
    else if (argv[i] === "--graph") graph = argv[++i];
    else if (argv[i] === "--jam-start") jamStart = true;
    else if (argv[i] === "--compass") compass = true;
    else if (argv[i] === "--every") everyS = Number(argv[++i]);
    else if (argv[i] === "--seeds") seedCount = Number(argv[++i]);
    else files.push(argv[i]);
  }
  if (!(Number.isInteger(seedCount) && seedCount >= 1)) throw new Error("--seeds takes a whole number ≥ 1");
  const first = mmConfig.seed ?? 1;
  const seeds = Array.from({ length: seedCount }, (_, k) => first + k);
  return { files, nav, verbose, mm, mmConfig, graph, jamStart, everyS, compass, seeds };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
/** Share of held-out fixes inside the map's circle, over all windows (honest ≈ 68 %). */
const insidePct = (cuts: CutResult[]) => {
  const scored = cuts.filter((c) => c.insideCircle !== null);
  const fixes = scored.reduce((n, c) => n + c.truthFixes, 0);
  return fixes ? `${Math.round((100 * scored.reduce((n, c) => n + c.insideCircle! * c.truthFixes, 0)) / fixes)} %` : "—";
};
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};

function main() {
  const { files, nav, verbose, mm, mmConfig, graph: graphArg, jamStart, everyS, compass, seeds } = parseArgs(process.argv.slice(2));
  if (jamStart) {
    runInitBench(files, { nav, mmConfig, graph: graphArg, everyS, verbose, compass, seeds });
    return;
  }
  const byDuration = new Map<number, (CutResult & { file: string })[]>(DURATIONS_S.map((d) => [d, []]));
  /** Map matching, one entry per window and seed (the EKF's max error alongside, for "better than"). */
  const mmByDuration = new Map<number, { maxM: number; endM: number; ekfMaxM: number }[]>(DURATIONS_S.map((d) => [d, []]));
  const runSeeds = mm ? seeds : [seeds[0]];

  for (const file of files) {
    const trip = readTripLog(new Uint8Array(readFileSync(file)));
    const base = replayTrip(trip, { nav });
    if (!base.summary.init) continue;
    let opened: ReturnType<typeof openGraph> | null = null;
    if (mm) {
      const first = trip.gnss.find((f) => isSatelliteFix(f) && f.hAccM <= 10) ?? trip.gnss.find((f) => f.hAccM < 500);
      const graphFile = graphArg ?? (first ? findGraph(first) : null);
      if (!graphFile) throw new Error(`${path.basename(file)}: no road graph covers it (tiles graph <region>, or --graph)`);
      opened = openGraph(graphFile, first!);
    }
    const optionsFor = (seed: number): ReplayOptions => ({ nav, ...(opened ? { mapMatch: { graph: opened.graph, config: { ...mmConfig, seed } } } : {}) });
    // On a fixed grid of log time: a change that moves the EKF start by a few seconds then still
    // scores the same windows (a shifted grid samples other outages and moved the medians by 5 m).
    const from = Math.ceil((base.summary.init.tS + 10) / STEP_S) * STEP_S;
    const away = phoneAwayTimes(trip);
    for (const d of DURATIONS_S) {
      for (let t = from; t + d <= base.summary.durationS; t += STEP_S) {
        if (away.filter((a) => a >= t && a < t + d).length >= MAX_PHONE_AWAY_FIXES) continue;
        // With the map the EKF depends on the seed too: a map start sets the pose everything after carries.
        for (const seed of runSeeds) {
          const cut = replayTrip(trip, { ...optionsFor(seed), cuts: [{ fromS: t, toS: t + d }] }).summary.cuts[0];
          if (cut.truthFixes < MIN_TRUTH_SHARE * d || cut.distanceM < MIN_DISTANCE_M || cut.maxErrorM === null) break;
          byDuration.get(d)!.push({ ...cut, file: path.basename(file) });
          if (cut.mapMatchMaxErrorM !== null && cut.mapMatchMaxErrorM !== undefined) {
            mmByDuration.get(d)!.push({ maxM: cut.mapMatchMaxErrorM, endM: cut.mapMatchLastErrorM!, ekfMaxM: cut.maxErrorM });
          }
          if (verbose) {
            console.log(
              `  ${path.basename(file)} ${t}+${d}s${runSeeds.length > 1 ? ` #${seed}` : ""} ${(cut.distanceM / 1000).toFixed(2)} km: ` +
                `max ${cut.maxErrorM.toFixed(0)} m, end ${cut.lastErrorM!.toFixed(0)} m, σ ${cut.meanSigmaM!.toFixed(0)} m` +
                (mm ? ` | map match max ${cut.mapMatchMaxErrorM?.toFixed(0) ?? "—"} m, end ${cut.mapMatchLastErrorM?.toFixed(0) ?? "—"} m` : ""),
            );
          }
        }
      }
    }
    opened?.close();
  }

  if (runSeeds.length > 1) console.log(`${runSeeds.length} seeds (${runSeeds.join(", ")}) pooled: windows × seeds`);
  console.log("outage  windows  km/win   max err: median  p90   end err: median  p90   err per km  err/σ  inside circle");
  for (const [d, cuts] of byDuration) {
    if (!cuts.length) continue;
    const max = cuts.map((c) => c.maxErrorM!);
    const end = cuts.map((c) => c.lastErrorM!);
    const perKm = cuts.map((c) => c.lastErrorM! / (c.distanceM / 1000));
    const ratio = cuts.map((c) => c.maxErrorM! / Math.max(1, c.meanSigmaM!));
    console.log(
      `${String(d).padStart(4)} s  ${String(cuts.length).padStart(7)}  ${median(cuts.map((c) => c.distanceM / 1000)).toFixed(2).padStart(6)}` +
        `   ${median(max).toFixed(1).padStart(13)} ${pct(max, 0.9).toFixed(1).padStart(5)}` +
        `   ${median(end).toFixed(1).padStart(13)} ${pct(end, 0.9).toFixed(1).padStart(5)}` +
        `   ${median(perKm).toFixed(1).padStart(10)} ${median(ratio).toFixed(2).padStart(6)}  ${insidePct(cuts).padStart(13)}`,
    );
  }
  // Per drive, so one drive can't hide behind (or dominate) the pooled numbers.
  const drives = [...new Set([...byDuration.values()].flat().map((c) => c.file))].sort();
  console.log("\nper drive: windows, max err median (m), err/σ median, inside circle, per outage length");
  console.log(`${"drive".padEnd(28)}${DURATIONS_S.map((d) => `${String(d).padStart(4)} s: win  max err/σ    in`).join("  ")}`);
  for (const file of drives) {
    const cols = DURATIONS_S.map((d) => {
      const cuts = byDuration.get(d)!.filter((c) => c.file === file);
      if (!cuts.length) return "—".padStart(29);
      const ratio = cuts.map((c) => c.maxErrorM! / Math.max(1, c.meanSigmaM!));
      return `${String(cuts.length).padStart(11)} ${median(cuts.map((c) => c.maxErrorM!)).toFixed(0).padStart(4)} ${median(ratio).toFixed(2).padStart(5)} ${insidePct(cuts).padStart(5)}`;
    });
    console.log(`${file.padEnd(28)}${cols.join("  ")}`);
  }

  if (!mm) return;
  console.log("\nmap match (dominant cluster, open loop)");
  console.log("outage  windows   max err: median  p90   end err: median  p90   better than EKF (max)");
  for (const [d, scored] of mmByDuration) {
    if (!scored.length) continue;
    const max = scored.map((c) => c.maxM);
    const end = scored.map((c) => c.endM);
    const better = scored.filter((c) => c.maxM < c.ekfMaxM).length;
    console.log(
      `${String(d).padStart(4)} s  ${String(scored.length).padStart(7)}` +
        `   ${median(max).toFixed(1).padStart(13)} ${pct(max, 0.9).toFixed(1).padStart(5)}` +
        `   ${median(end).toFixed(1).padStart(13)} ${pct(end, 0.9).toFixed(1).padStart(5)}` +
        `   ${String(better).padStart(8)} of ${scored.length}`,
    );
  }
}

main();

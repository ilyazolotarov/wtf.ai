// Outage benchmark: replays every log with simulated GNSS outages at fixed windows and
// aggregates the held-out error, so navigator changes can be compared on the same drives.
//
//   npm run replay:bench -- tools/triplog/logs/*.ulg
//   npm run replay:bench -- tools/triplog/logs/*.ulg --nav '{"ekf":{"initYawScaleSigma":0}}'
//   npm run replay:bench -- tools/triplog/logs/*.ulg --mm [--mm-config '{"particles":1000}'] [--graph <file>]
//
// With --mm the particle filter runs in every window (open loop) and its dominant cluster is
// scored against the same held-out fixes as the EKF (MAPMATCH-SPEC §10.2).

import { readFileSync } from "node:fs";
import path from "node:path";

import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { NavConfig } from "../../src/nav/navigator";
import { replayTrip, type CutResult, type ReplayOptions } from "../../src/nav/replay/replay";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";

const DURATIONS_S = [60, 120, 240];
const STEP_S = 30;
/** A window counts when held-out satellite fixes cover most of it (clean GNSS). */
const MIN_TRUTH_SHARE = 0.8;
/** And the car actually drives in it. */
const MIN_DISTANCE_M = 200;

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let nav: Partial<NavConfig> = {};
  let verbose = false;
  let mm = false;
  let mmConfig: Partial<MapMatchConfig> = {};
  let graph: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nav") nav = JSON.parse(argv[++i]) as Partial<NavConfig>;
    else if (argv[i] === "--verbose") verbose = true;
    else if (argv[i] === "--mm") mm = true;
    else if (argv[i] === "--mm-config") mmConfig = JSON.parse(argv[++i]) as Partial<MapMatchConfig>;
    else if (argv[i] === "--graph") graph = argv[++i];
    else files.push(argv[i]);
  }
  return { files, nav, verbose, mm, mmConfig, graph };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};

function main() {
  const { files, nav, verbose, mm, mmConfig, graph: graphArg } = parseArgs(process.argv.slice(2));
  const byDuration = new Map<number, (CutResult & { file: string })[]>(DURATIONS_S.map((d) => [d, []]));

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
    const options: ReplayOptions = { nav, ...(opened ? { mapMatch: { graph: opened.graph, config: mmConfig } } : {}) };
    const from = Math.ceil(base.summary.init.tS + 10);
    for (const d of DURATIONS_S) {
      for (let t = from; t + d <= base.summary.durationS; t += STEP_S) {
        const cut = replayTrip(trip, { ...options, cuts: [{ fromS: t, toS: t + d }] }).summary.cuts[0];
        if (cut.truthFixes < MIN_TRUTH_SHARE * d || cut.distanceM < MIN_DISTANCE_M || cut.maxErrorM === null) continue;
        byDuration.get(d)!.push({ ...cut, file: path.basename(file) });
        if (verbose) {
          console.log(
            `  ${path.basename(file)} ${t}+${d}s ${(cut.distanceM / 1000).toFixed(2)} km: max ${cut.maxErrorM.toFixed(0)} m, end ${cut.lastErrorM!.toFixed(0)} m, σ ${cut.meanSigmaM!.toFixed(0)} m` +
              (mm ? ` | map match max ${cut.mapMatchMaxErrorM?.toFixed(0) ?? "—"} m, end ${cut.mapMatchLastErrorM?.toFixed(0) ?? "—"} m` : ""),
          );
        }
      }
    }
    opened?.close();
  }

  console.log("outage  windows  km/win   max err: median  p90   end err: median  p90   err per km  err/σ");
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
        `   ${median(perKm).toFixed(1).padStart(10)} ${median(ratio).toFixed(2).padStart(6)}`,
    );
  }
  if (!mm) return;
  console.log("\nmap match (dominant cluster, open loop)");
  console.log("outage  windows   max err: median  p90   end err: median  p90   better than EKF (max)");
  for (const [d, cuts] of byDuration) {
    const scored = cuts.filter((c) => c.mapMatchMaxErrorM !== null);
    if (!scored.length) continue;
    const max = scored.map((c) => c.mapMatchMaxErrorM!);
    const end = scored.map((c) => c.mapMatchLastErrorM!);
    const better = scored.filter((c) => c.mapMatchMaxErrorM! < c.maxErrorM!).length;
    console.log(
      `${String(d).padStart(4)} s  ${String(scored.length).padStart(7)}` +
        `   ${median(max).toFixed(1).padStart(13)} ${pct(max, 0.9).toFixed(1).padStart(5)}` +
        `   ${median(end).toFixed(1).padStart(13)} ${pct(end, 0.9).toFixed(1).padStart(5)}` +
        `   ${String(better).padStart(8)} of ${scored.length}`,
    );
  }
}

main();

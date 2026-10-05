// Map matching on trip logs (MAPMATCH-SPEC §10.2, M4): runs the particle filter in a replay and
// scores it against the ground truth (truth-match.ts).
// Usage: npm run replay:mm -- [--graph <file>] [--cut <startS>:<lenS>]... [--open-loop [delayS]] [--mm '<json config>']
//          [--nav '<json>'] [--start <s>] [--jam <startS>:<lenS|inf>]... [--trace <fromS>:<toS>] [--threads <n>] <logs>
// Drives run on worker threads, printed in the order given.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { NavConfig } from "../../src/nav/navigator";
import type { JamWindow } from "../../src/nav/replay/jam";
import { appOutageCuts, replayTrip, type ReplayCut } from "../../src/nav/replay/replay";
import { matchTruth } from "../../src/nav/replay/truth-match";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";
import { isMainThread, Pool, serveJobs, threadsArg } from "./pool";

function parseArgs(argv: string[]) {
  const files: string[] = [];
  const cuts: ReplayCut[] = [];
  let graph: string | undefined;
  let config: Partial<MapMatchConfig> = {};
  let nav: Partial<NavConfig> = {};
  let openLoopDelayS: number | undefined;
  let trace: [number, number] | undefined;
  const jam: JamWindow[] = [];
  let startAtS: number | undefined;
  let appCuts = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--graph") graph = argv[++i];
    else if (a === "--mm") config = JSON.parse(argv[++i]) as Partial<MapMatchConfig>;
    else if (a === "--nav") nav = JSON.parse(argv[++i]) as Partial<NavConfig>;
    else if (a === "--trace") {
      const [from, to] = argv[++i].split(":").map(Number);
      trace = [from, to];
    }
    else if (a === "--jam") {
      const [from, len] = argv[++i].split(":");
      jam.push({ fromS: Number(from), toS: len === "inf" ? Infinity : Number(from) + Number(len) });
    } else if (a === "--start") startAtS = Number(argv[++i]);
    else if (a === "--app-cuts") appCuts = true;
    else if (a === "--cut") {
      const [from, len] = argv[++i].split(":").map(Number);
      cuts.push({ fromS: from, toS: from + len });
    } else if (a === "--open-loop") {
      const next = argv[i + 1];
      openLoopDelayS = next !== undefined && /^\d+(\.\d+)?$/.test(next) ? Number(argv[++i]) : 0;
    } else if (a === "-h" || a === "--help") {
      console.log(
        "replay:mm [--graph <file>] [--cut <startS>:<lenS>]... [--open-loop [delayS]] [--app-cuts] [--mm '<json>'] [--nav '<json>'] [--start <s>] [--jam <startS>:<lenS|inf>]... [--trace <fromS>:<toS>] [--threads <n>] <trip.ulg...>",
      );
      process.exit(0);
    } else files.push(a);
  }
  if (!files.length) throw new Error("no trip log given (see --help)");
  return { files, cuts, graph, config, nav, openLoopDelayS, trace, jam, startAtS, appCuts };
}

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)} %`);
const m = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v)} m`);
const spans = (s: [number, number][]) => s.slice(0, 8).map(([a, b]) => (a === b ? `${a.toFixed(0)}` : `${a.toFixed(0)}–${b.toFixed(0)}`)).join(", ") + (s.length > 8 ? ", …" : "");

type Args = ReturnType<typeof parseArgs>;

/** One drive: what it prints. */
function runFile({ file, args }: { file: string; args: Args }): string[] {
  const out: string[] = [];
  const log = (line: string) => out.push(line);
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const first = trip.gnss.find((f) => isSatelliteFix(f) && f.hAccM <= 10) ?? trip.gnss.find((f) => f.hAccM < 500);
  if (!first) return [`== ${basename(file)}: no usable fixes`];
  const graphFile = args.graph ?? findGraph(first);
  if (!graphFile) throw new Error("no graph covers this trip: build one with `tiles graph <region>` or pass --graph");
  // Truth and the replay each get their own reader: the truth matcher moves the graph's frame.
  const truthGraph = openGraph(graphFile, first);
  const truth = matchTruth(trip, truthGraph.graph);
  const navGraph = openGraph(graphFile, first);
  const started = performance.now();
  const r = replayTrip(trip, {
    cuts: args.appCuts ? [...args.cuts, ...appOutageCuts(trip)] : args.cuts,
    openLoop: args.openLoopDelayS === undefined ? undefined : { delayS: args.openLoopDelayS },
    nav: args.nav,
    mapMatch: { graph: navGraph.graph, truth, config: args.config },
    jam: args.jam,
    startAtS: args.startAtS,
  });
  const ms = performance.now() - started;
  const s = r.summary.mapMatch!;
  log(`== ${basename(file)}  (${r.summary.durationS.toFixed(0)} s, ${(r.summary.obdDistanceM / 1000).toFixed(2)} km, graph ${basename(graphFile)}, replay ${(ms / 1000).toFixed(1)} s)`);
  const init = r.summary.init;
  log(
    `  init: ${init ? `${init.method} at ${init.tS.toFixed(0)} s after ${(init.distanceM / 1000).toFixed(2)} km` + (init.estimate ? ` (±${init.estimate.accuracyM.toFixed(0)} m, ±${(((init.estimate.headingSigmaRad ?? 0) * 180) / Math.PI).toFixed(1)}°)` : "") : "never"}; truth: ${truth.points.length} fixes matched`,
  );
  log(
    `  samples ${s.samples} (+${s.initSamples} init): wrong road ${pct(s.wrongRoadRate)}, truth survival ${pct(s.truthSurvival)}, multimodal ${pct(s.multimodalShare)}, off-road ${pct(s.offRoadShare)}`,
  );
  if (s.relock.count) {
    log(`  re-lock: ${s.relock.count}×, median ${s.relock.medianS!.toFixed(1)} s / ${m(s.relock.medianM)}, max ${s.relock.maxS!.toFixed(1)} s / ${m(s.relock.maxM)}`);
  }
  if (s.updateMs) {
    const starts = s.startMs ? `; ${s.startMs.count} start${s.startMs.count === 1 ? "" : "s"}, slowest ${s.startMs.max.toFixed(1)} ms` : "";
    log(`  update: p50 ${s.updateMs.p50.toFixed(2)} ms, p99 ${s.updateMs.p99.toFixed(2)} ms, max ${s.updateMs.max.toFixed(1)} ms${starts}`);
  }
  if (s.wrongRoad.length) log(`  wrong road at (s): ${spans(s.wrongRoad)}`);
  if (s.lost.length) log(`  no particle on the true road at (s): ${spans(s.lost)}`);
  for (const c of r.summary.cuts) {
    log(
      `  ${c.openLoop ? "open loop" : "cut"} ${c.fromS.toFixed(0)}–${c.toS.toFixed(0)} s, ${(c.distanceM / 1000).toFixed(2)} km, ${c.truthFixes} truth fixes: ` +
        `max error EKF ${m(c.maxErrorM)} / map match ${m(c.mapMatchMaxErrorM)}, last EKF ${m(c.lastErrorM)} / map match ${m(c.mapMatchLastErrorM)}`,
    );
  }
  if (args.trace) {
    // Per second: filter state, top clusters (OSM way, weight, spread), the true way, errors to the fix.
    const [from, to] = args.trace;
    const way = (id: number | null) => (id === null ? "off" : String(truthGraph.graph.edge(id).wayId));
    for (const p of r.track) {
      if (p.tS < from || p.tS > to || !p.mapMatch) continue;
      const fix = r.fixes.find((f) => Math.abs(f.tS - p.tS) < 0.5 && f.satellite && f.fix.hAccM <= 10);
      const t = truth.at(trip.startUs + p.tS * 1e6);
      const cl = p.mapMatch.clusters.slice(0, 3).map((c) => `${way(c.edge)} ${(c.weight * 100).toFixed(0)}% ±${c.spreadM.toFixed(0)}`).join(" | ");
      const err = fix ? `pf ${m(fix.mapMatchErrorM ?? null)} ekf ${m(fix.errorM ?? null)}` : "";
      log(`  ${p.tS.toFixed(0).padStart(5)} ${p.mode.padEnd(8)} ${p.mapMatch.state.padEnd(10)} ${String(p.mapMatch.particles).padStart(4)} truth ${t ? truthGraph.graph.edge(t.edge).wayId : "—"}  ${cl}  ${err}`);
    }
  }
  truthGraph.close();
  navGraph.close();
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const threads = threadsArg(argv);
  const args = parseArgs(argv);
  const pool = new Pool(import.meta.url, threads);
  try {
    // Jam windows reach to Infinity, which survives the trip to a worker (structured clone).
    const outputs = await pool.map<{ file: string; args: Args }, string[]>(args.files.map((file) => ({ file, args })));
    for (const lines of outputs) for (const line of lines) console.log(line);
  } finally {
    await pool.close();
  }
}

serveJobs(import.meta.url, runFile);
if (isMainThread) await main();

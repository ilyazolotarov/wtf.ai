// Map matching on trip logs (MAPMATCH-SPEC §10.2, M4): runs the particle filter in a replay and
// scores it against the ground truth (truth-match.ts).
// Usage: npm run replay:mm -- [--graph <file>] [--cut <startS>:<lenS>]... [--open-loop [delayS]] [--mm '<json config>']
//          [--start <s>] [--jam <startS>:<lenS|inf>]... [--trace <fromS>:<toS>] <logs>

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { MapMatchConfig } from "../../src/nav/mapmatch/particle-filter";
import type { JamWindow } from "../../src/nav/replay/jam";
import { replayTrip, type ReplayCut } from "../../src/nav/replay/replay";
import { matchTruth } from "../../src/nav/replay/truth-match";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";

function parseArgs(argv: string[]) {
  const files: string[] = [];
  const cuts: ReplayCut[] = [];
  let graph: string | undefined;
  let config: Partial<MapMatchConfig> = {};
  let openLoopDelayS: number | undefined;
  let trace: [number, number] | undefined;
  const jam: JamWindow[] = [];
  let startAtS: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--graph") graph = argv[++i];
    else if (a === "--mm") config = JSON.parse(argv[++i]) as Partial<MapMatchConfig>;
    else if (a === "--trace") {
      const [from, to] = argv[++i].split(":").map(Number);
      trace = [from, to];
    }
    else if (a === "--jam") {
      const [from, len] = argv[++i].split(":");
      jam.push({ fromS: Number(from), toS: len === "inf" ? Infinity : Number(from) + Number(len) });
    } else if (a === "--start") startAtS = Number(argv[++i]);
    else if (a === "--cut") {
      const [from, len] = argv[++i].split(":").map(Number);
      cuts.push({ fromS: from, toS: from + len });
    } else if (a === "--open-loop") {
      const next = argv[i + 1];
      openLoopDelayS = next !== undefined && /^\d+(\.\d+)?$/.test(next) ? Number(argv[++i]) : 0;
    } else if (a === "-h" || a === "--help") {
      console.log(
        "replay:mm [--graph <file>] [--cut <startS>:<lenS>]... [--open-loop [delayS]] [--mm '<json>'] [--start <s>] [--jam <startS>:<lenS|inf>]... [--trace <fromS>:<toS>] <trip.ulg...>",
      );
      process.exit(0);
    } else files.push(a);
  }
  if (!files.length) throw new Error("no trip log given (see --help)");
  return { files, cuts, graph, config, openLoopDelayS, trace, jam, startAtS };
}

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)} %`);
const m = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v)} m`);
const spans = (s: [number, number][]) => s.slice(0, 8).map(([a, b]) => (a === b ? `${a.toFixed(0)}` : `${a.toFixed(0)}–${b.toFixed(0)}`)).join(", ") + (s.length > 8 ? ", …" : "");

const args = parseArgs(process.argv.slice(2));
for (const file of args.files) {
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const first = trip.gnss.find((f) => isSatelliteFix(f) && f.hAccM <= 10) ?? trip.gnss.find((f) => f.hAccM < 500);
  if (!first) {
    console.log(`== ${basename(file)}: no usable fixes`);
    continue;
  }
  const graphFile = args.graph ?? findGraph(first);
  if (!graphFile) throw new Error("no graph covers this trip: build one with `tiles graph <region>` or pass --graph");
  // Truth and the replay each get their own reader: the truth matcher moves the graph's frame.
  const truthGraph = openGraph(graphFile, first);
  const truth = matchTruth(trip, truthGraph.graph);
  const navGraph = openGraph(graphFile, first);
  const started = performance.now();
  const r = replayTrip(trip, {
    cuts: args.cuts,
    openLoop: args.openLoopDelayS === undefined ? undefined : { delayS: args.openLoopDelayS },
    mapMatch: { graph: navGraph.graph, truth, config: args.config },
    jam: args.jam,
    startAtS: args.startAtS,
  });
  const ms = performance.now() - started;
  const s = r.summary.mapMatch!;
  console.log(`== ${basename(file)}  (${r.summary.durationS.toFixed(0)} s, ${(r.summary.obdDistanceM / 1000).toFixed(2)} km, graph ${basename(graphFile)}, replay ${(ms / 1000).toFixed(1)} s)`);
  const init = r.summary.init;
  console.log(
    `  init: ${init ? `${init.method} at ${init.tS.toFixed(0)} s after ${(init.distanceM / 1000).toFixed(2)} km` + (init.estimate ? ` (±${init.estimate.accuracyM.toFixed(0)} m, ±${(((init.estimate.headingSigmaRad ?? 0) * 180) / Math.PI).toFixed(1)}°)` : "") : "never"}; truth: ${truth.points.length} fixes matched`,
  );
  console.log(
    `  samples ${s.samples} (+${s.initSamples} init): wrong road ${pct(s.wrongRoadRate)}, truth survival ${pct(s.truthSurvival)}, multimodal ${pct(s.multimodalShare)}, off-road ${pct(s.offRoadShare)}`,
  );
  if (s.relock.count) {
    console.log(`  re-lock: ${s.relock.count}×, median ${s.relock.medianS!.toFixed(1)} s / ${m(s.relock.medianM)}, max ${s.relock.maxS!.toFixed(1)} s / ${m(s.relock.maxM)}`);
  }
  if (s.updateMs) console.log(`  update: p50 ${s.updateMs.p50.toFixed(2)} ms, p99 ${s.updateMs.p99.toFixed(2)} ms, max ${s.updateMs.max.toFixed(1)} ms`);
  if (s.wrongRoad.length) console.log(`  wrong road at (s): ${spans(s.wrongRoad)}`);
  if (s.lost.length) console.log(`  no particle on the true road at (s): ${spans(s.lost)}`);
  for (const c of r.summary.cuts) {
    console.log(
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
      console.log(`  ${p.tS.toFixed(0).padStart(5)} ${p.mode.padEnd(8)} ${p.mapMatch.state.padEnd(10)} ${String(p.mapMatch.particles).padStart(4)} truth ${t ? truthGraph.graph.edge(t.edge).wayId : "—"}  ${cl}  ${err}`);
    }
  }
  truthGraph.close();
  navGraph.close();
}

// Ground truth for map matching (MAPMATCH-SPEC §10.1, M3): match clean fixes to the road graph
// with an offline HMM and report chains, breaks and how the routes compare with OBD distance.
// Usage: npm run replay:truth -- [--graph <file.graph.bin>] [--json <out>] tools/triplog/logs/*.ulg

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";

import type { OdometryStep } from "../../src/nav/odometry/odometry-output";
import { replayTrip } from "../../src/nav/replay/replay";
import { matchTruth, type TruthMatch } from "../../src/nav/replay/truth-match";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let graph: string | undefined;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--graph") graph = argv[++i];
    else if (argv[i] === "--json") json = argv[++i];
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("replay:truth [--graph <file.graph.bin>] [--json <out>] <trip.ulg...>");
      process.exit(0);
    } else files.push(argv[i]);
  }
  if (!files.length) throw new Error("no trip log given (see --help)");
  return { files, graph, json };
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "—");

/** Navigator odometry distance at a time: cumulative distance, interpolated within the chunk. */
function odometryAt(steps: OdometryStep[], tUs: number): number {
  let lo = 0;
  let hi = steps.length - 1;
  if (!steps.length || tUs <= steps[0].t0Us) return 0;
  if (tUs >= steps[hi].t1Us) return steps[hi].distanceM;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].t1Us <= tUs) lo = mid;
    else hi = mid;
  }
  const s = steps[hi];
  const f = s.t1Us > s.t0Us ? Math.max(0, Math.min(1, (tUs - s.t0Us) / (s.t1Us - s.t0Us))) : 1;
  return s.distanceM - s.dsM * (1 - f);
}

function report(name: string, trip: TripLog, truth: TruthMatch, steps: OdometryStep[], ms: number, graphName: string) {
  const tS = (tUs: number) => ((tUs - trip.startUs) / 1e6).toFixed(0);
  const chains = new Set(truth.legs.map((l) => l.from)).size ? truth.points.length - truth.legs.length : truth.points.length;
  console.log(`== ${name}  (graph ${graphName}, ${truth.fixes} clean fixes, ${ms.toFixed(0)} ms)`);
  if (!truth.points.length) {
    console.log("  no clean satellite fixes");
    return;
  }
  const speed = new Map(trip.gnss.map((f) => [f.tUs, f.speedMps ?? 0]));
  const dist = truth.points.filter((p) => (speed.get(p.tUs) ?? 0) >= 3).map((p) => p.distanceM);
  const moving = truth.legs.filter((l) => l.obdM >= 5);
  const misfit = moving.filter((l) => Math.abs(l.lengthM - l.obdM) > 10 + 0.1 * l.obdM);
  const penalised = truth.legs.filter((l) => l.penaltyM > 0);
  console.log(
    `  matched ${truth.points.length} fixes in ${chains} chain${chains === 1 ? "" : "s"}; moving fix → road median ${f1(quantile(dist, 0.5))} m, p95 ${f1(quantile(dist, 0.95))} m, max ${f1(Math.max(...dist))} m`,
  );
  const routeM = truth.legs.reduce((s, l) => s + l.lengthM, 0);
  const obdM = truth.legs.reduce((s, l) => s + l.obdM, 0);
  const odoM = truth.legs.reduce((s, l) => s + odometryAt(steps, truth.points[l.to].tUs) - odometryAt(steps, truth.points[l.from].tUs), 0);
  console.log(
    `  route ${(routeM / 1000).toFixed(2)} km vs OBD ${(obdM / 1000).toFixed(2)} km (×${f1((routeM / obdM) * 100)} %) vs navigator odometry ${(odoM / 1000).toFixed(2)} km (×${f1((routeM / odoM) * 100)} %)`,
  );
  console.log(`  legs that don't fit the OBD distance (> 10 m + 10 %): ${misfit.length} of ${moving.length} moving`);
  for (const l of misfit.slice(0, 10)) {
    console.log(`    ${tS(truth.points[l.from].tUs)}–${tS(truth.points[l.to].tUs)} s: route ${f1(l.lengthM)} m, OBD ${f1(l.obdM)} m, ${l.path.length} edges`);
  }
  if (penalised.length) {
    console.log(`  routes against one-way / restriction / U-turn: ${penalised.length}`);
    for (const l of penalised.slice(0, 10)) console.log(`    ${tS(truth.points[l.from].tUs)}–${tS(truth.points[l.to].tUs)} s: penalty ${l.penaltyM} m`);
  }
  for (const b of truth.breaks) {
    const what =
      b.reason === "no candidates"
        ? `no road within 30 m for ${b.fixes} fix${b.fixes === 1 ? "" : "es"}`
        : b.reason === "gap"
          ? `gap (${b.degradedFixes} fixes in it that aren't clean)`
          : b.reason;
    console.log(`  break ${tS(b.t0Us)}–${tS(b.t1Us)} s at (${b.lat.toFixed(5)}, ${b.lon.toFixed(5)}): ${what}`);
  }
}

const { files, graph: graphArg, json } = parseArgs(process.argv.slice(2));
const out: Record<string, unknown> = {};
for (const file of files) {
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const first = trip.gnss.find((f) => isSatelliteFix(f) && f.hAccM <= 10);
  if (!first) {
    console.log(`== ${basename(file)}: no clean satellite fixes`);
    continue;
  }
  const graphFile = graphArg ?? findGraph(first);
  if (!graphFile) throw new Error("no graph covers this trip: build one with `tiles graph <region>` or pass --graph");
  const { graph, close } = openGraph(graphFile, first);
  const t0 = performance.now();
  const truth = matchTruth(trip, graph);
  const ms = performance.now() - t0;
  const steps: OdometryStep[] = [];
  replayTrip(trip, { odometry: (s) => steps.push(s) });
  report(basename(file), trip, truth, steps, ms, basename(graphFile));
  out[basename(file)] = { points: truth.points, legs: truth.legs, breaks: truth.breaks };
  close();
}
if (json) writeFileSync(json, JSON.stringify(out));

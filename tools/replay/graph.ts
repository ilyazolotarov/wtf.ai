// Road graph vs trip logs (MAPMATCH-SPEC §12, M2): how far clean satellite fixes are from the
// nearest road, how well the road heading matches the GNSS course, and what the reader costs.
// Usage: npm run replay:graph -- [--graph <file.graph.bin>] tools/triplog/logs/*.ulg

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";

import { LocalFrame } from "../../src/nav/geo/local-frame";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";

const SEARCH_M = 50;
const OFF_ROAD_M = 15;

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let graph: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--graph") graph = argv[++i];
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("replay:graph [--graph <file.graph.bin>] <trip.ulg...>");
      process.exit(0);
    } else files.push(argv[i]);
  }
  if (!files.length) throw new Error("no trip log given (see --help)");
  return { files, graph };
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "—");
const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

const { files, graph: graphArg } = parseArgs(process.argv.slice(2));
for (const file of files) {
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const fixes = trip.gnss.filter((f) => isSatelliteFix(f) && f.hAccM <= 10 && (f.speedMps ?? 0) >= 3);
  if (!fixes.length) {
    console.log(`== ${basename(file)}: no clean moving satellite fixes`);
    continue;
  }
  const graphFile = graphArg ?? findGraph(fixes[0]);
  if (!graphFile) throw new Error("no graph covers this trip: build one with `tiles graph <region>` or pass --graph");

  let t0 = performance.now();
  const { graph, close } = openGraph(graphFile, fixes[0]);
  const openMs = performance.now() - t0;
  const frame = new LocalFrame(fixes[0]);

  const dist: number[] = [];
  const headingErr: number[] = [];
  let none = 0;
  let queryMs = 0;
  let loadMs = 0;
  let loadQueries = 0;
  for (const fix of fixes) {
    const [e, n] = frame.toEnu(fix);
    const loadsBefore = graph.stats.tileLoads;
    t0 = performance.now();
    const near = graph.edgesNear(e, n, SEARCH_M);
    const ms = performance.now() - t0;
    if (graph.stats.tileLoads > loadsBefore) {
      loadMs += ms;
      loadQueries++;
    } else queryMs += ms;
    if (!near.length) {
      none++;
      continue;
    }
    dist.push(near[0].distanceM);
    // Heading: the nearest edge within 10 m whose direction (either way) matches best.
    if (fix.courseRad !== undefined && (fix.courseAccRad ?? 0) <= (10 * Math.PI) / 180) {
      const close = near.filter((x) => x.distanceM <= 10);
      if (close.length) {
        headingErr.push(
          Math.min(...close.map((x) => Math.min(angleDiff(fix.courseRad!, x.headingRad), angleDiff(fix.courseRad!, x.headingRad + Math.PI)))),
        );
      }
    }
  }
  const deg = headingErr.map((r) => (r * 180) / Math.PI);
  const offRoad = dist.filter((d) => d > OFF_ROAD_M).length + none;
  const s = graph.stats;
  const cachedQueries = fixes.length - loadQueries;
  console.log(`== ${basename(file)}  (${fixes.length} clean moving fixes, graph ${basename(graphFile)} OSM ${graph.info.osmDate})`);
  console.log(
    `  fix → nearest road: median ${f1(quantile(dist, 0.5))} m, p90 ${f1(quantile(dist, 0.9))} m, p99 ${f1(quantile(dist, 0.99))} m; ` +
      `> ${OFF_ROAD_M} m or none within ${SEARCH_M} m: ${((offRoad / fixes.length) * 100).toFixed(1)} %`,
  );
  console.log(`  course vs road heading (≤ 10 m): median ${f1(quantile(deg, 0.5))}°, p90 ${f1(quantile(deg, 0.9))}°, p99 ${f1(quantile(deg, 0.99))}°`);
  console.log(
    `  reader: open ${f1(openMs)} ms, ${s.tileLoads} tiles loaded (${(s.bytesRead / 1e6).toFixed(2)} MB read), ` +
      `edgesNear(${SEARCH_M} m) ${f1((queryMs / Math.max(1, cachedQueries)) * 1000)} µs from cache, ` +
      `${f1(loadMs / Math.max(1, loadQueries))} ms when it loaded tiles (${f1((loadMs / Math.max(1, s.tileLoads)) * 1000)} µs per tile)`,
  );
  close();
}

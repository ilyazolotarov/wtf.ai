// Route planner benchmark on a synthetic country-sized road graph (tools/replay/synthetic-graph.ts), or a real one.
//
//   npm run route:bench                                  # 250 × 150 km grid, routes of 10–240 km
//   npm run route:bench -- --width 600 --height 400 --spacing 700 --routes 5
//   npm run route:bench -- --graph tools/tiles/out/release/ukraine.graph.bin --at 50.45,30.52 --radius 400
//   npm run route:bench -- --json out.json               # per-route results, to diff two runs (--compare a.json)
//   npm run route:bench -- --exact                       # also the exact search: how much slower the routes come out
//   npm run route:bench -- --options '{"heuristicWeight":1.2}'   # RouteOptions for the timed runs
//
// Each route runs twice: with a cold tile cache (decoding included, what the phone pays on a first plan) and with a
// warm one (the search alone). `sum` is a checksum of the plan: a speed-up that keeps routes the same keeps it.

import { readFileSync, writeFileSync } from "node:fs";

import type { Coordinate } from "../../src/nav/geo";
import { LocalFrame } from "../../src/nav/geo/local-frame";
import { bufferByteSource } from "../../src/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "../../src/nav/mapmatch/graph/road-graph";
import { planRoute, type RouteOptions, type RouteStatus } from "../../src/nav/routing/router";
import { fileByteSource } from "./graph-file";
import { buildSyntheticGraph } from "./synthetic-graph";

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const routes = Number(arg("routes", "12"));
const cacheTiles = Number(arg("cache-tiles", "2048"));
const jsonOut = arg("json");
const compare = arg("compare");
const graphFile = arg("graph");
const options: RouteOptions = JSON.parse(arg("options", "{}") as string);
const exact = argv.includes("--exact");

let source: ReturnType<typeof bufferByteSource>;
let pick: (rand: () => number) => [Coordinate, Coordinate];
let centre: Coordinate;
if (graphFile) {
  const [lat, lon] = (arg("at", "50.45,30.52") as string).split(",").map(Number);
  centre = { lat, lon };
  const radiusM = Number(arg("radius", "300")) * 1000;
  source = fileByteSource(graphFile);
  const frame = new LocalFrame(centre);
  pick = (rand) => {
    const p = () => {
      const r = radiusM * Math.sqrt(rand());
      const a = 2 * Math.PI * rand();
      return frame.toCoordinate(r * Math.sin(a), r * Math.cos(a));
    };
    return [p(), p()];
  };
  console.log(`graph ${graphFile}, points within ${radiusM / 1000} km of ${lat},${lon}`);
} else {
  const t0 = performance.now();
  const g = buildSyntheticGraph({ widthKm: Number(arg("width", "250")), heightKm: Number(arg("height", "150")), spacingM: Number(arg("spacing", "500")) });
  source = bufferByteSource(g.bytes);
  centre = g.at(g.cols >> 1, g.rows >> 1);
  console.log(`synthetic graph: ${g.nodes} nodes, ${g.edges} edges, ${(g.bytes.length / 1e6).toFixed(0)} MB, built in ${(performance.now() - t0).toFixed(0)} ms`);
  // Routes from the west/south edge to the east/north, of increasing length: the longest crosses the whole grid.
  pick = (rand) => {
    const margin = 4;
    const a = g.at(margin + Math.floor(rand() * 0.2 * g.cols), margin + Math.floor(rand() * 0.3 * g.rows));
    const b = g.at(Math.floor(g.cols * (0.3 + 0.7 * rand())) - margin, Math.floor(g.rows * (0.5 + 0.5 * rand())) - margin);
    return rand() < 0.5 ? [a, b] : [b, a];
  };
}

let state = Number(arg("seed", "1")) >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const frame = new LocalFrame(centre);
const lineKm = (a: Coordinate, b: Coordinate) => {
  const [ax, ay] = frame.toEnu(a);
  const [bx, by] = frame.toEnu(b);
  return Math.hypot(bx - ax, by - ay) / 1000;
};
function checksum(r: Exclude<RouteStatus, { status: "more" }>): string {
  if (r.status === "failed") return `failed:${r.reason}`;
  let h = 0;
  for (const l of r.plan.legs) h = (Math.imul(h, 31) + l.edge * 2 + (l.dir === 1 ? 0 : 1)) | 0;
  return `${(h >>> 0).toString(16)}/${Math.round(r.plan.lengthM)}m/${Math.round(r.plan.durationS)}s`;
}

interface Row { line: number; coldMs: number; warmMs: number; states: number; tiles: number; sum: string; durationS?: number; exactS?: number; exactStates?: number }
const rows: Row[] = [];
const warmGraph = new TiledRoadGraph(source, frame, { cacheTiles });
for (let i = 0; i < routes; i++) {
  const [a, b] = pick(rand);
  const cold = planRoute(new TiledRoadGraph(source, frame, { cacheTiles }), frame, a, b, options);
  const warm = planRoute(warmGraph, frame, a, b, options);
  const w2 = planRoute(warmGraph, frame, a, b, options);
  const ref = exact ? planRoute(warmGraph, frame, a, b, { hierarchy: false, heuristicWeight: 1, maxStates: 1e8 }) : null;
  rows.push({
    line: lineKm(a, b),
    coldMs: cold.stats.ms,
    warmMs: Math.min(warm.stats.ms, w2.stats.ms),
    states: cold.stats.states,
    tiles: cold.stats.tilesRead,
    sum: checksum(cold),
    ...(cold.status === "done" ? { durationS: cold.plan.durationS } : {}),
    ...(ref?.status === "done" ? { exactS: ref.plan.durationS, exactStates: ref.stats.states } : {}),
  });
}
rows.sort((x, y) => x.line - y.line);
const base: Row[] | null = compare ? JSON.parse(readFileSync(compare, "utf8")) : null;
console.log(`${"line km".padStart(8)}${"cold ms".padStart(10)}${"warm ms".padStart(10)}${"states".padStart(10)}${"tiles".padStart(8)}${"µs/state".padStart(10)}  sum${base ? "   (vs compare)" : ""}`);
for (const [i, r] of rows.entries()) {
  const b = base?.[i];
  const diff = b ? (b.sum === r.sum ? `  same, ${(b.coldMs / r.coldMs).toFixed(1)}× faster` : `  DIFFERS from ${b.sum}, ${(b.coldMs / r.coldMs).toFixed(1)}×`) : "";
  console.log(
    `${r.line.toFixed(0).padStart(8)}${r.coldMs.toFixed(0).padStart(10)}${r.warmMs.toFixed(0).padStart(10)}${String(r.states).padStart(10)}${String(r.tiles).padStart(8)}` +
      `${((r.warmMs * 1000) / Math.max(1, r.states)).toFixed(2).padStart(10)}  ${r.sum}${diff}` +
      (r.exactS && r.durationS ? `  vs exact: +${((100 * (r.durationS - r.exactS)) / r.exactS).toFixed(2)} % time, ${r.exactStates} states` : ""),
  );
}
const total = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
console.log(`total: cold ${total((r) => r.coldMs).toFixed(0)} ms, warm ${total((r) => r.warmMs).toFixed(0)} ms, ${total((r) => r.states)} states`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows));

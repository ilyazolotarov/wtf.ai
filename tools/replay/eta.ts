// Route time check (ROUTING-SPEC §4.4): the route planner's time for the road path each drive actually took, against
// the time it took. Route choice plays no part. The path is the drive's drawn truth (`<log>.truth.json`, timed by the
// odometer between clean fixes: drawn-truth.ts), else the offline truth match of its clean fixes (MAPMATCH-SPEC §10.1).
//
//   npm run route:eta                                   # every log in tools/triplog/logs
//   npm run route:eta -- tools/triplog/logs/2026100[56]*.ulg
//   npm run route:eta -- --costs '{"junctionS":4}'      # RouteCosts overrides
//   npm run route:eta -- --json out.json                # the windows, to compare runs
//   npm run route:eta -- --no-rush                      # free-flowing: no rush-hour factor at the drive's start
//   npm run route:eta -- --by-road                      # real and planned speed by kind of road
//   npm run route:eta -- --graphs <dir>                 # graph files from elsewhere than tools/tiles/out/release
//
// Each drive is cut into windows of about 2 km of driving. A stop over 2 min (parking, a shop) ends a window and isn't
// counted; shorter ones (lights, queues) are part of the drive. Stops at a drive's ends, gaps in the truth and
// stretches off the roads (car parks drawn as clouds of clicks) are left out.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { LocalFrame } from "../../src/nav/geo/local-frame";
import { EdgeFlag, ROAD_CLASS_NAMES, RoadClass } from "../../src/nav/mapmatch/graph/format";
import type { Exit, RoadEdge, RoadGraph } from "../../src/nav/mapmatch/graph/road-graph";
import { drawnTruthTrack, type DrawnTruth } from "../../src/nav/replay/drawn-truth";
import { matchTruth, type TruthMatch } from "../../src/nav/replay/truth-match";
import { congestion } from "../../src/nav/routing/congestion";
import { DEFAULT_ROUTE_COSTS, edgeSeconds, onPriorityRoad, passSeconds, type RouteCosts } from "../../src/nav/routing/cost";
import { legLengthM } from "../../src/nav/routing/router";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";

const LOG_DIR = "tools/triplog/logs";
const WINDOW_M = 2000;
const MIN_WINDOW_M = 500;
const LONG_STOP_S = 120;
/** Odometer metres per second under which the car stood. */
const STOPPED_MPS = 1;
/** The drawn path is put on the roads at this spacing, from edges this near. */
const SAMPLE_M = 5;
const SAMPLE_EDGE_M = 6;

export interface EtaWindow {
  log: string;
  source: "drawn" | "gps";
  /** Kyiv local time at the window's start, hours (fractional); weekday 0 = Monday. */
  hour: number;
  weekday: number;
  lengthM: number;
  actualS: number;
  plannedS: number;
  /** Share of the length on trunk … tertiary roads. */
  mainShare: number;
  /** Seconds stopped (short stops kept in the window). */
  stoppedS: number;
}

/** One step of a drive: fix to fix (GPS) or one second along the drawn path. */
interface Step {
  tUs: number;
  dt: number;
  movedM: number;
  plannedS: number;
  lengthM: number;
  mainM: number;
  /** The road it is on, for `--by-road`. */
  road?: RoadEdge;
  /** The truth breaks before this step (a gap in the fixes, the path leaves the roads): no window spans it. */
  breakBefore: boolean;
}

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let costs: Partial<RouteCosts> = {};
  let json: string | undefined;
  let graphs: string | undefined;
  let roads = false;
  let rush = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--costs") costs = JSON.parse(argv[++i]);
    else if (argv[i] === "--json") json = argv[++i];
    else if (argv[i] === "--graphs") graphs = argv[++i];
    else if (argv[i] === "--by-road") roads = true;
    else if (argv[i] === "--no-rush") rush = false;
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("route:eta [--costs '<json>'] [--graphs <dir>] [--by-road] [--no-rush] [--json <out>] [trip.ulg...]");
      process.exit(0);
    } else files.push(argv[i]);
  }
  if (!files.length) {
    files.push(...readdirSync(LOG_DIR).filter((f) => f.endsWith(".ulg")).sort().map((f) => join(LOG_DIR, f)));
  }
  return { files, costs: { ...DEFAULT_ROUTE_COSTS, ...costs }, json, graphs, roads, rush: rush && costs.congestion === undefined };
}

/** Wall clock (UTC µs) at an uptime, from the nearest sync pair. */
function utcAt(trip: TripLog, tUs: number): number | undefined {
  let best: { tUs: number; utcUs: number } | undefined;
  for (const s of trip.timeSync) if (!best || Math.abs(s.tUs - tUs) < Math.abs(best.tUs - tUs)) best = s;
  return best && best.utcUs + (tUs - best.tUs);
}

const KYIV = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function kyivTime(utcUs: number): { hour: number; weekday: number } {
  const parts = Object.fromEntries(KYIV.formatToParts(new Date(utcUs / 1000)).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour) + Number(parts.minute) / 60, weekday: WEEKDAYS.indexOf(parts.weekday) };
}

const MAIN = new Set<number>([RoadClass.trunk, RoadClass.primary, RoadClass.secondary, RoadClass.tertiary]);

const nodeAfter = (graph: RoadGraph, id: number, dir: 1 | -1) => {
  const e = graph.edge(id);
  return graph.node(dir === 1 ? e.to : e.from);
};

/** Passing the junction after directed edge `a` by its `i`-th exit, as the router prices it. */
function passAt(graph: RoadGraph, a: { id: number; dir: 1 | -1 }, exits: Exit[], i: number, c: RouteCosts): number {
  const cls = exits.map((x) => graph.edge(x.edge).cls);
  return passSeconds(nodeAfter(graph, a.id, a.dir), exits[i], c, onPriorityRoad(graph.edge(a.id).cls, i, exits, cls));
}

/** Junction and turn time from one directed edge to the next: adjacent, or with one short edge between. */
function transitionS(graph: RoadGraph, a: { id: number; dir: 1 | -1 }, b: { id: number; dir: 1 | -1 }, c: RouteCosts): number {
  const exits = graph.exits(a.id, a.dir);
  const direct = exits.findIndex((x) => x.edge === b.id && x.dir === b.dir);
  if (direct >= 0) return passAt(graph, a, exits, direct, c);
  for (const [i, x] of exits.entries()) {
    const next = graph.exits(x.edge, x.dir);
    const second = next.findIndex((y) => y.edge === b.id && y.dir === b.dir);
    if (second >= 0) return passAt(graph, a, exits, i, c) + passAt(graph, { id: x.edge, dir: x.dir }, next, second, c);
  }
  return 0;
}

/** Steps from the clean fixes' truth match: one per leg (fix to fix). */
function gpsSteps(graph: RoadGraph, truth: TruthMatch, c: RouteCosts): Step[] {
  return truth.legs.map((leg, l) => {
    const a = truth.points[leg.from];
    const b = truth.points[leg.to];
    let plannedS = 0;
    let lengthM = 0;
    let mainM = 0;
    for (let k = 0; k < leg.path.length; k++) {
      const { edge: id, dir } = leg.path[k];
      const edge = graph.edge(id);
      const end = edge.cum[edge.cum.length - 1];
      const fromM = k === 0 ? a.alongM : dir === 1 ? 0 : end;
      const toM = k === leg.path.length - 1 ? b.alongM : dir === 1 ? end : 0;
      const len = legLengthM(edge, { edge: id, dir, fromM, toM });
      plannedS += edgeSeconds(edge, len, c);
      lengthM += len;
      if (MAIN.has(edge.cls)) mainM += len;
      if (k + 1 < leg.path.length) plannedS += transitionS(graph, { id, dir }, { id: leg.path[k + 1].edge, dir: leg.path[k + 1].dir }, c);
    }
    return {
      tUs: a.tUs,
      dt: (b.tUs - a.tUs) / 1e6,
      movedM: leg.obdM,
      plannedS,
      lengthM,
      mainM,
      road: graph.edge(leg.path[0].edge),
      breakBefore: l > 0 && truth.legs[l - 1].to !== leg.from,
    };
  });
}

/**
 * Steps along a drawn path, one a second. The path is sampled every 5 m and each sample put on the road it lies on
 * (the drawing's road stretches are slices of graph edges): that gives the planner's time along the path, and the
 * drawing's timing gives the real one. Off the roads (car parks, yards) the truth breaks.
 */
function drawnSteps(trip: TripLog, graph: RoadGraph, frame: LocalFrame, drawn: DrawnTruth, c: RouteCosts): Step[] {
  const track = drawnTruthTrack(trip, drawn);
  const { path, cum } = track;
  const n = Math.floor(track.pathM / SAMPLE_M) + 1;
  const plannedAt = new Float64Array(n + 1);
  const mainAt = new Float64Array(n + 1);
  const onRoad = new Uint8Array(n + 1);
  const roadAt: (RoadEdge | undefined)[] = new Array(n + 1);
  let prev: { id: number; dir: 1 | -1 } | null = null;
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const s = Math.min(i * SAMPLE_M, track.pathM);
    while (k + 2 < cum.length && cum[k + 1] < s) k++;
    const span = cum[k + 1] - cum[k];
    const f = span > 0 ? (s - cum[k]) / span : 0;
    const [ae, an] = frame.toEnu({ lat: path[k][0], lon: path[k][1] });
    const [be, bn] = frame.toEnu({ lat: path[k + 1][0], lon: path[k + 1][1] });
    const heading = Math.atan2(be - ae, bn - an);
    let best: { id: number; dir: 1 | -1; d: number; edge: RoadEdge } | null = null;
    for (const near of graph.edgesNear(ae + f * (be - ae), an + f * (bn - an), SAMPLE_EDGE_M)) {
      const diff = Math.abs(Math.atan2(Math.sin(near.headingRad - heading), Math.cos(near.headingRad - heading)));
      if (diff > Math.PI / 4 && diff < (3 * Math.PI) / 4) continue;
      // At a junction two edges are as near: the one the path was on stays the pick until it ends.
      const d: number = near.distanceM - (prev && near.edge.id === prev.id ? 0.5 : 0);
      if (!best || d < best.d) best = { id: near.edge.id, dir: diff < Math.PI / 2 ? 1 : -1, d, edge: near.edge };
    }
    if (i > 0) {
      const ds = s - Math.min((i - 1) * SAMPLE_M, track.pathM);
      plannedAt[i] = plannedAt[i - 1];
      mainAt[i] = mainAt[i - 1];
      if (best) {
        plannedAt[i] += edgeSeconds(best.edge, ds, c);
        if (MAIN.has(best.edge.cls)) mainAt[i] += ds;
        if (prev && (prev.id !== best.id || prev.dir !== best.dir)) plannedAt[i] += transitionS(graph, prev, best, c);
      }
    }
    onRoad[i] = best ? 1 : 0;
    roadAt[i] = best?.edge;
    prev = best ? { id: best.id, dir: best.dir } : null;
  }
  const sampleOf = (s: number) => Math.max(0, Math.min(n, s / SAMPLE_M));
  const interp = (arr: Float64Array, s: number) => {
    const x = sampleOf(s);
    const i = Math.floor(x);
    return i >= n ? arr[n] : arr[i] + (x - i) * (arr[i + 1] - arr[i]);
  };
  const steps: Step[] = [];
  let broken = false;
  for (let j = 0; j + 1 < track.points.length; j++) {
    const [t0, , , s0] = track.points[j];
    const [t1, , , s1] = track.points[j + 1];
    let road = true;
    for (let i = Math.floor(sampleOf(Math.min(s0, s1))); i <= Math.ceil(sampleOf(Math.max(s0, s1))); i++) if (!onRoad[i]) road = false;
    if (!road) {
      broken = true;
      continue;
    }
    steps.push({
      tUs: trip.startUs + t0 * 1e6,
      dt: t1 - t0,
      movedM: Math.abs(s1 - s0),
      plannedS: interp(plannedAt, s1) - interp(plannedAt, s0),
      lengthM: s1 - s0,
      mainM: interp(mainAt, s1) - interp(mainAt, s0),
      road: roadAt[Math.round(sampleOf((s0 + s1) / 2))],
      breakBefore: broken,
    });
    broken = false;
  }
  return steps;
}

/** Real and planned time by kind of road (`--by-road`): steps inside windows, short stops on the road driven next. */
const byRoad = new Map<string, { m: number; actualS: number; plannedS: number }>();
function roadKind(e: RoadEdge | undefined): string {
  if (!e) return "?";
  const where = e.flags & EdgeFlag.city ? "city" : e.flags & EdgeFlag.urban ? "urban" : "rural";
  const limit = e.maxspeedKph ? `${e.maxspeedKph}` : "—";
  return `${ROAD_CLASS_NAMES[e.cls]}${e.flags & EdgeFlag.link ? "_link" : ""} ${where} ${limit}${e.flags & EdgeFlag.unpaved ? " unpaved" : ""}`;
}

function windows(log: string, source: EtaWindow["source"], trip: TripLog, steps: Step[]): EtaWindow[] {
  const out: EtaWindow[] = [];
  let w: EtaWindow | null = null;
  let mainM = 0;
  let stopS = 0; // the current stop, not yet in the window
  const close = () => {
    if (w && w.lengthM >= MIN_WINDOW_M) out.push({ ...w, mainShare: mainM / w.lengthM });
    w = null;
    mainM = 0;
  };
  for (const step of steps) {
    if (step.breakBefore) {
      close();
      stopS = 0;
    }
    if (step.movedM < STOPPED_MPS * step.dt) {
      stopS += step.dt;
      continue;
    }
    if (stopS > LONG_STOP_S) close();
    if (!w) {
      const utc = utcAt(trip, step.tUs);
      const t = utc === undefined ? { hour: NaN, weekday: -1 } : kyivTime(utc);
      w = { log, source, hour: t.hour, weekday: t.weekday, lengthM: 0, actualS: 0, plannedS: 0, mainShare: 0, stoppedS: 0 };
      stopS = 0; // a stop before the window's first movement isn't driving
    }
    const kind = byRoad.get(roadKind(step.road)) ?? { m: 0, actualS: 0, plannedS: 0 };
    byRoad.set(roadKind(step.road), kind);
    kind.m += step.lengthM;
    kind.actualS += step.dt + stopS;
    kind.plannedS += step.plannedS;
    w.actualS += step.dt + stopS;
    w.stoppedS += stopS;
    stopS = 0;
    w.plannedS += step.plannedS;
    w.lengthM += step.lengthM;
    mainM += step.mainM;
    if (w.lengthM >= WINDOW_M) close();
  }
  close();
  return out;
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const pct = (r: number) => `${r >= 1 ? "+" : ""}${((r - 1) * 100).toFixed(0)} %`;

/** Totals and the spread of real ÷ planned over the windows; "miss" is the median |real − planned| ÷ real. */
function summary(label: string, ws: EtaWindow[]): string {
  if (!ws.length) return `${label.padEnd(30)}   —`;
  const actual = ws.reduce((s, w) => s + w.actualS, 0);
  const planned = ws.reduce((s, w) => s + w.plannedS, 0);
  const km = ws.reduce((s, w) => s + w.lengthM, 0) / 1000;
  const ratios = ws.map((w) => w.actualS / w.plannedS);
  const miss = quantile(ws.map((w) => Math.abs(w.actualS - w.plannedS) / w.actualS), 0.5);
  return (
    `${label.padEnd(30)}${String(ws.length).padStart(4)} ${km.toFixed(0).padStart(4)} km ` +
    `${(actual / 60).toFixed(0).padStart(4)} min real ${(planned / 60).toFixed(0).padStart(4)} planned  ` +
    `real vs planned ${pct(actual / planned).padStart(6)}  windows p10/50/90 ${pct(quantile(ratios, 0.1))} / ` +
    `${pct(quantile(ratios, 0.5))} / ${pct(quantile(ratios, 0.9))}  miss ${(miss * 100).toFixed(0)} %`
  );
}

const { files, costs, json, graphs, roads, rush } = parseArgs(process.argv.slice(2));
const all: EtaWindow[] = [];
for (const file of files) {
  const log = basename(file, ".ulg");
  const trip = readTripLog(readFileSync(file));
  const truthFile = file.replace(/\.ulg$/, ".truth.json");
  const drawn = existsSync(truthFile) ? (JSON.parse(readFileSync(truthFile, "utf8")) as DrawnTruth) : null;
  const useDrawn = !!drawn && drawn.path.length > 1;
  const fix = trip.gnss.find((f) => isSatelliteFix(f) && f.hAccM <= 10);
  const origin = useDrawn ? { lat: drawn.path[0][0], lon: drawn.path[0][1] } : fix;
  if (!origin) continue;
  const graphFile = graphs ? findGraph(origin, graphs) : findGraph(origin);
  if (!graphFile) continue;
  const { graph, close } = openGraph(graphFile, origin);
  // Rush hours at the drive's start, as the app plans at departure.
  const startUtc = utcAt(trip, trip.startUs);
  const when = startUtc === undefined ? null : kyivTime(startUtc);
  const c = rush && when ? { ...costs, congestion: congestion(when.weekday, when.hour) } : costs;
  const steps = useDrawn ? drawnSteps(trip, graph, new LocalFrame(origin), drawn, c) : gpsSteps(graph, matchTruth(trip, graph), c);
  close();
  const source = useDrawn ? "drawn" : "gps";
  const ws = windows(log, source, trip, steps);
  if (!ws.length) continue;
  all.push(...ws);
  console.log(summary(`${log} ${source}`, ws));
}
console.log("");
console.log(summary("all", all));
console.log(summary("drawn", all.filter((w) => w.source === "drawn")));
console.log(summary("gps", all.filter((w) => w.source === "gps")));
console.log(summary("main roads ≥ 60 %", all.filter((w) => w.mainShare >= 0.6)));
console.log(summary("minor roads > 40 %", all.filter((w) => w.mainShare < 0.6)));
for (const [label, a, b] of [["07–10 h", 7, 10], ["10–16 h", 10, 16], ["16–20 h", 16, 20]] as const) {
  console.log(summary(label, all.filter((w) => w.hour >= a && w.hour < b)));
}
console.log(summary("other hours", all.filter((w) => !(w.hour >= 7 && w.hour < 20))));
if (roads) {
  console.log("\nroad (class, where, limit)              km   real km/h  planned km/h");
  for (const [kind, r] of [...byRoad].sort((a, b) => b[1].m - a[1].m)) {
    if (r.m < 500) continue;
    console.log(`${kind.padEnd(36)}${(r.m / 1000).toFixed(1).padStart(6)}${((r.m / r.actualS) * 3.6).toFixed(0).padStart(10)}${((r.m / r.plannedS) * 3.6).toFixed(0).padStart(12)}`);
  }
}
if (json) writeFileSync(json, JSON.stringify(all));

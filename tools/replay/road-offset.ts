// How far beside the road the car's clean satellite fixes, and the dot the app drew, sit: signed, metres right of the
// travel direction, on straight stretches away from junctions, on the road the offline truth matcher put the car on.
// Read-only. The three causes leave different marks:
// - lane offset: right of travel in both directions (the line is the road's centre, the car keeps right);
// - map geometry: the same side of the line whichever way it is driven, on every drive;
// - GPS bias: changes from drive to drive on the same road.
// `--replay log|wheels|gyro`: the dot from the app replayed now (turning as the log had it, from the wheels, from the
// phone's gyro) instead of the one the phone drew.
// Usage: npm run replay:offset -- [--graphs <dir>] [--replay log|wheels|gyro] [--detail <log id>] [--json <out>]
//   [--geojson <out>] <trip.ulg...>

import { readFileSync, writeFileSync } from "node:fs";
import path, { basename } from "node:path";

import { Oneway, ROAD_CLASS_NAMES } from "../../src/nav/mapmatch/graph/format";
import type { RoadEdge } from "../../src/nav/mapmatch/graph/road-graph";
import { matchTruth } from "../../src/nav/replay/truth-match";
import { isSatelliteFix, type GnssFix } from "../../src/nav/types";
import { MemoryKeyValueStore, phoneOf, replayTripInApp, seedFromLog } from "../../src/services/navigation/app-replay";
import { CalibrationStore } from "../../src/services/navigation/calibration-store";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph, RELEASE_DIR } from "./graph-file";

const DEG = Math.PI / 180;
const R = 6_371_008.8;
/** Clean fixes only: the truth rule. */
const MAX_HACC_M = 10;
/** Moving at road speed (no car parks, no creeping in queues where the car may sit across lanes). */
const MIN_SPEED_MPS = 5;
/** Away from the edge's ends (junctions), and the road straight over ±`STRAIGHT_HALF_M`. */
const END_MARGIN_M = 25;
const STRAIGHT_HALF_M = 20;
const STRAIGHT_MAX_RAD = 6 * DEG;
/** The car driving along the road, not changing lanes hard or turning. */
const COURSE_MAX_RAD = 12 * DEG;
/** A pass: consecutive kept fixes on one edge, one direction, no gap longer than this. */
const PASS_GAP_US = 5e6;
const MIN_PASS_FIXES = 3;

interface Sample {
  log: string;
  tUs: number;
  /** Seconds since the log's first fix. */
  tS: number;
  lat: number;
  lon: number;
  hAccM: number;
  speedMps: number;
  edge: number;
  wayId: number;
  cls: number;
  oneway: boolean;
  dir: 1 | -1;
  /** Metres right of the travel direction (fix, and the dot the app drew at that moment if it was GPS-led). */
  fixRight: number;
  dotRight: number | null;
}

interface Pass {
  log: string;
  edge: number;
  wayId: number;
  cls: number;
  oneway: boolean;
  dir: 1 | -1;
  t0S: number;
  t1S: number;
  n: number;
  lat: number;
  lon: number;
  fixRight: number;
  dotRight: number | null;
}

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let graphs = RELEASE_DIR;
  let detail: string | undefined;
  let json: string | undefined;
  let geojson: string | undefined;
  let replay: Replay | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--graphs") graphs = argv[++i];
    else if (argv[i] === "--detail") detail = argv[++i];
    else if (argv[i] === "--json") json = argv[++i];
    else if (argv[i] === "--geojson") geojson = argv[++i];
    else if (argv[i] === "--replay") {
      const r = argv[++i];
      if (r !== "log" && r !== "wheels" && r !== "gyro") throw new Error("--replay log|wheels|gyro");
      replay = r;
    } else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("replay:offset [--graphs <dir>] [--replay log|wheels|gyro] [--detail <log id>] [--json <out>] [--geojson <out>] <trip.ulg...>");
      process.exit(0);
    } else files.push(argv[i]);
  }
  if (!files.length) throw new Error("no trip log given (see --help)");
  return { files, graphs, detail, json, geojson, replay };
}

type Replay = "log" | "wheels" | "gyro";

/** The dots the app publishes for this drive when replayed now, as the log's `navEstimate`. */
function replayedDots(trip: TripLog, graphFile: string, replay: Replay): TripLog["navEstimate"] {
  const calibration = new CalibrationStore(new MemoryKeyValueStore(), phoneOf(trip));
  seedFromLog(trip, calibration);
  const first = trip.gnss.find((f) => f.hAccM <= 500)!;
  const opened = openGraph(graphFile, first);
  try {
    const r = replayTripInApp(trip, {
      calibration,
      roadGraph: { key: graphFile, region: path.basename(graphFile, ".graph.bin"), graph: opened.graph },
      ...(replay === "log" ? {} : { wheelYaw: replay === "wheels" }),
    });
    return r.published.map(({ timestampUs, ...p }) => ({ ...p, tUs: timestampUs }));
  } finally {
    opened.close();
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const f1 = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(1) : "—");
const u1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "—");
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The edge's vertices in metres around (lat, lon). */
function localXY(edge: RoadEdge, lat: number, lon: number): Float64Array {
  const ll = edge.lonLat;
  const out = new Float64Array(ll.length);
  const c = Math.cos(lat * DEG);
  for (let i = 0; i + 1 < ll.length; i += 2) {
    out[i] = (ll[i] - lon) * DEG * R * c;
    out[i + 1] = (ll[i + 1] - lat) * DEG * R;
  }
  return out;
}

function cumulative(xy: Float64Array): Float64Array {
  const cum = new Float64Array(xy.length / 2);
  for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(xy[2 * i] - xy[2 * i - 2], xy[2 * i + 1] - xy[2 * i - 1]);
  return cum;
}

/** Closest point of the polyline to the origin: along, geometry heading there, and signed offset right of geometry. */
function project(xy: Float64Array, cum: Float64Array): { alongM: number; headingRad: number; rightOfGeomM: number } {
  let best = { d: Infinity, alongM: 0, headingRad: 0, rightOfGeomM: 0 };
  for (let i = 0; i + 1 < cum.length; i++) {
    const ax = xy[2 * i], ay = xy[2 * i + 1];
    const dx = xy[2 * i + 2] - ax, dy = xy[2 * i + 3] - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2));
    const px = ax + t * dx, py = ay + t * dy;
    const d = Math.hypot(px, py);
    if (d < best.d) {
      const len = Math.sqrt(len2);
      // Right of the segment's direction: cross product sign (origin − closest point) × direction.
      const right = ((0 - px) * dy - (0 - py) * dx) / len;
      best = { d, alongM: cum[i] + t * len, headingRad: Math.atan2(dx, dy), rightOfGeomM: right };
    }
  }
  return best;
}

function pointAt(xy: Float64Array, cum: Float64Array, s: number): [number, number] {
  let i = 0;
  while (i + 2 < cum.length && cum[i + 1] < s) i++;
  const seg = cum[i + 1] - cum[i];
  const t = seg > 0 ? Math.max(0, Math.min(1, (s - cum[i]) / seg)) : 0;
  return [xy[2 * i] + t * (xy[2 * i + 2] - xy[2 * i]), xy[2 * i + 1] + t * (xy[2 * i + 3] - xy[2 * i + 1])];
}

/** Straight around `s`: the chords before and after it turn by less than `STRAIGHT_MAX_RAD`. */
function straightAround(xy: Float64Array, cum: Float64Array, s: number): boolean {
  const a = pointAt(xy, cum, s - STRAIGHT_HALF_M), m = pointAt(xy, cum, s), b = pointAt(xy, cum, s + STRAIGHT_HALF_M);
  const h1 = Math.atan2(m[0] - a[0], m[1] - a[1]);
  const h2 = Math.atan2(b[0] - m[0], b[1] - m[1]);
  return Math.abs(wrap(h2 - h1)) < STRAIGHT_MAX_RAD;
}

/** Signed metres right of travel of (lat, lon) from the edge, or null where the measure doesn't apply. */
function rightOfTravel(edge: RoadEdge, dir: 1 | -1, lat: number, lon: number, courseRad?: number): number | null {
  const xy = localXY(edge, lat, lon);
  const cum = cumulative(xy);
  const len = cum[cum.length - 1];
  const p = project(xy, cum);
  if (p.alongM < END_MARGIN_M || p.alongM > len - END_MARGIN_M) return null;
  if (!straightAround(xy, cum, p.alongM)) return null;
  const travel = dir === 1 ? p.headingRad : p.headingRad + Math.PI;
  if (courseRad !== undefined && Math.abs(wrap(courseRad - travel)) > COURSE_MAX_RAD) return null;
  return dir === 1 ? p.rightOfGeomM : -p.rightOfGeomM;
}

/** The dot the app drew nearest in time to `tUs` (within 0.5 s), while it was GPS-led. */
function dotAt(trip: TripLog, tUs: number, cursor: { k: number }): { lat: number; lon: number } | null {
  const est = trip.navEstimate;
  while (cursor.k + 1 < est.length && est[cursor.k + 1].tUs <= tUs) cursor.k++;
  let best: (typeof est)[number] | null = null;
  for (const k of [cursor.k, cursor.k + 1]) {
    const r = est[k];
    if (r && Math.abs(r.tUs - tUs) <= 5e5 && (!best || Math.abs(r.tUs - tUs) < Math.abs(best.tUs - tUs))) best = r;
  }
  if (!best || best.trust !== "TRUSTED" || best.source === "dr" || best.source === "manual") return null;
  return { lat: best.latDeg, lon: best.lonDeg };
}

function measureLog(file: string, graphsDir: string, replay?: Replay): Sample[] {
  const log = basename(file, ".ulg");
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const first = trip.gnss.find((f) => isSatelliteFix(f) && f.hAccM <= MAX_HACC_M);
  if (!first) return [];
  const graphFile = findGraph(first, graphsDir);
  if (!graphFile) {
    console.log(`  ${log}: no graph covers it`);
    return [];
  }
  if (replay) trip.navEstimate = replayedDots(trip, graphFile, replay);
  const { graph, close } = openGraph(graphFile, first);
  try {
    const truth = matchTruth(trip, graph);
    const fixAt = new Map<number, GnssFix>();
    for (const f of trip.gnss) fixAt.set(f.tUs, f);
    const cursor = { k: 0 };
    const out: Sample[] = [];
    for (const pt of truth.points) {
      const fix = fixAt.get(pt.tUs);
      if (!fix || !isSatelliteFix(fix) || fix.hAccM > MAX_HACC_M || (fix.speedMps ?? 0) < MIN_SPEED_MPS) continue;
      const edge = graph.edge(pt.edge);
      const fixRight = rightOfTravel(edge, pt.dir, fix.lat, fix.lon, fix.courseRad);
      if (fixRight === null) continue;
      const dot = dotAt(trip, fix.tUs, cursor);
      const dotRight = dot ? rightOfTravel(edge, pt.dir, dot.lat, dot.lon) : null;
      out.push({
        log,
        tUs: fix.tUs,
        tS: (fix.tUs - first.tUs) / 1e6,
        lat: fix.lat,
        lon: fix.lon,
        hAccM: fix.hAccM,
        speedMps: fix.speedMps ?? 0,
        edge: edge.id,
        wayId: edge.wayId,
        cls: edge.cls,
        oneway: edge.oneway !== Oneway.none,
        dir: pt.dir,
        fixRight,
        dotRight,
      });
    }
    return out;
  } finally {
    close();
  }
}

function passesOf(samples: Sample[]): Pass[] {
  const passes: Pass[] = [];
  let run: Sample[] = [];
  const flush = () => {
    if (run.length >= MIN_PASS_FIXES) {
      const dots = run.map((s) => s.dotRight).filter((d): d is number => d !== null);
      const mid = run[run.length >> 1];
      passes.push({
        log: mid.log,
        edge: mid.edge,
        wayId: mid.wayId,
        cls: mid.cls,
        oneway: mid.oneway,
        dir: mid.dir,
        t0S: run[0].tS,
        t1S: run[run.length - 1].tS,
        n: run.length,
        lat: mid.lat,
        lon: mid.lon,
        fixRight: median(run.map((s) => s.fixRight)),
        dotRight: dots.length >= MIN_PASS_FIXES ? median(dots) : null,
      });
    }
    run = [];
  };
  for (const s of samples) {
    const last = run[run.length - 1];
    if (last && (last.log !== s.log || last.edge !== s.edge || last.dir !== s.dir || s.tUs - last.tUs > PASS_GAP_US)) flush();
    run.push(s);
  }
  flush();
  return passes;
}

function line(label: string, xs: number[]): string {
  if (!xs.length) return `${label.padEnd(26)} —`;
  const abs = xs.map(Math.abs);
  return (
    `${label.padEnd(26)} n ${String(xs.length).padStart(5)}  median ${f1(median(xs)).padStart(6)} m right of travel` +
    `  |off| median ${u1(median(abs)).padStart(4)}  p90 ${u1(quantile(abs, 0.9)).padStart(5)}  share > 5 m ${((100 * abs.filter((a) => a > 5).length) / xs.length).toFixed(0).padStart(3)} %`
  );
}

const { files, graphs, detail, json, geojson, replay } = parseArgs(process.argv.slice(2));
const all: Sample[] = [];
console.log(`Measuring ${files.length} logs${replay ? `, the dot replayed (turning: ${replay})` : ""} (fixes ≤ ${MAX_HACC_M} m, ≥ ${MIN_SPEED_MPS * 3.6} km/h, straight road ≥ ${END_MARGIN_M} m from junctions)`);
for (const file of files) {
  const s = measureLog(file, graphs, replay);
  all.push(...s);
}
const passes = passesOf(all);
const logs = [...new Set(all.map((s) => s.log))];

console.log("\n== Per drive: fixes (and the dot the app drew while GPS-led), metres right of the travel direction");
for (const log of logs) {
  const s = all.filter((x) => x.log === log);
  console.log(line(`${log} fix`, s.map((x) => x.fixRight)));
  const d = s.map((x) => x.dotRight).filter((x): x is number => x !== null);
  if (d.length) console.log(line(`${" ".repeat(log.length)} dot`, d));
  const gap = s.filter((x) => x.dotRight !== null).map((x) => x.dotRight! - x.fixRight);
  if (gap.length) console.log(line(`${" ".repeat(log.length)} dot − fix`, gap));
}

console.log("\n== All drives, by road class and one-way (fixes)");
console.log(line("all fixes", all.map((x) => x.fixRight)));
console.log(line("all dots", all.map((x) => x.dotRight).filter((x): x is number => x !== null)));
console.log(line("all dot − fix", all.filter((x) => x.dotRight !== null).map((x) => x.dotRight! - x.fixRight)));
for (let c = 0; c < ROAD_CLASS_NAMES.length; c++) {
  for (const ow of [false, true]) {
    const xs = all.filter((x) => x.cls === c && x.oneway === ow).map((x) => x.fixRight);
    if (xs.length >= 20) console.log(line(`${ROAD_CLASS_NAMES[c]}${ow ? " one-way" : ""}`, xs));
  }
}

// Per edge, both directions driven: the part that flips with direction is lane offset, the part that doesn't is the
// line's position (plus GPS bias that happened to agree between the drives).
interface EdgeSplit {
  edge: number;
  wayId: number;
  cls: number;
  lat: number;
  lon: number;
  fwd: Pass[];
  bwd: Pass[];
  shiftRightOfGeom: number;
  lane: number;
}
const byEdge = new Map<number, Pass[]>();
for (const p of passes) byEdge.set(p.edge, [...(byEdge.get(p.edge) ?? []), p]);
const splits: EdgeSplit[] = [];
for (const [edge, ps] of byEdge) {
  const fwd = ps.filter((p) => p.dir === 1);
  const bwd = ps.filter((p) => p.dir === -1);
  if (!fwd.length || !bwd.length) continue;
  // In the geometry frame: forward right-of-travel = right of geometry; backward = left of it.
  const f = median(fwd.map((p) => p.fixRight));
  const b = -median(bwd.map((p) => p.fixRight));
  splits.push({ edge, wayId: ps[0].wayId, cls: ps[0].cls, lat: ps[0].lat, lon: ps[0].lon, fwd, bwd, shiftRightOfGeom: (f + b) / 2, lane: (f - b) / 2 });
}
console.log(`\n== Roads driven both ways (${splits.length} edges): what flips with direction (lane) vs what doesn't (the line)`);
if (splits.length) {
  console.log(`lane offset (right of travel)      median ${f1(median(splits.map((s) => s.lane)))} m  (p10 ${f1(quantile(splits.map((s) => s.lane), 0.1))}, p90 ${f1(quantile(splits.map((s) => s.lane), 0.9))})`);
  const shifts = splits.map((s) => Math.abs(s.shiftRightOfGeom));
  console.log(`line off the driven road |shift|    median ${u1(median(shifts))} m  p90 ${u1(quantile(shifts, 0.9))}  max ${u1(Math.max(...shifts))}  share > 3 m ${((100 * shifts.filter((x) => x > 3).length) / shifts.length).toFixed(0)} %`);
  console.log("  biggest (both directions driven; few passes = GPS bias can still be in it):");
  for (const s of [...splits].sort((a, b) => Math.abs(b.shiftRightOfGeom) - Math.abs(a.shiftRightOfGeom)).slice(0, 12)) {
    const drives = new Set([...s.fwd, ...s.bwd].map((p) => p.log)).size;
    console.log(
      `  ${u1(Math.abs(s.shiftRightOfGeom)).padStart(5)} m  lane ${f1(s.lane).padStart(5)}  ${String(s.fwd.length + s.bwd.length).padStart(2)} passes / ${drives} drives  ` +
        `${ROAD_CLASS_NAMES[s.cls].padEnd(12)} ${s.lat.toFixed(5)},${s.lon.toFixed(5)}  osm.org/way/${s.wayId}`,
    );
  }
}

// Same edge, same direction, different drives: how much the offset moves from drive to drive (GPS bias) against
// how much it moves from road to road.
const repeat: number[] = [];
const roadMeans: number[] = [];
for (const ps of byEdge.values()) {
  for (const dir of [1, -1] as const) {
    const perLog = new Map<string, number>();
    for (const p of ps.filter((x) => x.dir === dir)) if (!perLog.has(p.log)) perLog.set(p.log, p.fixRight);
    const v = [...perLog.values()];
    if (v.length < 2) continue;
    const m = median(v);
    roadMeans.push(m);
    for (const x of v) repeat.push(x - m);
  }
}
console.log(`\n== Same road, same direction, different drives (${roadMeans.length} road-directions)`);
if (roadMeans.length) {
  console.log(`drive-to-drive spread (GPS bias)    |dev| median ${u1(median(repeat.map(Math.abs)))} m  p90 ${u1(quantile(repeat.map(Math.abs), 0.9))}`);
  console.log(`road-to-road spread of the offset   median ${f1(median(roadMeans))}  p10 ${f1(quantile(roadMeans, 0.1))}  p90 ${f1(quantile(roadMeans, 0.9))}`);
}

// Spots where the offset beyond the usual lane offset is large and on the same side of the line on every pass.
const laneByClass = new Map<string, number>();
for (let c = 0; c < ROAD_CLASS_NAMES.length; c++) {
  for (const ow of [false, true]) {
    const xs = passes.filter((p) => p.cls === c && p.oneway === ow).map((p) => p.fixRight);
    if (xs.length >= 5) laneByClass.set(`${c}/${ow}`, median(xs));
  }
}
const typicalLane = median(passes.map((p) => p.fixRight));
const hot: { edge: number; excess: number; passes: Pass[]; drives: number }[] = [];
for (const [edge, ps] of byEdge) {
  const lane = laneByClass.get(`${ps[0].cls}/${ps[0].oneway}`) ?? typicalLane;
  // Excess offset in the geometry frame (right of the line as drawn).
  const ex = ps.map((p) => (p.fixRight - lane) * p.dir);
  const drives = new Set(ps.map((p) => p.log)).size;
  const sameSide = ex.every((x) => x > 0) || ex.every((x) => x < 0);
  if (drives >= 2 && sameSide) hot.push({ edge, excess: median(ex), passes: ps, drives });
}
console.log(`\n== Spots: beyond the usual lane offset, same side of the line on every pass, ≥ 2 drives (${hot.length} edges)`);
for (const h of hot.sort((a, b) => Math.abs(b.excess) - Math.abs(a.excess)).slice(0, 15)) {
  const p = h.passes[0];
  console.log(
    `  ${u1(Math.abs(h.excess)).padStart(5)} m ${h.excess > 0 ? "right" : "left "} of the line  ${String(h.passes.length).padStart(2)} passes / ${h.drives} drives  ` +
      `${ROAD_CLASS_NAMES[p.cls].padEnd(12)} ${p.oneway ? "one-way" : "two-way"}  ${p.lat.toFixed(5)},${p.lon.toFixed(5)}  osm.org/way/${p.wayId}`,
  );
}

if (detail) {
  const mine = passes.filter((p) => p.log.includes(detail));
  console.log(`\n== ${detail}: passes, time into the drive, fix and dot right of travel, other drives on that road`);
  for (const p of mine) {
    const others = (byEdge.get(p.edge) ?? []).filter((o) => o.log !== p.log);
    const same = others.filter((o) => o.dir === p.dir).map((o) => f1(o.fixRight));
    const opp = others.filter((o) => o.dir !== p.dir).map((o) => f1(o.fixRight));
    const flag = Math.abs(p.dotRight ?? p.fixRight) > 5 ? " <" : "";
    console.log(
      `  ${mmss(p.t0S).padStart(6)}–${mmss(p.t1S).padEnd(6)} fix ${f1(p.fixRight).padStart(5)}  dot ${f1(p.dotRight).padStart(5)}  ` +
        `${ROAD_CLASS_NAMES[p.cls].padEnd(12)} ${p.oneway ? "1w" : "2w"}  ${p.lat.toFixed(5)},${p.lon.toFixed(5)} way ${p.wayId}` +
        `${same.length ? `  same dir: ${same.join(" ")}` : ""}${opp.length ? `  opposite: ${opp.join(" ")}` : ""}${flag}`,
    );
  }
}

if (json) writeFileSync(json, JSON.stringify({ passes, splits: splits.map(({ fwd, bwd, ...s }) => ({ ...s, fwd: fwd.length, bwd: bwd.length })) }));
if (geojson) {
  writeFileSync(
    geojson,
    JSON.stringify({
      type: "FeatureCollection",
      features: all.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { log: s.log, t: Math.round(s.tS), fixRight: +s.fixRight.toFixed(2), dotRight: s.dotRight === null ? null : +s.dotRight.toFixed(2), way: s.wayId, dir: s.dir },
      })),
    }),
  );
}

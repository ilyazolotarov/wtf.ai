import { readFileSync } from "node:fs";
import path from "node:path";

import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { isSameRoad, legCoordinates, matchTruth } from "@/nav/replay/truth-match";
import type { GnssFix, ObdSpeedSample } from "@/nav/types";
import type { TripLog } from "@/triplog/trip-log-reader";

// The fixture network (tools/tiles tests/test_graph.py): grid of D = 0.0006° around (LAT0, LON0).
// Way 101 runs 1 (0,0) → 2 (1,0) east, 104 runs 2 → 6 (1,−1) south, 102 continues east from 2.
const FIXTURE = readFileSync(path.join(__dirname, "../../mapmatch/__fixtures__/net.graph.bin"));
const LON0 = 30.75;
const LAT0 = 51.52;
const D = 0.0006;
const frame = new LocalFrame({ lat: LAT0, lon: LON0 });
const graph = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), frame);
const START_US = 1_000_000_000;

/** A trip along ENU waypoints at constant speed: 1 Hz fixes (with a little noise) and 10 Hz OBD. */
function drive(waypoints: [number, number][], speed: number, options: { offsetM?: [number, number]; gapS?: [number, number] } = {}): TripLog {
  const legs = waypoints.slice(1).map((p, i) => {
    const a = waypoints[i];
    return { a, b: p, len: Math.hypot(p[0] - a[0], p[1] - a[1]) };
  });
  const total = legs.reduce((s, l) => s + l.len, 0);
  const at = (d: number) => {
    for (const l of legs) {
      if (d <= l.len) {
        const f = d / l.len;
        return { e: l.a[0] + f * (l.b[0] - l.a[0]), n: l.a[1] + f * (l.b[1] - l.a[1]), course: Math.atan2(l.b[0] - l.a[0], l.b[1] - l.a[1]) };
      }
      d -= l.len;
    }
    const l = legs.at(-1)!;
    return { e: l.b[0], n: l.b[1], course: Math.atan2(l.b[0] - l.a[0], l.b[1] - l.a[1]) };
  };
  const duration = total / speed;
  const gnss: GnssFix[] = [];
  const obdSpeed: ObdSpeedSample[] = [];
  for (let t = 0; t <= duration + 1e-9; t += 1) {
    if (options.gapS && t > options.gapS[0] && t < options.gapS[1]) continue;
    const p = at(t * speed);
    const noise = [Math.sin(7 * t) * 2, Math.cos(5 * t) * 2];
    const c = frame.toCoordinate(p.e + noise[0] + (options.offsetM?.[0] ?? 0), p.n + noise[1] + (options.offsetM?.[1] ?? 0));
    gnss.push({ tUs: START_US + t * 1e6, ...c, hAccM: 5, speedMps: speed, speedAccMps: 0.3, courseRad: p.course, courseAccRad: 0.05 });
  }
  for (let t = 0; t <= duration + 1; t += 0.1) obdSpeed.push({ tUs: START_US + t * 1e6, speedMps: speed, rawKph: Math.round(speed * 3.6) });
  return {
    startUs: START_US, info: {}, imu: [], mag: [], obdSpeed, gnss, engine: [], rpm: [], events: [], timeSync: [], messages: [], navEstimate: [], navMapMatch: [], truncated: false,
  };
}

const grid = (x: number, y: number) => frame.toEnu({ lon: LON0 + x * D, lat: LAT0 + y * D });

describe("matchTruth", () => {
  test("follows a right turn at a junction: 101 east, then 104 south", () => {
    const g = graph();
    const trip = drive([grid(0.05, 0), grid(1, 0), grid(1, -0.95)], 8);
    const truth = matchTruth(trip, g);
    expect(truth.breaks).toEqual([]);
    const ways = truth.points.map((p) => g.edge(p.edge).wayId);
    expect(ways[0]).toBe(101);
    expect(ways.at(-1)).toBe(104);
    expect(new Set(ways)).toEqual(new Set([101, 104]));
    expect(truth.points.every((p) => p.dir === 1)).toBe(true);
    // Legs match the OBD distance (both are the true distance here).
    for (const l of truth.legs) expect(Math.abs(l.lengthM - l.obdM)).toBeLessThan(6);
    expect(truth.legs.every((l) => l.penaltyM === 0)).toBe(true);
    // Between fixes the truth moves along the route.
    const mid = truth.at(START_US + 2.5e6)!; // 20 m along; the junction is ~40 m in
    expect(g.edge(mid.edge).wayId).toBe(101);
    const late = truth.at(truth.points.at(-1)!.tUs - 0.5e6)!;
    expect(g.edge(late.edge).wayId).toBe(104);
    expect(truth.at(START_US - 1e6)).toBeNull();
    // Route geometry runs from the first matched point to the last.
    const coords = truth.legs.flatMap((l) => legCoordinates(g, l, truth.points[l.from], truth.points[l.to]));
    expect(coords.length).toBeGreaterThan(truth.legs.length);
  });

  test("turning against the one-way 105 (8 → 4 only) still matches, with a penalty", () => {
    const g = graph();
    // East along 102 from 2 to 4, then south along 105 (4 → 8), which is one-way 8 → 4.
    const trip = drive([grid(1.1, 0), grid(3, 0), grid(3, -0.95)], 8);
    const truth = matchTruth(trip, g);
    const ways = truth.points.map((p) => g.edge(p.edge).wayId);
    expect(ways.at(-1)).toBe(105);
    expect(truth.legs.some((l) => l.penaltyM > 0)).toBe(true);
  });

  test("fixes far from any road form one 'no candidates' break", () => {
    const g = graph();
    const trip = drive([grid(0.05, 0), grid(1, 0)], 4, { offsetM: [0, -300] }); // south of everything
    const truth = matchTruth(trip, g);
    expect(truth.points).toEqual([]);
    expect(truth.breaks).toHaveLength(1);
    expect(truth.breaks[0]).toMatchObject({ reason: "no candidates", fixes: trip.gnss.length });
  });

  test("a long gap between clean fixes splits the chain", () => {
    const g = graph();
    const trip = drive([grid(-0.5, 0), grid(1, 0), grid(1, -0.95)], 2, { gapS: [10, 45] });
    const truth = matchTruth(trip, g);
    expect(truth.breaks.map((b) => b.reason)).toEqual(["gap"]);
    expect(truth.at(START_US + 30e6)).toBeNull();
    expect(truth.at(START_US + 5.5e6)).not.toBeNull();
  });

  test("isSameRoad: same edge, or a neighbour within the junction tolerance", () => {
    const g = graph();
    const truth = matchTruth(drive([grid(0.05, 0), grid(1, 0), grid(1, -0.95)], 8), g);
    const e101 = truth.points[0].edge;
    const e104 = truth.points.at(-1)!.edge;
    const len101 = g.edge(e101).cum.at(-1)!;
    expect(isSameRoad(g, { edge: e101, alongM: 10 }, e101)).toBe(true);
    expect(isSameRoad(g, { edge: e101, alongM: len101 - 5 }, e104)).toBe(true); // 5 m before node 2
    expect(isSameRoad(g, { edge: e101, alongM: len101 - 30 }, e104)).toBe(false);
  });
});

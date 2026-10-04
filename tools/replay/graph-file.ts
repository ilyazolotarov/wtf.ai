// Road graph files for Node tools: a ByteSource over fs, and the default graph for a trip.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Coordinate } from "../../src/nav/geo";
import { LocalFrame } from "../../src/nav/geo/local-frame";
import type { ByteSource } from "../../src/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "../../src/nav/mapmatch/graph/road-graph";
import { legCoordinates, matchTruth } from "../../src/nav/replay/truth-match";
import type { TripLog } from "../../src/triplog/trip-log-reader";

export const RELEASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tiles/out/release");

export function fileByteSource(file: string): ByteSource & { close(): void } {
  const fd = openSync(file, "r");
  const size = fstatSync(fd).size;
  return {
    size,
    read(offset, length) {
      const bytes = new Uint8Array(length);
      const got = readSync(fd, bytes, 0, length, offset);
      if (got !== length) throw new Error(`short read at ${offset}: ${got} of ${length}`);
      return bytes;
    },
    close: () => closeSync(fd),
  };
}

export function openGraph(file: string, origin: Coordinate): { graph: TiledRoadGraph; close(): void } {
  const source = fileByteSource(file);
  return { graph: new TiledRoadGraph(source, new LocalFrame(origin)), close: source.close };
}

/**
 * The smallest `*.graph.bin` in `dir` that has roads where `at` is: the oblast rather than
 * Ukraine, so tools behave like the app with that region active. Null when none covers it.
 */
export function findGraph(at: Coordinate, dir = RELEASE_DIR): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".graph.bin"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(a).size - statSync(b).size);
  for (const file of files) {
    const source = fileByteSource(file);
    try {
      const graph = new TiledRoadGraph(source, new LocalFrame(at));
      if (graph.tilesAround(0, 0, 500).length) return file;
    } finally {
      source.close();
    }
  }
  return null;
}

export interface RoadsPayload {
  graph: string | null;
  osmDate: string | null;
  tiles: number;
  /** GeoJSON. Roads drawn in travel direction for one-ways (`ow` 1), so arrows follow the line. */
  roads: { type: "FeatureCollection"; features: object[] };
  nodes: { type: "FeatureCollection"; features: object[] };
}

/** Roads within `radiusM` of the given points (by tiles), as GeoJSON for the replay viewer. */
export function roadsAround(graphFile: string, points: Coordinate[], radiusM = 400): RoadsPayload {
  const { graph, close } = openGraph(graphFile, points[0]);
  try {
    return roadsPayload(graph, graphFile, points, radiusM);
  } finally {
    close();
  }
}

function roadsPayload(graph: TiledRoadGraph, graphFile: string, points: Coordinate[], radiusM: number): RoadsPayload {
  const frame = new LocalFrame(points[0]);
  const tiles = new Set<number>();
  let last: [number, number] | null = null;
  for (const p of points) {
    const [e, n] = frame.toEnu(p);
    if (last && Math.hypot(e - last[0], n - last[1]) < radiusM / 4) continue;
    last = [e, n];
    for (const t of graph.tilesAround(e, n, radiusM)) tiles.add(t);
  }
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const edges = graph.edgesInTiles(tiles);
  const roads = edges.map((edge) => {
    const coords: number[][] = [];
    for (let j = 0; j < edge.lonLat.length; j += 2) coords.push([r6(edge.lonLat[j]), r6(edge.lonLat[j + 1])]);
    if (edge.oneway === 2) coords.reverse();
    return {
      type: "Feature",
      properties: { id: edge.id, way: edge.wayId, cls: edge.cls, ow: edge.oneway ? 1 : 0, fl: edge.flags, len: Math.round(edge.lengthM) },
      geometry: { type: "LineString", coordinates: coords },
    };
  });
  const nodeIds = new Set(edges.flatMap((e) => [e.from, e.to]));
  const nodes = [...nodeIds].map((id) => {
    const node = graph.node(id);
    return {
      type: "Feature",
      properties: { id, deg: node.edges.length, fl: node.flags },
      geometry: { type: "Point", coordinates: [r6(node.lon), r6(node.lat)] },
    };
  });
  return {
    graph: path.basename(graphFile),
    osmDate: graph.info.osmDate,
    tiles: tiles.size,
    roads: { type: "FeatureCollection", features: roads },
    nodes: { type: "FeatureCollection", features: nodes },
  };
}

export interface TruthPayload {
  graph: string | null;
  /** Legs as GeoJSON lines with `t0` / `t1` (s since log start); breaks as points with `reason`. */
  legs: { type: "FeatureCollection"; features: object[] };
  breaks: { type: "FeatureCollection"; features: object[] };
  summary: { fixes: number; matched: number; breaks: number };
}

/** Ground-truth route for the replay viewer (MAPMATCH-SPEC §10.1). */
export function truthRoute(graphFile: string, trip: TripLog): TruthPayload {
  const first = trip.gnss.find((f) => f.hAccM <= 10) ?? trip.gnss[0];
  const { graph, close } = openGraph(graphFile, first);
  try {
    const truth = matchTruth(trip, graph);
    const tS = (tUs: number) => Math.round(((tUs - trip.startUs) / 1e6) * 100) / 100;
    const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
    const legs = truth.legs.map((leg) => ({
      type: "Feature",
      properties: { t0: tS(truth.points[leg.from].tUs), t1: tS(truth.points[leg.to].tUs), len: Math.round(leg.lengthM), obd: Math.round(leg.obdM), pen: leg.penaltyM },
      geometry: {
        type: "LineString",
        coordinates: legCoordinates(graph, leg, truth.points[leg.from], truth.points[leg.to]).map(([x, y]) => [r6(x), r6(y)]),
      },
    }));
    const breaks = truth.breaks.map((b) => ({
      type: "Feature",
      properties: { t0: tS(b.t0Us), t1: tS(b.t1Us), reason: b.reason, fixes: b.fixes, degraded: b.degradedFixes ?? 0 },
      geometry: { type: "Point", coordinates: [r6(b.lon), r6(b.lat)] },
    }));
    return {
      graph: path.basename(graphFile),
      legs: { type: "FeatureCollection", features: legs },
      breaks: { type: "FeatureCollection", features: breaks },
      summary: { fixes: truth.fixes, matched: truth.points.length, breaks: truth.breaks.length },
    };
  } finally {
    close();
  }
}

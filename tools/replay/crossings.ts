// Road crossings away from junctions (src/nav/mapmatch/road-crossing.ts, MAPMATCH-SPEC §7.4) along a path: a car
// crosses a road only at a junction.
//   npm run replay:crossings -- tools/triplog/logs/*.ulg      the true paths (clean satellite fixes): how often a
//                                                             real car seems to do it (GPS noise, OSM geometry)
// replay:places counts the same for the filter's off-road cluster.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LocalFrame } from "../../src/nav/geo/local-frame";
import { ROAD_CLASS_NAMES } from "../../src/nav/mapmatch/graph/format";
import { closestPoint, type RoadEdge, type RoadGraph } from "../../src/nav/mapmatch/graph/road-graph";
import { CROSSING_RULES, crossedRoad } from "../../src/nav/mapmatch/road-crossing";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog } from "../../src/triplog/trip-log-reader";
import { findGraph, openGraph } from "./graph-file";

export interface PathPoint {
  tS: number;
  e: number;
  n: number;
}
export interface Crossing {
  tS: number;
  wayId: number;
  cls: string;
  /** Distance from the crossing to the nearer end of the edge (a junction or a way's end), m. */
  junctionM: number;
}

/** Look this far before and after a crossing for points clear of the road on both sides. */
const AROUND_S = 6;

/** Which side of the edge a point is on (by the edge's direction at its closest point); 0 within `clearM`. */
function sideOf(edge: RoadEdge, a: PathPoint): number {
  const c = closestPoint(edge, a.e, a.n);
  if (c.distanceM < CROSSING_RULES.clearM) return 0;
  return Math.sign(Math.sin(c.headingRad) * (a.n - c.n) - Math.cos(c.headingRad) * (a.e - c.e));
}

/** Crossings of mapped roads away from junctions (road-crossing.ts), clear of the road within a few seconds each side. */
export function roadCrossings(graph: RoadGraph, path: PathPoint[]): Crossing[] {
  const out: Crossing[] = [];
  for (let k = 0; k + 1 < path.length; k++) {
    const p = path[k], q = path[k + 1];
    const hit = crossedRoad(graph, p.e, p.n, q.e, q.n, CROSSING_RULES, true);
    if (!hit) continue;
    const before = path.slice(0, k + 1).filter((a) => a.tS >= p.tS - AROUND_S);
    const after = path.slice(k + 1).filter((a) => a.tS <= q.tS + AROUND_S);
    const s0 = before.map((a) => sideOf(hit.edge, a)).find((s) => s !== 0);
    const s1 = after.map((a) => sideOf(hit.edge, a)).reverse().find((s) => s !== 0);
    if (s0 === undefined || s1 === undefined || s0 === s1) continue;
    if (!out.some((c) => c.wayId === hit.edge.wayId && Math.abs(c.tS - p.tS) < 2 * AROUND_S)) {
      out.push({ tS: p.tS, wayId: hit.edge.wayId, cls: ROAD_CLASS_NAMES[hit.edge.cls] ?? String(hit.edge.cls), junctionM: hit.junctionM });
    }
  }
  return out;
}

export const formatCrossings = (cs: Crossing[]) => cs.map((c) => `${c.tS.toFixed(0)} s ${c.cls} ${c.wayId} (${c.junctionM.toFixed(0)} m from a junction)`).join("; ");

function main() {
  const files = process.argv.slice(2);
  let total = 0;
  for (const file of files) {
    const trip = readTripLog(new Uint8Array(readFileSync(file)));
    const fixes = trip.gnss.filter((f) => isSatelliteFix(f) && f.hAccM <= 10);
    const graphFile = fixes.length ? findGraph(fixes[0]) : null;
    if (!graphFile) continue;
    const g = openGraph(graphFile, fixes[0]);
    const frame = new LocalFrame(fixes[0]);
    // Runs of clean fixes, a break where they are more than 3 s apart.
    const runs: PathPoint[][] = [];
    let last = -Infinity;
    for (const f of fixes) {
      const tS = (f.tUs - trip.startUs) / 1e6;
      if (tS - last > 3) runs.push([]);
      const [e, n] = frame.toEnu(f);
      runs.at(-1)!.push({ tS, e, n });
      last = tS;
    }
    const found = runs.flatMap((r) => roadCrossings(g.graph, r));
    g.close();
    total += found.length;
    console.log(`${path.basename(file).padEnd(28)} ${String(fixes.length).padStart(5)} clean fixes  crossings ${found.length}${found.length ? `: ${formatCrossings(found)}` : ""}`);
  }
  console.log(`total ${total}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

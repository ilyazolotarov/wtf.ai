// The road ahead of a car that has no route (the emulated adapter's car, VEHICLE-LINK-SPEC §13): from the road it is
// on, the straightest way on at each junction, as a line a `RouteDrive` drives along. Never against a one-way or a
// turn restriction; onto a driveway, a parking aisle or a private road only where there is nothing else; back round a
// turning bulb at a dead end.

import type { Coordinate } from "../geo";
import { LocalFrame } from "../geo/local-frame";
import { EdgeFlag, Oneway } from "../mapmatch/graph/format";
import { geometryLength, type EdgeId, type Exit, type RoadEdge, type RoadGraph } from "../mapmatch/graph/road-graph";

/** On `edge`, travelling `dir` along its geometry, `alongM` from its start. */
export interface RoadSpot {
  edge: EdgeId;
  dir: 1 | -1;
  alongM: number;
}

/** A stretch of the line on one edge: from `alongM` on it, starting at the line's point `firstPoint`. */
export interface RoadStretch extends RoadSpot {
  firstPoint: number;
}

export interface RoadLine {
  points: Coordinate[];
  stretches: RoadStretch[];
  /** The road ends where the line does (no way on, not even back): the car stops there. */
  ends: boolean;
}

/** A car this far from a road isn't on it, m. */
export const ROAD_SNAP_M = 40;
/** A road heading off the car's heading counts as this much farther, m per rad: the road it drives along, not the crossing one. */
const HEADING_WEIGHT_M = 20;
/** A driveway, a parking aisle or a private road counts as this much farther, m: the car is on the street beside it. */
const MINOR_PENALTY_M = 25;
/** At most this many edges in one line (a lane of short edges). */
const MAX_STRETCHES = 400;

const TWO_PI = 2 * Math.PI;
const angleBetween = (a: number, b: number) => Math.abs(a - b - TWO_PI * Math.floor((a - b + Math.PI) / TWO_PI));
const against = (edge: RoadEdge, dir: 1 | -1) => edge.oneway === (dir === 1 ? Oneway.backward : Oneway.forward);
const minor = (edge: RoadEdge) => (edge.flags & (EdgeFlag.minorService | EdgeFlag.private)) !== 0;

/**
 * The road the car at `at` is on, going the way of `headingRad` (clockwise from north; absent: the way the road allows,
 * its geometry's when both): the nearest within `ROAD_SNAP_M`, a road off the heading or a minor one as if farther.
 * Null: no road.
 */
export function roadUnder(graph: RoadGraph, frame: LocalFrame, at: Coordinate, headingRad?: number): RoadSpot | null {
  const [e, n] = frame.toEnu(at);
  const near = graph.edgesNear(e, n, ROAD_SNAP_M);
  let best: { spot: RoadSpot; score: number } | null = null;
  for (const c of near) {
    let dir: 1 | -1 = against(c.edge, 1) ? -1 : 1;
    let score = c.distanceM + (minor(c.edge) ? MINOR_PENALTY_M : 0);
    if (headingRad !== undefined) {
      dir = Math.cos(headingRad - c.headingRad) >= 0 ? 1 : -1;
      if (against(c.edge, dir)) continue;
      score += HEADING_WEIGHT_M * angleBetween(headingRad, dir > 0 ? c.headingRad : c.headingRad + Math.PI);
    }
    if (!best || score < best.score) best = { spot: { edge: c.edge.id, dir, alongM: c.alongM }, score };
  }
  return best?.spot ?? null;
}

/**
 * The way on after travelling `dir` along `edge`: the exit turning least, never against a one-way or a restriction,
 * a driveway, a parking aisle or a private road only when nothing else goes on; back the same road at a dead end. Null:
 * none.
 */
export function straightOn(graph: RoadGraph, edge: EdgeId, dir: 1 | -1): Exit | null {
  const exits = graph.exits(edge, dir).filter((x) => !x.againstOneway && !x.restricted);
  const on = exits.filter((x) => !x.uTurn);
  const main = on.filter((x) => !minor(graph.edge(x.edge)));
  const pick = (main.length ? main : on).reduce<Exit | null>((a, x) => (!a || Math.abs(x.turnRad) < Math.abs(a.turnRad) ? x : a), null);
  return pick ?? exits.find((x) => x.uTurn) ?? null;
}

/** The road from `from` on, straight on at each junction (`straightOn`), at least `lengthM` long unless it ends. */
export function roadLine(graph: RoadGraph, from: RoadSpot, lengthM: number): RoadLine {
  const points: Coordinate[] = [];
  const stretches: RoadStretch[] = [];
  let spot: RoadSpot = from;
  let total = 0;
  for (;;) {
    const edge = graph.edge(spot.edge);
    const firstPoint = Math.max(0, points.length - 1);
    for (const p of edgePoints(edge, spot.dir, spot.alongM)) {
      const last = points[points.length - 1];
      if (!last || last.lat !== p.lat || last.lon !== p.lon) points.push(p);
    }
    stretches.push({ ...spot, firstPoint });
    total += spot.dir > 0 ? edgeLength(edge) - spot.alongM : spot.alongM;
    if (total >= lengthM || stretches.length >= MAX_STRETCHES) return { points, stretches, ends: false };
    const next = straightOn(graph, spot.edge, spot.dir);
    if (!next) return { points, stretches, ends: true };
    if (next.uTurn) {
      points.push(...turnBack(points));
      total += TURN_BACK_LENGTH_M;
    }
    spot = { edge: next.edge, dir: next.dir, alongM: next.dir > 0 ? 0 : edgeLength(graph.edge(next.edge)) };
  }
}

/** A turn back at a dead end goes round a bulb past it, on arcs of this radius, m. */
const TURN_BACK_R_M = 6;
/** 60° right, 300° left, 60° right. */
const TURN_BACK_LENGTH_M = (7 * Math.PI * TURN_BACK_R_M) / 3;

/**
 * The car turning back at the line's end, as round a turning bulb: right 60°, left round 300°, right 60° into the end
 * again the other way. Its wheels turn as on a road (a reversal on the spot isn't a car's), and the loop ends where
 * the road back starts.
 */
function turnBack(points: Coordinate[]): Coordinate[] {
  const end = points[points.length - 1];
  const before = points[points.length - 2];
  if (!before) return [];
  const frame = new LocalFrame(end);
  const [be, bn] = frame.toEnu(before);
  const h = Math.atan2(-be, -bn);
  const r = TURN_BACK_R_M;
  // The car's own frame: x to its right, y ahead, angles anticlockwise.
  const local: [number, number][] = [];
  const arc = (cx: number, cy: number, from: number, sweep: number) => {
    const steps = Math.round(Math.abs(sweep) / ((10 * Math.PI) / 180));
    for (let k = 1; k <= steps; k++) {
      const a = from + (sweep * k) / steps;
      local.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  arc(r, 0, Math.PI, -Math.PI / 3);
  arc(0, Math.sqrt(3) * r, -Math.PI / 3, (5 * Math.PI) / 3);
  arc(-r, 0, Math.PI / 3, -Math.PI / 3);
  local.pop();
  const out = local.map(([x, y]) => frame.toCoordinate(x * Math.cos(h) + y * Math.sin(h), -x * Math.sin(h) + y * Math.cos(h)));
  // Back at the end exactly: the road back starts there.
  out.push(end);
  return out;
}

/**
 * Where on the roads a car `alongM` along `line` is (`alongTo(i)`: along the line to its point `i`, as the drive
 * measures it).
 */
export function spotOnLine(graph: RoadGraph, line: RoadLine, alongM: number, alongTo: (i: number) => number): RoadSpot {
  let k = 0;
  while (k + 1 < line.stretches.length && alongTo(line.stretches[k + 1].firstPoint) <= alongM) k++;
  const s = line.stretches[k];
  const len = edgeLength(graph.edge(s.edge));
  const on = s.alongM + s.dir * (alongM - alongTo(s.firstPoint));
  return { edge: s.edge, dir: s.dir, alongM: Math.max(0, Math.min(len, on)) };
}

const edgeLength = geometryLength;

/** The edge's geometry from `fromM` along it to its end in `dir`, in degrees. */
function edgePoints(edge: RoadEdge, dir: 1 | -1, fromM: number): Coordinate[] {
  const { cum, lonLat } = edge;
  const vertex = (i: number): Coordinate => ({ lat: lonLat[2 * i + 1], lon: lonLat[2 * i] });
  const out: Coordinate[] = [pointAt(edge, fromM)];
  if (dir > 0) {
    for (let i = 0; i < cum.length; i++) if (cum[i] > fromM) out.push(vertex(i));
  } else {
    for (let i = cum.length - 1; i >= 0; i--) if (cum[i] < fromM) out.push(vertex(i));
  }
  return out;
}

function pointAt(edge: RoadEdge, alongM: number): Coordinate {
  const { cum, lonLat } = edge;
  let i = 0;
  while (i + 2 < cum.length && cum[i + 1] < alongM) i++;
  if (cum.length < 2) return { lat: lonLat[1], lon: lonLat[0] };
  const len = cum[i + 1] - cum[i];
  const f = len > 0 ? Math.max(0, Math.min(1, (alongM - cum[i]) / len)) : 0;
  // A vertex as it is: the next edge starts there, and the line holds it once.
  if (f === 0 || f === 1) return { lat: lonLat[2 * (i + f) + 1], lon: lonLat[2 * (i + f)] };
  return {
    lat: lonLat[2 * i + 1] + f * (lonLat[2 * i + 3] - lonLat[2 * i + 1]),
    lon: lonLat[2 * i] + f * (lonLat[2 * i + 2] - lonLat[2 * i]),
  };
}

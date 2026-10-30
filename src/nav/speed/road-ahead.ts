// The road ahead of the car (UI-SPEC §6.5): from where the car may be on the roads, along them the way it would go
// on (the route's way, else straight on), and the speed cameras on it facing its traffic.

import type { LocalFrame } from "../geo/local-frame";
import { EdgeFlag } from "../mapmatch/graph/format";
import type { EdgeId, Exit, NearEdge, RoadEdge, RoadGraph } from "../mapmatch/graph/road-graph";
import type { SpeedCamera } from "./cameras";
import { edgeLimit, LIMIT_LEAD_S, slowingM, type SpeedLimit } from "./speed-limit";

/** Where the car may be: on `edge`, travelling `dir` along its geometry, `alongM` from its start; `weight` its share. */
export interface RoadPosition {
  edge: EdgeId;
  dir: 1 | -1;
  alongM: number;
  weight: number;
}

/** A camera on a road: the edge, how far along it, and the way along it whose traffic it checks (0: both). */
export interface CameraOnRoad {
  camera: SpeedCamera;
  edge: EdgeId;
  alongM: number;
  dir: 1 | -1 | 0;
}

/** A camera on the road ahead: how far, on which edge, and the share of the car's positions that have it ahead. */
export interface CameraSighting {
  camera: SpeedCamera;
  edge: EdgeId;
  distanceM: number;
  share: number;
}

/** A camera checks a road this close: OSM puts it on the road or beside it (a pole on the verge, between carriageways), m. */
const CAMERA_ROAD_M = 30;
/** Roads this little farther than the nearest it may check are its roads too (both edges at a node, two lanes), m. */
const CAMERA_ROAD_SLACK_M = 5;
/** A camera's direction and a road's agree within this. */
const CAMERA_HEADING_RAD = (45 * Math.PI) / 180;
/** Straight on at a junction: an exit within this of the way in. */
const STRAIGHT_RAD = (45 * Math.PI) / 180;
/** The same OSM way bent at a junction is followed up to this turn: the road the car is on goes on there. */
const SAME_WAY_RAD = (100 * Math.PI) / 180;
/** At most this many stretches of road from one position (forks on forks). */
const MAX_STRETCHES = 64;
/** Positions the car may be in, heaviest first, until they hold this share, and at most this many. */
const STARTS_SHARE = 0.95;
const MAX_STARTS = 4;

const TWO_PI = 2 * Math.PI;
const angleBetween = (a: number, b: number) => Math.abs(a - b - TWO_PI * Math.floor((a - b + Math.PI) / TWO_PI));

/**
 * The roads each camera checks: the nearest within 30 m along its direction (either way along it without one), and
 * any as near give or take 5 m. Driveways and parking aisles are no camera's.
 */
export function camerasOnRoads(graph: RoadGraph, frame: LocalFrame, cameras: Iterable<SpeedCamera>): CameraOnRoad[] {
  const out: CameraOnRoad[] = [];
  for (const camera of cameras) {
    const [e, n] = frame.toEnu(camera);
    const found: { near: NearEdge; dir: 1 | -1 | 0 }[] = [];
    for (const near of graph.edgesNear(e, n, CAMERA_ROAD_M)) {
      if (near.edge.flags & EdgeFlag.minorService) continue;
      let dir: 1 | -1 | 0 = 0;
      if (camera.bearingRad !== undefined) {
        if (angleBetween(camera.bearingRad, near.headingRad) <= CAMERA_HEADING_RAD) dir = 1;
        else if (angleBetween(camera.bearingRad, near.headingRad + Math.PI) <= CAMERA_HEADING_RAD) dir = -1;
        else continue;
      }
      found.push({ near, dir });
    }
    if (!found.length) continue;
    const nearest = found[0].near.distanceM;
    for (const { near, dir } of found) {
      if (near.distanceM <= nearest + CAMERA_ROAD_SLACK_M) out.push({ camera, edge: near.edge.id, alongM: near.alongM, dir });
    }
  }
  return out;
}

/** The route as the road ahead follows it: after each directed edge, the route's next one. */
export type RouteNext = ReadonlyMap<string, { edge: EdgeId; dir: 1 | -1 }>;
const directed = (edge: EdgeId, dir: 1 | -1) => `${edge}:${dir}`;

export function routeNext(legs: readonly { edge: EdgeId; dir: 1 | -1 }[]): RouteNext {
  const next = new Map<string, { edge: EdgeId; dir: 1 | -1 }>();
  for (let i = 0; i + 1 < legs.length; i++) {
    const a = legs[i];
    const b = legs[i + 1];
    if (a.edge !== b.edge || a.dir !== b.dir) next.set(directed(a.edge, a.dir), { edge: b.edge, dir: b.dir });
  }
  return next;
}

/** A directed stretch of the road ahead: on `edge` travelling `dir`, `fromM` to `toM` along it, `startM` ahead at `fromM`. */
export interface Stretch {
  edge: EdgeId;
  dir: 1 | -1;
  fromM: number;
  toM: number;
  startM: number;
}

/**
 * The roads ahead of a position, up to `maxM` along them. At a junction the car goes on along the route when it is
 * on it, else straight on (every exit within 45°: both ways of a fork), or along its own OSM way where it bends; never
 * back, against a one-way or a turn restriction. A road that ends, or meets others only at an angle, ends it.
 */
export function roadAhead(graph: RoadGraph, start: RoadPosition, maxM: number, route?: RouteNext): Stretch[] {
  const out: Stretch[] = [];
  const seen = new Set<string>();
  const queue: Omit<Stretch, "toM">[] = [{ edge: start.edge, dir: start.dir, fromM: start.alongM, startM: 0 }];
  while (queue.length && out.length < MAX_STRETCHES) {
    const s = queue.shift()!;
    const key = directed(s.edge, s.dir);
    if (seen.has(key)) continue;
    seen.add(key);
    const edge = graph.edge(s.edge);
    const toM = s.dir > 0 ? edge.lengthM : 0;
    out.push({ ...s, toM });
    const endM = s.startM + Math.abs(toM - s.fromM);
    if (endM >= maxM) continue;
    for (const x of goesOn(graph, edge, s.dir, route)) {
      queue.push({ edge: x.edge, dir: x.dir, fromM: x.dir > 0 ? 0 : graph.edge(x.edge).lengthM, startM: endM });
    }
  }
  return out;
}

/**
 * The road `aheadM` on from a position, as far as it can only go on: one way on at each node (driveways and parking
 * aisles aside). At a node with a choice it stops, the car may turn there: the road it stopped on.
 */
export function edgeAhead(graph: RoadGraph, start: Omit<RoadPosition, "weight">, aheadM: number): RoadEdge {
  let edge = graph.edge(start.edge);
  let dir = start.dir;
  let left = aheadM - (dir > 0 ? edge.lengthM - start.alongM : start.alongM);
  for (let i = 0; left > 0 && i < MAX_STRETCHES; i++) {
    const on = graph
      .exits(edge.id, dir)
      .filter((x) => !x.uTurn && !x.againstOneway && !x.restricted && !(graph.edge(x.edge).flags & EdgeFlag.minorService));
    if (on.length !== 1) break;
    edge = graph.edge(on[0].edge);
    dir = on[0].dir;
    left -= edge.lengthM;
  }
  return edge;
}

/**
 * The road whose limit a car on it at `speedMps` is shown (UI-SPEC §6.4): the one it will be on once a change has
 * shown (`LIMIT_LEAD_S`, `edgeAhead`), or sooner, a lower limit next on its road (`nextLimits`) as soon as slowing
 * gently from the limit here (`slowingM`; without one, from the speed) would take it there by the start: the warning
 * comes in time to slow down, and a higher limit still shows where it starts.
 */
export function limitRoad(graph: RoadGraph, start: Omit<RoadPosition, "weight">, speedMps: number, route?: RouteNext): RoadEdge {
  const leadM = speedMps * LIMIT_LEAD_S;
  let pick = edgeAhead(graph, start, leadM);
  let pickKph = edgeLimit(pick)?.kph ?? Infinity;
  const fromKph = edgeLimit(graph.edge(start.edge))?.kph ?? speedMps * 3.6;
  for (const next of nextLimits(graph, start, leadM + slowingM(fromKph, 0), route)) {
    const kph = next.limit.kph;
    if (kph < fromKph && kph < pickKph && next.startM <= leadM + slowingM(fromKph, kph)) {
      pick = next.edge;
      pickKph = kph;
    }
  }
  return pick;
}

/**
 * The next other limit on the car's road within `maxM`, on each way it may go, and how far ahead it starts. The road:
 * the route's way when the car is on it, else straight on (within 45°, every way of a fork) to roads of its class or
 * higher, not onto a slip road from a road that isn't one: a side road or an exit with a lower limit isn't the car's
 * until it turns there. Roads without a limit don't end it.
 */
export function nextLimits(graph: RoadGraph, start: Omit<RoadPosition, "weight">, maxM: number, route?: RouteNext): { edge: RoadEdge; limit: SpeedLimit; startM: number }[] {
  const first = graph.edge(start.edge);
  const hereKph = edgeLimit(first)?.kph;
  const out: { edge: RoadEdge; limit: SpeedLimit; startM: number }[] = [];
  const seen = new Set<string>([directed(first.id, start.dir)]);
  const queue = [{ edge: first, dir: start.dir, endM: start.dir > 0 ? first.lengthM - start.alongM : start.alongM }];
  while (queue.length && seen.size < MAX_STRETCHES) {
    const s = queue.shift()!;
    if (s.endM >= maxM) continue;
    for (const x of onItsRoad(graph, s.edge, s.dir, route)) {
      const key = directed(x.edge, x.dir);
      if (seen.has(key)) continue;
      seen.add(key);
      const edge = graph.edge(x.edge);
      const limit = edgeLimit(edge);
      if (limit && limit.kph !== hereKph) out.push({ edge, limit, startM: s.endM });
      else queue.push({ edge, dir: x.dir, endM: s.endM + edge.lengthM });
    }
  }
  return out;
}

function onItsRoad(graph: RoadGraph, via: RoadEdge, dir: 1 | -1, route?: RouteNext): Exit[] {
  const exits = graph
    .exits(via.id, dir)
    .filter((x) => !x.uTurn && !x.againstOneway && !x.restricted && !(graph.edge(x.edge).flags & EdgeFlag.minorService));
  const planned = route?.get(directed(via.id, dir));
  const onRoute = planned && exits.find((x) => x.edge === planned.edge && x.dir === planned.dir);
  if (onRoute) return [onRoute];
  const onLink = (via.flags & EdgeFlag.link) !== 0;
  return exits.filter((x) => {
    const e = graph.edge(x.edge);
    return Math.abs(x.turnRad) <= STRAIGHT_RAD && e.cls <= via.cls && (onLink || !(e.flags & EdgeFlag.link));
  });
}

function goesOn(graph: RoadGraph, via: RoadEdge, dir: 1 | -1, route?: RouteNext): Exit[] {
  const exits = graph.exits(via.id, dir).filter((x) => !x.uTurn && !x.againstOneway && !x.restricted);
  const planned = route?.get(directed(via.id, dir));
  const onRoute = planned && exits.find((x) => x.edge === planned.edge && x.dir === planned.dir);
  if (onRoute) return [onRoute];
  if (exits.length <= 1) return exits;
  const on = exits.filter((x) => Math.abs(x.turnRad) <= STRAIGHT_RAD);
  const sameWay = exits.find((x) => Math.abs(x.turnRad) <= SAME_WAY_RAD && graph.edge(x.edge).wayId === via.wayId);
  if (sameWay && !on.includes(sameWay)) on.push(sameWay);
  return on;
}

/**
 * The positions to look ahead from: the heaviest on a road with a direction, until they hold 95 % of the weight (at
 * most 4). Weights stay shares of the whole, off the roads included.
 */
export function startsFrom(candidates: readonly { edge: EdgeId | null; dir?: 1 | -1; alongM?: number; weight: number }[]): RoadPosition[] {
  const total = candidates.reduce((s, c) => s + Math.max(0, c.weight), 0);
  if (!(total > 0)) return [];
  const onRoads = candidates
    .filter((c): c is { edge: EdgeId; dir: 1 | -1; alongM: number; weight: number } => c.edge !== null && c.dir !== undefined && c.alongM !== undefined && c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const out: RoadPosition[] = [];
  let held = 0;
  for (const c of onRoads) {
    if (held >= STARTS_SHARE || out.length >= MAX_STARTS) break;
    out.push({ edge: c.edge, dir: c.dir, alongM: c.alongM, weight: c.weight / total });
    held += c.weight / total;
  }
  return out;
}

/**
 * The cameras on the road ahead of each position, up to `maxM`, checking the car's traffic, nearest first. Each at the
 * distance its heaviest position sees it; `share`: the weight of the positions that see it.
 */
export function camerasAhead(
  graph: RoadGraph,
  starts: readonly RoadPosition[],
  onRoads: ReadonlyMap<EdgeId, readonly CameraOnRoad[]>,
  maxM: number,
  route?: RouteNext,
): CameraSighting[] {
  const out = new Map<number, CameraSighting & { by: number }>();
  for (const start of starts) {
    const mine = new Map<number, { edge: EdgeId; distanceM: number }>();
    for (const s of roadAhead(graph, start, maxM, route)) {
      for (const c of onRoads.get(s.edge) ?? []) {
        if (c.dir !== 0 && c.dir !== s.dir) continue;
        const ahead = (c.alongM - s.fromM) * s.dir;
        const left = (s.toM - c.alongM) * s.dir;
        const distanceM = s.startM + ahead;
        if (ahead < 0 || left < 0 || distanceM > maxM) continue;
        const was = mine.get(c.camera.id);
        if (!was || distanceM < was.distanceM) mine.set(c.camera.id, { edge: s.edge, distanceM });
      }
    }
    for (const [id, seen] of mine) {
      const camera = onRoads.get(seen.edge)!.find((c) => c.camera.id === id)!.camera;
      const sighting = out.get(id);
      if (!sighting) out.set(id, { camera, ...seen, share: start.weight, by: start.weight });
      else {
        sighting.share += start.weight;
        if (start.weight > sighting.by) Object.assign(sighting, seen, { by: start.weight });
      }
    }
  }
  return [...out.values()].map(({ by: _, ...s }) => s).sort((a, b) => a.distanceM - b.distanceM);
}

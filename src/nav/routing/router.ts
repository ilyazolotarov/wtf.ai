// A* route planner over the directed edges of the region's road graph (ROUTING-SPEC §5).
// Pure TS: the app runs it in slices on the JS thread, Node tools run it to the end.

import type { Coordinate } from "../geo";
import type { LocalFrame } from "../geo/local-frame";
import { EdgeFlag, Oneway, RoadClass } from "../mapmatch/graph/format";
import type { EdgeId, GraphStats, NearEdge, RoadEdge, RoadGraph } from "../mapmatch/graph/road-graph";
import { DEFAULT_ROUTE_COSTS, edgeSpeedMps, entrySeconds, maxSpeedMps, turnSeconds, type RouteCosts } from "./cost";
import { MinHeap } from "./min-heap";

export interface RouteStart extends Coordinate {
  /** The car's heading, clockwise from north; unknown: both directions start free. */
  headingRad?: number;
  /** How far off the position may be, m: start candidates within max(25 m, this). */
  accuracyM?: number;
}

export interface RouteOptions {
  costs?: Partial<RouteCosts>;
  /** States settled before giving up ("too far"). */
  maxStates?: number;
}

/** A directed stretch of an edge, from `fromM` to `toM` along its geometry (`fromM > toM`: against it). */
export interface RouteLeg {
  edge: EdgeId;
  dir: 1 | -1;
  fromM: number;
  toM: number;
}

export interface RoutePlan {
  legs: RouteLeg[];
  lengthM: number;
  durationS: number;
  /** The route as a polyline, from the start's projection on its road to the destination's. */
  coordinates: Coordinate[];
  /** How far the route's ends are from the requested start and destination, m. */
  offRoadM: { start: number; end: number };
  /** The route starts against the car's heading: turn around first. */
  startTurnaround?: boolean;
}

export interface RouteStats {
  /** Directed edges settled. */
  states: number;
  tilesRead: number;
  /** Time spent in `run`, ms. */
  ms: number;
}

export type RouteFailure = "no-road-at-start" | "no-road-at-destination" | "no-route" | "too-far";

export type RouteStatus =
  | { status: "more"; stats: RouteStats }
  | { status: "done"; plan: RoutePlan; stats: RouteStats }
  | { status: "failed"; reason: RouteFailure; stats: RouteStats };

const START_RADIUS_M = 25;
/** Start candidates: the nearest edge and any within this of it. */
const START_MARGIN_M = 10;
/** A candidate's closest point this near its end is that end's node. */
const JUNCTION_END_M = 0.5;
/** Farther edges, up to this far from the start or the destination, are fallback ends. */
const FALLBACK_RADIUS_M = 500;
/** A public road this close to the nearest edge wins over a private road or a driveway. */
const DEST_PUBLIC_M = 50;
/**
 * Fallback ends (§5.1): a road island (a car park or gated area not connected in OSM) must not leave the route
 * impossible, so every edge within `FALLBACK_RADIUS_M` is an end too, at a cost no ordinary detour reaches. A
 * fallback start costs twice as much: better to end away from the pin than to start away from the car. The cost
 * is the search's only: the route's duration leaves it out.
 */
const FALLBACK_S = 3600;
const FALLBACK_MPS = 1;
const FALLBACK_START_FACTOR = 2;
/**
 * Before searching, each end's roads are followed (any direction, any turn) up to this many edges: when that runs
 * out first, the end is on an island, and if the other end's roads aren't on it there is no route. Saves searching
 * the whole region (1 s in Node for an oblast) to find out.
 */
const ISLAND_EDGES = 3000;
/** Keeps the straight-line heuristic under the true time despite rounding in the lengths. */
const HEURISTIC_SAFETY = 0.995;
/**
 * Hierarchy pruning: this far from both ends, only roads up to `PRUNE_CLASS` are searched (a trip across the
 * country drives motorways, trunk and primary roads between the towns, never the side streets of villages in
 * between). Near either end every road stays: that is where the route leaves or enters the hierarchy. A node whose
 * only legal exits are minor roads keeps them, so the pruning never makes a dead end.
 */
const PRUNE_RADIUS_M = 20_000;
const PRUNE_CLASS = RoadClass.tertiary;
export const DEFAULT_MAX_STATES = 2_000_000;

const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const wrap = (a: number) => a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
const now = () => globalThis.performance?.now() ?? Date.now();

/** Search states (directed edges settled or queued) in growable typed arrays, found by key through one map. */
class StateTable {
  private readonly index = new Map<number, number>();
  keys = new Float64Array(4096);
  /** Time to the end of the directed edge. */
  g = new Float64Array(4096);
  /** Heuristic at its end (it depends on the edge only: computed once). */
  h = new Float64Array(4096);
  /** Index of the previous state; −1 for a start. */
  parent = new Int32Array(4096);
  closed = new Uint8Array(4096);
  size = 0;

  find(key: number): number {
    return this.index.get(key) ?? -1;
  }

  add(key: number, g: number, h: number, parent: number): number {
    if (this.size === this.keys.length) this.grow();
    const i = this.size++;
    this.index.set(key, i);
    this.keys[i] = key;
    this.g[i] = g;
    this.h[i] = h;
    this.parent[i] = parent;
    return i;
  }

  private grow(): void {
    const n = this.keys.length * 2;
    const copy = <T extends Float64Array | Int32Array | Uint8Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.set(a);
      return b;
    };
    this.keys = copy(this.keys);
    this.g = copy(this.g);
    this.h = copy(this.h);
    this.parent = copy(this.parent);
    this.closed = copy(this.closed);
  }
}

/** Directed edge → search state key, and back. */
const keyOf = (edge: EdgeId, dir: 1 | -1) => 2 * edge + (dir === 1 ? 0 : 1);
const edgeOf = (key: number) => Math.floor(key / 2);
const dirOf = (key: number): 1 | -1 => (key % 2 === 0 ? 1 : -1);
const geometryLength = (edge: RoadEdge) => edge.cum[edge.cum.length - 1];
const allowed = (edge: RoadEdge, dir: 1 | -1) => edge.oneway !== (dir === 1 ? Oneway.backward : Oneway.forward);
const isPublic = (edge: RoadEdge) => !(edge.flags & (EdgeFlag.private | EdgeFlag.minorService));

/** A leg's length, m (OSM lengths, as the route's). */
export const legLengthM = (edge: RoadEdge, leg: RouteLeg) => stretchM(edge, leg.fromM, leg.toM);

/** Metres of the edge's OSM length between two positions along its geometry. */
function stretchM(edge: RoadEdge, a: number, b: number): number {
  const length = geometryLength(edge);
  return length > 0 ? (Math.abs(b - a) / length) * edge.lengthM : 0;
}

/** Straight-line distance, m (equirectangular at the mean latitude: well under 0.1 % off within a region). */
function distanceM(a: Coordinate, b: Coordinate): number {
  const x = (b.lon - a.lon) * DEG * Math.cos(((a.lat + b.lat) / 2) * DEG);
  const y = (b.lat - a.lat) * DEG;
  return EARTH_RADIUS_M * Math.sqrt(x * x + y * y);
}

/** Where the route may start or end: an edge near the point (and how far off), and the cost of using it. */
interface End {
  near: NearEdge;
  extraS: number;
}

/**
 * One route search, advanced in slices by `run` (ROUTING-SPEC §5.4). States are directed edges; `g` is the time
 * to the end of one. The destination is a separate goal entry in the queue, offered by every state whose next
 * edge is the destination's.
 */
export class RouteSearch {
  readonly costs: RouteCosts;
  private readonly maxStates: number;
  private readonly heap = new MinHeap();
  private readonly states = new StateTable();
  /** Start states (by state index): the start they come from. */
  private readonly starts = new Map<number, End>();
  /**
   * Goal entries (queued as −(index + 1)): the destination end, the parent state index (−1: straight from `start`
   * on the same edge), and where the last leg enters the destination's edge.
   */
  private readonly goals: { cost: number; dest: End; parent: number; start?: End; dir: 1 | -1; fromM: number }[] = [];
  /** Destination ends by edge. */
  private readonly dests = new Map<EdgeId, End>();
  /** The heuristic aims at the destination point less this: the main destination end's distance from it. */
  private destSlackM = 0;
  /** Metres per degree of longitude and latitude at the start, and the same at the destination (pruning). */
  private readonly startKm = { x: 0, y: 0 };
  private readonly destKm = { x: 0, y: 0 };
  private readonly vmax: number;
  private started = false;
  private finished: RouteStatus | null = null;
  private readonly stats: RouteStats = { states: 0, tilesRead: 0, ms: 0 };
  private readonly tilesAtStart: number;

  constructor(
    private readonly graph: RoadGraph & { stats?: GraphStats },
    private readonly frame: LocalFrame,
    readonly from: RouteStart,
    readonly to: Coordinate,
    options: RouteOptions = {},
  ) {
    this.costs = { ...DEFAULT_ROUTE_COSTS, ...options.costs };
    this.maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
    this.vmax = maxSpeedMps(this.costs);
    this.tilesAtStart = graph.stats?.tileLoads ?? 0;
  }

  /** Settle up to `maxStates` more states. */
  run(maxStates = Infinity): RouteStatus {
    if (this.finished) return this.finished;
    const t0 = now();
    try {
      if (!this.started) {
        this.started = true;
        const failure = this.begin();
        if (failure) return this.finish({ status: "failed", reason: failure, stats: this.stats });
      }
      for (let n = 0; n < maxStates; n++) {
        const value = this.heap.pop();
        if (value === undefined) return this.finish({ status: "failed", reason: "no-route", stats: this.stats });
        if (value < 0) return this.finish({ status: "done", plan: this.plan(-value - 1), stats: this.stats });
        if (this.states.closed[value]) continue;
        this.states.closed[value] = 1;
        if (++this.stats.states > this.maxStates) return this.finish({ status: "failed", reason: "too-far", stats: this.stats });
        this.expand(value);
      }
      return { status: "more", stats: this.stats };
    } finally {
      this.stats.ms += now() - t0;
      this.stats.tilesRead = (this.graph.stats?.tileLoads ?? 0) - this.tilesAtStart;
    }
  }

  private finish(status: RouteStatus): RouteStatus {
    this.finished = status;
    return status;
  }

  /** Snap both ends to the roads (§5.1) and queue the start states. */
  private begin(): RouteFailure | null {
    const [de, dn] = this.frame.toEnu(this.to);
    const nearDest = this.graph.edgesNear(de, dn, FALLBACK_RADIUS_M);
    if (!nearDest.length) return "no-road-at-destination";
    const first = nearDest[0];
    const main = isPublic(first.edge)
      ? first
      : (nearDest.find((x) => isPublic(x.edge) && x.distanceM <= first.distanceM + DEST_PUBLIC_M) ?? first);
    this.destSlackM = main.distanceM;
    this.destKm.x = DEG * EARTH_RADIUS_M * Math.cos(this.to.lat * DEG);
    this.destKm.y = DEG * EARTH_RADIUS_M;
    this.startKm.x = DEG * EARTH_RADIUS_M * Math.cos(this.from.lat * DEG);
    this.startKm.y = DEG * EARTH_RADIUS_M;
    this.dests.set(main.edge.id, { near: main, extraS: 0 });
    for (const near of nearDest.filter((x) => x !== main)) {
      this.dests.set(near.edge.id, { near, extraS: FALLBACK_S + Math.max(0, near.distanceM - main.distanceM) / FALLBACK_MPS });
    }

    const [se, sn] = this.frame.toEnu(this.from);
    const nearStart = this.graph.edgesNear(se, sn, FALLBACK_RADIUS_M);
    if (!nearStart.length) return "no-road-at-start";
    // Within the position's accuracy, the nearest road and those as near (a parallel road); off the roads, the
    // nearest road. Not the roads that only touch the nearest one at a junction close by: the car isn't on them.
    const nearest = nearStart[0];
    const radius = Math.max(START_RADIUS_M, this.from.accuracyM ?? 0, nearest.distanceM);
    const ends = [nearest.edge.from, nearest.edge.to];
    const atJunction = (x: NearEdge) =>
      (x.alongM <= JUNCTION_END_M && ends.includes(x.edge.from)) || (x.alongM >= geometryLength(x.edge) - JUNCTION_END_M && ends.includes(x.edge.to));
    const isMain = (x: NearEdge) => x === nearest || (x.distanceM <= radius && x.distanceM <= nearest.distanceM + START_MARGIN_M && !atJunction(x));
    for (const near of nearStart.filter(isMain)) this.addStart({ near, extraS: 0 });
    for (const near of nearStart.filter((x) => !isMain(x))) {
      this.addStart({ near, extraS: FALLBACK_START_FACTOR * (FALLBACK_S + near.distanceM / FALLBACK_MPS) });
    }
    if (!this.heap.size) return "no-road-at-start";
    const startEdges = nearStart.map((x) => x.edge.id);
    const destEdges = [...this.dests.keys()];
    for (const [mine, other] of [[startEdges, destEdges], [destEdges, startEdges]]) {
      const island = this.island(mine);
      if (island && !other.some((id) => island.has(id))) return "no-route";
    }
    return null;
  }

  /** The edges connected to these, any direction, any turn; null when more than `ISLAND_EDGES` (not an island). */
  private island(seeds: EdgeId[]): Set<EdgeId> | null {
    const seen = new Set(seeds);
    const queue = [...seen];
    while (queue.length) {
      const edge = this.graph.edge(queue.pop()!);
      for (const nodeId of [edge.from, edge.to]) {
        for (const { edge: next } of this.graph.node(nodeId).edges) {
          if (seen.has(next)) continue;
          if (seen.size >= ISLAND_EDGES) return null;
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  /** Leaving in direction `dir` along a road heading `roadHeadingRad` turns the car around. */
  private againstHeading(roadHeadingRad: number, dir: 1 | -1): boolean {
    const heading = this.from.headingRad;
    const travel = dir === 1 ? roadHeadingRad : roadHeadingRad + Math.PI;
    return heading !== undefined && Math.abs(wrap(travel - heading)) > Math.PI / 2;
  }

  private addStart(start: End): void {
    const c = this.costs;
    const { edge, alongM, headingRad } = start.near;
    for (const dir of [1, -1] as const) {
      if (!allowed(edge, dir)) continue;
      const turnaround = this.againstHeading(headingRad, dir) ? c.turnaroundS : 0;
      const g0 = start.extraS + turnaround;
      // Straight to a destination ahead on the same edge.
      const dest = this.dests.get(edge.id);
      if (dest && (dir === 1 ? dest.near.alongM >= alongM : dest.near.alongM <= alongM)) {
        this.offerGoal(g0 + dest.extraS + stretchM(edge, alongM, dest.near.alongM) / edgeSpeedMps(edge, c), dest, -1, dir, alongM, start);
      }
      const key = keyOf(edge.id, dir);
      const g = g0 + stretchM(edge, alongM, dir === 1 ? geometryLength(edge) : 0) / edgeSpeedMps(edge, c);
      const known = this.states.find(key);
      let i: number;
      if (known < 0) {
        i = this.states.add(key, g, this.heuristic(edge, dir), -1);
      } else {
        if (g >= this.states.g[known]) continue;
        i = known;
        this.states.g[i] = g;
        this.states.parent[i] = -1;
      }
      this.starts.set(i, start);
      this.heap.push(g + this.states.h[i], i);
    }
  }

  private expand(index: number): void {
    const c = this.costs;
    const states = this.states;
    const key = states.keys[index];
    const g = states.g[index];
    const edge = this.graph.edge(edgeOf(key));
    const dir = dirOf(key);
    const node = this.graph.node(dir === 1 ? edge.to : edge.from);
    const junction = node.edges.length >= 3;
    const exits = this.graph.exits(edge.id, dir);
    // Far from both ends only the main roads are searched, unless nothing else is legal there (see PRUNE_RADIUS_M).
    const prune = this.farFromEnds(node.lat, node.lon);
    let legal = 0;
    let kept = 0;
    for (const x of exits) {
      if (x.uTurn || x.againstOneway || x.restricted) continue;
      legal++;
      if (!prune || this.graph.edge(x.edge).cls <= PRUNE_CLASS) kept++;
    }
    const pruneNow = prune && kept > 0;
    // A dead end (or a one-way trap): turning back is the only way on.
    const uTurns = legal === 0;
    for (const x of exits) {
      if (x.againstOneway || (uTurns ? !x.uTurn : x.uTurn || x.restricted)) continue;
      const out = this.graph.edge(x.edge);
      if (pruneNow && out.cls > PRUNE_CLASS) continue;
      const pass = x.uTurn ? c.uTurnS : junction ? c.junctionS + turnSeconds(x.turnRad, c) : 0;
      const speed = edgeSpeedMps(out, c);
      const dest = this.dests.get(out.id);
      if (dest) {
        const entry = x.dir === 1 ? 0 : geometryLength(out);
        this.offerGoal(g + pass + dest.extraS + stretchM(out, entry, dest.near.alongM) / speed, dest, index, x.dir, entry);
      }
      const nextKey = keyOf(out.id, x.dir);
      const known = states.find(nextKey);
      if (known >= 0 && states.closed[known]) continue;
      const ng = g + pass + entrySeconds(out, c) + out.lengthM / speed;
      if (known < 0) {
        const next = states.add(nextKey, ng, this.heuristic(out, x.dir), index);
        this.heap.push(ng + states.h[next], next);
      } else if (ng < states.g[known]) {
        states.g[known] = ng;
        states.parent[known] = index;
        this.heap.push(ng + states.h[known], known);
      }
    }
  }

  /** The point is beyond `PRUNE_RADIUS_M` from the start and from the destination (flat-earth distance). */
  private farFromEnds(lat: number, lon: number): boolean {
    const r2 = PRUNE_RADIUS_M * PRUNE_RADIUS_M;
    let dx = (lon - this.from.lon) * this.startKm.x;
    let dy = (lat - this.from.lat) * this.startKm.y;
    if (dx * dx + dy * dy <= r2) return false;
    dx = (lon - this.to.lon) * this.destKm.x;
    dy = (lat - this.to.lat) * this.destKm.y;
    return dx * dx + dy * dy > r2;
  }

  private offerGoal(cost: number, dest: End, parent: number, dir: 1 | -1, fromM: number, start?: End): void {
    this.goals.push({ cost, dest, parent, start, dir, fromM });
    this.heap.push(cost, -this.goals.length);
  }

  /**
   * Time to the destination at the fastest speed, from the end of a directed edge. Never more than the true time:
   * the main destination end is `destSlackM` from the point, and a fallback end nearer still costs `FALLBACK_S`.
   */
  private heuristic(edge: RoadEdge, dir: 1 | -1): number {
    const end = this.graph.node(dir === 1 ? edge.to : edge.from);
    return (HEURISTIC_SAFETY * Math.max(0, distanceM(end, this.to) - this.destSlackM)) / this.vmax;
  }

  private plan(goalIndex: number): RoutePlan {
    const goal = this.goals[goalIndex];
    const legs: RouteLeg[] = [{ edge: goal.dest.near.edge.id, dir: goal.dir, fromM: goal.fromM, toM: goal.dest.near.alongM }];
    let start = goal.start;
    for (let i = goal.parent; i !== -1; i = this.states.parent[i]) {
      const key = this.states.keys[i];
      const edge = this.graph.edge(edgeOf(key));
      const dir = dirOf(key);
      const length = geometryLength(edge);
      const first = this.states.parent[i] === -1;
      if (first) start = this.starts.get(i);
      legs.unshift({ edge: edge.id, dir, fromM: first ? start!.near.alongM : dir === 1 ? 0 : length, toM: dir === 1 ? length : 0 });
    }
    const coordinates: Coordinate[] = [];
    let lengthM = 0;
    // The duration is the search's cost without its penalties: fallback ends and the entry penalties of the legs
    // between the first and the last (those two never pay one).
    let penaltyS = start!.extraS + goal.dest.extraS;
    for (const [i, leg] of legs.entries()) {
      const edge = this.graph.edge(leg.edge);
      if (i > 0 && i < legs.length - 1) penaltyS += entrySeconds(edge, this.costs);
      lengthM += stretchM(edge, leg.fromM, leg.toM);
      for (const p of legCoordinates(edge, leg)) {
        const last = coordinates.at(-1);
        if (!last || last.lat !== p.lat || last.lon !== p.lon) coordinates.push(p);
      }
    }
    return {
      legs,
      lengthM,
      durationS: goal.cost - penaltyS,
      coordinates,
      offRoadM: { start: start!.near.distanceM, end: goal.dest.near.distanceM },
      ...(this.againstHeading(start!.near.headingRad, legs[0].dir) ? { startTurnaround: true } : {}),
    };
  }
}

/** The leg's stretch of the edge's geometry, in driving order. */
export function legCoordinates(edge: RoadEdge, leg: RouteLeg): Coordinate[] {
  const { cum, lonLat } = edge;
  const at = (m: number): Coordinate => {
    let i = 0;
    while (i + 2 < cum.length && cum[i + 1] < m) i++;
    const span = cum[i + 1] - cum[i];
    const t = span > 0 ? Math.min(1, Math.max(0, (m - cum[i]) / span)) : 0;
    return { lon: lonLat[2 * i] + t * (lonLat[2 * i + 2] - lonLat[2 * i]), lat: lonLat[2 * i + 1] + t * (lonLat[2 * i + 3] - lonLat[2 * i + 1]) };
  };
  const lo = Math.min(leg.fromM, leg.toM);
  const hi = Math.max(leg.fromM, leg.toM);
  const points = [at(lo)];
  for (let i = 0; i < cum.length; i++) if (cum[i] > lo && cum[i] < hi) points.push({ lon: lonLat[2 * i], lat: lonLat[2 * i + 1] });
  points.push(at(hi));
  return leg.fromM <= leg.toM ? points : points.reverse();
}

/** Plan a route in one go (tools, tests). */
export function planRoute(
  graph: RoadGraph & { stats?: GraphStats },
  frame: LocalFrame,
  from: RouteStart,
  to: Coordinate,
  options: RouteOptions = {},
): Exclude<RouteStatus, { status: "more" }> {
  const search = new RouteSearch(graph, frame, from, to, options);
  const result = search.run();
  if (result.status === "more") throw new Error("unreachable: an unlimited run always finishes");
  return result;
}

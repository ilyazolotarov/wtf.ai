// Trips with stops on the way (STOPS-SPEC §4): one route search per leg, run one after another in the same slices,
// joined into one plan whose stops are points along it. Without stops a trip is the plain route.

import { bearingRad, haversineM, type Coordinate } from "../geo";
import type { LocalFrame } from "../geo/local-frame";
import type { GraphStats, RoadGraph } from "../mapmatch/graph/road-graph";
import { routeManeuvers, type Maneuver } from "./maneuvers";
import {
  RouteSearch,
  type PlanStop,
  type RoadSide,
  type RouteFailure,
  type RouteOptions,
  type RoutePlan,
  type RouteStart,
  type RouteStats,
} from "./router";

/** At most this many stops between the car and the destination. */
export const MAX_STOPS = 5;
/** A place this close to the road is on it: no side. */
export const SIDE_MIN_M = 15;
/**
 * A leg after a stop starts as a parked car does: its heading as the car arrived, sure enough that leaving the other
 * way costs the parked turnaround (ROUTING-SPEC §4), not so sure it costs the driving one.
 */
const STOP_HEADING_SIGMA_RAD = (10 * Math.PI) / 180;
const STOP_ACCURACY_M = 5;
/** The next leg's first point this close to the last one's end is the same point. */
const SAME_POINT_M = 1;

/** A point of a trip: a stop, or the destination (last). */
export interface TripPoint extends Coordinate {
  key: string;
}

export type TripStatus =
  | { status: "more"; stats: RouteStats }
  | { status: "done"; plan: RoutePlan; legs: RoutePlan[]; stats: RouteStats }
  | { status: "failed"; reason: RouteFailure; leg: number; stats: RouteStats };

/** How a leg after a stop starts: where the last one ended, facing the way the car arrived, standing. */
export function legStart(prev: RoutePlan): RouteStart {
  const pts = prev.coordinates;
  const end = pts[pts.length - 1];
  let i = pts.length - 2;
  while (i >= 0 && haversineM(pts[i], end) < 0.5) i--;
  return {
    lat: end.lat,
    lon: end.lon,
    accuracyM: STOP_ACCURACY_M,
    speedMps: 0,
    ...(i >= 0 ? { headingRad: bearingRad(pts[i], end), headingSigmaRad: STOP_HEADING_SIGMA_RAD } : {}),
  };
}

/**
 * A trip's search: the legs to `points` (stops, then the destination) one after another, advanced in slices by `run`
 * like a `RouteSearch` (ROUTING-SPEC §5.4). A leg that finds no route fails the trip, naming the leg.
 */
export class TripSearch {
  private leg = 0;
  private search: RouteSearch;
  private readonly plans: RoutePlan[] = [];
  private readonly stats: RouteStats = { states: 0, tilesRead: 0, ms: 0 };
  private finished: TripStatus | null = null;

  constructor(
    private readonly graph: RoadGraph & { stats?: GraphStats },
    private readonly frame: LocalFrame,
    readonly from: RouteStart,
    readonly points: TripPoint[],
    private readonly options: RouteOptions = {},
  ) {
    if (!points.length) throw new Error("a trip needs a destination");
    this.search = new RouteSearch(graph, frame, from, points[0], options);
  }

  run(maxStates = Infinity): TripStatus {
    if (this.finished) return this.finished;
    let budget = maxStates;
    for (;;) {
      const before = this.stats.states;
      const r = this.search.run(budget);
      // The search's stats are its own, cumulative: this leg's so far on top of the legs before it.
      const legStats = r.stats;
      const sum: RouteStats = {
        states: this.legsStats.states + legStats.states,
        tilesRead: this.legsStats.tilesRead + legStats.tilesRead,
        ms: this.legsStats.ms + legStats.ms,
        ...(this.legsStats.fellBackAt || legStats.fellBackAt ? { fellBackAt: this.legsStats.fellBackAt ?? legStats.fellBackAt } : {}),
      };
      Object.assign(this.stats, sum);
      if (r.status === "more") return { status: "more", stats: this.stats };
      if (r.status === "failed") return (this.finished = { status: "failed", reason: r.reason, leg: this.leg, stats: this.stats });
      this.plans.push(r.plan);
      this.legsStats = { ...sum };
      if (this.plans.length === this.points.length) {
        return (this.finished = { status: "done", plan: joinPlans(this.plans, this.points), legs: this.plans, stats: this.stats });
      }
      budget -= this.stats.states - before;
      this.leg++;
      this.search = new RouteSearch(this.graph, this.frame, legStart(r.plan), this.points[this.leg], this.options);
      if (budget <= 0) return { status: "more", stats: this.stats };
    }
  }

  /** The finished legs' stats, summed. */
  private legsStats: RouteStats = { states: 0, tilesRead: 0, ms: 0 };
}

/** Plan a trip in one go (tools, tests). */
export function planTrip(
  graph: RoadGraph & { stats?: GraphStats },
  frame: LocalFrame,
  from: RouteStart,
  points: TripPoint[],
  options: RouteOptions = {},
): Exclude<TripStatus, { status: "more" }> {
  const r = new TripSearch(graph, frame, from, points, options).run();
  if (r.status === "more") throw new Error("unreachable: an unlimited run always finishes");
  return r;
}

/** The legs as one plan, each leg's end but the last a stop (`points`: the stops, then the destination). */
export function joinPlans(legs: RoutePlan[], points: TripPoint[]): RoutePlan {
  if (legs.length === 1) return legs[0];
  const coordinates: Coordinate[] = [];
  const stops: PlanStop[] = [];
  let lengthM = 0;
  let durationS = 0;
  legs.forEach((leg, i) => {
    const pts = leg.coordinates;
    const skip = coordinates.length && pts.length && haversineM(coordinates[coordinates.length - 1], pts[0]) < SAME_POINT_M ? 1 : 0;
    for (let k = skip; k < pts.length; k++) coordinates.push(pts[k]);
    lengthM += leg.lengthM;
    durationS += leg.durationS;
    if (i < legs.length - 1) {
      const end = pts[pts.length - 1];
      const point = { lat: points[i].lat, lon: points[i].lon };
      stops.push({ key: points[i].key, atM: lengthM, atS: durationS, lat: end.lat, lon: end.lon, point, side: legEndSide(leg, point) });
    }
  });
  const first = legs[0];
  return {
    legs: legs.flatMap((l) => l.legs),
    lengthM,
    durationS,
    coordinates,
    offRoadM: { start: first.offRoadM.start, end: legs[legs.length - 1].offRoadM.end },
    ...(first.startTurnaround ? { startTurnaround: true } : {}),
    stops,
  };
}

/** The side of the road `point` is on at a leg's end, driving it. */
function legEndSide(leg: RoutePlan, point: Coordinate): RoadSide | null {
  const pts = leg.coordinates;
  const end = pts[pts.length - 1];
  let i = pts.length - 2;
  while (i >= 0 && haversineM(pts[i], end) < 0.5) i--;
  return i >= 0 ? sideOf(pts[i], end, point) : null;
}

/**
 * Which side of the road from `a` to `b` (driving towards `b`) `point` is on, measured from `b`'s end of it; within
 * `SIDE_MIN_M` of the road, or with no direction, none.
 */
export function sideOf(a: Coordinate, b: Coordinate, point: Coordinate): RoadSide | null {
  const k = Math.cos((b.lat * Math.PI) / 180);
  const dx = (b.lon - a.lon) * k;
  const dy = b.lat - a.lat;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const px = (point.lon - b.lon) * k;
  const py = point.lat - b.lat;
  // Distance from the road's line, in degrees of latitude.
  const cross = (dx * py - dy * px) / len;
  if (Math.abs(cross) * 111_195 < SIDE_MIN_M) return null;
  return cross > 0 ? "left" : "right";
}

/**
 * The trip's maneuvers: each leg's in order, a `stop` (with its side) in place of a leg's `arrive` and the next leg's
 * `depart`; the last leg ends with `arrive`.
 */
export function tripManeuvers(graph: RoadGraph, legs: RoutePlan[], plan: RoutePlan): Maneuver[] {
  if (legs.length === 1) return routeManeuvers(graph, legs[0]);
  const out: Maneuver[] = [];
  let offsetM = 0;
  legs.forEach((leg, i) => {
    const own = routeManeuvers(graph, leg);
    for (const m of own) {
      if (i > 0 && m.kind === "depart") continue;
      const at = { ...m, atM: m.atM + offsetM };
      if (m.kind === "arrive" && i < legs.length - 1) {
        const stop = plan.stops![i];
        out.push({ ...at, kind: "stop", atM: stop.atM, stop: stop.key, ...(stop.side ? { side: stop.side } : {}) });
        continue;
      }
      out.push(at);
    }
    offsetM += leg.lengthM;
  });
  return out;
}

/** The plan's time to `alongM`, s: each leg at its own pace, so a stop's arrival is its leg's. */
export function elapsedS(plan: RoutePlan, alongM: number): number {
  if (plan.lengthM <= 0) return 0;
  let fromM = 0;
  let fromS = 0;
  for (const s of plan.stops ?? []) {
    if (alongM <= s.atM) return fromS + (s.atM > fromM ? ((alongM - fromM) / (s.atM - fromM)) * (s.atS - fromS) : 0);
    fromM = s.atM;
    fromS = s.atS;
  }
  const leftM = plan.lengthM - fromM;
  return Math.min(plan.durationS, fromS + (leftM > 0 ? ((Math.max(fromM, alongM) - fromM) / leftM) * (plan.durationS - fromS) : 0));
}

/**
 * Where a new stop goes among `stops` (between `from`, the car, and `to`, the destination): between the two
 * consecutive points where it adds the least straight-line distance (STOPS-SPEC §4). The index to insert it at.
 */
export function insertionIndex(from: Coordinate, stops: Coordinate[], to: Coordinate, p: Coordinate): number {
  const points = [from, ...stops, to];
  let best = 0;
  let bestM = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const addM = haversineM(points[i], p) + haversineM(p, points[i + 1]) - haversineM(points[i], points[i + 1]);
    if (addM < bestM) {
      bestM = addM;
      best = i;
    }
  }
  return best;
}

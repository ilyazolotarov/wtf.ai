// Routing cost model (ROUTING-SPEC §4): seconds to drive an edge, pass a junction, take a turn.
// Starting values; tune from drives.

import { EdgeFlag, RoadClass } from "../mapmatch/graph/format";
import type { RoadEdge } from "../mapmatch/graph/road-graph";

const DEG = Math.PI / 180;

export interface RouteCosts {
  /** km/h by road class, in `RoadClass` order. */
  speedKph: readonly number[];
  /** Links (`_link` roads) drive at this share of their class speed. */
  linkFactor: number;
  roundaboutMaxKph: number;
  /** Passing a node where 3 or more edges meet. */
  junctionS: number;
  /** Turns under this are straight on (no cost); over `sharpRad` they are sharp. */
  straightRad: number;
  sharpRad: number;
  /** Right turns are clockwise (positive `Exit.turnRad`); left turns cross oncoming traffic. */
  rightS: number;
  leftS: number;
  sharpRightS: number;
  sharpLeftS: number;
  /** Back along the arrival edge, only where nothing else is legal (a dead end). */
  uTurnS: number;
  /** Starting in the direction more than 90° off the car's heading. */
  turnaroundS: number;
  /**
   * The same while the car drives (a re-plan after a wrong turn): turning around mid-street needs a gap and is often
   * not allowed, so going round the block wins unless it is much longer.
   */
  turnaroundMovingS: number;
  /** Entering an edge (not the start or destination edge). */
  privateS: number;
  minorServiceS: number;
  trackS: number;
}

export const DEFAULT_ROUTE_COSTS: RouteCosts = {
  // Minor roads near OSRM's car profile: residential 25, service 12. At 30 / 20 km/h with 5–10 s turns, routes cut
  // through residential blocks on their service lanes instead of the main street (2026-10-05, ROUTING-SPEC §4).
  //         motorway trunk primary secondary tertiary unclassified residential living service track road
  speedKph: [110, 90, 60, 50, 45, 35, 25, 8, 12, 10, 20],
  linkFactor: 0.6,
  roundaboutMaxKph: 30,
  junctionS: 2,
  straightRad: 30 * DEG,
  sharpRad: 120 * DEG,
  rightS: 8,
  leftS: 15,
  sharpRightS: 15,
  sharpLeftS: 20,
  uTurnS: 30,
  turnaroundS: 60,
  turnaroundMovingS: 300,
  privateS: 600,
  minorServiceS: 60,
  trackS: 120,
};

/** Driving speed on an edge, m/s. */
export function edgeSpeedMps(edge: RoadEdge, c: RouteCosts): number {
  let kph = c.speedKph[edge.cls] ?? c.speedKph[RoadClass.road];
  if (edge.flags & EdgeFlag.link) kph *= c.linkFactor;
  if (edge.flags & EdgeFlag.roundabout) kph = Math.min(kph, c.roundaboutMaxKph);
  return kph / 3.6;
}

/** The fastest speed in the model, m/s: the A* heuristic's. */
export function maxSpeedMps(c: RouteCosts): number {
  return Math.max(...c.speedKph) / 3.6;
}

/** A turn by `turnRad` (clockwise positive) at a junction. */
export function turnSeconds(turnRad: number, c: RouteCosts): number {
  const a = Math.abs(turnRad);
  if (a < c.straightRad) return 0;
  if (a < c.sharpRad) return turnRad > 0 ? c.rightS : c.leftS;
  return turnRad > 0 ? c.sharpRightS : c.sharpLeftS;
}

/** Penalty for entering an edge: private access, driveways and parking aisles, tracks. */
export function entrySeconds(edge: RoadEdge, c: RouteCosts): number {
  let s = 0;
  if (edge.flags & EdgeFlag.private) s += c.privateS;
  if (edge.flags & EdgeFlag.minorService) s += c.minorServiceS;
  if (edge.cls === RoadClass.track) s += c.trackS;
  return s;
}

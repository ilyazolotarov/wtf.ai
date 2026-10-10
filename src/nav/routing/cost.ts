// Routing cost model (ROUTING-SPEC §4): seconds to drive an edge, pass a junction, take a turn.
// Speeds come from the map's attributes where the graph has them (§4.1), else from the road class alone.

import { EdgeFlag, NodeFlag, RoadClass } from "../mapmatch/graph/format";
import type { Exit, RoadEdge, RoadNode } from "../mapmatch/graph/road-graph";

const DEG = Math.PI / 180;

export interface RouteCosts {
  /** km/h by road class, in `RoadClass` order: graphs without speed attributes. */
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

  // Graphs with speed attributes (`EdgeFlag.attributes`, §4.1).
  /** The limit where none is tagged (Ukrainian traffic rules §12.4–12.6): in a settlement, outside, motorways. */
  urbanLimitKph: number;
  ruralLimitKph: number;
  motorwayLimitKph: number;
  /**
   * Share of the limit driven between junctions, free-flowing: outside settlements; in a town or village, on its
   * through roads (trunk, primary, secondary) and its other streets; in a city (traffic lights priced apart).
   */
  ruralLimitShare: number;
  townMainLimitShare: number;
  townLimitShare: number;
  cityLimitShare: number;
  /** km/h by road class, in `RoadClass` order: no faster than this whatever the limit. */
  capKph: readonly number[];
  unpavedMaxKph: number;
  /** A junction with traffic lights: the mean wait for green and the start (§4.2). */
  signalS: number;
  /** A traffic light away from junctions (a signalled crossing, mostly green for cars). */
  crossingSignalS: number;
  /** Time on big cities' main roads (trunk to tertiary, `EdgeFlag.bigCity`) × this: rush hours (§4.3); 1 = free. */
  congestion: number;
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
  urbanLimitKph: 50,
  ruralLimitKph: 90,
  motorwayLimitKph: 130,
  // Logged drives (Chernihiv oblast, 2026-10-03…06, ROUTING-SPEC §4.4): 102 km/h on rural 90 roads, 75 on 50 through
  // villages, 39 on untagged town tertiaries, 24–29 on city primaries. Rounded down: one driver's car.
  ruralLimitShare: 1.1,
  townMainLimitShare: 1.3,
  townLimitShare: 1.0,
  cityLimitShare: 0.9,
  //       motorway trunk primary secondary tertiary unclassified residential living service track road
  capKph: [120, 110, 100, 90, 80, 60, 30, 10, 15, 15, 30],
  unpavedMaxKph: 30,
  signalS: 15,
  crossingSignalS: 5,
  congestion: 1,
};

const MAIN_CLASSES = new Set<number>([RoadClass.trunk, RoadClass.primary, RoadClass.secondary, RoadClass.tertiary]);
const THROUGH_CLASSES = new Set<number>([RoadClass.motorway, RoadClass.trunk, RoadClass.primary, RoadClass.secondary]);

function limitShare(edge: RoadEdge, c: RouteCosts): number {
  if (edge.flags & EdgeFlag.city) return c.cityLimitShare;
  if (!(edge.flags & EdgeFlag.urban)) return c.ruralLimitShare;
  return THROUGH_CLASSES.has(edge.cls) ? c.townMainLimitShare : c.townLimitShare;
}

/** Free-flowing driving speed on an edge, m/s. */
export function edgeSpeedMps(edge: RoadEdge, c: RouteCosts): number {
  let kph: number;
  if (edge.flags & EdgeFlag.attributes) {
    const urban = (edge.flags & EdgeFlag.urban) !== 0;
    const limit =
      edge.maxspeedKph || (edge.cls === RoadClass.motorway ? c.motorwayLimitKph : urban ? c.urbanLimitKph : c.ruralLimitKph);
    kph = Math.min(limit * limitShare(edge, c), c.capKph[edge.cls] ?? c.capKph[RoadClass.road]);
    if (edge.flags & EdgeFlag.unpaved) kph = Math.min(kph, c.unpavedMaxKph);
  } else {
    kph = c.speedKph[edge.cls] ?? c.speedKph[RoadClass.road];
  }
  if (edge.flags & EdgeFlag.link) kph *= c.linkFactor;
  if (edge.flags & EdgeFlag.roundabout) kph = Math.min(kph, c.roundaboutMaxKph);
  return kph / 3.6;
}

/**
 * Seconds to drive `m` metres of the edge: at its speed, a signalled crossing on it by the share driven (where along
 * it is unknown), and big cities' main roads slowed by the congestion.
 */
export function edgeSeconds(edge: RoadEdge, m: number, c: RouteCosts): number {
  let s = m / edgeSpeedMps(edge, c);
  if ((edge.flags & (EdgeFlag.attributes | EdgeFlag.signals)) === (EdgeFlag.attributes | EdgeFlag.signals) && edge.lengthM > 0) {
    s += (c.crossingSignalS * Math.min(m, edge.lengthM)) / edge.lengthM;
  }
  if (c.congestion !== 1 && edge.flags & EdgeFlag.bigCity && MAIN_CLASSES.has(edge.cls)) s *= c.congestion;
  return s;
}

/** The fastest speed in the model, m/s: the A* heuristic's. */
export function maxSpeedMps(c: RouteCosts): number {
  return Math.max(...c.speedKph, ...c.capKph) / 3.6;
}

/** A turn by `turnRad` (clockwise positive) at a junction. */
export function turnSeconds(turnRad: number, c: RouteCosts): number {
  const a = Math.abs(turnRad);
  if (a < c.straightRad) return 0;
  if (a < c.sharpRad) return turnRad > 0 ? c.rightS : c.leftS;
  return turnRad > 0 ? c.sharpRightS : c.sharpLeftS;
}

/**
 * Passing the node at the end of the arrival edge, leaving by `exit`: junction, turn or U-turn, and its traffic
 * lights. `priority`: straight on along a road bigger than every other road there (a main road past side streets),
 * where nobody slows down: no junction time. Stop and give-way signs (`NodeFlag.stop`) cost nothing yet: they hold
 * only the minor road, and which approach that is isn't known here.
 */
export function passSeconds(node: RoadNode, exit: Exit, c: RouteCosts, priority = false): number {
  if (exit.uTurn) return c.uTurnS;
  const junction = node.edges.length >= 3;
  const lights = node.flags & NodeFlag.signals ? (junction ? c.signalS : c.crossingSignalS) : 0;
  if (!junction) return lights;
  const turn = turnSeconds(exit.turnRad, c);
  return (priority && turn === 0 ? 0 : c.junctionS + turn) + lights;
}

/**
 * Whether leaving by `exits[i]` keeps to the priority road: arriving and leaving on roads of a bigger class than every
 * other way at the junction (`cls[j]` is `exits[j]`'s class; `RoadClass`: smaller numbers are bigger roads).
 */
export function onPriorityRoad(arrivalCls: number, i: number, exits: readonly Exit[], cls: ArrayLike<number>): boolean {
  const driven = Math.max(arrivalCls, cls[i]);
  for (let j = 0; j < exits.length; j++) {
    if (j !== i && !exits[j].uTurn && cls[j] <= driven) return false;
  }
  return true;
}

/** Penalty for entering an edge: private access, driveways and parking aisles, tracks. */
export function entrySeconds(edge: RoadEdge, c: RouteCosts): number {
  let s = 0;
  if (edge.flags & EdgeFlag.private) s += c.privateS;
  if (edge.flags & EdgeFlag.minorService) s += c.minorServiceS;
  if (edge.cls === RoadClass.track) s += c.trackS;
  return s;
}

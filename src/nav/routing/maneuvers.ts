// Turn instructions from a planned route (ROUTING-SPEC §6): one per junction where the driver has to choose,
// from the turn angle and the other legal ways on; roundabouts as "take the n-th exit". No street names (v1).

import { EdgeFlag, RoadClass } from "../mapmatch/graph/format";
import type { Exit, RoadEdge, RoadGraph } from "../mapmatch/graph/road-graph";
import { legLengthM, type RoutePlan } from "./router";

const DEG = Math.PI / 180;
/** The straightest way on, turning less than this, needs no instruction (unless it's a fork). */
const CONTINUE_RAD = 45 * DEG;
/** Another legal way within this of the chosen one, both nearly straight: a fork ("keep left / right"). */
const FORK_RAD = 35 * DEG;
/** Turns up to this are slight; over `SHARP_RAD` sharp. */
const SLIGHT_RAD = 45 * DEG;
const SHARP_RAD = 135 * DEG;

export type ManeuverKind =
  | "depart"
  | "slight-left"
  | "slight-right"
  | "left"
  | "right"
  | "sharp-left"
  | "sharp-right"
  | "keep-left"
  | "keep-right"
  | "u-turn"
  | "roundabout"
  | "arrive";

export const MANEUVER_KINDS: readonly ManeuverKind[] = [
  "depart", "slight-left", "slight-right", "left", "right", "sharp-left", "sharp-right",
  "keep-left", "keep-right", "u-turn", "roundabout", "arrive",
];

export interface Maneuver {
  kind: ManeuverKind;
  /** Distance from the route's start, m. */
  atM: number;
  lat: number;
  lon: number;
  /** Heading change, clockwise (right) positive; 0 for depart and arrive. */
  turnRad: number;
  /** Roundabouts: the exit to take, counting the legal exits passed, 1-based. */
  exit?: number;
}

const isRoundabout = (flags: number) => (flags & EdgeFlag.roundabout) !== 0;
const legal = (x: Exit) => !x.uTurn && !x.againstOneway && !x.restricted;
const isLink = (e: RoadEdge) => (e.flags & EdgeFlag.link) !== 0;
/** Driveways, parking aisles, private roads, tracks and service roads. */
const isMinor = (e: RoadEdge) => e.cls >= RoadClass.service || (e.flags & (EdgeFlag.private | EdgeFlag.minorService)) !== 0;

/**
 * Whether another way at a junction is a real choice for a driver on `chosen`: from a main road, a driveway or a
 * service road isn't, and neither is a slip road off it (staying on the road needs no instruction).
 */
function isChoice(chosen: RoadEdge, other: RoadEdge): boolean {
  if (isMinor(other) && !isMinor(chosen)) return false;
  return !(isLink(other) && !isLink(chosen));
}

function turnKind(turnRad: number): ManeuverKind {
  const a = Math.abs(turnRad);
  const side = turnRad > 0 ? "right" : "left";
  if (a < SLIGHT_RAD) return `slight-${side}`;
  if (a <= SHARP_RAD) return side;
  return `sharp-${side}`;
}

/** The route's maneuvers in driving order, from `depart` to `arrive`. */
export function routeManeuvers(graph: RoadGraph, plan: RoutePlan): Maneuver[] {
  const { legs, coordinates } = plan;
  const first = coordinates[0];
  const last = coordinates.at(-1)!;
  const out: Maneuver[] = [{ kind: "depart", atM: 0, lat: first.lat, lon: first.lon, turnRad: 0 }];
  // The car faces away from the route's start: turning around comes first.
  if (plan.startTurnaround) out.push({ kind: "u-turn", atM: 0, lat: first.lat, lon: first.lon, turnRad: Math.PI });
  let atM = 0;
  /** Inside a roundabout: where the route entered it, the heading change so far and the legal exits passed. */
  let roundabout: { atM: number; lat: number; lon: number; turnRad: number; exits: number } | null = null;
  for (let i = 0; i + 1 < legs.length; i++) {
    const leg = legs[i];
    const next = legs[i + 1];
    const edge = graph.edge(leg.edge);
    atM += legLengthM(edge, leg);
    const exits = graph.exits(leg.edge, leg.dir);
    const chosen = exits.find((x) => x.edge === next.edge && x.dir === next.dir);
    if (!chosen) continue; // a leg boundary that isn't a node: the route never makes one
    const node = graph.node(leg.dir === 1 ? edge.to : edge.from);
    const here = { atM, lat: node.lat, lon: node.lon };
    const inRoundabout = isRoundabout(edge.flags);
    const outRoundabout = isRoundabout(graph.edge(next.edge).flags);
    if (inRoundabout || outRoundabout) {
      roundabout ??= { ...here, turnRad: 0, exits: 0 };
      roundabout.turnRad += chosen.turnRad;
      if (!inRoundabout) continue; // entering
      // Legal ways off the roundabout at this node.
      const off = exits.filter((x) => legal(x) && !isRoundabout(graph.edge(x.edge).flags)).length;
      if (outRoundabout) {
        roundabout.exits += off;
        continue;
      }
      out.push({ kind: "roundabout", atM: roundabout.atM, lat: roundabout.lat, lon: roundabout.lon, turnRad: roundabout.turnRad, exit: roundabout.exits + 1 });
      roundabout = null;
      continue;
    }
    if (chosen.uTurn) {
      out.push({ kind: "u-turn", ...here, turnRad: chosen.turnRad });
      continue;
    }
    const chosenEdge = graph.edge(chosen.edge);
    const others = exits.filter((x) => x !== chosen && legal(x) && isChoice(chosenEdge, graph.edge(x.edge)));
    if (!others.length) continue; // nothing else to take: the road just goes on
    const straightest = [chosen, ...others].reduce((a, b) => (Math.abs(b.turnRad) < Math.abs(a.turnRad) ? b : a));
    if (chosen === straightest && Math.abs(chosen.turnRad) < CONTINUE_RAD) {
      // A branch much less important than the road it leaves (a side street off a primary road) isn't a fork.
      const fork = others.find((x) => Math.abs(x.turnRad - chosen.turnRad) < FORK_RAD && graph.edge(x.edge).cls <= chosenEdge.cls + 1);
      if (fork) out.push({ kind: chosen.turnRad < fork.turnRad ? "keep-left" : "keep-right", ...here, turnRad: chosen.turnRad });
      continue;
    }
    out.push({ kind: turnKind(chosen.turnRad), ...here, turnRad: chosen.turnRad });
  }
  out.push({ kind: "arrive", atM: plan.lengthM, lat: last.lat, lon: last.lon, turnRad: 0 });
  return out;
}

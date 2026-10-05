// Road crossings away from junctions (MAPMATCH-SPEC open item 13): a car crosses a road only at a junction, so a
// path that goes straight over one elsewhere, from clear of it on one side to clear of it on the other, is not a
// car's. No real path in the clean drives does it (tools/replay/crossings.ts). A measure for the replay tools: as a
// penalty on off-road particles it cost 10–20× the update time and didn't pay (open item 13).

import { EdgeFlag } from "./graph/format";
import { closestPoint, type RoadEdge, type RoadGraph } from "./graph/road-graph";

export interface CrossingRules {
  /** Both ends of the path this far from the road: running along it (lane offset, noise) is no crossing. */
  clearM: number;
  /** A crossing this close to an edge's end is at a junction (or a way's end). */
  junctionM: number;
  /** A crossing this close to a bridge or tunnel is a road passing over or under (the flag may be on either road). */
  bridgeM: number;
}

export const CROSSING_RULES: CrossingRules = { clearM: 4, junctionM: 25, bridgeM: 15 };

/** Where segment p→q properly crosses a→b: the fraction along a→b, else null. */
export function segmentCrossing(px: number, py: number, qx: number, qy: number, ax: number, ay: number, bx: number, by: number): number | null {
  const rx = qx - px, ry = qy - py, sx = bx - ax, sy = by - ay;
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const t = ((ax - px) * sy - (ay - py) * sx) / den;
  const u = ((ax - px) * ry - (ay - py) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? u : null;
}

/**
 * A road (not a bridge, tunnel, driveway or parking aisle) that the step p→q crosses away from junctions, `clearM`
 * from it at both ends; null when none. `skipClear` leaves the clear test to the caller (a path over several steps).
 */
export function crossedRoad(graph: RoadGraph, pe: number, pn: number, qe: number, qn: number, rules = CROSSING_RULES, skipClear = false): { edge: RoadEdge; junctionM: number } | null {
  const len = Math.hypot(qe - pe, qn - pn);
  if (len === 0) return null;
  for (const near of graph.edgesNear((pe + qe) / 2, (pn + qn) / 2, len / 2 + 1)) {
    const edge = near.edge;
    if (edge.flags & (EdgeFlag.bridge | EdgeFlag.tunnel | EdgeFlag.minorService)) continue;
    const { xy, cum } = edge;
    for (let i = 0; i + 1 < cum.length; i++) {
      const u = segmentCrossing(pe, pn, qe, qn, xy[2 * i], xy[2 * i + 1], xy[2 * i + 2], xy[2 * i + 3]);
      if (u === null) continue;
      const along = cum[i] + u * (cum[i + 1] - cum[i]);
      const junctionM = Math.min(along, edge.lengthM - along);
      if (junctionM < rules.junctionM) continue;
      if (!skipClear && (closestPoint(edge, pe, pn).distanceM < rules.clearM || closestPoint(edge, qe, qn).distanceM < rules.clearM)) continue;
      const x = xy[2 * i] + u * (xy[2 * i + 2] - xy[2 * i]);
      const y = xy[2 * i + 1] + u * (xy[2 * i + 3] - xy[2 * i + 1]);
      if (graph.edgesNear(x, y, rules.bridgeM).some((b) => b.edge.flags & (EdgeFlag.bridge | EdgeFlag.tunnel))) continue;
      return { edge, junctionM };
    }
  }
  return null;
}

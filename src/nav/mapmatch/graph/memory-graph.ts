// A small road graph held in memory, built from polylines: the Guide's drawn maps plan real routes on it with the
// same router and maneuvers as the region graph (ROUTING-SPEC §5). Not for a region: everything is one tile and
// `edgesNear` scans every edge.

import type { Coordinate } from "../../geo";
import type { LocalFrame } from "../../geo/local-frame";
import { Oneway } from "./format";
import {
  closestPoint, endHeading, startHeading, type EdgeId, type Exit, type NearEdge, type NodeId, type RoadEdge,
  type RoadGraph, type RoadNode,
} from "./road-graph";

export interface MemoryWay {
  /** `RoadClass`. */
  cls: number;
  /** Its vertices; ways share a junction where they share a vertex (same coordinate). */
  points: Coordinate[];
  oneway?: number;
  flags?: number;
  maxspeedKph?: number;
}

const TWO_PI = 2 * Math.PI;
const wrap = (a: number) => {
  const w = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  return w === -Math.PI ? Math.PI : w;
};
const key = (c: Coordinate) => `${c.lat.toFixed(7)},${c.lon.toFixed(7)}`;

export class MemoryRoadGraph implements RoadGraph {
  private readonly edges: RoadEdge[] = [];
  private readonly nodes: (RoadNode & { edges: { edge: EdgeId; end: 0 | 1 }[] })[] = [];

  /** Each way is split into edges at its ends and at every vertex another way shares. */
  constructor(frame: LocalFrame, ways: MemoryWay[]) {
    const uses = new Map<string, number>();
    for (const way of ways) for (const p of new Set(way.points.map(key))) uses.set(p, (uses.get(p) ?? 0) + 1);
    const nodeAt = new Map<string, NodeId>();
    const node = (c: Coordinate): NodeId => {
      const k = key(c);
      const known = nodeAt.get(k);
      if (known !== undefined) return known;
      const [e, n] = frame.toEnu(c);
      const id = this.nodes.length;
      this.nodes.push({ id, lat: c.lat, lon: c.lon, e, n, flags: 0, edges: [] });
      nodeAt.set(k, id);
      return id;
    };
    ways.forEach((way, wayId) => {
      let start = 0;
      for (let i = 1; i < way.points.length; i++) {
        const last = i === way.points.length - 1;
        if (!last && (uses.get(key(way.points[i])) ?? 0) < 2) continue;
        this.addEdge(frame, wayId, way, way.points.slice(start, i + 1), node(way.points[start]), node(way.points[i]));
        start = i;
      }
    });
  }

  private addEdge(frame: LocalFrame, wayId: number, way: MemoryWay, points: Coordinate[], from: NodeId, to: NodeId) {
    const id = this.edges.length;
    const lonLat = new Float64Array(points.flatMap((p) => [p.lon, p.lat]));
    const xy = new Float64Array(2 * points.length);
    frame.toEnuArray(lonLat, xy);
    const cum = new Float64Array(points.length);
    for (let j = 1; j < points.length; j++) {
      cum[j] = cum[j - 1] + Math.hypot(xy[2 * j] - xy[2 * j - 2], xy[2 * j + 1] - xy[2 * j - 1]);
    }
    this.edges.push({
      id,
      wayId,
      from,
      to,
      lengthM: cum[points.length - 1],
      cls: way.cls,
      oneway: way.oneway ?? Oneway.none,
      flags: way.flags ?? 0,
      maxspeedKph: way.maxspeedKph ?? 0,
      lonLat,
      xy,
      cum,
    });
    this.nodes[from].edges.push({ edge: id, end: 0 });
    this.nodes[to].edges.push({ edge: id, end: 1 });
  }

  edgesNear(e: number, n: number, radiusM: number): NearEdge[] {
    return this.edges
      .map((edge) => closestPoint(edge, e, n))
      .filter((near) => near.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  edge(id: EdgeId): RoadEdge {
    const edge = this.edges[id];
    if (!edge) throw new RangeError(`no edge ${id}`);
    return edge;
  }

  node(id: NodeId): RoadNode {
    const node = this.nodes[id];
    if (!node) throw new RangeError(`no node ${id}`);
    return node;
  }

  /** As the region graph's, without turn restrictions. */
  exits(via: EdgeId, dir: 1 | -1): Exit[] {
    const arrival = this.edge(via);
    const headingIn = dir === 1 ? endHeading(arrival) : wrap(startHeading(arrival) + Math.PI);
    return this.node(dir === 1 ? arrival.to : arrival.from).edges.map(({ edge: id, end }) => {
      const out = this.edge(id);
      const exitDir: 1 | -1 = end === 0 ? 1 : -1;
      const headingOut = exitDir === 1 ? startHeading(out) : wrap(endHeading(out) + Math.PI);
      return {
        edge: id,
        dir: exitDir,
        turnRad: wrap(headingOut - headingIn),
        againstOneway: out.oneway === (exitDir === 1 ? Oneway.backward : Oneway.forward),
        restricted: false,
        uTurn: id === via,
      };
    });
  }

  tilesAround(): number[] {
    return [0];
  }

  pin(): void {}
}

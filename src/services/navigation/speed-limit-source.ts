// The speed limit for each published position (UI-SPEC §6.4), on the road reader shared with the road ahead.

import type { EdgeId, RoadEdge } from "@/nav/mapmatch/graph/road-graph";
import type { PositionEstimate } from "@/nav/position/types";
import { limitRoad, routeNext, type RouteNext } from "@/nav/speed/road-ahead";
import { agreedLimit, LimitHold, snapCandidates, snapRadiusM, type LimitCandidate, type SpeedLimit } from "@/nav/speed/speed-limit";
import { snapsToRoads, type LimitGraph, type RoadReader, type RoadWeights } from "@/services/navigation/road-reader";

export type { LimitGraph, RoadWeights };

export interface SpeedLimitSourceDeps {
  reader: RoadReader;
  note(text: string): void;
}

export class SpeedLimitSource {
  private readonly hold = new LimitHold();
  private noted: string | null = null;
  /** The active route's legs as the road ahead follows them, on the graph file `key`. */
  private route: { key: string; next: RouteNext } | null = null;

  constructor(private readonly deps: SpeedLimitSourceDeps) {}

  /** The active route (null: none), planned on the graph file `key`: a lower limit ahead is looked for along it. */
  setRoute(route: { key: string; legs: readonly { edge: EdgeId; dir: 1 | -1 }[] } | null): void {
    this.route = route ? { key: route.key, next: routeNext(route.legs) } : null;
  }

  /**
   * The limit to show at `p`. With map matching's `roads`, from the roads it believes in; else, for a position from a
   * trusted GNSS fix, the driver's placing or phone-only mode, from the roads around it. A dead-reckoned dot without
   * map matching gets none: it may be anywhere in its circle. Moving, each road's limit where the car will be on it once
   * a change has shown, or a lower one ahead in time to slow down (`limitRoad`).
   */
  at(p: PositionEstimate, nowMs: number, roads?: RoadWeights): SpeedLimit | null {
    const shown = this.hold.update(this.limitAt(p, roads), nowMs);
    const text = shown ? `${shown.kph} ${shown.tagged ? "(OSM)" : "(default)"}` : "none";
    if (text !== this.noted) {
      this.noted = text;
      this.deps.note(`speed limit ${text}`);
    }
    return shown;
  }

  /** A new sign (or none) waits out its moment: the position should be published again once it has. */
  waiting(): boolean {
    return this.hold.waiting();
  }

  reset(): void {
    this.hold.reset();
  }

  private limitAt(p: PositionEstimate, roads?: RoadWeights): SpeedLimit | null {
    const reader = this.deps.reader.near(p);
    if (!reader) return null;
    const speedMps = p.speedMps ?? 0;
    const route = this.route?.key === reader.key ? this.route.next : undefined;
    const ahead = (c: LimitCandidate): LimitCandidate => {
      if (!c.edge || !c.dir || c.alongM === undefined || !(speedMps > 0)) return c;
      try {
        return { ...c, edge: limitRoad(reader.graph, { edge: c.edge.id, dir: c.dir, alongM: c.alongM }, speedMps, route) };
      } catch {
        return c;
      }
    };
    if (roads && roads.key === reader.key) {
      return agreedLimit(roads.weights.map((r) => ahead({ ...r, edge: r.edge === null ? null : edgeOf(reader, r.edge) })));
    }
    if (!snapsToRoads(p)) return null;
    const [e, n] = reader.frame.toEnu(p);
    const near = reader.graph.edgesNear(e, n, snapRadiusM(p.accuracyM));
    return agreedLimit(snapCandidates(near, p.accuracyM, p.headingRad, p.speedMps).map(ahead));
  }
}

/** The edge, null when the file doesn't have it (a key reused across files would be a bug, not a crash). */
export function edgeOf(reader: LimitGraph, id: EdgeId): RoadEdge | null {
  try {
    return reader.graph.edge(id);
  } catch {
    return null;
  }
}

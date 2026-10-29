// The speed limit for each published position (UI-SPEC §6.4), on the road reader shared with the road ahead.

import type { EdgeId, RoadEdge } from "@/nav/mapmatch/graph/road-graph";
import type { PositionEstimate } from "@/nav/position/types";
import { edgeAhead } from "@/nav/speed/road-ahead";
import { agreedLimit, LIMIT_LEAD_S, LimitHold, snapCandidates, snapRadiusM, type LimitCandidate, type SpeedLimit } from "@/nav/speed/speed-limit";
import { snapsToRoads, type LimitGraph, type RoadReader, type RoadWeights } from "@/services/navigation/road-reader";

export type { LimitGraph, RoadWeights };

export interface SpeedLimitSourceDeps {
  reader: RoadReader;
  note(text: string): void;
}

export class SpeedLimitSource {
  private readonly hold = new LimitHold();
  private noted: string | null = null;

  constructor(private readonly deps: SpeedLimitSourceDeps) {}

  /**
   * The limit to show at `p`. With map matching's `roads`, from the roads it believes in; else, for a position from a
   * trusted GNSS fix, the driver's placing or phone-only mode, from the roads around it. A dead-reckoned dot without
   * map matching gets none: it may be anywhere in its circle. Moving, each road's limit where the car will be on it once
   * a change has held (`LIMIT_LEAD_S`).
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
    const leadM = (p.speedMps ?? 0) * LIMIT_LEAD_S;
    const ahead = (c: LimitCandidate): LimitCandidate => {
      if (!c.edge || !c.dir || c.alongM === undefined || !(leadM > 0)) return c;
      try {
        return { ...c, edge: edgeAhead(reader.graph, { edge: c.edge.id, dir: c.dir, alongM: c.alongM }, leadM) };
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

// The speed limit for each published position (UI-SPEC §6.4), on a road graph reader of its own: the navigator's moves
// into the navigator's frame, and without an adapter there is no navigator to ask.

import type { Coordinate } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import type { EdgeId, RoadEdge, RoadGraph } from "@/nav/mapmatch/graph/road-graph";
import type { PositionEstimate } from "@/nav/position/types";
import { agreedLimit, LimitHold, snapCandidates, snapRadiusM, type LimitCandidate, type SpeedLimit } from "@/nav/speed/speed-limit";

export interface LimitGraph {
  key: string;
  graph: RoadGraph & { setFrame(frame: LocalFrame): void };
  close(): void;
}

/** Map matching's weight on each road, on the graph file `key` (the navigator's). */
export interface RoadWeights {
  key: string;
  weights: { edge: EdgeId | null; weight: number }[];
}

export interface SpeedLimitSourceDeps {
  /** A new reader on the active region's graph (null: none); the source closes it. */
  open(): LimitGraph | null;
  /** The active graph's key now: a different one opens the reader again. */
  activeKey(): string | null;
  note(text: string): void;
}

/** The reader's frame follows the car: past this from its origin, a new one around the car (LocalFrame's few km). */
const REFRAME_M = 20_000;

export class SpeedLimitSource {
  private reader: (LimitGraph & { frame: LocalFrame }) | null = null;
  /** A file that wouldn't open isn't tried again until the active graph changes. */
  private failedKey: string | null = null;
  private readonly hold = new LimitHold();
  private noted: string | null = null;

  constructor(private readonly deps: SpeedLimitSourceDeps) {}

  /**
   * The limit to show at `p`. With map matching's `roads`, from the roads it believes in; else, for a position from a
   * trusted GNSS fix, the driver's placing or phone-only mode, from the roads around it. A dead-reckoned dot without
   * map matching gets none: it may be anywhere in its circle.
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

  close(): void {
    this.reader?.close();
    this.reader = null;
    this.hold.reset();
  }

  private limitAt(p: PositionEstimate, roads?: RoadWeights): SpeedLimit | null {
    const reader = this.readerNear(p);
    if (!reader) return null;
    if (roads && roads.key === reader.key) return agreedLimit(roads.weights.map((r) => ({ edge: r.edge === null ? null : this.edge(reader, r.edge), weight: r.weight })));
    const snaps = p.source === "manual" || p.phoneOnly || (p.source === "gnss" && p.trust === "TRUSTED");
    if (!snaps || p.alternatives?.length) return null;
    const [e, n] = reader.frame.toEnu(p);
    const near = reader.graph.edgesNear(e, n, snapRadiusM(p.accuracyM));
    const candidates: LimitCandidate[] = snapCandidates(near, p.accuracyM, p.headingRad, p.speedMps);
    return agreedLimit(candidates);
  }

  private edge(reader: LimitGraph, id: EdgeId): RoadEdge | null {
    try {
      return reader.graph.edge(id);
    } catch {
      return null;
    }
  }

  /** The reader on the active graph, its frame around the car. */
  private readerNear(p: Coordinate): (LimitGraph & { frame: LocalFrame }) | null {
    const key = this.deps.activeKey();
    if (this.reader && this.reader.key !== key) this.close();
    if (!this.reader && key && key !== this.failedKey) {
      const g = this.deps.open();
      if (g) {
        this.reader = { ...g, frame: new LocalFrame(p) };
        g.graph.setFrame(this.reader.frame);
        this.failedKey = null;
      } else this.failedKey = key;
    }
    const r = this.reader;
    if (r) {
      const [e, n] = r.frame.toEnu(p);
      if (Math.hypot(e, n) > REFRAME_M) {
        r.frame = new LocalFrame(p);
        r.graph.setFrame(r.frame);
      }
    }
    return r;
  }
}

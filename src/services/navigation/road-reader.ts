// A reader of the active region's road graph for what the map says where the car is: the speed limit (UI-SPEC §6.4)
// and the road ahead with its cameras (§6.5). Its own: the navigator's moves into the navigator's frame, and without
// an adapter there is no navigator to ask.

import type { Coordinate } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import type { EdgeId, RoadGraph } from "@/nav/mapmatch/graph/road-graph";
import type { PositionEstimate } from "@/nav/position/types";

export interface LimitGraph {
  key: string;
  graph: RoadGraph & { setFrame(frame: LocalFrame): void };
  close(): void;
}

/** The open reader, its frame around the car. */
export type OpenRoads = LimitGraph & { frame: LocalFrame };

/**
 * Map matching's weight on each road (and the way along it, where on it), on the graph file `key` (the navigator's):
 * `ParticleFilter.roadWeights`.
 */
export interface RoadWeights {
  key: string;
  weights: readonly { edge: EdgeId | null; weight: number; dir?: 1 | -1; alongM?: number }[];
}

export interface RoadReaderDeps {
  /** A new reader on the active region's graph (null: none); `RoadReader` closes it. */
  open(): LimitGraph | null;
  /** The active graph's key now: a different one opens the reader again. */
  activeKey(): string | null;
}

/** The reader's frame follows the car: past this from its origin, a new one around the car (LocalFrame's few km). */
const REFRAME_M = 20_000;

/**
 * A position the roads around it can be taken from, without map matching: a trusted GNSS fix, the driver's placing,
 * phone-only mode; not with another place it may as well be. A dead-reckoned dot may be anywhere in its circle.
 */
export const snapsToRoads = (p: PositionEstimate) =>
  (p.source === "manual" || !!p.phoneOnly || (p.source === "gnss" && p.trust === "TRUSTED")) && !p.alternatives?.length;

export class RoadReader {
  private reader: OpenRoads | null = null;
  /** A file that wouldn't open isn't tried again until the active graph changes. */
  private failedKey: string | null = null;

  constructor(private readonly deps: RoadReaderDeps) {}

  /** The reader on the active graph, its frame around `p`; null without one. */
  near(p: Coordinate): OpenRoads | null {
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

  close(): void {
    this.reader?.close();
    this.reader = null;
  }
}

// Alternative routes (ROUTING-SPEC §8.7): after the main route, the planner runs again with the roads already
// taken made slower (the penalty method), and keeps what comes out if it is a real choice: different enough from
// every route kept so far and not much slower than the main one. Pure TS, advanced in slices like `RouteSearch`.

import { haversineM, type Coordinate } from "../geo";
import type { LocalFrame } from "../geo/local-frame";
import type { EdgeId, GraphStats, RoadGraph } from "../mapmatch/graph/road-graph";
import { legCoordinates, legLengthM, RouteSearch, type RouteOptions, type RoutePlan, type RouteStart } from "./router";

export interface AlternativeRules {
  /** Alternatives kept at most. */
  max: number;
  /** Searches at most (the main one not counted): a rejected result still costs one. */
  maxSearches: number;
  /** Time on every road of a route kept so far × this, once per route that has it. */
  penalty: number;
  /** Kept only if it takes at most this × the main route's time … */
  maxSlower: number;
  /** … and at most this much longer, s. */
  maxExtraS: number;
  /** Kept only if at most this share of its length is on roads of a route kept so far. */
  maxShared: number;
}

/**
 * Starting values. 1.4 makes the next search leave a shared stretch once another road is within 40 % of it;
 * Google-like choices (a few minutes either way) pass 1.3× and 0.6 shared; a parallel street for a few blocks doesn't.
 */
export const DEFAULT_ALTERNATIVE_RULES: AlternativeRules = {
  max: 2,
  maxSearches: 3,
  penalty: 1.4,
  maxSlower: 1.3,
  maxExtraS: 20 * 60,
  maxShared: 0.6,
};

export interface AlternativeStats {
  searches: number;
  states: number;
  ms: number;
}

export type AlternativeStatus =
  | { status: "more"; stats: AlternativeStats }
  | { status: "done"; alternatives: RoutePlan[]; stats: AlternativeStats };

/** Metres of `plan` on edges of `edges`. */
export function sharedM(graph: RoadGraph, plan: RoutePlan, edges: ReadonlySet<EdgeId>): number {
  let m = 0;
  for (const leg of plan.legs) if (edges.has(leg.edge)) m += legLengthM(graph.edge(leg.edge), leg);
  return m;
}

export const edgeSet = (plan: RoutePlan) => new Set(plan.legs.map((l) => l.edge));

/**
 * Where to label an alternative on the map: halfway along its longest stretch off the roads of `others` (where it
 * is told apart from them); the route's middle if it has none.
 */
export function labelPoint(graph: RoadGraph, plan: RoutePlan, others: readonly ReadonlySet<EdgeId>[]): Coordinate {
  let best = { from: 0, to: plan.legs.length, m: -1 };
  let run = { from: 0, m: 0 };
  plan.legs.forEach((leg, i) => {
    if (others.some((edges) => edges.has(leg.edge))) {
      run = { from: i + 1, m: 0 };
      return;
    }
    run.m += legLengthM(graph.edge(leg.edge), leg);
    if (run.m > best.m) best = { from: run.from, to: i + 1, m: run.m };
  });
  const legs = plan.legs.slice(best.from, best.to);
  const total = legs.reduce((m, leg) => m + legLengthM(graph.edge(leg.edge), leg), 0);
  let left = total / 2;
  for (const leg of legs) {
    const edge = graph.edge(leg.edge);
    const m = legLengthM(edge, leg);
    if (left <= m || leg === legs.at(-1)) {
      // `left` of the leg's `m` metres (OSM length) along its polyline, by share.
      const pts = legCoordinates(edge, leg);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1], pts[i]));
      const target = (Math.min(left, m) / Math.max(m, 1e-9)) * cum.at(-1)!;
      let i = 1;
      while (i < pts.length - 1 && cum[i] < target) i++;
      const t = cum[i] > cum[i - 1] ? (target - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
      return { lat: pts[i - 1].lat + t * (pts[i].lat - pts[i - 1].lat), lon: pts[i - 1].lon + t * (pts[i].lon - pts[i - 1].lon) };
    }
    left -= m;
  }
  return plan.coordinates[Math.floor(plan.coordinates.length / 2)];
}

export class AlternativeSearch {
  private readonly rules: AlternativeRules;
  private readonly kept: RoutePlan[] = [];
  private readonly keptEdges: Set<EdgeId>[];
  private search: RouteSearch | null = null;
  /** States the current search had settled after its last slice. */
  private searchStates = 0;
  private readonly stats: AlternativeStats = { searches: 0, states: 0, ms: 0 };
  private finished: AlternativeStatus | null = null;

  constructor(
    private readonly graph: RoadGraph & { stats?: GraphStats },
    private readonly frame: LocalFrame,
    private readonly from: RouteStart,
    private readonly to: Coordinate,
    private readonly main: RoutePlan,
    private readonly options: RouteOptions = {},
    rules: Partial<AlternativeRules> = {},
  ) {
    this.rules = { ...DEFAULT_ALTERNATIVE_RULES, ...rules };
    this.keptEdges = [edgeSet(main)];
  }

  /** Settle up to `maxStates` more states, over as many searches as that reaches. */
  run(maxStates = Infinity): AlternativeStatus {
    if (this.finished) return this.finished;
    let budget = maxStates;
    while (budget > 0) {
      if (!this.search) {
        if (this.kept.length >= this.rules.max || this.stats.searches >= this.rules.maxSearches) return this.finish();
        this.search = new RouteSearch(this.graph, this.frame, this.from, this.to, { ...this.options, avoid: this.avoidMap() });
        this.searchStates = 0;
        this.stats.searches++;
      }
      const r = this.search.run(budget);
      budget -= Math.max(1, r.stats.states - this.searchStates);
      this.searchStates = r.stats.states;
      if (r.status === "more") break;
      this.stats.states += r.stats.states;
      this.stats.ms += r.stats.ms;
      this.search = null;
      if (r.status === "failed") return this.finish();
      if (this.acceptable(r.plan)) {
        this.kept.push(r.plan);
        this.keptEdges.push(edgeSet(r.plan));
      }
    }
    return { status: "more", stats: this.stats };
  }

  private finish(): AlternativeStatus {
    this.finished = { status: "done", alternatives: this.kept, stats: this.stats };
    return this.finished;
  }

  /** Every edge of the routes kept so far (the main one included): the penalty once per route that has it. */
  private avoidMap(): Map<EdgeId, number> {
    const avoid = new Map<EdgeId, number>();
    for (const edges of this.keptEdges) for (const e of edges) avoid.set(e, (avoid.get(e) ?? 1) * this.rules.penalty);
    return avoid;
  }

  private acceptable(plan: RoutePlan): boolean {
    const r = this.rules;
    if (plan.durationS > this.main.durationS * r.maxSlower || plan.durationS - this.main.durationS > r.maxExtraS) return false;
    if (plan.lengthM <= 0) return false;
    return this.keptEdges.every((edges) => sharedM(this.graph, plan, edges) <= r.maxShared * plan.lengthM);
  }
}

// Alternative routes (ROUTING-SPEC §8.7): after the main route, the planner runs again with the roads already
// found made slower (the penalty method), and keeps what comes out if it is a real choice: different enough from
// every route kept so far and not much slower than the main one. Pure TS, advanced in slices like `RouteSearch`.

import { haversineM, type Coordinate } from "../geo";
import type { LocalFrame } from "../geo/local-frame";
import type { EdgeId, GraphStats, RoadGraph } from "../mapmatch/graph/road-graph";
import { FALLBACK_WEIGHT, legCoordinates, legLengthM, RouteSearch, type RouteOptions, type RoutePlan, type RouteStart } from "./router";

export interface AlternativeRules {
  /** Alternatives kept at most. */
  max: number;
  /** Searches at most (the main one not counted): a rejected result still costs one. */
  maxSearches: number;
  /** Time on every road of a route found so far (kept, or turned down as too shared) × this, once per route. */
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

/** `alternatives`: those kept so far (each kept for good: a later search only adds). */
export type AlternativeStatus =
  | { status: "more"; alternatives: readonly RoutePlan[]; stats: AlternativeStats }
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
  private readonly options: RouteOptions;
  private readonly kept: RoutePlan[] = [];
  /** The main route's roads, then each kept alternative's: what a new one must differ from. */
  private readonly keptEdges: Set<EdgeId>[];
  /**
   * The routes whose roads the next search is slowed on: the kept ones and those turned down as too shared. Without
   * the latter the next search had the same penalties and found the same route again, turned down again: a long
   * route's three searches cost three times one (2026-11-02).
   */
  private readonly penalised: Set<EdgeId>[];
  /**
   * A search fell back to the higher weight (`RouteOptions.fallbackAfterStates`): the next ones start there, instead
   * of each settling the fallback's worth of states and starting again. Weight 2 from the first search lost
   * alternatives the main weight finds (2 of 44 routes, 2026-11-02).
   */
  private fellBack = false;
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
    options: RouteOptions = {},
    rules: Partial<AlternativeRules> = {},
  ) {
    this.rules = { ...DEFAULT_ALTERNATIVE_RULES, ...rules };
    this.options = options;
    this.keptEdges = [edgeSet(main)];
    this.penalised = [...this.keptEdges];
  }

  /** Settle up to `maxStates` more states, over as many searches as that reaches. */
  run(maxStates = Infinity): AlternativeStatus {
    if (this.finished) return this.finished;
    let budget = maxStates;
    while (budget > 0) {
      if (!this.search) {
        if (this.kept.length >= this.rules.max || this.stats.searches >= this.rules.maxSearches) return this.finish();
        const weight = this.fellBack ? { heuristicWeight: this.options.fallbackWeight ?? FALLBACK_WEIGHT, fallbackAfterStates: Infinity } : {};
        this.search = new RouteSearch(this.graph, this.frame, this.from, this.to, { ...this.options, ...weight, avoid: this.avoidMap() });
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
      if (r.stats.fellBackAt) this.fellBack = true;
      if (r.status === "failed") return this.finish();
      const verdict = this.verdict(r.plan);
      // Too slow: slowing more roads makes the next search's routes cost more, not less; it is over.
      if (verdict === "slower") return this.finish();
      const edges = edgeSet(r.plan);
      this.penalised.push(edges);
      if (verdict === "kept") {
        this.kept.push(r.plan);
        this.keptEdges.push(edges);
        // Back to the caller with it at once: it goes on the map while the next one is searched.
        break;
      }
    }
    return { status: "more", alternatives: this.kept, stats: this.stats };
  }

  private finish(): AlternativeStatus {
    this.finished = { status: "done", alternatives: this.kept, stats: this.stats };
    return this.finished;
  }

  /** Every edge of the routes found so far (the main one included): the penalty once per route that has it. */
  private avoidMap(): Map<EdgeId, number> {
    const avoid = new Map<EdgeId, number>();
    for (const edges of this.penalised) for (const e of edges) avoid.set(e, (avoid.get(e) ?? 1) * this.rules.penalty);
    return avoid;
  }

  private verdict(plan: RoutePlan): "kept" | "slower" | "shared" {
    const r = this.rules;
    if (plan.durationS > this.main.durationS * r.maxSlower || plan.durationS - this.main.durationS > r.maxExtraS) return "slower";
    if (plan.lengthM <= 0) return "slower";
    return this.keptEdges.every((edges) => sharedM(this.graph, plan, edges) <= r.maxShared * plan.lengthM) ? "kept" : "shared";
  }
}

/** The alternatives in one go (tools, tests). */
export function planAlternatives(
  graph: RoadGraph & { stats?: GraphStats },
  frame: LocalFrame,
  from: RouteStart,
  to: Coordinate,
  main: RoutePlan,
  options: RouteOptions = {},
  rules: Partial<AlternativeRules> = {},
): Extract<AlternativeStatus, { status: "done" }> {
  const search = new AlternativeSearch(graph, frame, from, to, main, options, rules);
  for (;;) {
    const r = search.run();
    if (r.status === "done") return r;
  }
}

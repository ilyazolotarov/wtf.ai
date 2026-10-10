// Routing in the app (ROUTING-SPEC §8): plans a route from the published position on the active region's road
// graph, in slices between frames, guides along it, plans again when the car leaves it, and writes every plan
// and the guidance into the trip log. After a new route is on its way, alternatives are searched the same way
// (§8.7): never before the route itself, so they never hold up the start.

import type { Coordinate } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import type { GraphStats, RoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { AlternativeSearch, edgeSet, labelPoint, sharedM } from "@/nav/routing/alternatives";
import { congestionAt } from "@/nav/routing/congestion";
import { RouteGuidance, type GuidanceState, type GuidanceStep } from "@/nav/routing/guidance";
import { routeManeuvers, type Maneuver } from "@/nav/routing/maneuvers";
import { RouteSearch, type RouteFailure, type RoutePlan, type RouteStart } from "@/nav/routing/router";
import type { PositionEstimate } from "@/nav/position/types";
import type {
  NavRouteManeuverRecord,
  NavRoutePointRecord,
  NavRouteProgressRecord,
  NavRouteRecord,
  ROUTE_REASON_CODES,
} from "@/triplog/schema";

/** Decoded tiles the planner keeps (ROUTING-SPEC §7: ~20 MB, 0.57 s for 172 km in Node). */
export const ROUTER_CACHE_TILES = 2048;
/**
 * Each slice settles states for about this long, then yields to the UI. The map draws on its own thread; a yield
 * waits for the next timer tick (about a frame), so short slices spent most of a long plan's wall time waiting.
 */
const SLICE_MS = 32;
const FIRST_SLICE_STATES = 1000;
/** After a plan, the next one for leaving the route waits at least this long. */
const REPLAN_COOLDOWN_MS = 10_000;
/**
 * A plan whose route goes off again within this long of being made did not fix anything: the route was never the
 * problem, the position was. Each such repeat doubles the wait, up to `REPLAN_COOLDOWN_MAX_MS`, and a route that
 * stays on longer than this clears the streak. Under jamming on 2026-10-06 the flat 10 s cooldown re-planned a
 * 62 km route 25 times in 12 min, each from a dot several kilometres from the car, at 700-780 ms a plan.
 */
const REPLAN_SETTLED_MS = 60_000;
const REPLAN_COOLDOWN_MAX_MS = 160_000;
/** "Arrived" stays on the map this long, then the route ends. */
const ARRIVED_LINGER_MS = 60_000;
/** The active route's destination, kept so a restarted app (iOS may end it mid-drive) picks the route up again. */
const ACTIVE_KEY = "route.active";
const RESUME_MAX_AGE_MS = 12 * 3600_000;
/** A faster alternative replaces the route by itself while the car is still this close to the start. */
const SWAP_NEAR_START_M = 50;
/** … and only if it saves at least this. */
const SWAP_MIN_GAIN_S = 30;

export interface RouteDestination extends Coordinate {
  /** A name to show (a city from the list); a point on the map has none. */
  name?: string;
  /** The list entry it came from. */
  id?: string;
}

export type RouteProblem = RouteFailure | "no-road-graph" | "no-position" | "outside-region";

/** Another way to the destination (ROUTING-SPEC §8.7), drawn beside the route until the car is on one of them. */
export interface AlternativeRoute {
  plan: RoutePlan;
  /** Its time minus the route's, s (negative: faster). */
  deltaS: number;
  /** Where the map labels it: on its own stretch, away from the route. */
  labelAt: Coordinate;
}

export interface RouteSnapshot {
  destination: RouteDestination;
  /** `planning`: the first plan is being made; `failed`: it couldn't be. */
  status: "planning" | "active" | "failed";
  failure?: RouteProblem;
  planId: number;
  plan?: RoutePlan;
  maneuvers?: Maneuver[];
  guidance?: GuidanceStep;
  /** Planning again after leaving the route: the old route stays drawn meanwhile. */
  replanning: boolean;
  /** The last re-plan failed (the old route stays). */
  replanFailure?: RouteProblem;
  /** Other ways to the destination; empty or absent: none (yet). */
  alternatives?: AlternativeRoute[];
}

/** The last plan's cost on this phone, for the developer screen (trip logs only record while driving). */
export interface RoutePlanStats {
  id: number;
  reason: Reason;
  /** `done`, or why it failed. */
  outcome: "done" | RouteProblem;
  lengthM: number | null;
  states: number;
  tiles: number;
  /** In the search, and from the request to the result. */
  planMs: number;
  wallMs: number;
  slices: number;
}

export interface RouteDebug {
  /** Plans made this session (re-plans included). */
  plans: number;
  last: RoutePlanStats | null;
  /** Settled states per slice now (adapts to ~12 ms). */
  sliceStates: number;
}

export interface RoutingGraph {
  key: string;
  graph: RoadGraph & {
    stats?: GraphStats;
    setFrame(frame: LocalFrame): void;
    info?: { builtAt: number };
    /** The graph's tile at a point, −1 outside the region's tiles. */
    tileAt?(c: Coordinate): number;
  };
  close(): void;
}

export interface RouteLog {
  route(r: NavRouteRecord): void;
  point(r: NavRoutePointRecord): void;
  maneuver(r: NavRouteManeuverRecord): void;
  progress(r: NavRouteProgressRecord): void;
}

export interface RouteServiceDeps {
  position: { getSnapshot(): PositionEstimate | null; subscribe(listener: () => void): () => void };
  /** Opens a reader on the active region's road graph (null: none). */
  openGraph(): RoutingGraph | null;
  /** Monotonic uptime, µs (trip-log timestamps). */
  nowUs(): number;
  /** Wall clock, ms. */
  now?(): number;
  note?(text: string): void;
  log?: RouteLog;
  /** Runs `fn` later (between frames); tests pass their own. */
  defer?(fn: () => void, ms: number): () => void;
  /** The route in force changed (a plan, a re-plan, the end): its plan, or null. */
  onRoute?(plan: RoutePlan | null): void;
  /** Keeps the active destination across app restarts. */
  store?: { getJson<T>(key: string): T | null; setJson(key: string, value: unknown): void };
}

type Reason = (typeof ROUTE_REASON_CODES)[number];

/** Route start from the published position: on the road while map-matched, with its heading and speed when known. */
function startOf(p: PositionEstimate) {
  return {
    lat: p.lat,
    lon: p.lon,
    accuracyM: p.accuracyM,
    ...(p.headingRad !== undefined ? { headingRad: p.headingRad } : {}),
    ...(p.speedMps !== undefined ? { speedMps: p.speedMps } : {}),
  };
}

/** Phone GPS while it isn't trusted can't judge the route (it may be anywhere). */
const reliable = (p: PositionEstimate) => !(p.source === "gnss" && p.trust !== "TRUSTED");

export class RouteService {
  private readonly deps: RouteServiceDeps;
  private snapshot: RouteSnapshot | null = null;
  private listeners = new Set<() => void>();
  private graph: RoutingGraph | null = null;
  private guidance: RouteGuidance | null = null;
  private nextPlanId = 1;
  /** The search in progress: its id and how to cancel the next slice. */
  private planning: { id: number; cancel: () => void } | null = null;
  private lastPlanAt = -Infinity;
  /** Off-route plans in a row whose route went off again before `REPLAN_SETTLED_MS`; doubles the wait each time. */
  private replanStreak = 0;
  /** When the route of the last plan first went off (null: not yet). */
  private offSincePlanAt: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private notedState: GuidanceState | null = null;
  /** For the arrival note: when the route started, the first plan's time and length, and the distance driven. */
  private trip: { startedAt: number; plannedS: number; plannedM: number; drivenM: number; lastAt: number | null } | null = null;
  private arrivedTimer: (() => void) | null = null;
  private sliceStates = FIRST_SLICE_STATES;
  private planCount = 0;
  private lastStats: RoutePlanStats | null = null;
  /** The alternatives search in progress (after a new route): its plan id and how to cancel the next slice. */
  private altSearch: { id: number; cancel: () => void } | null = null;
  /** The alternatives, each followed by its own guidance from the start: the one the car is on can take over. */
  private others: { plan: RoutePlan; maneuvers: Maneuver[]; guidance: RouteGuidance }[] = [];

  constructor(deps: RouteServiceDeps) {
    this.deps = deps;
  }

  getSnapshot = (): RouteSnapshot | null => this.snapshot;

  getDebug(): RouteDebug {
    return { plans: this.planCount, last: this.lastStats, sliceStates: this.sliceStates };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Plan to `destination` from where the car is now and guide along it. */
  start(destination: RouteDestination, resumed = false): void {
    this.stop(false);
    this.deps.store?.setJson(ACTIVE_KEY, { destination, savedAt: this.now() });
    this.note(
      `route ${resumed ? "resumed after an app restart, " : ""}to ${destination.lat.toFixed(5)},${destination.lon.toFixed(5)}` +
        (destination.name ? ` (${destination.name})` : ""),
    );
    this.set({ destination, status: "planning", planId: 0, replanning: false });
    this.unsubscribe = this.deps.position.subscribe(this.onPosition);
    this.plan("new");
  }

  /**
   * After an app start: the route that was active when the app last ran (within 12 h), planned again from where
   * the car is once there is a position.
   */
  resume(): void {
    const saved = this.deps.store?.getJson<{ destination: RouteDestination; savedAt: number }>(ACTIVE_KEY);
    if (!saved || this.snapshot || !(this.now() - saved.savedAt < RESUME_MAX_AGE_MS)) return;
    if (this.deps.position.getSnapshot()) {
      this.start(saved.destination, true);
      return;
    }
    const unsubscribe = this.deps.position.subscribe(() => {
      if (!this.deps.position.getSnapshot()) return;
      unsubscribe();
      if (!this.snapshot) this.start(saved.destination, true);
    });
  }

  stop(note = true): void {
    if (note) this.deps.store?.setJson(ACTIVE_KEY, null);
    if (!this.snapshot) return;
    if (note) this.note(`route stop${this.guidance?.step ? ` at ${km(this.guidance.step.alongM)} of ${km(this.guidance.plan.lengthM)}` : ""}`);
    this.planning?.cancel();
    this.planning = null;
    this.dropAlternatives(false);
    this.arrivedTimer?.();
    this.arrivedTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.guidance = null;
    this.trip = null;
    this.notedState = null;
    this.graph?.close();
    this.graph = null;
    this.deps.onRoute?.(null);
    this.set(null);
  }

  /** A trip started: log the active route again, so the trip's log has it (reason `resume`). */
  logActiveRoute(): void {
    const s = this.snapshot;
    if (!s?.plan || !s.maneuvers) return;
    this.logPlan(s.planId, "resume", s.plan, s.maneuvers, null);
  }

  /** `RouteCosts.congestion` of the last plan started. */
  private planCongestion = 1;

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private defer(fn: () => void, ms: number): () => void {
    if (this.deps.defer) return this.deps.defer(fn, ms);
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  }

  private set(next: RouteSnapshot | null): void {
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  }

  private note(text: string): void {
    this.deps.note?.(text);
  }

  private openGraph(): RoutingGraph | null {
    // Reopened per route: the region may have changed in between.
    this.graph ??= this.deps.openGraph();
    return this.graph;
  }

  /** Start a search from the published position; it runs in slices until done. */
  private plan(reason: Reason): void {
    const s = this.snapshot;
    if (!s) return;
    const position = this.deps.position.getSnapshot();
    const graph = position ? this.openGraph() : null;
    const id = this.nextPlanId++;
    const outside = (c: Coordinate) => (graph?.graph.tileAt?.(c) ?? 0) < 0;
    const problem: RouteProblem | null = !position
      ? "no-position"
      : !graph
        ? "no-road-graph"
        : outside(s.destination) || outside(position)
          ? "outside-region"
          : null;
    if (problem || !position || !graph) {
      this.failed(id, reason, problem ?? "no-position", position, 0);
      return;
    }
    this.dropAlternatives();
    const frame = new LocalFrame(position);
    graph.graph.setFrame(frame);
    const from = startOf(position);
    const startedAt = this.now();
    // Rush hours at the time it leaves (ROUTING-SPEC §4.3): city main roads take longer, the route may go round them.
    this.planCongestion = congestionAt(new Date(startedAt));
    const search = new RouteSearch(graph.graph, frame, from, s.destination, { costs: { congestion: this.planCongestion } });
    let slices = 0;
    // Measured from when the last plan's route went off, not from this plan: the wait itself must not end the streak.
    const quick = this.offSincePlanAt !== null && this.offSincePlanAt - this.lastPlanAt < REPLAN_SETTLED_MS;
    this.replanStreak = reason === "off-route" && quick ? this.replanStreak + 1 : 0;
    this.lastPlanAt = startedAt;
    this.offSincePlanAt = null;
    if (reason === "off-route") this.set({ ...this.snapshot!, replanning: true });
    const step = () => {
      if (this.planning?.id !== id) return;
      slices++;
      const t0 = this.now();
      const r = search.run(this.sliceStates);
      // Aim each slice at SLICE_MS: the phone's speed is unknown until it plans.
      const ms = Math.max(0.5, this.now() - t0);
      if (r.status === "more") {
        this.sliceStates = Math.max(200, Math.min(50_000, Math.round((this.sliceStates * SLICE_MS) / ms)));
        this.planning = { id, cancel: this.defer(step, 0) };
        return;
      }
      this.planning = null;
      const wallMs = this.now() - startedAt;
      if (r.status === "failed") {
        this.failed(id, reason, r.reason, position, wallMs, { states: r.stats.states, tiles: r.stats.tilesRead, planMs: r.stats.ms, slices });
        return;
      }
      const maneuvers = routeManeuvers(graph.graph, r.plan);
      // A re-plan starts where the car drives: it is on the new route, not on its way to it from a car park.
      this.guidance = new RouteGuidance(r.plan, maneuvers, {}, { joined: reason === "off-route" });
      this.notedState = null;
      this.trip ??= { startedAt, plannedS: r.plan.durationS, plannedM: r.plan.lengthM, drivenM: 0, lastAt: null };
      const cur = this.snapshot!;
      this.set({ ...cur, status: "active", failure: undefined, replanFailure: undefined, planId: id, plan: r.plan, maneuvers, guidance: undefined, replanning: false });
      this.logPlan(id, reason, r.plan, maneuvers, { states: r.stats.states, tiles: r.stats.tilesRead, planMs: r.stats.ms, wallMs, slices, fellBackAt: r.stats.fellBackAt }, position);
      this.deps.onRoute?.(r.plan);
      this.onPosition();
      // The route is on its way; alternatives only now, in slices of their own.
      if (reason === "new") this.searchAlternatives(id, graph, frame, from, r.plan);
    };
    this.planning = { id, cancel: this.defer(step, 0) };
  }

  /**
   * Alternatives to a new route (ROUTING-SPEC §8.7), searched in slices after it. A faster one takes over while the
   * car hasn't left the start (the main search's weighted heuristic can miss the fastest route).
   */
  private searchAlternatives(id: number, graph: RoutingGraph, frame: LocalFrame, from: RouteStart, main: RoutePlan): void {
    const s = this.snapshot;
    if (!s) return;
    const search = new AlternativeSearch(graph.graph, frame, from, s.destination, main, { costs: { congestion: this.planCongestion } });
    const startedAt = this.now();
    const step = () => {
      if (this.altSearch?.id !== id) return;
      const r = search.run(this.sliceStates);
      if (r.status === "more") {
        this.altSearch = { id, cancel: this.defer(step, 0) };
        return;
      }
      this.altSearch = null;
      const cur = this.snapshot;
      if (!cur || cur.planId !== id || !cur.plan) return;
      this.others = r.alternatives.map((plan) => {
        const maneuvers = routeManeuvers(graph.graph, plan);
        return { plan, maneuvers, guidance: new RouteGuidance(plan, maneuvers) };
      });
      const mainEdges = edgeSet(main);
      this.note(
        `route alternatives: ${r.alternatives.length}` +
          r.alternatives.map((a) => ` (${signedMin(a.durationS - main.durationS)}, ${km(a.lengthM)}, ${Math.round((sharedM(graph.graph, a, mainEdges) / a.lengthM) * 100)} % shared)`).join("") +
          `; ${r.stats.searches} searches, ${r.stats.states} states, ${Math.round(r.stats.ms)} ms (${Math.round(this.now() - startedAt)} ms wall)`,
      );
      let fastest = -1;
      this.others.forEach((o, i) => {
        if (o.plan.durationS < (fastest < 0 ? main.durationS : this.others[fastest].plan.durationS)) fastest = i;
      });
      const along = this.guidance?.step?.alongM ?? 0;
      if (fastest >= 0 && main.durationS - this.others[fastest].plan.durationS >= SWAP_MIN_GAIN_S && along <= SWAP_NEAR_START_M) {
        this.takeAlternative(fastest, "faster");
        return;
      }
      this.publishAlternatives();
    };
    this.altSearch = { id, cancel: this.defer(step, 0) };
  }

  /** Follow alternative `index` instead of the route: tapped on the map. */
  chooseAlternative(index: number): void {
    if (index >= 0 && index < this.others.length) this.takeAlternative(index, "chosen");
  }

  /**
   * Alternative `index` becomes the route and the route an alternative. Their guidance changes places with them, so
   * the progress each has made stays.
   */
  private takeAlternative(index: number, why: "chosen" | "faster" | "taken"): void {
    const s = this.snapshot;
    const current = this.guidance;
    if (!s?.plan || !s.maneuvers || !current) return;
    const next = this.others[index];
    const id = this.nextPlanId++;
    this.others = [{ plan: s.plan, maneuvers: s.maneuvers, guidance: current }, ...this.others.filter((_, i) => i !== index)];
    this.guidance = next.guidance;
    this.notedState = null;
    if (this.trip) {
      this.trip.plannedS = next.plan.durationS;
      this.trip.plannedM = next.plan.lengthM;
    }
    this.note(`route alternative taken (${why}): ${km(next.plan.lengthM)}, ${Math.round(next.plan.durationS / 60)} min, was ${Math.round(s.plan.durationS / 60)} min`);
    this.set({ ...s, planId: id, plan: next.plan, maneuvers: next.maneuvers, guidance: next.guidance.step ?? undefined, replanning: false, replanFailure: undefined });
    this.logPlan(id, "alternative", next.plan, next.maneuvers, null, this.deps.position.getSnapshot() ?? undefined);
    this.publishAlternatives();
    this.deps.onRoute?.(next.plan);
  }

  /** The alternatives into the snapshot, timed against the route and labelled off its roads. */
  private publishAlternatives(): void {
    const s = this.snapshot;
    const graph = this.graph?.graph;
    if (!s?.plan || !graph) return;
    const main = s.plan;
    const mainEdges = edgeSet(main);
    const alternatives = this.others.map((o) => ({
      plan: o.plan,
      deltaS: o.plan.durationS - main.durationS,
      labelAt: labelPoint(graph, o.plan, [mainEdges]),
    }));
    this.set({ ...s, alternatives });
  }

  /** No more alternatives: a re-plan, the end, or the car is on its route and off all of them. */
  private dropAlternatives(publish = true): void {
    this.altSearch?.cancel();
    this.altSearch = null;
    this.others = [];
    if (publish && this.snapshot?.alternatives) this.set({ ...this.snapshot, alternatives: undefined });
  }

  private failed(
    id: number,
    reason: Reason,
    problem: RouteProblem,
    position: PositionEstimate | null,
    wallMs: number,
    stats = { states: 0, tiles: 0, planMs: 0, slices: 0 },
  ): void {
    const s = this.snapshot!;
    this.planCount++;
    this.lastStats = { id, reason, outcome: problem, lengthM: null, states: stats.states, tiles: stats.tiles, planMs: stats.planMs, wallMs, slices: stats.slices };
    this.note(`route plan #${id} (${reason}) failed: ${problem}${stats.states ? `, ${stats.states} states, ${Math.round(stats.planMs)} ms` : ""}`);
    this.deps.log?.route({
      timestampUs: this.deps.nowUs(),
      planId: id,
      reason,
      status: problem === "no-road-graph" || problem === "no-position" || problem === "outside-region" ? "cancelled" : problem,
      fromLatDeg: position?.lat ?? NaN,
      fromLonDeg: position?.lon ?? NaN,
      fromHeadingRad: position?.headingRad ?? NaN,
      toLatDeg: s.destination.lat,
      toLonDeg: s.destination.lon,
      lengthM: NaN,
      durationS: NaN,
      offStartM: NaN,
      offEndM: NaN,
      states: stats.states,
      tiles: stats.tiles,
      planMs: stats.planMs,
      wallMs,
      slices: stats.slices,
      points: 0,
      maneuvers: 0,
      graphBuilt: this.graph?.graph.info?.builtAt ?? 0,
    });
    // A failed re-plan keeps the route the car left; a failed first plan ends in `failed`.
    if (s.plan) this.set({ ...s, replanning: false, replanFailure: problem });
    else this.set({ ...s, status: "failed", failure: problem, planId: id, replanning: false });
  }

  private logPlan(
    id: number,
    reason: Reason,
    plan: RoutePlan,
    maneuvers: Maneuver[],
    stats: { states: number; tiles: number; planMs: number; wallMs: number; slices: number; fellBackAt?: number } | null,
    position?: PositionEstimate,
  ): void {
    const s = this.snapshot!;
    const t = this.deps.nowUs();
    const start = plan.coordinates[0];
    if (stats) {
      this.planCount++;
      const { fellBackAt, ...counts } = stats;
      this.lastStats = { id, reason, outcome: "done", lengthM: plan.lengthM, ...counts };
      this.note(
        `route plan #${id} (${reason}): ${km(plan.lengthM)}, ${Math.round(plan.durationS / 60)} min, ${maneuvers.length - 2} maneuvers; ` +
          `${stats.states} states, ${stats.tiles} tiles, ${Math.round(stats.planMs)} ms in ${stats.slices} slices (${Math.round(stats.wallMs)} ms wall)` +
          (plan.offRoadM.start > 30 || plan.offRoadM.end > 30 ? `; ends ${Math.round(plan.offRoadM.start)} / ${Math.round(plan.offRoadM.end)} m off` : "") +
          (this.planCongestion !== 1 ? `; rush hour ×${this.planCongestion}` : "") +
          (fellBackAt ? `; weight raised after ${fellBackAt} states` : ""),
      );
    }
    const log = this.deps.log;
    if (!log) return;
    log.route({
      timestampUs: t,
      planId: id,
      reason,
      status: "done",
      fromLatDeg: position?.lat ?? start.lat,
      fromLonDeg: position?.lon ?? start.lon,
      fromHeadingRad: position?.headingRad ?? NaN,
      toLatDeg: s.destination.lat,
      toLonDeg: s.destination.lon,
      lengthM: plan.lengthM,
      durationS: plan.durationS,
      offStartM: plan.offRoadM.start,
      offEndM: plan.offRoadM.end,
      states: stats?.states ?? 0,
      tiles: stats?.tiles ?? 0,
      planMs: stats?.planMs ?? 0,
      wallMs: stats?.wallMs ?? 0,
      slices: stats?.slices ?? 0,
      points: plan.coordinates.length,
      maneuvers: maneuvers.length,
      graphBuilt: this.graph?.graph.info?.builtAt ?? 0,
    });
    plan.coordinates.forEach((c, index) => log.point({ timestampUs: t, planId: id, index, latDeg: c.lat, lonDeg: c.lon }));
    maneuvers.forEach((m, index) =>
      log.maneuver({ timestampUs: t, planId: id, index, kind: m.kind, exit: m.exit ?? 0, latDeg: m.lat, lonDeg: m.lon, atM: m.atM, turnRad: m.turnRad }),
    );
  }

  private onPosition = (): void => {
    const s = this.snapshot;
    const guidance = this.guidance;
    const p = this.deps.position.getSnapshot();
    if (!s || !guidance || !p || s.status !== "active") return;
    const trip = this.trip;
    if (trip) {
      if (trip.lastAt !== null && p.speedMps !== undefined) trip.drivenM += p.speedMps * Math.max(0, (p.timestamp - trip.lastAt) / 1000);
      trip.lastAt = p.timestamp;
    }
    const at = {
      lat: p.lat,
      lon: p.lon,
      tMs: p.timestamp,
      accuracyM: p.accuracyM,
      headingRad: p.headingRad,
      speedMps: p.speedMps,
      mapMatch: p.mapMatch,
      reliable: reliable(p),
    };
    const step = guidance.update(at);
    // The alternatives follow the car too: off the route but on one of them, the driver chose it.
    const others = this.others.map((o) => o.guidance.update(at));
    if (step.state === "off") {
      const taken = others.findIndex((o) => o.state === "on");
      if (taken >= 0) {
        this.takeAlternative(taken, "taken");
        return;
      }
    }
    if (others.length && step.state === "on" && others.every((o) => o.state === "off")) this.dropAlternatives(false);
    this.deps.log?.progress({
      timestampUs: this.deps.nowUs(),
      planId: s.planId,
      state: step.state,
      nextIndex: step.nextIndex,
      alongM: step.alongM,
      offM: Number.isFinite(step.offM) ? step.offM : NaN,
      remainingM: step.remainingM,
      remainingS: step.remainingS,
      toNextM: step.toNextM,
    });
    this.noteState(step, p);
    this.set({ ...s, guidance: step, ...(this.others.length ? {} : { alternatives: undefined }) });
    if (step.state === "off" && !this.planning) this.offSincePlanAt ??= this.now();
    if (step.state === "off" && !this.planning && this.mayReplan(p)) this.plan("off-route");
    if (step.state === "arrived" && !this.arrivedTimer) {
      this.dropAlternatives();
      this.arrivedTimer = this.defer(() => this.stop(), ARRIVED_LINGER_MS);
    }
  };

  /**
   * Is leaving the route worth a new one? Only when the position is fit to say the car left it.
   *
   * While map matching is `offroad` the filter itself says the dot is not on any road, so "off route" means "I
   * lost the car", not "the car turned" — and a plan from a dot beside the road starts off it and goes off again
   * at once. On 2026-10-06, 16 km into a jammed drive, a 95° turn the route itself asked for landed 62 m short of
   * the junction, the filter went off-road, and four plans went out in 31 s while it recovered on its own.
   */
  private mayReplan(p: PositionEstimate): boolean {
    if (p.mapMatch === "offroad") return false;
    const wait = Math.min(REPLAN_COOLDOWN_MS * 2 ** this.replanStreak, REPLAN_COOLDOWN_MAX_MS);
    return this.now() - this.lastPlanAt >= wait;
  }

  /** Guidance state changes into the trip log; `leaving` ↔ `on` flickers only as a count at the end. */
  private noteState(step: GuidanceStep, p: PositionEstimate): void {
    const state = step.state;
    if (state === this.notedState || state === "leaving") return;
    const was = this.notedState;
    this.notedState = state;
    if (was === null && state === "on") return;
    const where = `at ${km(step.alongM)}, ${Number.isFinite(step.offM) ? `${Math.round(step.offM)} m off` : "nothing matched"}, ±${Math.round(p.accuracyM)} m, ${p.source}${p.mapMatch ? `/${p.mapMatch}` : ""}`;
    if (state === "arrived" && this.trip) {
      const t = this.trip;
      this.note(
        `route arrived ${where}: ${Math.round((this.now() - t.startedAt) / 60_000)} min (planned ${Math.round(t.plannedS / 60)}), ` +
          `driven ${km(t.drivenM)} (planned ${km(t.plannedM)})`,
      );
      return;
    }
    this.note(`route ${state} ${where}`);
  }
}

const km = (m: number) => `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
const signedMin = (s: number) => `${s < 0 ? "−" : "+"}${Math.round(Math.abs(s) / 60)} min`;

// Routing in the app (ROUTING-SPEC §8): plans a route from the published position on the active region's road
// graph, in slices between frames, guides along it, plans again when the car leaves it, and writes every plan
// and the guidance into the trip log.

import type { Coordinate } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import type { GraphStats, RoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { RouteGuidance, type GuidanceState, type GuidanceStep } from "@/nav/routing/guidance";
import { routeManeuvers, type Maneuver } from "@/nav/routing/maneuvers";
import { RouteSearch, type RouteFailure, type RoutePlan } from "@/nav/routing/router";
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
/** Each slice settles states for about this long, then yields to the UI. */
const SLICE_MS = 12;
const FIRST_SLICE_STATES = 1000;
/** After a plan, the next one for leaving the route waits at least this long. */
const REPLAN_COOLDOWN_MS = 10_000;
/** "Arrived" stays on the map this long, then the route ends. */
const ARRIVED_LINGER_MS = 60_000;

export interface RouteDestination extends Coordinate {
  /** A name to show (a city from the list); a point on the map has none. */
  name?: string;
  /** The list entry it came from. */
  id?: string;
}

export type RouteProblem = RouteFailure | "no-road-graph" | "no-position" | "outside-region";

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
}

type Reason = (typeof ROUTE_REASON_CODES)[number];

/** Route start from the published position: on the road while map-matched, with its heading when it has one. */
function startOf(p: PositionEstimate) {
  return { lat: p.lat, lon: p.lon, accuracyM: p.accuracyM, ...(p.headingRad !== undefined ? { headingRad: p.headingRad } : {}) };
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
  private unsubscribe: (() => void) | null = null;
  private notedState: GuidanceState | null = null;
  /** For the arrival note: when the route started, the first plan's time and length, and the distance driven. */
  private trip: { startedAt: number; plannedS: number; plannedM: number; drivenM: number; lastAt: number | null } | null = null;
  private arrivedTimer: (() => void) | null = null;
  private sliceStates = FIRST_SLICE_STATES;
  private planCount = 0;
  private lastStats: RoutePlanStats | null = null;

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
  start(destination: RouteDestination): void {
    this.stop(false);
    this.note(`route to ${destination.lat.toFixed(5)},${destination.lon.toFixed(5)}${destination.name ? ` (${destination.name})` : ""}`);
    this.set({ destination, status: "planning", planId: 0, replanning: false });
    this.unsubscribe = this.deps.position.subscribe(this.onPosition);
    this.plan("new");
  }

  stop(note = true): void {
    if (!this.snapshot) return;
    if (note) this.note(`route stop${this.guidance?.step ? ` at ${km(this.guidance.step.alongM)} of ${km(this.guidance.plan.lengthM)}` : ""}`);
    this.planning?.cancel();
    this.planning = null;
    this.arrivedTimer?.();
    this.arrivedTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.guidance = null;
    this.trip = null;
    this.notedState = null;
    this.graph?.close();
    this.graph = null;
    this.set(null);
  }

  /** A trip started: log the active route again, so the trip's log has it (reason `resume`). */
  logActiveRoute(): void {
    const s = this.snapshot;
    if (!s?.plan || !s.maneuvers) return;
    this.logPlan(s.planId, "resume", s.plan, s.maneuvers, null);
  }

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
    const frame = new LocalFrame(position);
    graph.graph.setFrame(frame);
    const from = startOf(position);
    const search = new RouteSearch(graph.graph, frame, from, s.destination);
    const startedAt = this.now();
    let slices = 0;
    this.lastPlanAt = startedAt;
    if (reason === "off-route") this.set({ ...s, replanning: true });
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
      this.guidance = new RouteGuidance(r.plan, maneuvers);
      this.notedState = null;
      this.trip ??= { startedAt, plannedS: r.plan.durationS, plannedM: r.plan.lengthM, drivenM: 0, lastAt: null };
      const cur = this.snapshot!;
      this.set({ ...cur, status: "active", failure: undefined, replanFailure: undefined, planId: id, plan: r.plan, maneuvers, guidance: undefined, replanning: false });
      this.logPlan(id, reason, r.plan, maneuvers, { states: r.stats.states, tiles: r.stats.tilesRead, planMs: r.stats.ms, wallMs, slices }, position);
      this.onPosition();
    };
    this.planning = { id, cancel: this.defer(step, 0) };
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
    stats: { states: number; tiles: number; planMs: number; wallMs: number; slices: number } | null,
    position?: PositionEstimate,
  ): void {
    const s = this.snapshot!;
    const t = this.deps.nowUs();
    const start = plan.coordinates[0];
    if (stats) {
      this.planCount++;
      this.lastStats = { id, reason, outcome: "done", lengthM: plan.lengthM, ...stats };
      this.note(
        `route plan #${id} (${reason}): ${km(plan.lengthM)}, ${Math.round(plan.durationS / 60)} min, ${maneuvers.length - 2} maneuvers; ` +
          `${stats.states} states, ${stats.tiles} tiles, ${Math.round(stats.planMs)} ms in ${stats.slices} slices (${Math.round(stats.wallMs)} ms wall)` +
          (plan.offRoadM.start > 30 || plan.offRoadM.end > 30 ? `; ends ${Math.round(plan.offRoadM.start)} / ${Math.round(plan.offRoadM.end)} m off` : ""),
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
    const step = guidance.update({
      lat: p.lat,
      lon: p.lon,
      tMs: p.timestamp,
      accuracyM: p.accuracyM,
      headingRad: p.headingRad,
      speedMps: p.speedMps,
      mapMatch: p.mapMatch,
      reliable: reliable(p),
    });
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
    this.set({ ...s, guidance: step });
    if (step.state === "off" && !this.planning && this.now() - this.lastPlanAt >= REPLAN_COOLDOWN_MS) this.plan("off-route");
    if (step.state === "arrived" && !this.arrivedTimer) this.arrivedTimer = this.defer(() => this.stop(), ARRIVED_LINGER_MS);
  };

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

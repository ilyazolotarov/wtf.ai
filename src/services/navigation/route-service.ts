// Routing in the app (ROUTING-SPEC §8): plans a route from the published position on the active region's road
// graph, in slices between frames, guides along it, plans again when the car leaves it, and writes every plan
// and the guidance into the trip log. After a new route is on its way, alternatives are searched the same way
// (§8.7): never before the route itself, so they never hold up the start.

import { DRIVER_WORD_M } from "@/nav/navigator";
import { haversineM, type Coordinate } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import type { GraphStats, RoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { ALONG_PAGE, placesAlong, RouteLine, type Box } from "@/nav/routing/along";
import { AlternativeSearch, edgeSet, labelPoint, sharedM } from "@/nav/routing/alternatives";
import { congestionAt } from "@/nav/routing/congestion";
import { RouteGuidance, type GuidanceState, type GuidanceStep } from "@/nav/routing/guidance";
import { DetourSearch, type DetourJob } from "@/nav/routing/detour";
import type { Maneuver } from "@/nav/routing/maneuvers";
import type { RoadSide, RouteFailure, RoutePlan, RouteStart } from "@/nav/routing/router";
import { insertionIndex, joinPlans, MAX_STOPS, tripManeuvers, TripSearch, type TripPoint, type TripStatus } from "@/nav/routing/trip";
import type { PlaceCategory, StopPlace } from "@/nav/search/search-index";
import type { PositionEstimate } from "@/nav/position/types";
import type {
  NavRouteManeuverRecord,
  NavRoutePointRecord,
  NavRouteProgressRecord,
  NavRouteRecord,
  NavRouteStopRecord,
  ROUTE_REASON_CODES,
} from "@/triplog/schema";

/**
 * Decoded tiles the planner keeps while it searches (ROUTING-SPEC §8.2). Hermes keeps the heap it grew to: 2048,
 * with every edge's geometry decoded (~80 KB a tile), left a 146 km route's 1,458 tiles at ~250 MB of the app's memory
 * for good (iOS, 2026-11-01). 512 slowed a route's alternatives by 4 % in Node; 256 by 32 %.
 */
export const ROUTER_CACHE_TILES = 512;
/** …and once a search is over (a plan with its alternatives, a re-plan, a failure): a re-plan starts near the car. */
export const ROUTER_IDLE_TILES = 32;
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
/**
 * A route the car drove this far on did fix something, however soon it left it: the driver took another way. On
 * 2026-10-12 a driver ignoring the route on purpose drove each new one 155-260 m and turned off at its first turn;
 * counted as plans that fixed nothing, the waits grew to 40 and 80 s and the last one never came. The plans of the
 * 2026-10-06 loop mostly went off within 50 m, many within 4 s, before the car was ever on them.
 */
const REPLAN_FOLLOWED_M = 100;
/** "Arrived" stays on the map this long, then the route ends. */
const ARRIVED_LINGER_MS = 60_000;
/** The active route's destination, kept so a restarted app (iOS may end it mid-drive) picks the route up again. */
const ACTIVE_KEY = "route.active";
const RESUME_MAX_AGE_MS = 12 * 3600_000;
/**
 * At a stop (STOPS-SPEC §5.2) the route waits: no re-plan within this of the stop's point, nor while the car stands
 * (slower than `STOP_STANDING_MPS`). A forecourt beside the road is off the route; a driver walking into the shop with
 * the phone isn't driving.
 */
const STOP_HOLD_M = 150;
const STOP_STANDING_MPS = 1;
/**
 * A stop is left behind when the car, leaving the route, came within this of it and is now `PASS_AWAY_M` further from it
 * than it ever was (STOPS-SPEC §5.3): never turned back to it by surprise.
 */
const PASS_NEAR_M = 200;
const PASS_AWAY_M = 100;
/** The card offering a stop left behind goes after this much driving. */
const PASSED_CARD_M = 2000;
/** One frame for every search of a route (they share the graph reader's decoded geometry), until the car is this far from it. */
const FRAME_REACH_M = 30_000;
/** A search for a place off the route (the add-a-stop search) may go further from it than the list's. */
const FAR_DETOUR_MAX_STATES = 150_000;

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

export type RouteProblem = RouteFailure | "no-road-graph" | "no-position" | "outside-region" | "too-many-stops";

/** A stop on the way (STOPS-SPEC §4): its key is its own for the whole trip. */
export interface TripStop extends RouteDestination {
  key: string;
  /** What it is, when it came from the places along the route (or a search result of one of their kinds). */
  category?: PlaceCategory;
  /** What the map knows of it (`PlaceFlag`: fuels, 24/7). */
  flags?: number;
  /** Its opening hours (`StopPlace.hours`); null or none: unknown. */
  hours?: readonly number[] | null;
}

/** The stop the car is at, waiting to go on (STOPS-SPEC §5.2). */
export interface AtStop {
  stop: TripStop;
  /** Its leg's end along the plan it was reached on, m. */
  atM: number;
}

/** A stop left behind (STOPS-SPEC §5.3), offered back. */
export interface PassedStop {
  stop: TripStop;
  /** Going back through it takes this much longer than going on, s; absent while it is worked out; null: no way back. */
  backDeltaS?: number | null;
  /** Driven when it was left behind, m: the card goes `PASSED_CARD_M` later. */
  atDrivenM: number;
}

/** A place on the map before it becomes a stop (STOPS-SPEC §7.3): the trip through it, planned from where the car is. */
export interface StopPreview {
  place: TripStop;
  /** Where it would go among the stops. */
  index: number;
  status: "planning" | "done" | "failed";
  plan?: RoutePlan;
  maneuvers?: Maneuver[];
  /** The trip through it against the route as it is, s. */
  deltaS?: number;
}

/** A place along the route ahead (STOPS-SPEC §6.3). */
export interface AlongItem {
  place: StopPlace;
  /** Where it is along the plan it was found on, m (the car's `guidance.alongM` is on the same scale). */
  alongM: number;
  side: RoadSide | null;
  /** Its detour, s; undefined while it is worked out. */
  detourS?: number;
}

export interface AlongState {
  category: PlaceCategory;
  /** `no-places`: the region's search file has no places (download it again); `no-route`: no route to search along. */
  status: "searching" | "done" | "no-places" | "no-route";
  items: AlongItem[];
  /** Further along the route there may be more. */
  more: boolean;
}

/** A result of the add-a-stop search with its detour (STOPS-SPEC §7.1). */
export interface DetourEstimate {
  key: string;
  /** s; undefined while worked out; null: no way there within the search's limit. */
  detourS?: number | null;
}

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
  /** The stops on the way not reached yet, in order (STOPS-SPEC §4). */
  stops: TripStop[];
  /** Waiting at a stop just reached, until the car goes on. */
  atStop?: AtStop;
  /** A stop left behind: the card offering it back. */
  passedStop?: PassedStop;
  /** A place shown on the map before it becomes a stop. */
  preview?: StopPreview;
  /** The places along the route ahead, of one kind. */
  along?: AlongState;
  /** The first plan failed on the way to this stop (`failure`), by key. */
  failedStop?: string;
  /** Detours of the add-a-stop search's results, by key: s, null when unreachable; absent while worked out. */
  estimates?: Readonly<Record<string, number | null>>;
  /** `planning`: the first plan is being made; `failed`: it couldn't be. */
  status: "planning" | "active" | "failed";
  failure?: RouteProblem;
  planId: number;
  /** Why the plan with this id was made (`alternative`: the driver took one; no re-plan). */
  planReason?: Reason;
  plan?: RoutePlan;
  maneuvers?: Maneuver[];
  guidance?: GuidanceStep;
  /** Planning again after leaving the route: the old route stays drawn meanwhile. */
  replanning: boolean;
  /**
   * The driver keeps to their own way (another navigator's, say): this plan's route is the second re-plan in a row
   * whose route before it they didn't follow. Its guidance shows but isn't spoken or popped up on the car until they
   * follow it (`REPLAN_FOLLOWED_M` along it). The re-plan they left first was announced.
   */
  ownWay?: boolean;
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
    /** Keeps only the `keep` most recently used decoded tiles. */
    trim?(keep: number): void;
  };
  close(): void;
}

export interface RouteLog {
  route(r: NavRouteRecord): void;
  point(r: NavRoutePointRecord): void;
  maneuver(r: NavRouteManeuverRecord): void;
  stop?(r: NavRouteStopRecord): void;
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
  /** The route in force changed (a plan, a re-plan, the end): its plan, or null; and the graph file it is on. */
  onRoute?(plan: RoutePlan | null, graphKey?: string): void;
  /** Keeps the active destination across app restarts. */
  store?: { getJson<T>(key: string): T | null; setJson(key: string, value: unknown): void };
  /** The active region's places to stop at (the search file's section, STOPS-SPEC §6.1); null: no search file. */
  places?(): { hasPlaces: boolean; placesIn(box: Box, categories?: ReadonlySet<PlaceCategory>): StopPlace[] } | null;
}

type Reason = (typeof ROUTE_REASON_CODES)[number];

/**
 * Route start from the published position: on the road while map-matched, with its heading (and how sure) and speed
 * when known.
 */
function startOf(p: PositionEstimate) {
  return {
    lat: p.lat,
    lon: p.lon,
    accuracyM: p.accuracyM,
    ...(p.headingRad !== undefined ? { headingRad: p.headingRad } : {}),
    ...(p.headingSigmaRad !== undefined ? { headingSigmaRad: p.headingSigmaRad } : {}),
    ...(p.speedMps !== undefined ? { speedMps: p.speedMps } : {}),
  };
}

/** Phone GPS while it isn't trusted can't judge the route (it may be anywhere). */
const reliable = (p: PositionEstimate) => !(p.source === "gnss" && p.trust !== "TRUSTED");

/** A stop as given: a place, a pin, a search result; its key is made if it has none. */
export type StopInput = RouteDestination & { key?: string; category?: PlaceCategory; flags?: number; hours?: readonly number[] | null };

type JobName = "preview" | "back" | "along" | "estimates";

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
  /** How far along the last plan's route the car has been on it. */
  private followedM = 0;
  /** Why the last plan was made: a re-plan left unfollowed after another one is the driver's own way. */
  private lastReason: Reason | null = null;
  /** The driver's placing (`manual.placedAt`) last seen: another one is a new placing. */
  private seenPlacedAt: number | undefined = undefined;
  /** A placing not planned from yet (it came while a plan was on its way). */
  private placedPending = false;
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
  private others: { plan: RoutePlan; legs: RoutePlan[]; maneuvers: Maneuver[]; guidance: RouteGuidance }[] = [];
  /** The current plan's legs and the points they end at (its stops, then the destination). */
  private legs: RoutePlan[] = [];
  private points: TripPoint[] = [];
  /** One frame for all of a route's searches (they share the graph reader's projected geometry), and its origin. */
  private frame: LocalFrame | null = null;
  private frameOrigin: Coordinate | null = null;
  /** The current plan's stops reached or passed already, by key. */
  private handledStops = new Set<string>();
  /** The closest the car came to the next stop: one left behind off the route (STOPS-SPEC §5.3). */
  private closest: { key: string; m: number } | null = null;
  private stopCount = 0;
  /** Searches beside the route's own, each in its own slices: how to cancel the next, and whose it is. */
  private jobCancels: Partial<Record<JobName, () => void>> = {};
  private jobTokens: Partial<Record<JobName, object>> = {};
  /** The preview's legs, for taking it as the route without planning again. */
  private previewTrip: { key: string; legs: RoutePlan[]; points: TripPoint[]; from: RouteStart; stats: TripStatus["stats"]; wallMs: number } | null = null;
  /** The current plan as a line (places along it, detours), made once per plan. */
  private line: { planId: number; line: RouteLine } | null = null;

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

  /** Plan to `destination`, through `stops` on the way, from where the car is now and guide along it. */
  start(destination: RouteDestination, { resumed = false, stops = [] }: { resumed?: boolean; stops?: readonly StopInput[] } = {}): void {
    this.stop(false);
    const trip = stops.slice(0, MAX_STOPS).map((st) => this.keyed(st));
    this.save(destination, trip);
    this.note(
      `route ${resumed ? "resumed after an app restart, " : ""}to ${destination.lat.toFixed(5)},${destination.lon.toFixed(5)}` +
        (destination.name ? ` (${destination.name})` : "") +
        (trip.length ? ` via ${trip.map(stopLabel).join(", ")}` : ""),
    );
    this.set({ destination, stops: trip, status: "planning", planId: 0, planReason: "new", replanning: false });
    // A placing from before is where this route is planned from, not a reason to plan it again.
    this.seenPlacedAt = this.deps.position.getSnapshot()?.manual?.placedAt;
    this.placedPending = false;
    this.unsubscribe = this.deps.position.subscribe(this.onPosition);
    this.plan("new");
  }

  /**
   * After an app start: the route that was active when the app last ran (within 12 h), planned again from where
   * the car is once there is a position, through the stops it hadn't reached.
   */
  resume(): void {
    const saved = this.deps.store?.getJson<{ destination: RouteDestination; stops?: TripStop[]; savedAt: number }>(ACTIVE_KEY);
    if (!saved || this.snapshot || !(this.now() - saved.savedAt < RESUME_MAX_AGE_MS)) return;
    const go = () => this.start(saved.destination, { resumed: true, stops: saved.stops ?? [] });
    if (this.deps.position.getSnapshot()) {
      go();
      return;
    }
    const unsubscribe = this.deps.position.subscribe(() => {
      if (!this.deps.position.getSnapshot()) return;
      unsubscribe();
      if (!this.snapshot) go();
    });
  }

  stop(note = true): void {
    if (note) this.deps.store?.setJson(ACTIVE_KEY, null);
    if (!this.snapshot) return;
    if (note) this.note(`route stop${this.guidance?.step ? ` at ${km(this.guidance.step.alongM)} of ${km(this.guidance.plan.lengthM)}` : ""}`);
    this.planning?.cancel();
    this.planning = null;
    this.dropAlternatives(false);
    (["preview", "back", "along", "estimates"] as const).forEach((j) => this.cancelJob(j));
    this.arrivedTimer?.();
    this.arrivedTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.guidance = null;
    this.trip = null;
    this.notedState = null;
    this.legs = [];
    this.points = [];
    this.handledStops.clear();
    this.closest = null;
    this.previewTrip = null;
    this.line = null;
    this.frame = null;
    this.frameOrigin = null;
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

  // ── Stops (STOPS-SPEC §4–5) ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * A stop on the way: at `index` among the stops, else where it adds least (by its place along the route when it is
   * near it). Planned again from the car at once. False: there are `MAX_STOPS` already, or no route.
   */
  addStop(place: StopInput, index?: number): boolean {
    const s = this.snapshot;
    if (!s || s.stops.length >= MAX_STOPS) return false;
    const stop = this.keyed(place);
    const at = Math.max(0, Math.min(s.stops.length, index ?? this.stopIndexFor(stop)));
    const stops = [...s.stops];
    stops.splice(at, 0, stop);
    this.note(`route stop added: ${stopLabel(stop)}, ${at + 1} of ${stops.length}`);
    this.changeStops(stops);
    return true;
  }

  removeStop(key: string): void {
    const s = this.snapshot;
    const stop = s?.stops.find((x) => x.key === key);
    if (!s || !stop) return;
    this.note(`route stop removed: ${stopLabel(stop)}`);
    this.changeStops(s.stops.filter((x) => x !== stop));
  }

  /** Moves a stop `delta` places earlier (−) or later (+) among the stops. */
  moveStop(key: string, delta: number): void {
    const s = this.snapshot;
    const i = s?.stops.findIndex((x) => x.key === key) ?? -1;
    if (!s || i < 0) return;
    const j = Math.max(0, Math.min(s.stops.length - 1, i + delta));
    if (j === i) return;
    const stops = [...s.stops];
    const [stop] = stops.splice(i, 1);
    stops.splice(j, 0, stop);
    this.note(`route stop moved: ${stopLabel(stop)}, ${j + 1} of ${stops.length}`);
    this.changeStops(stops);
  }

  /** "Go on" at a stop: its card goes; guidance is already on the next leg. */
  goOn(): void {
    const s = this.snapshot;
    if (!s?.atStop) return;
    this.note(`route stop left: ${stopLabel(s.atStop.stop)}, next leg (go on)`);
    this.set({ ...s, atStop: undefined });
  }

  /** Back to the stop left behind: it is the next stop again, planned from the car. */
  backToPassed(): void {
    const s = this.snapshot;
    const passed = s?.passedStop;
    if (!s || !passed) return;
    this.cancelJob("back");
    this.note(`route stop back: ${stopLabel(passed.stop)}${passed.backDeltaS != null ? `, ${signedMin(passed.backDeltaS)}` : ""}`);
    const stops = [passed.stop, ...s.stops].slice(0, MAX_STOPS);
    this.save(s.destination, stops);
    this.set({ ...s, stops, passedStop: undefined });
    this.plan("stop-back");
  }

  dismissPassed(): void {
    const s = this.snapshot;
    if (!s?.passedStop) return;
    this.cancelJob("back");
    this.set({ ...s, passedStop: undefined });
  }

  /**
   * A place on the map before it becomes a stop (STOPS-SPEC §7.3): the trip through it, planned from where the car
   * is, in slices; the route is guided as before meanwhile.
   */
  previewStop(place: StopInput, index?: number): void {
    const s = this.snapshot;
    const position = this.deps.position.getSnapshot();
    const graph = this.graph;
    if (!s || s.status !== "active" || !position || !graph) return;
    const stop = this.keyed(place);
    const at = Math.max(0, Math.min(s.stops.length, index ?? this.stopIndexFor(stop)));
    const stops = [...s.stops];
    stops.splice(at, 0, stop);
    this.set({ ...s, preview: { place: stop, index: at, status: stops.length > MAX_STOPS ? "failed" : "planning" } });
    if (stops.length > MAX_STOPS) return;
    const points = pointsOf(stops, s.destination);
    const frame = this.frameAt(graph, position);
    const from = startOf(position);
    const search = new TripSearch(graph.graph, frame, from, points, { costs: { congestion: this.planCongestion } });
    const startedAt = this.now();
    this.runJob("preview", (budget) => {
      const r = search.run(budget);
      if (r.status === "more") return false;
      const cur = this.snapshot;
      if (!cur?.preview || cur.preview.place.key !== stop.key) return true;
      if (r.status === "failed") {
        this.set({ ...cur, preview: { ...cur.preview, status: "failed" } });
        return true;
      }
      const maneuvers = tripManeuvers(graph.graph, r.legs, r.plan);
      this.previewTrip = { key: stop.key, legs: r.legs, points, from, stats: r.stats, wallMs: this.now() - startedAt };
      const nowS = cur.guidance?.remainingS ?? cur.plan?.durationS ?? r.plan.durationS;
      this.set({ ...cur, preview: { ...cur.preview, status: "done", plan: r.plan, maneuvers, deltaS: r.plan.durationS - nowS } });
      return true;
    });
  }

  /** The preview becomes a stop: its trip is the route (no new plan when it is ready). */
  confirmPreview(): void {
    const s = this.snapshot;
    const pv = s?.preview;
    if (!s || !pv) return;
    this.cancelJob("preview");
    const trip = this.previewTrip;
    const graph = this.graph;
    const position = this.deps.position.getSnapshot();
    if (pv.status !== "done" || !pv.plan || !trip || trip.key !== pv.place.key || !graph || !this.frame || !position) {
      this.set({ ...s, preview: undefined });
      this.addStop(pv.place, pv.index);
      return;
    }
    const stops = [...s.stops];
    stops.splice(pv.index, 0, pv.place);
    this.note(`route stop added: ${stopLabel(pv.place)}, ${pv.index + 1} of ${stops.length}${pv.deltaS != null ? `, ${signedMin(pv.deltaS)}` : ""}`);
    this.save(s.destination, stops);
    this.set({ ...s, stops, preview: undefined });
    this.planning?.cancel();
    this.planning = null;
    this.dropAlternatives();
    const id = this.nextPlanId++;
    this.lastReason = "stops";
    this.lastPlanAt = this.now();
    this.offSincePlanAt = null;
    this.followedM = 0;
    const stats = { states: trip.stats.states, tiles: trip.stats.tilesRead, planMs: trip.stats.ms, wallMs: trip.wallMs, slices: 0 };
    this.adopt(id, "stops", pv.plan, trip.legs, trip.points, graph, this.frame, trip.from, position, stats, false);
    this.previewTrip = null;
  }

  cancelPreview(): void {
    const s = this.snapshot;
    this.cancelJob("preview");
    this.previewTrip = null;
    if (s?.preview) this.set({ ...s, preview: undefined });
  }

  /**
   * The places of `category` along the route ahead (STOPS-SPEC §6.3), then their detours one by one; `more`: the next
   * ones after those listed.
   */
  findAlong(category: PlaceCategory, more = false): void {
    const s = this.snapshot;
    const guidance = this.guidance;
    const graph = this.graph;
    if (!s) return;
    if (s.status !== "active" || !guidance || !graph || !this.frame) {
      this.set({ ...s, along: { category, status: "no-route", items: [], more: false } });
      return;
    }
    const places = this.deps.places?.();
    if (!places?.hasPlaces) {
      this.set({ ...s, along: { category, status: "no-places", items: [], more: false } });
      return;
    }
    const line = this.lineOf(s.planId, guidance.plan);
    const carM = guidance.step?.alongM ?? 0;
    const kept = more && s.along?.category === category ? s.along.items : [];
    // Further along than the last one listed.
    const fromM = kept.length ? Math.max(carM, kept[kept.length - 1].alongM + 1) : carM;
    const categories = new Set([category]);
    const t0 = this.now();
    const r = placesAlong(line, fromM, (box) => places.placesIn(box, categories), { count: ALONG_PAGE });
    const items = [...kept, ...r.hits.map((h) => ({ place: h.place, alongM: h.alongM, side: h.side }))];
    this.note(`along the way: ${category}, ${r.hits.length} places in ${km(Math.max(0, (r.hits.at(-1)?.alongM ?? fromM) - carM))} (${Math.round(this.now() - t0)} ms)`);
    this.set({ ...s, along: { category, status: r.hits.length ? "searching" : "done", items, more: r.more } });
    if (!r.hits.length) return;
    const jobs: DetourJob[] = r.hits.map((h) => ({ key: h.place.key, point: h.place, alongM: h.alongM }));
    const search = new DetourSearch(graph.graph, this.frame, line, carM, jobs, { costs: { congestion: this.planCongestion } });
    const detoursAt = this.now();
    this.runJob("along", (budget) => {
      const out = search.run(budget);
      const cur = this.snapshot;
      if (!cur?.along || cur.along.category !== category) return true;
      if (out.results.length || out.done) {
        const found = new Map(out.results.map((x) => [x.key, x.detourS]));
        const next = cur.along.items.flatMap((it): AlongItem[] => {
          if (!found.has(it.place.key)) return [it];
          const detourS = found.get(it.place.key);
          // Not reachable within the search's limit: left out.
          return detourS == null ? [] : [{ ...it, detourS }];
        });
        if (out.done) this.note(`along the way: ${jobs.length} detours in ${Math.round(this.now() - detoursAt)} ms`);
        this.set({ ...cur, along: { ...cur.along, items: next, status: out.done ? "done" : "searching" } });
      }
      return out.done;
    });
  }

  closeAlong(): void {
    const s = this.snapshot;
    this.cancelJob("along");
    if (s?.along) this.set({ ...s, along: undefined });
  }

  /** Each place's detour from the route (the add-a-stop search, STOPS-SPEC §7.1), one by one into `estimates`. */
  estimateDetours(places: readonly (Coordinate & { key: string })[]): void {
    const s = this.snapshot;
    const guidance = this.guidance;
    const graph = this.graph;
    if (!s || s.status !== "active" || !guidance || !graph || !this.frame) return;
    const line = this.lineOf(s.planId, guidance.plan);
    const carM = guidance.step?.alongM ?? 0;
    const jobs = places.map((p) => ({ key: p.key, point: { lat: p.lat, lon: p.lon }, alongM: line.project(p, carM, FAR_PROJECT_M)?.alongM ?? carM }));
    const estimates: Record<string, number | null> = {};
    this.set({ ...s, estimates: { ...estimates } });
    const search = new DetourSearch(graph.graph, this.frame, line, carM, jobs, {
      costs: { congestion: this.planCongestion },
      maxStates: FAR_DETOUR_MAX_STATES,
    });
    this.runJob("estimates", (budget) => {
      const out = search.run(budget);
      const cur = this.snapshot;
      if (!cur?.estimates) return true;
      for (const x of out.results) estimates[x.key] = x.detourS;
      if (out.results.length) this.set({ ...cur, estimates: { ...estimates } });
      return out.done;
    });
  }

  clearEstimates(): void {
    const s = this.snapshot;
    this.cancelJob("estimates");
    if (s?.estimates) this.set({ ...s, estimates: undefined });
  }

  /** `MAX_STOPS` (the route page offers no more). */
  get maxStops(): number {
    return MAX_STOPS;
  }

  private changeStops(stops: TripStop[]): void {
    const s = this.snapshot!;
    this.save(s.destination, stops);
    this.set({ ...s, stops, preview: undefined });
    this.plan("stops");
  }

  private keyed(st: StopInput): TripStop {
    return { ...st, key: st.key ?? `s${this.now().toString(36)}-${++this.stopCount}` };
  }

  /** Where a new stop goes: by its place along the route when it is near it, else where it adds least (§4). */
  private stopIndexFor(stop: Coordinate): number {
    const s = this.snapshot!;
    const guidance = this.guidance;
    if (guidance && s.status === "active") {
      const at = this.lineOf(s.planId, guidance.plan).project(stop, guidance.step?.alongM ?? 0, NEAR_ROUTE_M);
      if (at) {
        const planStops = guidance.plan.stops ?? [];
        return s.stops.filter((x) => (planStops.find((ps) => ps.key === x.key)?.atM ?? Infinity) < at.alongM).length;
      }
    }
    const from = this.deps.position.getSnapshot() ?? s.destination;
    return insertionIndex(from, s.stops, s.destination, stop);
  }

  private save(destination: RouteDestination, stops: TripStop[]): void {
    this.deps.store?.setJson(ACTIVE_KEY, { destination, stops, savedAt: this.now() });
  }

  private lineOf(planId: number, plan: RoutePlan): RouteLine {
    if (this.line?.planId !== planId) this.line = { planId, line: new RouteLine(plan) };
    return this.line.line;
  }

  /** Runs `step` in slices until it says it is done; another job of the same name cancels it. */
  private runJob(name: JobName, step: (budget: number) => boolean): void {
    this.cancelJob(name);
    const token = {};
    this.jobTokens[name] = token;
    const tick = () => {
      if (this.jobTokens[name] !== token) return;
      if (step(this.sliceStates)) {
        delete this.jobTokens[name];
        delete this.jobCancels[name];
        return;
      }
      this.jobCancels[name] = this.defer(tick, 0);
    };
    this.jobCancels[name] = this.defer(tick, 0);
  }

  private cancelJob(name: JobName): void {
    this.jobCancels[name]?.();
    delete this.jobCancels[name];
    delete this.jobTokens[name];
  }

  /**
   * The frame all of a route's searches share: the graph reader projects the geometry it decodes into one frame, so a
   * search in another would read it wrong. A new one only when the car is far from it, and the searches beside the
   * route's own stop then.
   */
  private frameAt(graph: RoutingGraph, near: Coordinate): LocalFrame {
    if (!this.frame || !this.frameOrigin || haversineM(this.frameOrigin, near) > FRAME_REACH_M) {
      (["preview", "back", "along", "estimates"] as const).forEach((j) => this.cancelJob(j));
      this.frame = new LocalFrame(near);
      this.frameOrigin = { lat: near.lat, lon: near.lon };
      graph.graph.setFrame(this.frame);
      const s = this.snapshot;
      if (s?.preview || s?.estimates) this.set({ ...s, preview: undefined, estimates: undefined });
    }
    return this.frame;
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

  /** Start a search from the published position, through the stops; it runs in slices until done. */
  private plan(reason: Reason): void {
    const s = this.snapshot;
    if (!s) return;
    const position = this.deps.position.getSnapshot();
    const graph = position ? this.openGraph() : null;
    const id = this.nextPlanId++;
    const outside = (c: Coordinate) => (graph?.graph.tileAt?.(c) ?? 0) < 0;
    const points = pointsOf(s.stops, s.destination);
    const problem: RouteProblem | null = !position
      ? "no-position"
      : !graph
        ? "no-road-graph"
        : points.some(outside) || outside(position)
          ? "outside-region"
          : s.stops.length > MAX_STOPS
            ? "too-many-stops"
            : null;
    if (problem || !position || !graph) {
      this.failed(id, reason, problem ?? "no-position", position, 0);
      return;
    }
    this.dropAlternatives();
    const frame = this.frameAt(graph, position);
    const from = startOf(position);
    const startedAt = this.now();
    // Rush hours at the time it leaves (ROUTING-SPEC §4.3): city main roads take longer, the route may go round them.
    this.planCongestion = congestionAt(new Date(startedAt));
    const search = new TripSearch(graph.graph, frame, from, points, { costs: { congestion: this.planCongestion } });
    let slices = 0;
    // Measured from when the last plan's route went off, not from this plan: the wait itself must not end the streak.
    const quick = this.offSincePlanAt !== null && this.offSincePlanAt - this.lastPlanAt < REPLAN_SETTLED_MS && this.followedM < REPLAN_FOLLOWED_M;
    this.replanStreak = reason === "off-route" && quick ? this.replanStreak + 1 : 0;
    // Leaving a re-planned route the car never followed, after leaving the route before it: the driver's own way.
    const ownWay = reason === "off-route" && this.lastReason === "off-route" && this.followedM < REPLAN_FOLLOWED_M;
    this.lastReason = reason;
    this.lastPlanAt = startedAt;
    this.offSincePlanAt = null;
    this.followedM = 0;
    if (reason === "off-route" || reason === "placed" || reason === "stops" || reason === "stop-back") {
      this.set({ ...this.snapshot!, replanning: true });
    }
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
        const cur = this.snapshot!;
        const failedStop = r.leg < points.length - 1 ? points[r.leg].key : undefined;
        this.failed(id, reason, r.reason, position, wallMs, { states: r.stats.states, tiles: r.stats.tilesRead, planMs: r.stats.ms, slices }, failedStop);
        if (failedStop) this.note(`route plan #${id} failed on the way to ${stopLabel(cur.stops.find((x) => x.key === failedStop) ?? cur.destination)}`);
        graph.graph.trim?.(ROUTER_IDLE_TILES);
        return;
      }
      const stats = { states: r.stats.states, tiles: r.stats.tilesRead, planMs: r.stats.ms, wallMs, slices, fellBackAt: r.stats.fellBackAt };
      this.adopt(id, reason, r.plan, r.legs, points, graph, frame, from, position, stats, ownWay);
    };
    this.planning = { id, cancel: this.defer(step, 0) };
  }

  /** A plan made (or a preview taken) becomes the route: guided, published, logged; alternatives after a new one. */
  private adopt(
    id: number,
    reason: Reason,
    plan: RoutePlan,
    legs: RoutePlan[],
    points: TripPoint[],
    graph: RoutingGraph,
    frame: LocalFrame,
    from: RouteStart,
    position: PositionEstimate,
    stats: { states: number; tiles: number; planMs: number; wallMs: number; slices: number; fellBackAt?: number },
    ownWay: boolean,
  ): void {
    const maneuvers = tripManeuvers(graph.graph, legs, plan);
    // A re-plan starts where the car drives: it is on the new route, not on its way to it from a car park. So does a
    // change of stops made while the car was on the route.
    const wasOn = this.guidance?.step?.state === "on";
    const joined = reason === "off-route" || reason === "placed" || reason === "stop-back" || (reason === "stops" && wasOn);
    this.guidance = new RouteGuidance(plan, maneuvers, {}, { joined });
    this.legs = legs;
    this.points = points;
    this.handledStops.clear();
    this.closest = null;
    this.notedState = null;
    this.trip ??= { startedAt: this.now(), plannedS: plan.durationS, plannedM: plan.lengthM, drivenM: 0, lastAt: null };
    const cur = this.snapshot!;
    this.set({
      ...cur,
      status: "active",
      failure: undefined,
      failedStop: undefined,
      replanFailure: undefined,
      planId: id,
      planReason: reason,
      plan,
      maneuvers,
      guidance: undefined,
      replanning: false,
      ownWay,
    });
    this.logPlan(id, reason, plan, maneuvers, stats, position);
    if (ownWay && !cur.ownWay) this.note("route not followed again: guidance shown, not spoken");
    this.deps.onRoute?.(plan, this.graph?.key);
    this.onPosition();
    // The route is on its way; alternatives only now, in slices of their own.
    if (reason === "new") this.searchAlternatives(id, graph, frame, from, legs[0], points[0]);
    else graph.graph.trim?.(ROUTER_IDLE_TILES);
    // The places listed were along the old route: listed again along this one.
    const along = this.snapshot?.along;
    if (along && along.status !== "no-places") this.findAlong(along.category);
  }

  /**
   * Alternatives to a new route (ROUTING-SPEC §8.7), searched in slices after it: for the leg to the next point only,
   * the rest of the trip shared (STOPS-SPEC §4). A faster one takes over while the car hasn't left the start (the main
   * search's weighted heuristic can miss the fastest route).
   */
  private searchAlternatives(id: number, graph: RoutingGraph, frame: LocalFrame, from: RouteStart, main: RoutePlan, to: Coordinate): void {
    const search = new AlternativeSearch(graph.graph, frame, from, to, main, { costs: { congestion: this.planCongestion } });
    const startedAt = this.now();
    const step = () => {
      if (this.altSearch?.id !== id) return;
      const r = search.run(this.sliceStates);
      if (r.status === "more") {
        this.altSearch = { id, cancel: this.defer(step, 0) };
        return;
      }
      this.altSearch = null;
      this.settleAlternatives(id, graph, r, startedAt);
      graph.graph.trim?.(ROUTER_IDLE_TILES);
    };
    this.altSearch = { id, cancel: this.defer(step, 0) };
  }

  /** The alternatives found: kept, the fastest taken while the car hasn't left the start, or published. */
  private settleAlternatives(
    id: number,
    graph: RoutingGraph,
    r: { alternatives: RoutePlan[]; stats: { searches: number; states: number; ms: number } },
    startedAt: number,
  ): void {
    const cur = this.snapshot;
    if (!cur || cur.planId !== id || !cur.plan) return;
    const main = cur.plan;
    this.others = r.alternatives.map((first) => {
      const legs = [first, ...this.legs.slice(1)];
      const plan = joinPlans(legs, this.points);
      const maneuvers = tripManeuvers(graph.graph, legs, plan);
      return { plan, legs, maneuvers, guidance: new RouteGuidance(plan, maneuvers) };
    });
    const mainEdges = edgeSet(main);
    this.note(
      `route alternatives: ${this.others.length}` +
        this.others.map(({ plan: a }) => ` (${signedMin(a.durationS - main.durationS)}, ${km(a.lengthM)}, ${Math.round((sharedM(graph.graph, a, mainEdges) / a.lengthM) * 100)} % shared)`).join("") +
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
    this.others = [{ plan: s.plan, legs: this.legs, maneuvers: s.maneuvers, guidance: current }, ...this.others.filter((_, i) => i !== index)];
    this.guidance = next.guidance;
    this.legs = next.legs;
    this.notedState = null;
    if (this.trip) {
      this.trip.plannedS = next.plan.durationS;
      this.trip.plannedM = next.plan.lengthM;
    }
    this.note(`route alternative taken (${why}): ${km(next.plan.lengthM)}, ${Math.round(next.plan.durationS / 60)} min, was ${Math.round(s.plan.durationS / 60)} min`);
    this.set({ ...s, planId: id, planReason: "alternative", plan: next.plan, maneuvers: next.maneuvers, guidance: next.guidance.step ?? undefined, replanning: false, replanFailure: undefined });
    this.logPlan(id, "alternative", next.plan, next.maneuvers, null, this.deps.position.getSnapshot() ?? undefined);
    this.publishAlternatives();
    this.deps.onRoute?.(next.plan, this.graph?.key);
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
    failedStop?: string,
  ): void {
    const s = this.snapshot!;
    this.planCount++;
    this.lastStats = { id, reason, outcome: problem, lengthM: null, states: stats.states, tiles: stats.tiles, planMs: stats.planMs, wallMs, slices: stats.slices };
    this.note(`route plan #${id} (${reason}) failed: ${problem}${stats.states ? `, ${stats.states} states, ${Math.round(stats.planMs)} ms` : ""}`);
    const code = problem === "no-road-graph" || problem === "no-position" || problem === "outside-region" || problem === "too-many-stops" ? "cancelled" : problem;
    this.deps.log?.route({
      timestampUs: this.deps.nowUs(),
      planId: id,
      reason,
      status: code,
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
    else this.set({ ...s, status: "failed", failure: problem, failedStop, planId: id, replanning: false });
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
      const stopCount = plan.stops?.length ?? 0;
      this.note(
        `route plan #${id} (${reason}): ${km(plan.lengthM)}, ${Math.round(plan.durationS / 60)} min, ${maneuvers.length - 2 - stopCount} maneuvers` +
          (stopCount ? `, ${stopCount} stops` : "") +
          `; ${stats.states} states, ${stats.tiles} tiles, ${Math.round(stats.planMs)} ms in ${stats.slices} slices (${Math.round(stats.wallMs)} ms wall)` +
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
    (plan.stops ?? []).forEach((ps, index) => {
      const stop = s.stops.find((x) => x.key === ps.key);
      log.stop?.({
        timestampUs: t,
        planId: id,
        index,
        latDeg: ps.point.lat,
        lonDeg: ps.point.lon,
        atM: ps.atM,
        atS: ps.atS,
        side: ps.side ?? "none",
        category: stop?.category ?? "none",
      });
    });
  }

  private onPosition = (): void => {
    const s = this.snapshot;
    const guidance = this.guidance;
    const p = this.deps.position.getSnapshot();
    const placedAt = p?.manual?.placedAt;
    if (placedAt !== undefined && placedAt !== this.seenPlacedAt) {
      this.seenPlacedAt = placedAt;
      this.placedPending = true;
    }
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
    if (step.state === "on" && !this.planning) this.followedM = Math.max(this.followedM, step.alongM);
    // Following the route now: it is spoken again.
    const ownWay = s.ownWay && this.followedM < REPLAN_FOLLOWED_M;
    if (s.ownWay && !ownWay) this.note("route followed: guidance spoken again");
    const stopPatch = this.trackStops(step, p);
    this.set({ ...this.snapshot!, ...stopPatch, guidance: step, ownWay, ...(this.others.length ? {} : { alternatives: undefined }) });
    if (step.state === "off" && !this.planning) this.offSincePlanAt ??= this.now();
    // The driver just put the car on the map, off this route: plan from there now, whatever the wait or map matching
    // says (2026-10-13: placed 501 m from the dot on a lot, the route stayed "unsure, 378 m off" for 7 minutes).
    const placed = this.placedPending && !this.planning;
    if (placed) this.placedPending = false;
    if (placed && step.state !== "on" && step.state !== "arrived") this.plan("placed");
    else if (step.state === "off" && !this.planning && this.mayReplan(p) && !this.holdAtStop(p)) {
      this.passIfBehind(p);
      this.plan("off-route");
    }
    if (step.state === "arrived" && !this.arrivedTimer) {
      this.dropAlternatives();
      this.arrivedTimer = this.defer(() => this.stop(), ARRIVED_LINGER_MS);
    }
  };

  /**
   * The trip's stops as the car drives (STOPS-SPEC §5): reached (it waits there), passed on the route (offered back),
   * left (the next leg), the card of one passed gone after a while; the closest the car came to the next one.
   */
  private trackStops(step: GuidanceStep, p: PositionEstimate): Partial<RouteSnapshot> {
    const s = this.snapshot!;
    const plan = this.guidance!.plan;
    const patch: Partial<RouteSnapshot> = {};
    let stops = s.stops;
    for (const i of step.reachedStops ?? []) {
      const ps = plan.stops![i];
      if (this.handledStops.has(ps.key)) continue;
      this.handledStops.add(ps.key);
      const stop = stops.find((x) => x.key === ps.key);
      if (!stop) continue;
      stops = stops.filter((x) => x !== stop);
      patch.atStop = { stop, atM: ps.atM };
      this.note(`route stop reached: ${stopLabel(stop)} at ${km(step.alongM)}`);
    }
    for (const i of step.passedStops ?? []) {
      const ps = plan.stops![i];
      if (this.handledStops.has(ps.key)) continue;
      this.handledStops.add(ps.key);
      const stop = stops.find((x) => x.key === ps.key);
      if (!stop) continue;
      stops = stops.filter((x) => x !== stop);
      patch.passedStop = { stop, atDrivenM: this.trip?.drivenM ?? 0 };
      this.note(`route stop passed: ${stopLabel(stop)} at ${km(step.alongM)}`);
      this.defer(() => this.searchBack(stop), 0);
    }
    const atStop = "atStop" in patch ? patch.atStop : s.atStop;
    if (atStop && !("atStop" in patch) && step.state === "on" && step.alongM >= atStop.atM + REPLAN_FOLLOWED_M) {
      patch.atStop = undefined;
      this.note(`route stop left: ${stopLabel(atStop.stop)}, next leg`);
    }
    const passed = "passedStop" in patch ? patch.passedStop : s.passedStop;
    if (passed && !("passedStop" in patch) && this.trip && this.trip.drivenM - passed.atDrivenM > PASSED_CARD_M) {
      patch.passedStop = undefined;
      this.cancelJob("back");
    }
    const next = stops[0];
    if (!next) this.closest = null;
    else {
      const d = haversineM(p, next);
      if (this.closest?.key !== next.key) this.closest = { key: next.key, m: d };
      else this.closest.m = Math.min(this.closest.m, d);
    }
    if (stops !== s.stops) {
      patch.stops = stops;
      this.save(s.destination, stops);
    }
    return patch;
  }

  /**
   * At a stop the route waits (STOPS-SPEC §5.2): no re-plan near it or while the car stands. Leaving it another way
   * ends the wait, and the rest of the trip is planned from there.
   */
  private holdAtStop(p: PositionEstimate): boolean {
    const s = this.snapshot!;
    const at = s.atStop;
    if (!at) return false;
    if (haversineM(p, at.stop) < STOP_HOLD_M || (p.speedMps ?? 0) < STOP_STANDING_MPS) return true;
    this.note(`route stop left: ${stopLabel(at.stop)}, off the route`);
    this.set({ ...s, atStop: undefined });
    return false;
  }

  /**
   * Leaving the route after coming near the next stop and driving away from it: it is behind (STOPS-SPEC §5.3). It is
   * left out of the new plan and offered back, never planned back to by surprise.
   */
  private passIfBehind(p: PositionEstimate): void {
    const s = this.snapshot!;
    const next = s.stops[0];
    const c = this.closest;
    if (!next || c?.key !== next.key || c.m > PASS_NEAR_M) return;
    if (haversineM(p, next) < c.m + PASS_AWAY_M) return;
    this.handledStops.add(next.key);
    const stops = s.stops.slice(1);
    this.note(`route stop passed: ${stopLabel(next)}, ${Math.round(c.m)} m from it at the closest`);
    this.save(s.destination, stops);
    this.set({ ...s, stops, passedStop: { stop: next, atDrivenM: this.trip?.drivenM ?? 0 } });
    this.closest = null;
    this.defer(() => this.searchBack(next), 0);
  }

  /** How much longer going back through a stop left behind takes than going on: the card's "+n min". */
  private searchBack(stop: TripStop): void {
    const s = this.snapshot;
    const position = this.deps.position.getSnapshot();
    const graph = this.graph;
    if (!s?.passedStop || s.passedStop.stop.key !== stop.key || !position || !graph) return;
    const frame = this.frameAt(graph, position);
    const search = new TripSearch(graph.graph, frame, startOf(position), pointsOf([stop, ...s.stops], s.destination), {
      costs: { congestion: this.planCongestion },
    });
    this.runJob("back", (budget) => {
      const r = search.run(budget);
      if (r.status === "more") return false;
      const cur = this.snapshot;
      if (!cur?.passedStop || cur.passedStop.stop.key !== stop.key) return true;
      // Against the route on (once it is planned without the stop).
      const onS = cur.guidance?.remainingS ?? cur.plan?.durationS ?? 0;
      const backDeltaS = r.status === "done" ? Math.max(0, r.plan.durationS - onS) : null;
      this.set({ ...cur, passedStop: { ...cur.passedStop, backDeltaS } });
      return true;
    });
  }

  /**
   * Is leaving the route worth a new one? Only when the position is fit to say the car left it.
   *
   * While map matching is `offroad` the filter itself says the dot is not on any road, so "off route" means "I
   * lost the car", not "the car turned" — and a plan from a dot beside the road starts off it and goes off again
   * at once. On 2026-10-06, 16 km into a jammed drive, a 95° turn the route itself asked for landed 62 m short of
   * the junction, the filter went off-road, and four plans went out in 31 s while it recovered on its own.
   */
  private mayReplan(p: PositionEstimate): boolean {
    // Unless the driver vouched for the dot lately (`DRIVER_WORD_M`, the navigator's), or the car stands where it parked
    // off the roads: map matching `offroad` there is a car on a lot, not a lost dot.
    const vouched = p.parkedOffRoad === true || (p.sinceDriverM !== undefined && p.sinceDriverM < DRIVER_WORD_M);
    if (p.mapMatch === "offroad" && !vouched) return false;
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

/** A stop this close to the route is placed among the stops by where it is along it. */
const NEAR_ROUTE_M = 1000;
/** A search result is measured against the route this far from it. */
const FAR_PROJECT_M = 20_000;

/** The trip's points for a search: its stops, then the destination. */
function pointsOf(stops: readonly TripStop[], destination: RouteDestination): TripPoint[] {
  return [...stops.map((x) => ({ key: x.key, lat: x.lat, lon: x.lon })), { key: "destination", lat: destination.lat, lon: destination.lon }];
}

/** A stop in notes: its name or what it is, and where. */
const stopLabel = (x: RouteDestination & { category?: string }) =>
  `${x.name ?? x.category ?? "point"} (${x.lat.toFixed(5)},${x.lon.toFixed(5)})`;

const km = (m: number) => `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
const signedMin = (s: number) => `${s < 0 ? "−" : "+"}${Math.round(Math.abs(s) / 60)} min`;

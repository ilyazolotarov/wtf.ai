// Which position the map draws as the car (MAPMATCH-SPEC §6.2, §11): the one rule NavigatorService.publish and the
// replay tools (drive-report.ts) share, so a replay's dot can't drift from the app's.

import type { Coordinate } from "../geo";
import type { MapMatchState } from "../mapmatch/particle-filter";
import type { MapMatchEstimate, NavEstimate } from "../navigator";

/** A satellite fix accepted this recently: the EKF is within metres of GPS and is the dot ("fused", not "dr"). */
export const FUSED_WINDOW_US = 3_000_000;
/** Map-match states in which the dominant hypothesis is the dot while dead-reckoning. */
export const MAP_MATCH_PUCK: ReadonlySet<MapMatchState> = new Set(["tracking", "multimodal", "offroad"]);
/**
 * From this speed an off-road top hypothesis is drawn on the road it could be on (`road`, MAPMATCH-SPEC §11): off
 * the roads the car only parks, and no parking manoeuvre is driven at 15 km/h.
 */
export const DRAW_ON_ROAD_MPS = 15 / 3.6;
/** The dot's radius from a hypothesis' spread is at least this (a tight cluster isn't a perfect one). */
export const MAP_MATCH_MIN_ACCURACY_M = 5;
/**
 * The route as a cue to which way the car goes (MAPMATCH-SPEC §11): a hypothesis on the route's first `ROUTE_CUE_M`
 * (within `ROUTE_CUE_NEAR_M` of it) travelling against it counts this many times less when choosing the dot. Only the
 * choice: the filter's weights never see the route (in them it thinned the hypotheses into wrong map starts, 2026-10-14).
 */
export const ROUTE_CUE_FACTOR = 4;
const ROUTE_CUE_M = 1_000;
const ROUTE_CUE_NEAR_M = 30;
/**
 * The route's first segment also counts this far back from where it starts: the route begins where the car stood,
 * and a hypothesis that set off the other way is behind that point, off the route (2026-10-14: the dot still drove
 * south 66 m behind a route north, until the filter itself turned it round with a 237 m jump).
 */
const ROUTE_CUE_BACK_M = 300;

/**
 * The dominant map-matching hypothesis when it places the car (undefined: the navigator's own position is the dot):
 * while dead-reckoning, and while anchored (heading unknown) once the filter has found a road (it left `init`). The
 * anchor is the latest Wi-Fi/cell fix: under jamming hundreds of metres off, and standing still while the car drives.
 * On 2026-10-06 from a cold start the filter held the road within 10 m for minutes while that dot drifted 3 km away.
 * Not while standing where it was parked off the roads (`parkedOffRoad`): the off-road particles spread over the
 * pose's σ in clusters lighter than a road's within it, and the dot is the spot it parked in.
 */
export function puckHypothesis(
  estimate: NavEstimate,
  deadReckoning: boolean,
  route: readonly Coordinate[] | null = null,
): MapMatchEstimate["clusters"][number] | undefined {
  const mm = estimate.mapMatch;
  if (!(deadReckoning || estimate.mode === "anchored") || !mm || !MAP_MATCH_PUCK.has(mm.state) || estimate.parkedOffRoad) return undefined;
  const top = route?.length ? routeChoice(mm.clusters, route) : mm.clusters[0];
  // The filter keeps its off-road hypothesis (it is how it finds the road again), but a car at speed is drawn on a road.
  if (top?.road && mm.state === "offroad" && (estimate.speedMps ?? 0) >= DRAW_ON_ROAD_MPS) {
    return { ...top, lat: top.road.lat, lon: top.road.lon, headingRad: top.road.headingRad };
  }
  return top;
}

/**
 * The dot's ~68 % radius: the hypothesis' spread, else the EKF's — but never smaller than how far the Wi-Fi/cell
 * fixes put the car when they agree it is nowhere near this track (`Navigator.positionDoubtM`). Both of the first
 * two are the filter's own spread, which stays a few metres however wrong the dot is: on 2026-10-06 the dot sat
 * 10 km out at ±5 m for 12 min, which read as certainty and hid the control that would have fixed it.
 */
export function puckAccuracyM(estimate: NavEstimate, hypothesis: MapMatchEstimate["clusters"][number] | undefined): number {
  const spread = hypothesis ? Math.max(hypothesis.spreadM, MAP_MATCH_MIN_ACCURACY_M) : estimate.accuracyM;
  return Math.max(spread, estimate.doubtM ?? 0);
}

/**
 * The heaviest cluster once those travelling against the route's start count `ROUTE_CUE_FACTOR` times less: on a
 * straight road under jamming, with no course, turn or parked pose, both directions were near even and the dot set
 * off whichever way the particles leaned (2026-10-14, the emulator drove the car backwards).
 */
function routeChoice(clusters: MapMatchEstimate["clusters"], route: readonly Coordinate[]): MapMatchEstimate["clusters"][number] | undefined {
  let best = clusters[0];
  let bestScore = -1;
  for (const c of clusters) {
    const along = routeBearingNear(route, c);
    const against = along !== null && Math.abs(Math.atan2(Math.sin(c.headingRad - along), Math.cos(c.headingRad - along))) > Math.PI / 2;
    const score = against ? c.weight / ROUTE_CUE_FACTOR : c.weight;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** The route's bearing (clockwise from north) at its nearest point to `p` within its first `ROUTE_CUE_M`, if that is near. */
function routeBearingNear(route: readonly Coordinate[], p: Coordinate): number | null {
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const local = (c: Coordinate) => [(c.lon - p.lon) * kx, (c.lat - p.lat) * 111_320] as const;
  // The start, moved back along the first segment: that stretch behind the route counts as the route.
  const [sx, sy] = local(route[0]);
  const [nx, ny] = route.length > 1 ? local(route[1]) : [sx, sy];
  const firstLen = Math.hypot(nx - sx, ny - sy);
  const back = firstLen > 0 ? ([sx - ((nx - sx) / firstLen) * ROUTE_CUE_BACK_M, sy - ((ny - sy) / firstLen) * ROUTE_CUE_BACK_M] as const) : null;
  const points = back ? [back, ...route.map(local)] : route.map(local);
  let travelled = -(back ? ROUTE_CUE_BACK_M : 0);
  let best: { d: number; bearing: number } | null = null;
  for (let i = 1; i < points.length && travelled < ROUTE_CUE_M; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    travelled += Math.sqrt(len2);
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d <= ROUTE_CUE_NEAR_M && (!best || d < best.d)) best = { d, bearing: Math.atan2(dx, dy) };
  }
  return best?.bearing ?? null;
}

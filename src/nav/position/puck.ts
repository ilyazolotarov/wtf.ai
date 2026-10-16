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
/**
 * The dot stays with the hypothesis it was drawn on while that one keeps this share of the leader's weight: on a
 * near-even contest the leader changed hands every second or two, and the dot jumped 14–39 m between them, through
 * the buildings (2026-10-15, a car pulling out of a parking area beside a parallel lane).
 */
export const KEEP_SHARE = 0.5;
/**
 * The hypothesis it was drawn on: the one nearest where the last dot has driven to since (at the car's speed, on its
 * heading), within this. Not nearest the last dot itself: at 126 km/h a hypothesis 18 m behind on the same road is
 * there half a second later, and the dot stalled and jumped back and forth between the two (2026-10-06 replayed).
 */
const KEEP_REACH_M = 15;
/** The dot drawn last (`puckHypothesis` returned it at `tUs`), for its continuity. */
export interface LastPuck {
  lat: number;
  lon: number;
  headingRad: number;
  tUs: number;
}

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
 * The car's own heading as a cue (MAPMATCH-SPEC §11): a hypothesis travelling more than `HEADING_CUE_RAD` off the
 * navigator's heading counts this many times less when choosing the dot. Through a turn the filter compares the car's
 * turn with the road's only once the car drives straight again, so mid-turn at a T-junction the particles that turned
 * left and those that turned right weigh about the same; they are on the same cross street, travelling opposite ways,
 * and the dot drew whichever led: for 1–2.5 s it ran the wrong way down the street (emulated and simulated drives,
 * 2026-10-16). The gyro knows which way the car turned. Only the choice, as with the route.
 */
export const HEADING_CUE_FACTOR = 8;
const HEADING_CUE_RAD = Math.PI / 2;
/** Replay tools only: the cues for an experiment (factor 1 switches one off). The app never changes them. */
export const puckTuning = {
  headingCueFactor: HEADING_CUE_FACTOR,
  headingCueRad: HEADING_CUE_RAD,
  routeCueFactor: ROUTE_CUE_FACTOR,
  /** `steadyDot`: on, how fast the dot may step back along its road and catch up ahead (m/s), beyond which it jumps (m). */
  steady: true,
  steadyBackMps: 1,
  steadyCatchMps: 8,
  steadyMaxM: 80,
  /**
   * …and never held farther than this from the hypothesis along its road: on a bend the road leaves the straight
   * line it is held along (unlimited, the dot was off the roads at speed 16 → 30 s over the corpus).
   */
  steadyHoldM: 15,
  /**
   * Across its road, onto another road, round a turn (within `steadyMaxM`) and back within `steadyHoldM` of the
   * hypothesis along its road, the dot glides there at most this fast
   * (m/s) instead of jumping: the filter's corrections come as the car turns or a rival takes the lead, 30–80 m at
   * once, and the map eased each over a quarter of a second, a jump to the eye. 0: at once.
   */
  slideMps: 25,
};

/** The dot drawn last after `steadyDot` (before extrapolation), for the next one. */
export interface DrawnDot {
  lat: number;
  lon: number;
  headingRad: number;
  tUs: number;
}

/**
 * Where to draw a hypothesis that continues the last dot's road: the last dot carried on at the car's speed, then
 * moved toward the hypothesis across the road at up to `slideMps` but along it at most `steadyBackMps` back and
 * `steadyCatchMps` ahead. The hypothesis' position along a road wanders with the filter's resampling (a second's worth
 * of metres back and forth), which the driver sees as the dot jumping and stepping back. Another direction: straight
 * toward the hypothesis at up to `slideMps`. A gap past `steadyMaxM`: the hypothesis itself.
 */
export function steadyDot(target: { lat: number; lon: number; headingRad: number }, last: DrawnDot | null, speedMps: number | undefined, tUs: number): { lat: number; lon: number } {
  const t = puckTuning;
  if (!t.steady || !last) return target;
  const dtS = (tUs - last.tUs) / 1e6;
  if (!(dtS > 0 && dtS <= 2)) return target;
  const turned = angle(target.headingRad, last.headingRad) > Math.PI / 4;
  if (turned && !(t.slideMps > 0)) return target;
  const kx = 111_320 * Math.cos((last.lat * Math.PI) / 180);
  const ue = Math.sin(target.headingRad);
  const un = Math.cos(target.headingRad);
  // Where the last dot has driven to, and the hypothesis from there: along the road and across it.
  const moved = Math.max(0, speedMps ?? 0) * dtS;
  const pe = moved * Math.sin(last.headingRad);
  const pn = moved * Math.cos(last.headingRad);
  const de = (target.lon - last.lon) * kx - pe;
  const dn = (target.lat - last.lat) * 111_320 - pn;
  const gapM = Math.hypot(de, dn);
  if (gapM > t.steadyMaxM) return target;
  const slideM = t.slideMps * dtS;
  if (turned) {
    // Round a turn: straight toward the hypothesis, no faster than the slide.
    const f = gapM > slideM ? slideM / gapM : 1;
    return { lat: last.lat + (pn + f * dn) / 111_320, lon: last.lon + (pe + f * de) / kx };
  }
  const along = de * ue + dn * un;
  const limited = Math.max(-t.steadyBackMps * dtS, Math.min(t.steadyCatchMps * dtS, along));
  // Held within `steadyHoldM` of the hypothesis along the road, gliding there too.
  const held = Math.max(along - t.steadyHoldM, Math.min(along + t.steadyHoldM, limited));
  const kept = slideM > 0 ? limited + Math.max(-slideM, Math.min(slideM, held - limited)) : held;
  // Across the road at once, or no faster than the slide.
  const acrossE = de - along * ue;
  const acrossN = dn - along * un;
  const acrossM = Math.hypot(acrossE, acrossN);
  const g = slideM > 0 && acrossM > slideM ? slideM / acrossM : 1;
  const e = pe + kept * ue + g * acrossE;
  const n = pn + kept * un + g * acrossN;
  return { lat: last.lat + n / 111_320, lon: last.lon + e / kx };
}
/** The navigator's heading counts as a cue only while it is this sure. */
const HEADING_CUE_SIGMA_RAD = (30 * Math.PI) / 180;

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
  last: LastPuck | null = null,
): MapMatchEstimate["clusters"][number] | undefined {
  const mm = estimate.mapMatch;
  if (!(deadReckoning || estimate.mode === "anchored") || !mm || !MAP_MATCH_PUCK.has(mm.state) || estimate.parkedOffRoad) return undefined;
  const score = cueScore(estimate, route);
  const leader = mm.clusters.reduce<MapMatchEstimate["clusters"][number] | undefined>((best, c) => (!best || score(c) > score(best) ? c : best), undefined);
  const top = leader && last ? (kept(mm.clusters, leader, last, estimate, score) ?? leader) : leader;
  // The filter keeps its off-road hypothesis (it is how it finds the road again), but a car at speed is drawn on a road.
  // Whenever the hypothesis is off-road, not only in state `offroad` (off-road weight over half): that flickered on
  // and off around half, and the dot jumped 20–30 m between the hypothesis and its road (2026-10-15).
  if (top?.road && (estimate.speedMps ?? 0) >= DRAW_ON_ROAD_MPS) {
    return { ...top, lat: top.road.lat, lon: top.road.lon, headingRad: top.road.headingRad };
  }
  return top;
}

/** The hypothesis the dot was drawn on, while it keeps `KEEP_SHARE` of the leader's weight; null: none. */
function kept(
  clusters: MapMatchEstimate["clusters"],
  leader: MapMatchEstimate["clusters"][number],
  last: LastPuck,
  estimate: NavEstimate,
  score: (c: MapMatchEstimate["clusters"][number]) => number,
): MapMatchEstimate["clusters"][number] | null {
  const dtS = Math.max(0, Math.min(2, (estimate.tUs - last.tUs) / 1e6));
  const movedM = Math.abs(estimate.speedMps ?? 0) * dtS;
  const kx = 111_320 * Math.cos((last.lat * Math.PI) / 180);
  // Where the last dot has driven to, metres east and north of it.
  const toE = movedM * Math.sin(last.headingRad);
  const toN = movedM * Math.cos(last.headingRad);
  let best: MapMatchEstimate["clusters"][number] | null = null;
  let bestM = Infinity;
  for (const c of clusters) {
    // An off-road one may have been drawn on its road (`DRAW_ON_ROAD_MPS`): either place is where it was.
    const at = [c, ...(c.road ? [c.road] : [])];
    const d = Math.min(...at.map((p) => Math.hypot((p.lon - last.lon) * kx - toE, (p.lat - last.lat) * 111_320 - toN)));
    if (d < bestM) {
      best = c;
      bestM = d;
    }
  }
  return best && best !== leader && bestM <= KEEP_REACH_M && score(best) >= KEEP_SHARE * score(leader) ? best : null;
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

const angle = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/**
 * A hypothesis' weight for choosing the dot: `ROUTE_CUE_FACTOR` times less travelling against the route's start (on a
 * straight road under jamming, with no course, turn or parked pose, both directions were near even and the dot set off
 * whichever way the particles leaned: 2026-10-14, the emulator drove the car backwards), and `HEADING_CUE_FACTOR`
 * times less travelling against the navigator's heading.
 */
function cueScore(estimate: NavEstimate, route: readonly Coordinate[] | null) {
  const heading = estimate.headingRad;
  const headingCue = heading !== undefined && Number.isFinite(heading) && (estimate.headingSigmaRad ?? Infinity) <= HEADING_CUE_SIGMA_RAD;
  return (c: MapMatchEstimate["clusters"][number]): number => {
    let score = c.weight;
    if (route?.length) {
      const along = routeBearingNear(route, c);
      if (along !== null && angle(c.headingRad, along) > Math.PI / 2) score /= puckTuning.routeCueFactor;
    }
    if (headingCue && angle(c.headingRad, heading) > puckTuning.headingCueRad) score /= puckTuning.headingCueFactor;
    return score;
  };
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

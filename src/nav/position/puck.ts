// Which position the map draws as the car (MAPMATCH-SPEC §6.2, §11): the one rule NavigatorService.publish and the
// replay tools (drive-report.ts) share, so a replay's dot can't drift from the app's.

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

/** While dead-reckoning: the dominant map-matching hypothesis when it places the car (undefined: the EKF is the dot). */
export function puckHypothesis(estimate: NavEstimate, deadReckoning: boolean): MapMatchEstimate["clusters"][number] | undefined {
  const mm = estimate.mapMatch;
  if (!deadReckoning || !mm || !MAP_MATCH_PUCK.has(mm.state)) return undefined;
  const top = mm.clusters[0];
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

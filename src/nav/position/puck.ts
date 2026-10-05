// Which position the map draws as the car (MAPMATCH-SPEC §6.2, §11): the one rule NavigatorService.publish and the
// replay tools (drive-report.ts) share, so a replay's dot can't drift from the app's.

import type { MapMatchState } from "../mapmatch/particle-filter";
import type { MapMatchEstimate, NavEstimate } from "../navigator";

/** A satellite fix accepted this recently: the EKF is within metres of GPS and is the dot ("fused", not "dr"). */
export const FUSED_WINDOW_US = 3_000_000;
/** Map-match states in which the dominant hypothesis is the dot while dead-reckoning. */
const MAP_MATCH_PUCK: ReadonlySet<MapMatchState> = new Set(["tracking", "multimodal", "offroad"]);
/** The dot's radius from a hypothesis' spread is at least this (a tight cluster isn't a perfect one). */
export const MAP_MATCH_MIN_ACCURACY_M = 5;

/** While dead-reckoning: the dominant map-matching hypothesis when it places the car (undefined: the EKF is the dot). */
export function puckHypothesis(estimate: NavEstimate, deadReckoning: boolean): MapMatchEstimate["clusters"][number] | undefined {
  const mm = estimate.mapMatch;
  return deadReckoning && mm && MAP_MATCH_PUCK.has(mm.state) ? mm.clusters[0] : undefined;
}

/** The dot's ~68 % radius: the hypothesis' spread, else the EKF's. */
export function puckAccuracyM(estimate: NavEstimate, hypothesis: MapMatchEstimate["clusters"][number] | undefined): number {
  return hypothesis ? Math.max(hypothesis.spreadM, MAP_MATCH_MIN_ACCURACY_M) : estimate.accuracyM;
}

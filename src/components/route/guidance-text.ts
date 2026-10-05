import type { IconName } from "@/components/ui/icon";
import type { Strings } from "@/i18n/en";
import type { ManeuverKind } from "@/nav/routing/maneuvers";
import type { RouteProblem } from "@/services/navigation/route-service";

type Lang = "en" | "uk";

export const MANEUVER_ICON: Record<ManeuverKind, IconName> = {
  depart: "straight",
  "slight-left": "turn_slight_left",
  "slight-right": "turn_slight_right",
  left: "turn_left",
  right: "turn_right",
  "sharp-left": "turn_sharp_left",
  "sharp-right": "turn_sharp_right",
  "keep-left": "fork_left",
  "keep-right": "fork_right",
  "u-turn": "u_turn_left",
  roundabout: "roundabout_left",
  arrive: "flag",
};

export const MANEUVER_TEXT: Record<ManeuverKind, keyof Strings> = {
  depart: "mDepart",
  "slight-left": "mSlightLeft",
  "slight-right": "mSlightRight",
  left: "mLeft",
  right: "mRight",
  "sharp-left": "mSharpLeft",
  "sharp-right": "mSharpRight",
  "keep-left": "mKeepLeft",
  "keep-right": "mKeepRight",
  "u-turn": "mUTurn",
  roundabout: "mRoundabout",
  arrive: "mArrive",
};

export const PROBLEM_TEXT: Record<RouteProblem, keyof Strings> = {
  "no-road-graph": "routeNoRoadGraph",
  "no-position": "routeNoPosition",
  "no-road-at-start": "routeNoRoadAtStart",
  "no-road-at-destination": "routeNoRoadAtDestination",
  "no-route": "routeNoRoute",
  "too-far": "routeTooFar",
  "outside-region": "routeOutsideRegionFailed",
};

/** Distance to a maneuver, in the steps a driver reads: 10 m under 300 m, 50 m under 1 km, then 0.1 km. */
export function formatManeuverDistance(meters: number, lang: Lang): string {
  const m = lang === "uk" ? "м" : "m";
  const km = lang === "uk" ? "км" : "km";
  if (meters < 300) return `${Math.max(0, Math.round(meters / 10) * 10)} ${m}`;
  if (meters < 1000) return `${Math.round(meters / 50) * 50} ${m}`;
  const value = (meters / 1000).toFixed(meters >= 100_000 ? 0 : 1);
  return `${lang === "uk" ? value.replace(".", ",") : value} ${km}`;
}

/** "18 min", "1 h 5 min". */
export function formatDurationS(seconds: number, t: (key: keyof Strings) => string): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  return h ? `${h} ${t("hoursShort")} ${r} ${t("minutesShort")}` : `${r} ${t("minutesShort")}`;
}

/** Clock time `seconds` from now, "14:32". */
export function formatArrival(seconds: number, nowMs: number): string {
  const d = new Date(nowMs + seconds * 1000);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

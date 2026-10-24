import { formatDurationS, formatManeuverDistance, maneuverInstruction } from "@/components/route/guidance-text";
import type { Strings } from "@/i18n/en";
import type { Maneuver, ManeuverKind } from "@/nav/routing/maneuvers";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import type { CarEstimates, CarManeuver, CarTrip } from "../../../modules/car-play/src/CarPlayModule";

/** SF Symbols standing in for the app's own turn icons (`MANEUVER_ICON`) until those are drawn as images. */
export const MANEUVER_SYMBOL: Record<ManeuverKind, string> = {
  depart: "arrow.up",
  "slight-left": "arrow.up.left",
  "slight-right": "arrow.up.right",
  left: "arrow.turn.up.left",
  right: "arrow.turn.up.right",
  "sharp-left": "arrow.down.left",
  "sharp-right": "arrow.down.right",
  "keep-left": "arrow.up.left",
  "keep-right": "arrow.up.right",
  "u-turn": "arrow.uturn.down",
  roundabout: "arrow.counterclockwise",
  arrive: "flag.checkered",
};

/** What the car's screen shows of a route (docs/CARPLAY-SPEC.md §4). */
export interface CarGuidance {
  /** Changes with the destination: a new trip on the car's screen. A re-plan to the same one is the same trip. */
  tripKey: string;
  trip: CarTrip;
  /** Changes when other maneuvers are next: they are sent again only then, the estimates with every position. */
  maneuversKey: string;
  maneuvers: CarManeuver[];
  estimates: CarEstimates;
  arrived: boolean;
}

/** The car's guidance for the route service's snapshot; null while there is none to follow. */
export function carGuidance(
  route: RouteSnapshot | null,
  t: (key: keyof Strings) => string,
  language: "en" | "uk",
): CarGuidance | null {
  const plan = route?.plan;
  const guidance = route?.guidance;
  const maneuvers = route?.maneuvers;
  if (!route || route.status !== "active" || !plan || !guidance || !maneuvers?.length) return null;
  const { destination } = route;
  const next = maneuvers[guidance.nextIndex];
  if (!next) return null;
  const then = guidance.thenIndex != null ? maneuvers[guidance.thenIndex] : undefined;
  // The plan's own pace for what is left: guidance has no time per maneuver.
  const sPerM = guidance.remainingM > 0 ? guidance.remainingS / guidance.remainingM : 0;
  const shown = (m: Maneuver, distanceM: number): CarManeuver => ({
    instruction: maneuverInstruction(m, t),
    symbol: MANEUVER_SYMBOL[m.kind],
    distanceM,
    timeS: distanceM * sPerM,
  });
  const start = plan.coordinates[0] ?? destination;
  return {
    tripKey: `${destination.lat},${destination.lon}`,
    trip: {
      originLat: start.lat,
      originLon: start.lon,
      destinationLat: destination.lat,
      destinationLon: destination.lon,
      destinationName: destination.name ?? null,
      summary: `${formatDurationS(plan.durationS, t)} · ${formatManeuverDistance(plan.lengthM, language)}`,
    },
    maneuversKey: `${route.planId}:${guidance.nextIndex}:${guidance.thenIndex ?? ""}`,
    maneuvers: then ? [shown(next, guidance.toNextM), shown(then, then.atM - next.atM)] : [shown(next, guidance.toNextM)],
    estimates: {
      toNextM: guidance.toNextM,
      toNextS: guidance.toNextM * sPerM,
      remainingM: guidance.remainingM,
      remainingS: guidance.remainingS,
    },
    arrived: guidance.state === "arrived",
  };
}

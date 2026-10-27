import { formatManeuverDistance, maneuverInstruction, PROBLEM_TEXT } from "@/components/route/guidance-text";
import type { Strings } from "@/i18n/en";
import { isStartTurnaround } from "@/nav/routing/announcer";
import type { Maneuver } from "@/nav/routing/maneuvers";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import type { CarDistanceUnit, CarRoutePayload, CarStepPayload } from "../../../modules/android-auto/src/AndroidAutoModule";

/**
 * A distance as the car shows it, rounded as the phone's banner rounds it (`formatManeuverDistance`): 10 m under 300 m,
 * 50 m under 1 km, then 0.1 km, whole kilometres from 100 km. The car writes the unit in its own language.
 */
export function carDistance(meters: number): { shown: number; unit: CarDistanceUnit } {
  const m = Math.max(0, meters);
  if (m < 300) return { shown: Math.round(m / 10) * 10, unit: "m" };
  if (m < 1000) return { shown: Math.round(m / 50) * 50, unit: "m" };
  if (m < 100_000) return { shown: Math.round(m / 100) / 10, unit: "km1" };
  return { shown: Math.round(m / 1000), unit: "km" };
}

/**
 * What the car's screen shows of the route service's snapshot (docs/ANDROID-AUTO-SPEC.md §4): the next maneuver with
 * the distance to it, the one after when it follows closely, the distance and time left; or why there is no maneuver
 * to show (planning, a failure, arrival). Each maneuver's distance and time are from the car, as the trip in the car's
 * other displays wants them. Null: no route.
 */
export function carRoute(route: RouteSnapshot | null, t: (key: keyof Strings) => string, language: "en" | "uk"): CarRoutePayload | null {
  if (!route) return null;
  const { destination, guidance, maneuvers, plan } = route;
  const base = {
    destinationName: destination.name ?? "",
    replanning: route.replanning,
    quiet: route.ownWay === true,
    steps: [] as CarStepPayload[],
    remainingM: 0,
    remainingS: 0,
    remainingShown: 0,
    remainingUnit: "m" as CarDistanceUnit,
  };
  if (route.status === "failed") {
    return { ...base, status: "failed", message: t(route.failure ? PROBLEM_TEXT[route.failure] : "routeCancelled") };
  }
  const next = guidance && maneuvers ? maneuvers[guidance.nextIndex] : undefined;
  // Planned, but no progress on it yet (the first position on the route comes with the next update): still planning.
  if (route.status === "planning" || !plan || !guidance || !maneuvers || !next) {
    return { ...base, status: "planning", message: t("planningRoute") };
  }
  const remaining = carDistance(guidance.remainingM);
  const left = { remainingM: guidance.remainingM, remainingS: guidance.remainingS, remainingShown: remaining.shown, remainingUnit: remaining.unit };
  if (guidance.state === "arrived") return { ...base, ...left, status: "arrived", message: t("arrived") };
  // The plan's own pace for what is left: guidance has no time per maneuver.
  const sPerM = guidance.remainingM > 0 ? guidance.remainingS / guidance.remainingM : 0;
  const step = (m: Maneuver, distanceM: number): CarStepPayload => {
    const { shown, unit } = carDistance(distanceM);
    return {
      id: carManeuverId(m),
      kind: m.kind,
      exit: m.exit ?? null,
      instruction: maneuverInstruction(m, t),
      distanceM,
      timeS: distanceM * sPerM,
      shownDistance: shown,
      shownUnit: unit,
      distanceText: formatManeuverDistance(distanceM, language),
    };
  };
  const then = guidance.thenIndex != null ? maneuvers[guidance.thenIndex] : undefined;
  const steps = [step(next, guidance.toNextM)];
  if (then) steps.push(step(then, guidance.toNextM + Math.max(0, then.atM - next.atM)));
  // Planning again: the old maneuvers are no guide, the car's notification says so.
  return { ...base, ...left, status: "active", message: route.replanning ? t("planningRoute") : null, steps };
}

/**
 * A maneuver the same on the road whatever plan holds it (its kind, exit and place, to about a metre): the car pops
 * up a turn once, not again when a re-plan or an alternative taken keeps it. Turning around at the start is one
 * wherever the car is when planned: a re-plan while it drives on away doesn't pop it up again.
 */
export function carManeuverId(m: Maneuver): string {
  if (isStartTurnaround(m)) return "u-turn@start";
  return `${m.kind}:${m.exit ?? ""}@${m.lat.toFixed(5)},${m.lon.toFixed(5)}`;
}

import { formatAlternativeDelta, formatDurationS, formatManeuverDistance, maneuverInstruction, PROBLEM_TEXT } from "@/components/route/guidance-text";
import { cameraWords, speedBesideCard, type SpeedAlertsSnapshot } from "@/components/map/speed-alerts";
import { formatDistance } from "@/components/status/format-geo";
import type { Strings } from "@/i18n/en";
import { isStartTurnaround } from "@/nav/routing/announcer";
import type { Maneuver } from "@/nav/routing/maneuvers";
import type { RoutePlan } from "@/nav/routing/router";
import type { RouteProblem, RouteSnapshot } from "@/services/navigation/route-service";

import type { CarDistanceUnit, CarRoutePayload, CarSpeedPayload, CarStepPayload, CarStopPayload } from "./car-types";

/** The failures whose phone words name a phone screen ("… in Offline maps"): the condition only, for CarPlay. */
const PHONE_FREE_PROBLEM: Partial<Record<RouteProblem, keyof Strings>> = { "no-road-graph": "carPlayNoRoadGraph" };

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
 * What the car's screen shows of the route service's snapshot (docs/ANDROID-AUTO-SPEC.md §4, CARPLAY-SPEC §4): the next maneuver with
 * the distance to it, the one after when it follows closely, the distance and time left; or why there is no maneuver
 * to show (planning, a failure, arrival). Each maneuver's distance and time are from the car, as the trip in the car's
 * other displays wants them. Null: no route.
 */
export function carRoute(
  route: RouteSnapshot | null,
  t: (key: keyof Strings) => string,
  language: "en" | "uk",
  /** The street each route goes by (`viaNames`): the route's, then its alternatives'. */
  via: (string | null)[] = [],
  /**
   * CarPlay: the failures' words without the phone's screens (Apple's guidelines), and one trip through the stops
   * (STOPS-SPEC §9): the estimates to the next stop, a stop reached an arrival there.
   */
  phoneFree = false,
): CarRoutePayload | null {
  const payload = carRouteAll(route, t, language, via, phoneFree);
  return payload && phoneFree ? byStops(payload, route!, t) : payload;
}

/**
 * CarPlay's trip to the destination, told stop by stop: its estimates to the next stop, and a stop reached is an
 * arrival there (`atStop`), the estimates then to the one after.
 */
function byStops(p: CarRoutePayload, route: RouteSnapshot, t: (key: keyof Strings) => string): CarRoutePayload {
  const ahead = p.stops[0];
  const leg =
    ahead && (p.status === "active" || p.status === "planning")
      ? { remainingM: ahead.remainingM, remainingS: ahead.remainingS, remainingShown: ahead.remainingShown, remainingUnit: ahead.remainingUnit }
      : {};
  if (route.atStop && p.status === "active") {
    return { ...p, ...leg, status: "arrived", message: t("atStopTitle"), steps: [], alternatives: [] };
  }
  return { ...p, ...leg };
}

const carRemaining = (remainingM: number, remainingS: number) => {
  const r = carDistance(remainingM);
  return { remainingM, remainingS, remainingShown: r.shown, remainingUnit: r.unit };
};

function carRouteAll(
  route: RouteSnapshot | null,
  t: (key: keyof Strings) => string,
  language: "en" | "uk",
  via: (string | null)[],
  phoneFree: boolean,
): CarRoutePayload | null {
  if (!route) return null;
  const { destination, guidance, maneuvers, plan } = route;
  const base = {
    destinationName: destination.name ?? "",
    destinationLat: destination.lat,
    destinationLon: destination.lon,
    replanning: route.replanning,
    quiet: route.ownWay === true,
    steps: [] as CarStepPayload[],
    remainingM: 0,
    remainingS: 0,
    remainingShown: 0,
    remainingUnit: "m" as CarDistanceUnit,
    title: "",
    detail: "",
    alternatives: [],
    stops: [] as CarStopPayload[],
    atStop: false,
  };
  if (route.status === "failed") {
    const problem = route.failure ? ((phoneFree && PHONE_FREE_PROBLEM[route.failure]) || PROBLEM_TEXT[route.failure]) : "routeCancelled";
    return { ...base, status: "failed", message: t(problem) };
  }
  if (route.status === "planning" || !plan || !maneuvers?.length) {
    return { ...base, status: "planning", message: t("planningRoute") };
  }
  // No progress on it yet (the first position on it comes with the next update; an alternative taken while the car
  // stands waits for the car to move): from the plan's start, as the phone's banner shows it. Shown as planning, a
  // route taken at a stop stayed "Planning route…" until another was.
  const nextIndex = guidance?.nextIndex ?? Math.min(1, maneuvers.length - 1);
  const next = maneuvers[nextIndex];
  if (!next) return { ...base, status: "planning", message: t("planningRoute") };
  const toNextM = guidance?.toNextM ?? next.atM;
  const remainingM = guidance?.remainingM ?? plan.lengthM;
  const remainingS = guidance?.remainingS ?? plan.durationS;
  const left = carRemaining(remainingM, remainingS);
  // The stops ahead, each from the car: its leg's own pace (the plan's time to it less the time already behind).
  const alongM = guidance?.alongM ?? 0;
  const doneS = plan.durationS - remainingS;
  const stops = (plan.stops ?? []).flatMap((ps): CarStopPayload[] => {
    const stop = route.stops.find((x) => x.key === ps.key);
    return stop ? [{ name: stop.name ?? "", ...carRemaining(Math.max(0, ps.atM - alongM), Math.max(0, ps.atS - doneS)) }] : [];
  });
  if (guidance?.state === "arrived") return { ...base, ...left, status: "arrived", message: t("arrived") };
  // The plan's own pace for what is left: guidance has no time per maneuver.
  const sPerM = remainingM > 0 ? remainingS / remainingM : 0;
  const step = (m: Maneuver, distanceM: number): CarStepPayload => {
    const { shown, unit } = carDistance(distanceM);
    return {
      id: carManeuverId(m),
      kind: m.kind === "stop" && m.side ? `stop-${m.side}` : m.kind,
      exit: m.exit ?? null,
      instruction: maneuverInstruction(m, t),
      distanceM,
      timeS: distanceM * sPerM,
      shownDistance: shown,
      shownUnit: unit,
      distanceText: formatManeuverDistance(distanceM, language),
    };
  };
  const then = guidance?.thenIndex != null ? maneuvers[guidance.thenIndex] : undefined;
  const steps = [step(next, toNextM)];
  if (then) steps.push(step(then, toNextM + Math.max(0, then.atM - next.atM)));
  // The routes list: each way by the street it goes by, then how it compares; its whole time and distance, as the
  // alternatives are timed against the route's whole plan. A time difference alone says nothing of why to take it.
  const whole = (p: RoutePlan) => `${formatDurationS(p.durationS, t)} · ${formatDistance(p.lengthM, language)}`;
  const row = (name: string | null | undefined, compared: string, p: RoutePlan) =>
    name ? { title: name, detail: `${compared} · ${whole(p)}` } : { title: compared, detail: whole(p) };
  const current = row(via[0], t("carThisRoute"), plan);
  const alternatives = route.replanning
    ? []
    : (route.alternatives ?? []).map((a, index) => ({ index, ...row(via[index + 1], formatAlternativeDelta(a.deltaS, t), a.plan) }));
  // Planning again: the old maneuvers are no guide, the car's notification says so. At a stop, its words.
  const atStop = route.atStop?.stop;
  return {
    ...base,
    ...left,
    stops,
    atStop: atStop != null,
    status: "active",
    message: route.replanning ? t("planningRoute") : atStop ? (atStop.name ? `${t("atStopTitle")}: ${atStop.name}` : t("atStopTitle")) : null,
    steps,
    title: via[0] ? current.title : "",
    detail: current.detail,
    alternatives,
  };
}

/**
 * What the car's map shows of the speed and the camera ahead (speed-alerts.ts; ANDROID-AUTO-SPEC §4): the speed with
 * the limit's sign, red past the driver's margin, and the phone's camera card. Beside a card with a sign, as on the
 * phone: no sign of its own, red past the lower of the road's and the camera's limits (`speedBesideCard`).
 */
export function carSpeed({ speed: road, camera }: SpeedAlertsSnapshot, t: (key: keyof Strings) => string, language: "en" | "uk"): CarSpeedPayload {
  const speed = speedBesideCard(road, camera);
  const words = camera && cameraWords(camera, t, language);
  return {
    speedKph: speed.speedKph ?? null,
    limitKph: speed.limitKph ?? null,
    over: speed.over,
    unit: t("speed"),
    camera:
      camera && words
        ? {
            id: camera.id,
            title: words.title,
            line: words.line,
            limitKph: camera.limitKph ?? null,
            slowDown: words.red,
            progress: camera.progress,
          }
        : null,
  };
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
